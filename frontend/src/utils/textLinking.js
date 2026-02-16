// Utility functions for fast text linking and navigation

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
 * @param {number} highlightDuration - Duration of highlight in milliseconds (default 2000)
 * @returns {Promise} - Resolves when scroll and highlight are complete
 */
export function scrollToOffsetWithHighlight(container, offset, rawPageContent, highlightDuration = 2000) {
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
      highlightSpan.style.backgroundColor = 'rgba(255, 255, 0, 0.5)';
      highlightSpan.style.transition = 'background-color 0.5s ease-out';
      highlightSpan.style.padding = '2px 0';
      
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
          highlightSpan.style.backgroundColor = '';
          setTimeout(() => {
            if (highlightSpan.parentNode) {
              const text = highlightSpan.textContent;
              highlightSpan.parentNode.replaceChild(document.createTextNode(text), highlightSpan);
            }
          }, 500);
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
 * Helper: Create markdown segments (separate text and image syntax)
 */
function createMarkdownSegments(rawMd) {
  const segments = [];
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
 * Helper: Map raw character offset to rendered character offset
 */
function mapRawToRenderedOffset(rawOffset, segments) {
  let currentRawOffset = 0;
  let currentRenderedOffset = 0;

  for (const segment of segments) {
    if (segment.type === 'text') {
      const decodedContent = decodeHtmlEntities(segment.rawContent);
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

      if (currentRawOffset + segment.rawContent.length >= rawOffset) {
        // Target is within this segment
        const rawOffsetInSegment = rawOffset - currentRawOffset;
        const proportion = rawOffsetInSegment / segment.rawContent.length;
        const renderedOffsetInSegment = Math.floor(proportion * renderedLength);
        return currentRenderedOffset + renderedOffsetInSegment;
      }

      currentRawOffset += segment.rawContent.length;
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
function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || !text) return '';
  try {
    const element = document.createElement('textarea');
    element.innerHTML = text;
    return element.value;
  } catch (e) {
    return text;
  }
}


