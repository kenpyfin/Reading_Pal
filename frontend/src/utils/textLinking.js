// Utility functions for fast text linking and navigation
import logger from './logger';

/**
 * Fast offset-to-page calculation using binary search for O(log n) performance
 * @param {number} offset - Global character offset in the document
 * @param {Array} pageBoundaries - Array of {start, end} objects representing page boundaries
 * @returns {Object|null} - {pageNumber, offsetInPage} or null if not found
 */
export function getPageForOffset(offset, pageBoundaries) {
  if (!pageBoundaries || pageBoundaries.length === 0) {
    return null;
  }

  // Binary search for the page containing this offset
  let left = 0;
  let right = pageBoundaries.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const boundary = pageBoundaries[mid];

    if (offset >= boundary.start && offset < boundary.end) {
      return {
        pageNumber: mid + 1, // Pages are 1-indexed
        offsetInPage: offset - boundary.start
      };
    } else if (offset < boundary.start) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  // Handle case where offset is exactly at the end of the last page
  const lastBoundary = pageBoundaries[pageBoundaries.length - 1];
  if (offset === lastBoundary.end) {
    return {
      pageNumber: pageBoundaries.length,
      offsetInPage: lastBoundary.end - lastBoundary.start
    };
  }

  return null;
}

/**
 * Smooth scroll to an offset with highlight animation
 * @param {HTMLElement} container - The scrollable container element
 * @param {number} offset - Character offset within the current page content
 * @param {string} rawPageContent - Raw markdown content of the current page
 * @param {number} highlightDuration - Duration of highlight in milliseconds (default 10000)
 * @returns {Promise} - Resolves when scroll and highlight are complete
 */
export function scrollToOffsetWithHighlight(container, offset, rawPageContent, highlightDuration = 10000) {
  return new Promise((resolve) => {
    if (!container || !rawPageContent) {
      resolve();
      return;
    }

    // Create markdown segments (text and images)
    const segments = createMarkdownSegments(rawPageContent);

    // Map raw offset to rendered offset
    const renderedOffset = mapRawToRenderedOffset(offset, segments);

    // Find the text node at this rendered offset
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let currentRenderedOffset = 0;
    let targetNode = null;
    let targetOffsetInNode = 0;
    let textNode;

    while ((textNode = walker.nextNode())) {
      const nodeLength = textNode.textContent.length;

      if (currentRenderedOffset + nodeLength >= renderedOffset) {
        targetNode = textNode;
        targetOffsetInNode = renderedOffset - currentRenderedOffset;
        break;
      }

      currentRenderedOffset += nodeLength;
    }

    if (!targetNode) {
      // Fallback: scroll to top
      container.scrollTop = 0;
      resolve();
      return;
    }

    // Create range and highlight
    try {
      const range = document.createRange();
      range.setStart(targetNode, Math.max(0, Math.min(targetOffsetInNode, targetNode.textContent.length)));
      range.setEnd(targetNode, Math.max(0, Math.min(targetOffsetInNode + 10, targetNode.textContent.length)));

      const highlightSpan = document.createElement('span');
      highlightSpan.className = 'text-link-highlight';
      highlightSpan.style.backgroundColor = 'var(--color-highlight-bg)';
      highlightSpan.style.transition = 'background-color 1s ease-out';
      highlightSpan.style.padding = '2px 0';
      highlightSpan.style.borderRadius = '2px';

      range.surroundContents(highlightSpan);

      // Calculate scroll position
      let scrollTop = 0;
      let element = highlightSpan;
      while (element && element !== container) {
        scrollTop += element.offsetTop;
        element = element.offsetParent;
      }

      // Smooth scroll with offset for better visibility
      const targetScrollTop = Math.max(0, scrollTop - 100);

      container.scrollTo({
        top: targetScrollTop,
        behavior: 'smooth'
      });

      // Fade out highlight after duration
      setTimeout(() => {
        if (highlightSpan.parentNode) {
          highlightSpan.style.backgroundColor = 'transparent';
          setTimeout(() => {
            if (highlightSpan.parentNode) {
              const text = highlightSpan.textContent;
              highlightSpan.parentNode.replaceChild(document.createTextNode(text), highlightSpan);
            }
          }, 1000);
        }
        resolve();
      }, highlightDuration);

    } catch (e) {
      console.error('[textLinking] Error creating highlight:', e);
      // Fallback: just scroll to approximate position
      const approximateScrollTop = (offset / rawPageContent.length) * container.scrollHeight;
      container.scrollTo({
        top: approximateScrollTop,
        behavior: 'smooth'
      });
      resolve();
    }
  });
}

