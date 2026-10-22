// Keep in sync with backend/services/page_boundaries.py.
// A page is one third of the previous two-screen cap: 2,000 characters of
// text, 1,000 characters plus one image, or two images. A heading, a code
// fence, or a long word may move the break earlier. It may not push past
// that cap.

export const SCREEN_CHARS = 1000;
export const MAX_PAGE_BUDGET = SCREEN_CHARS * 2;

const STRUCTURAL_TITLE_LINE = /^(?:(Chapter|Part|Book|Volume|Section|Lesson|Step)\s+(?:\d+|[IVXLCDM]+)\b(.*)|(Preface|Introduction|Foreword|Prologue|Epilogue|Conclusion|Afterword|Appendix)\b(.*))$/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)\n]+\)/g;

function isStructuralTitleLine(line) {
  let raw = String(line || '').trim();
  if (!raw || raw.startsWith('#') || raw.length > 120) return false;
  if (raw.endsWith('.') && (raw.match(/\./g) || []).length === 1 && raw.split(/\s+/).length <= 4) {
    raw = raw.slice(0, -1).trim();
  } else if (raw.includes('.')) {
    return false;
  }
  if (raw.split(/\s+/).length > 14) return false;
  return STRUCTURAL_TITLE_LINE.test(raw);
}

export function collectHeadingOffsets(markdown) {
  const offsets = [];
  let offset = 0;
  let inFence = false;
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const stripped = line.trim();
    if (stripped.startsWith('```')) {
      inFence = !inFence;
    } else if (!inFence && stripped) {
      if (/^#{1,6}\s+\S/.test(line) || isStructuralTitleLine(stripped)) {
        offsets.push(offset);
      }
    }
    offset += line.length + 1;
  }
  return offsets;
}

function imageSpans(markdown) {
  const spans = [];
  const re = new RegExp(MARKDOWN_IMAGE.source, 'g');
  let match = re.exec(markdown);
  while (match) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    match = re.exec(markdown);
  }
  return spans;
}

function hardPageEnd(markdown, pageStart, budgetCap, imageCost, spans) {
  const total = markdown.length;
  let budget = 0;
  let index = pageStart;
  let spanAt = 0;
  while (spanAt < spans.length && spans[spanAt].end <= pageStart) {
    spanAt += 1;
  }
  while (index < total) {
    if (spanAt < spans.length && spans[spanAt].start < index && index < spans[spanAt].end) {
      index = spans[spanAt].end;
      continue;
    }
    if (spanAt < spans.length && spans[spanAt].start === index) {
      let cursor = index;
      while (cursor > pageStart && /\s/.test(markdown[cursor - 1])) {
        cursor -= 1;
      }
      const slackBudget = budget - (index - cursor);
      if (slackBudget + imageCost > budgetCap) {
        return index;
      }
      budget = slackBudget + imageCost;
      index = spans[spanAt].end;
      spanAt += 1;
      continue;
    }
    if (budget >= budgetCap) {
      return index;
    }
    budget += 1;
    index += 1;
  }
  return index;
}

function snapPageEndToHeading(headingOffsets, pageStart, proposedEnd, targetCharsPerPage, totalLength, maxEnd) {
  const windowLo = pageStart + Math.floor(targetCharsPerPage * 0.55);
  const windowHi = Math.min(maxEnd, totalLength);
  if (windowLo >= windowHi) return proposedEnd;
  const candidates = headingOffsets.filter((h) => h > pageStart && h >= windowLo && h <= windowHi);
  if (!candidates.length) return proposedEnd;
  candidates.sort((a, b) => Math.abs(a - proposedEnd) - Math.abs(b - proposedEnd) || a - b);
  return candidates[0];
}

function snapBackToWhitespace(markdown, pageStart, proposedEnd) {
  if (proposedEnd >= markdown.length || proposedEnd <= pageStart) return proposedEnd;
  if (/\s/.test(markdown[proposedEnd - 1])) return proposedEnd;
  for (let i = proposedEnd; i > pageStart; i -= 1) {
    if (/\s/.test(markdown[i - 1])) {
      if (i - pageStart < Math.max(1, Math.floor((proposedEnd - pageStart) / 2)) && (proposedEnd - pageStart) > 64) {
        return proposedEnd;
      }
      return i;
    }
  }
  return proposedEnd;
}

function endBeforeOpenFence(markdown, pageStart, proposedEnd) {
  const segment = markdown.slice(pageStart, proposedEnd);
  const fenceCount = (segment.match(/```/g) || []).length;
  if (fenceCount % 2 === 0) return proposedEnd;
  const last = segment.lastIndexOf('```');
  if (last <= 0) return proposedEnd;
  return pageStart + last;
}

function endBeforeOpenTag(markdown, pageStart, proposedEnd) {
  const segment = markdown.slice(pageStart, proposedEnd);
  const lastOpen = segment.lastIndexOf('<');
  const lastClose = segment.lastIndexOf('>');
  if (lastOpen > lastClose && lastOpen > 0) {
    return pageStart + lastOpen;
  }
  return proposedEnd;
}

function leaveImageSpan(pageStart, proposedEnd, hardEnd, spans) {
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (span.start >= pageStart && span.start < proposedEnd && proposedEnd < span.end) {
      if (span.end <= hardEnd) return span.end;
      return span.start > pageStart ? span.start : hardEnd;
    }
  }
  return proposedEnd;
}

export function calculatePageBoundaries(markdown, targetCharsPerPage) {
  if (!markdown || typeof markdown !== 'string') {
    return [];
  }
  const budgetCap = targetCharsPerPage > 0 ? targetCharsPerPage : MAX_PAGE_BUDGET;
  const imageCost = Math.max(1, Math.floor(budgetCap / 2));
  const totalLength = markdown.length;
  const headingOffsets = collectHeadingOffsets(markdown);
  const spans = imageSpans(markdown);
  const boundaries = [];
  let currentOffset = 0;

  while (currentOffset < totalLength) {
    const pageStart = currentOffset;
    const hardEnd = hardPageEnd(markdown, pageStart, budgetCap, imageCost, spans);
    let actualEnd = hardEnd;

    if (hardEnd < totalLength) {
      const endsOnImage = spans.some((span) => span.end === hardEnd && span.start >= pageStart);
      const headingEnd = snapPageEndToHeading(
        headingOffsets,
        pageStart,
        hardEnd,
        budgetCap,
        totalLength,
        hardEnd,
      );
      if (headingEnd !== hardEnd && headingEnd > pageStart && headingEnd <= hardEnd) {
        actualEnd = headingEnd;
      } else if (!endsOnImage) {
        actualEnd = snapBackToWhitespace(markdown, pageStart, hardEnd);
      }
      actualEnd = endBeforeOpenFence(markdown, pageStart, actualEnd);
      actualEnd = endBeforeOpenTag(markdown, pageStart, actualEnd);
      actualEnd = leaveImageSpan(pageStart, actualEnd, hardEnd, spans);
    }

    if (actualEnd <= pageStart) {
      actualEnd = hardEnd > pageStart ? hardEnd : Math.min(totalLength, pageStart + 1);
    }
    if (hardEnd > pageStart && actualEnd > hardEnd) {
      actualEnd = hardEnd;
    }
    actualEnd = Math.min(actualEnd, totalLength);
    boundaries.push({ start: pageStart, end: actualEnd });
    currentOffset = actualEnd;

    if (boundaries.length > 10000) {
      break;
    }
  }
  return boundaries;
}
