/**
 * Land on the stored start of the section. Do not skip ahead to a later
 * sentence; that put the reader near the end of short sections.
 */
export function resolveGuideNavigationOffset(markdown, startOffset) {
  if (typeof markdown !== 'string' || typeof startOffset !== 'number' || Number.isNaN(startOffset)) {
    return startOffset;
  }
  return Math.max(0, Math.min(Math.floor(startOffset), markdown.length));
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
 * Highlight the opening sentence of the stored span on the page that contains
 * the start. A later key quote must not become the scroll target.
 */
export function resolveGuideHighlightOnPage({
  pageMarkdown,
  pageStartGlobal,
  startOffset,
  endOffset,
}) {
  if (typeof pageMarkdown !== 'string') return null;
  if (typeof pageStartGlobal !== 'number' || typeof startOffset !== 'number' || typeof endOffset !== 'number') {
    return null;
  }
  if (!(endOffset > startOffset)) return null;

  const pageEndGlobal = pageStartGlobal + pageMarkdown.length;
  const containsStart = startOffset >= pageStartGlobal && startOffset < pageEndGlobal;
  if (!containsStart) return null;

  const overlapStart = Math.max(startOffset, pageStartGlobal);
  const overlapEnd = Math.min(endOffset, pageEndGlobal);
  if (overlapEnd <= overlapStart) return null;

  const { plain, rawToPlain, plainToRaw } = projectPageMarkdown(pageMarkdown);
  const plainStart = plainIndexForRaw(rawToPlain, overlapStart - pageStartGlobal);
  const plainEnd = plainIndexForRaw(rawToPlain, overlapEnd - pageStartGlobal);
  if (plainEnd <= plainStart) return null;

  const range = openingSentence(plain, plainStart, plainEnd);
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