/**
 * Searches for a string in a DOM container and returns the text node and offset.
 * Used for "re-pinpointing" when raw offsets might be slightly off due to complex markdown.
 * @param {HTMLElement} container 
 * @param {string} searchText 
 * @returns {Object|null} {node, offset}
 */
export function findTextInContainer(container, searchText) {
  if (!container || !searchText || searchText.trim().length === 0) return null;

  const cleanSearchText = searchText.trim().replace(/\s+/g, ' ');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let textNode;

  // Create a combined text representation to find the index
  let fullText = "";
  const nodes = [];
  const startOffsets = [];

  while ((textNode = walker.nextNode())) {
    startOffsets.push(fullText.length);
    fullText += textNode.textContent;
    nodes.push(textNode);
  }

  // Use a flexible search that ignores whitespace differences
  const escapedText = cleanSearchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const searchRegex = new RegExp(escapedText.replace(/\s+/g, '\\s+'), 'i');
  const match = fullText.match(searchRegex);

  if (match) {
    const matchStart = match.index;
    // Find which node contains this start index
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (matchStart >= startOffsets[i]) {
        return {
          node: nodes[i],
          offset: matchStart - startOffsets[i],
          matchLength: match[0].length
        };
      }
    }
  }

  return null;
}

/**
 * Helper: Create markdown segments (separate text and image syntax)
 */
export function createMarkdownSegments(rawMd) {
  const segments = [];
  // Updated regex to catch basic markdown syntax that gets rendered/stripped
  const imageRegex = /(!\[(?:[^\]]*)\]\((?:[^\s\)]*)(?:\s"[^"]*")?\))/g;
  let lastIdx = 0;
  let matchResult;

  while ((matchResult = imageRegex.exec(rawMd)) !== null) {
    if (matchResult.index > lastIdx) {
      segments.push({ type: 'text', rawContent: rawMd.substring(lastIdx, matchResult.index) });
    }
    segments.push({ type: 'image', rawContent: matchResult[0] });
    lastIdx = matchResult.index + matchResult[0].length;
  }

  if (lastIdx < rawMd.length) {
    segments.push({ type: 'text', rawContent: rawMd.substring(lastIdx) });
  }

  return segments;
}

/**
 * Helper: Map raw character offset to rendered character offset.
 * This version attempts to account for markdown characters that are stripped during rendering.
 */
