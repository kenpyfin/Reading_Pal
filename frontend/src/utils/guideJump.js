const SENTENCE_LOOKAHEAD = 320;

function isMidSentenceFragment(markdown, start) {
  if (start <= 0) return false;
  const before = markdown.slice(Math.max(0, start - 120), start);
  if (/\n\s*$/.test(before)) return false;
  const trimmed = before.replace(/\s+$/, '');
  if (!trimmed) return false;
  if (/[.!?]["')\]]*$/.test(trimmed)) return false;
  return true;
}

/**
 * Land on the stored start. Skip forward only when the characters just
 * before that start are a mid-sentence fragment.
 */
export function resolveGuideNavigationOffset(markdown, startOffset) {
  if (typeof markdown !== 'string' || typeof startOffset !== 'number' || Number.isNaN(startOffset)) {
    return startOffset;
  }
  const start = Math.max(0, Math.min(Math.floor(startOffset), markdown.length));
  if (!isMidSentenceFragment(markdown, start)) return start;
  const lookahead = markdown.slice(start, start + SENTENCE_LOOKAHEAD);
  const boundary = lookahead.match(/[.!?]\s+/);
  if (!boundary || typeof boundary.index !== 'number') return start;
  const candidate = start + boundary.index + boundary[0].length;
  if (candidate > start && candidate <= markdown.length) return candidate;
  return start;
}

/**
 * Drop heading markers and image syntax so guide offsets can be applied to
 * the text the reader actually sees. plainToRaw[plainIndex] is the markdown
 * index of that visible character; the last entry is the exclusive end.
 */
export function projectPageMarkdown(markdown) {
  const source = typeof markdown === 'string' ? markdown : '';
  const rawToPlain = new Array(source.length + 1);
  const plainToRaw = [];
  let plain = '';
  let i = 0;

  const markSkipped = (rawIndex) => {
    rawToPlain[rawIndex] = plain.length;
  };

  while (i < source.length) {
    if (i === 0 || source[i - 1] === '\n') {
      const heading = source.slice(i).match(/^#{1,6}[ \t]+/);
      if (heading) {
        for (let k = 0; k < heading[0].length; k += 1) markSkipped(i + k);
        i += heading[0].length;
        continue;
      }
    }
    const image = source.slice(i).match(/^!\[[^\]]*\]\([^)\n]*(?:\s+"[^"]*")?\)/);
    if (image) {
      for (let k = 0; k < image[0].length; k += 1) markSkipped(i + k);
      i += image[0].length;
      continue;
    }
    rawToPlain[i] = plain.length;
    plainToRaw.push(i);
    plain += source[i];
    i += 1;
  }

  rawToPlain[source.length] = plain.length;
  plainToRaw.push(source.length);
  return { plain, rawToPlain, plainToRaw };
}

export function plainIndexForRaw(rawToPlain, rawIndex) {
  if (!rawToPlain || rawToPlain.length === 0) return 0;
  const clamped = Math.max(0, Math.min(rawIndex, rawToPlain.length - 1));
  return rawToPlain[clamped];
}

function normalizeQuote(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}

function findQuoteInPlain(plain, start, end, quote) {
  const cleaned = normalizeQuote(quote);
  if (!cleaned) return null;
  const span = plain.slice(start, end);
  if (!span) return null;
  const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const match = span.match(new RegExp(escaped, 'i'));
  if (!match || typeof match.index !== 'number') return null;
  return {
    start: start + match.index,
    end: start + match.index + match[0].length,
  };
}

function openingSentence(plain, start, end) {
  const span = plain.slice(start, end);
  if (!span.trim()) return null;
  const match = span.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let length = match ? match[0].length : Math.min(span.length, 240);
  if (length < 1) length = Math.min(span.length, 1);
  return { start, end: start + length };
}

function rawRangeFromPlain(plainToRaw, plainLength, range) {
  if (!range) return null;
  const startPlain = Math.max(0, Math.min(range.start, plainToRaw.length - 1));
  const endPlain = Math.max(range.start, Math.min(range.end, plainLength));
  const rawStart = plainToRaw[startPlain];
  const rawEnd = plainToRaw[Math.max(0, Math.min(endPlain, plainToRaw.length - 1))];
  if (typeof rawStart !== 'number' || typeof rawEnd !== 'number' || rawEnd <= rawStart) return null;
  return { rawStart, rawEnd };
}

/**
 * Highlight the quote only inside the stored span, after heading and image
 * syntax are removed. If the quote is not in that span, highlight the opening
 * sentence on the page that contains the stored start.
 */
export function resolveGuideHighlightOnPage({
  pageMarkdown,
  pageStartGlobal,
  startOffset,
  endOffset,
  quote,
}) {
  if (typeof pageMarkdown !== 'string') return null;
  if (typeof pageStartGlobal !== 'number' || typeof startOffset !== 'number' || typeof endOffset !== 'number') {
    return null;
  }
  if (!(endOffset > startOffset)) return null;

  const pageEndGlobal = pageStartGlobal + pageMarkdown.length;
  const overlapStart = Math.max(startOffset, pageStartGlobal);
  const overlapEnd = Math.min(endOffset, pageEndGlobal);
  if (overlapEnd <= overlapStart) return null;

  const { plain, rawToPlain, plainToRaw } = projectPageMarkdown(pageMarkdown);
  const plainStart = plainIndexForRaw(rawToPlain, overlapStart - pageStartGlobal);
  const plainEnd = plainIndexForRaw(rawToPlain, overlapEnd - pageStartGlobal);
  if (plainEnd <= plainStart) return null;

  const containsStart = startOffset >= pageStartGlobal && startOffset < pageEndGlobal;
  let range = findQuoteInPlain(plain, plainStart, plainEnd, quote);
  if (!range && containsStart) {
    range = openingSentence(plain, plainStart, plainEnd);
  }
  return rawRangeFromPlain(plainToRaw, plain.length, range);
}

/** Markdown index on this page where the section-end marker should sit. */
export function markerOffsetInPageMarkdown(pageMarkdown, pageStartGlobal, endOffset) {
  if (typeof pageMarkdown !== 'string') return null;
  if (typeof pageStartGlobal !== 'number' || typeof endOffset !== 'number' || Number.isNaN(endOffset)) {
    return null;
  }
  const pageEnd = pageStartGlobal + pageMarkdown.length;
  if (endOffset < pageStartGlobal || endOffset > pageEnd) return null;
  const { rawToPlain, plainToRaw } = projectPageMarkdown(pageMarkdown);
  const plainIdx = plainIndexForRaw(rawToPlain, endOffset - pageStartGlobal);
  const snapped = plainToRaw[Math.max(0, Math.min(plainIdx, plainToRaw.length - 1))];
  return typeof snapped === 'number' ? snapped : null;
}