export function mapRawToRenderedOffset(rawOffset, segments) {
  let currentRawOffset = 0;
  let currentRenderedOffset = 0;

  for (const segment of segments) {
    if (segment.type === 'text') {
      const rawText = segment.rawContent;

      // Calculate "rendered" version of this raw text by stripping common markdown
      // This is an approximation as actual rendering depends on the markdown parser config
      let cleanedText = rawText
        .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
        .replace(/(\*|_)(.*?)\1/g, '$2')    // italic
        .replace(/\[(.*?)\]\(.*?\)/g, '$1') // links
        .replace(/^#{1,6}\s+/gm, '')        // headers
        .replace(/`([^`]+)`/g, '$1');       // inline code

      const decodedContent = decodeHtmlEntities(cleanedText);
      let renderedLength = 0;
      let inSpace = false;

      for (let i = 0; i < decodedContent.length; i++) {
        if (/\s/.test(decodedContent[i])) {
          if (!inSpace) renderedLength++;
          inSpace = true;
        } else {
          renderedLength++;
          inSpace = false;
        }
      }

      if (currentRawOffset + rawText.length >= rawOffset) {
        // Target is within this segment
        const rawOffsetInSegment = rawOffset - currentRawOffset;

        // Use proportion to estimate rendered offset within segment
        // This handles cases where markdown characters are sprinkled throughout
        const proportion = rawOffsetInSegment / rawText.length;
        const renderedOffsetInSegment = Math.round(proportion * renderedLength);

        return currentRenderedOffset + renderedOffsetInSegment;
      }

      currentRawOffset += rawText.length;
      currentRenderedOffset += renderedLength;
    } else {
      // Image segment - adds to raw but not rendered
      currentRawOffset += segment.rawContent.length;
    }
  }

  return currentRenderedOffset;
}

/**
 * Helper: Decode HTML entities
 */
export function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || !text) return '';
  try {
    const element = document.createElement('textarea');
    element.innerHTML = text;
    return element.value;
  } catch (e) {
    // Fail-safe for non-browser environments or errors
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
}



/**
 * Maps a rendered character offset back to a raw markdown offset
 * @param {number} renderedOffsetTarget - Target offset in the rendered text
 * @param {Array} mdSegments - Array of markdown segments
 * @returns {number} - Corresponding raw character offset
 */
export function mapRenderedToRawOffset(renderedOffsetTarget, mdSegments) {
  let currentRawOffset = 0;
  let currentRenderedOffset = 0;

  for (const segment of mdSegments) {
    if (segment.type === 'text') {
      const rawContentOfSegment = segment.rawContent;
      const decodedContent = decodeHtmlEntities(rawContentOfSegment);

      let approxRenderedLengthOfDecoded = 0;
      let inSpaceSequenceOuter = false;
      for (let i = 0; i < decodedContent.length; i++) {
        if (/\s/.test(decodedContent[i])) {
          if (!inSpaceSequenceOuter) approxRenderedLengthOfDecoded++;
          inSpaceSequenceOuter = true;
        } else {
          approxRenderedLengthOfDecoded++;
          inSpaceSequenceOuter = false;
        }
      }

      if (currentRenderedOffset + approxRenderedLengthOfDecoded >= renderedOffsetTarget) {
        let renderedCharsCountedInDecodedSegment = 0;
        let inSpaceSequenceInner = false;
        const targetRenderedCharsInThisDecodedSegment = renderedOffsetTarget - currentRenderedOffset;

        if (targetRenderedCharsInThisDecodedSegment <= 0) {
          return currentRawOffset;
        }

        let k_decoded = 0;
        for (k_decoded = 0; k_decoded < decodedContent.length; k_decoded++) {
          const charIsSpace = /\s/.test(decodedContent[k_decoded]);
          if (charIsSpace) {
            if (!inSpaceSequenceInner) renderedCharsCountedInDecodedSegment++;
            inSpaceSequenceInner = true;
          } else {
            renderedCharsCountedInDecodedSegment++;
            inSpaceSequenceInner = false;
          }

          if (renderedCharsCountedInDecodedSegment >= targetRenderedCharsInThisDecodedSegment) {
            let estimatedRawChars;
            if (decodedContent.length === 0) {
              estimatedRawChars = 0;
            } else {
              const proportionOfDecoded = (k_decoded + 1) / decodedContent.length;
              estimatedRawChars = Math.round(proportionOfDecoded * rawContentOfSegment.length);
            }
            return currentRawOffset + estimatedRawChars;
          }
        }
        return currentRawOffset + rawContentOfSegment.length;
      }

      currentRenderedOffset += approxRenderedLengthOfDecoded;
      currentRawOffset += rawContentOfSegment.length;
    } else {
      currentRawOffset += segment.rawContent.length;
    }
  }

  return currentRawOffset;
}
