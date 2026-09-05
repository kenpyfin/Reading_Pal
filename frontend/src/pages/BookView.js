import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useParams, Link } from 'react-router-dom';
import BookPane from '../components/BookPane';
import NotePane from '../components/NotePane';
import ReadingGuidePane from '../components/ReadingGuidePane'; // Import ReadingGuidePane
import AllNotesModal from '../components/AllNotesModal';
import NoteDisplayModal from '../components/NoteDisplayModal';
import { debounce } from 'lodash';
import './BookView.css';
import logger from '../utils/logger'; // Ensure logger is imported
import { getPageForOffset } from '../utils/textLinking'; // Import text linking utilities
import {
  getStoredAuthToken,
  getStoredReadingPosition,
  getStoredReadingViewMode,
  setStoredReadingPosition,
  setStoredReadingViewMode,
} from '../utils/storage';
import {
  putBookMeta,
  getBookMeta,
  putGuide,
  getGuide,
  getGuideEntry,
  DEFAULT_GUIDE_ID,
  MAX_READING_GUIDES,
  putAnnotations,
  getAnnotations,
  prefetchMarkdownImages,
  rewriteMarkdownWithCachedImages,
  cacheRoadmapGraphImages,
  hydrateRoadmapWithCachedGraphs,
  addOutboxEntry,
  getOutboxCount,
  newLocalId,
  isLocalId,
  removePendingCreateNote,
  removePendingCreateBookmark,
} from '../utils/offlineBookCache';
import { flushOutbox } from '../utils/outboxSync';
import {
  mergeAnnotationsByTimestamp,
  applyLocalProgressToggle,
  reconcileGuideProgressState,
} from '../utils/syncReconciler';

// Virtual "pages" when splitting full markdown for reading (smaller = less text per page, more page numbers).
const APPROX_CHARS_PER_PAGE = 8000;

const BOOK_CONTROLS_EXPANDED_KEY = 'readingPal_bookControlsExpanded';
const FLOATING_TOOLBAR_TOP_PX = 80;
/** Show floating control after scrolling this many px (inner scroll container). */
const SCROLL_TOP_REVEAL_PX = 16;

function readStoredBookControlsExpanded() {
  if (typeof window === 'undefined') return true;
  try {
    const v = window.sessionStorage.getItem(BOOK_CONTROLS_EXPANDED_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch (_e) {
    /* ignore */
  }
  return true;
}

// Helper to decode HTML entities (basic version)
function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || !text) return ''; // Handle empty or non-string input
  try {
    const element = document.createElement('textarea');
    element.innerHTML = text;
    return element.value;
  } catch (e) {
    // Fallback for environments where DOM might not be fully available (less likely in React frontend)
    // or if innerHTML assignment fails for some reason.
    logger.error("[decodeHtmlEntities] Error decoding text:", text, e);
    return text; // Return original text on error
  }
}

// --- Helper function to segment Markdown ---
function createMarkdownSegments(rawMd) {
  const segments = [];
  // Regex for images. Could be expanded for other syntax.
  // Matches: ![alt text](url "title") or ![alt text](url) or ![](url)
  const imageRegex = /(!\[(?:[^\]]*)\]\((?:[^\s\)]*)(?:\s"[^"]*")?\))/g;
  let lastIdx = 0;
  let matchResult;
  while ((matchResult = imageRegex.exec(rawMd)) !== null) {
    if (matchResult.index > lastIdx) {
      segments.push({ type: 'text', rawContent: rawMd.substring(lastIdx, matchResult.index) });
    }
    segments.push({ type: 'image', rawContent: matchResult[0] }); // 'image' is a placeholder for 'syntax'
    lastIdx = imageRegex.lastIndex;
  }
  if (lastIdx < rawMd.length) {
    segments.push({ type: 'text', rawContent: rawMd.substring(lastIdx) });
  }
  return segments;
}

// --- Helper function for mapping rendered offset to raw offset ---
function mapRenderedToRawOffset(renderedOffsetTarget, mdSegments) {
  let currentRawOffset = 0;
  let currentRenderedOffset = 0;
  // For debugging:
  let totalApproxRenderedLengthOfSegments = 0;
  mdSegments.filter(s => s.type === 'text').forEach(s => {
      const decodedContent = decodeHtmlEntities(s.rawContent);
      let approxLen = 0; let inSpace = false;
      for (let i = 0; i < decodedContent.length; i++) {
          if (/\s/.test(decodedContent[i])) { if (!inSpace) approxLen++; inSpace = true; }
          else { approxLen++; inSpace = false; }
      }
      totalApproxRenderedLengthOfSegments += approxLen;
  });
  logger.debug(`[mapRenderedToRawOffset] Target Rendered Offset: ${renderedOffsetTarget}. Total approx rendered length of all text segments (after decoding + collapse): ${totalApproxRenderedLengthOfSegments}`);

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
      logger.debug(`[mapRenderedToRawOffset] Processing TEXT segment. Raw len: ${rawContentOfSegment.length}, Decoded len: ${decodedContent.length}, ApproxRenderedLenOfDecoded: ${approxRenderedLengthOfDecoded}. currentRenderedOffset: ${currentRenderedOffset}, currentRawOffset: ${currentRawOffset}. Raw (start): "${rawContentOfSegment.substring(0, 30)}", Decoded (start): "${decodedContent.substring(0,30)}"`);

      if (currentRenderedOffset + approxRenderedLengthOfDecoded >= renderedOffsetTarget) {
        // Target falls within this segment
        let renderedCharsCountedInDecodedSegment = 0;
        let inSpaceSequenceInner = false;
        const targetRenderedCharsInThisDecodedSegment = renderedOffsetTarget - currentRenderedOffset;

        if (targetRenderedCharsInThisDecodedSegment <= 0) {
          logger.debug(`[mapRenderedToRawOffset] Target ${targetRenderedCharsInThisDecodedSegment} is <=0 for this segment. Returning currentRawOffset ${currentRawOffset}.`);
          return currentRawOffset; // Selection starts at or before this segment's rendered content
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
            // We've found the target in terms of decoded+collapsed characters.
            // `k_decoded + 1` is the length of the prefix of `decodedContent` (before collapse) that covers the target.
            // Estimate corresponding raw length:
            let estimatedRawChars;
            if (decodedContent.length === 0) { // Avoid division by zero if decoded content is empty
                estimatedRawChars = 0;
            } else {
                const proportionOfDecoded = (k_decoded + 1) / decodedContent.length;
                estimatedRawChars = Math.round(proportionOfDecoded * rawContentOfSegment.length);
            }
            logger.debug(`[mapRenderedToRawOffset] Target met in segment. Decoded prefix len: ${k_decoded + 1}, Rendered chars covered: ${renderedCharsCountedInDecodedSegment}. Estimated raw chars for this part: ${estimatedRawChars}. Returning: ${currentRawOffset + estimatedRawChars}`);
            return currentRawOffset + estimatedRawChars;
          }
        }
        // If loop finishes, it means all of decodedContent was consumed to attempt to meet the target.
        // This implies the target was at or beyond the end of this segment's rendered content.
        logger.debug(`[mapRenderedToRawOffset] Inner loop completed for segment. All decoded chars consumed. Adding full raw length of segment: ${rawContentOfSegment.length}. Returning: ${currentRawOffset + rawContentOfSegment.length}`);
        return currentRawOffset + rawContentOfSegment.length; // Add full raw length of this segment
      }

      // Target is beyond this segment
      currentRenderedOffset += approxRenderedLengthOfDecoded;
      currentRawOffset += rawContentOfSegment.length; // Always use full raw length for raw offset accumulation

    } else { // 'image' or other non-text syntax
      logger.debug(`[mapRenderedToRawOffset] Processing IMAGE segment. Raw len: ${segment.rawContent.length}. currentRawOffset before add: ${currentRawOffset}. Content: "${segment.rawContent.substring(0, 30)}"`);
      currentRawOffset += segment.rawContent.length;
    }
  }

  logger.debug(`[mapRenderedToRawOffset] Target ${renderedOffsetTarget} beyond all segments. currentRenderedOffset: ${currentRenderedOffset}. Returning total accumulated raw offset ${currentRawOffset}.`);
  return currentRawOffset;
}

function normalizeWhitespaceWithIndexMap(text) {
  const normalizedChars = [];
  const indexMap = [];
  let previousWasWhitespace = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const isWhitespace = /\s/.test(char);
    if (isWhitespace) {
      if (!previousWasWhitespace) {
        normalizedChars.push(' ');
        indexMap.push(i);
      }
      previousWasWhitespace = true;
    } else {
      normalizedChars.push(char);
      indexMap.push(i);
      previousWasWhitespace = false;
    }
  }

  while (normalizedChars.length > 0 && normalizedChars[0] === ' ') {
    normalizedChars.shift();
    indexMap.shift();
  }
  while (normalizedChars.length > 0 && normalizedChars[normalizedChars.length - 1] === ' ') {
    normalizedChars.pop();
    indexMap.pop();
  }

  return {
    normalized: normalizedChars.join(''),
    indexMap,
  };
}

function findNearestMatchIndex(haystack, needle, targetIndex) {
  if (!needle || !haystack) return -1;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let searchFrom = 0;

  while (searchFrom <= haystack.length) {
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx === -1) break;
    const distance = Math.abs(idx - targetIndex);
    if (distance < bestDistance) {
      bestIndex = idx;
      bestDistance = distance;
    }
    searchFrom = idx + 1;
  }

  return bestIndex;
}

function expandRangeToWordBoundaries(text, start, end) {
  const maxBoundaryExpansion = 24;
  let safeStart = Math.max(0, Math.min(start, text.length));
  let safeEnd = Math.max(safeStart + 1, Math.min(end, text.length));

  let leftExpanded = 0;
  while (
    safeStart > 0 &&
    leftExpanded < maxBoundaryExpansion &&
    /\S/.test(text[safeStart - 1]) &&
    /\S/.test(text[safeStart])
  ) {
    safeStart--;
    leftExpanded++;
  }

  let rightExpanded = 0;
  while (
    safeEnd < text.length &&
    rightExpanded < maxBoundaryExpansion &&
    /\S/.test(text[safeEnd - 1]) &&
    /\S/.test(text[safeEnd])
  ) {
    safeEnd++;
    rightExpanded++;
  }

  return { start: safeStart, end: safeEnd };
}

function resolveNoteHighlightRange(plainPageText, anchorInPage, sourceText) {
  if (!plainPageText || !sourceText) return null;

  const pageLength = plainPageText.length;
  if (pageLength <= 0) return null;

  const anchor = Math.max(0, Math.min(anchorInPage, pageLength - 1));
  const expectedLen = Math.max(1, sourceText.length);
  const searchRadius = Math.max(240, Math.min(2200, expectedLen * 4));
  const windowStart = Math.max(0, anchor - searchRadius);
  const windowEnd = Math.min(pageLength, anchor + expectedLen + searchRadius);
  const windowText = plainPageText.substring(windowStart, windowEnd);

  const exactMatchInWindow = findNearestMatchIndex(
    windowText,
    sourceText,
    Math.max(0, anchor - windowStart)
  );
  if (exactMatchInWindow !== -1) {
    const exactStart = windowStart + exactMatchInWindow;
    return {
      start: exactStart,
      end: Math.min(pageLength, exactStart + sourceText.length),
      strategy: 'exact',
    };
  }

  const normalizedWindow = normalizeWhitespaceWithIndexMap(windowText);
  const normalizedNeedle = normalizeWhitespaceWithIndexMap(sourceText);
  if (normalizedWindow.normalized && normalizedNeedle.normalized) {
    const estimatedNormalizedAnchor = normalizeWhitespaceWithIndexMap(
      windowText.substring(0, Math.max(0, anchor - windowStart))
    ).normalized.length;
    const normalizedMatchIndex = findNearestMatchIndex(
      normalizedWindow.normalized,
      normalizedNeedle.normalized,
      estimatedNormalizedAnchor
    );

    if (normalizedMatchIndex !== -1) {
      const normalizedMatchEnd = normalizedMatchIndex + normalizedNeedle.normalized.length - 1;
      const localStart = normalizedWindow.indexMap[normalizedMatchIndex];
      const localEndChar = normalizedWindow.indexMap[normalizedMatchEnd];
      if (
        typeof localStart === 'number' &&
        typeof localEndChar === 'number'
      ) {
        const normalizedRange = expandRangeToWordBoundaries(
          plainPageText,
          windowStart + localStart,
          windowStart + localEndChar + 1
        );
        return {
          ...normalizedRange,
          strategy: 'normalized',
        };
      }
    }
  }

  const minGenerousLen = Math.max(28, Math.min(260, Math.round(expectedLen * 1.4)));
  const generousStart = Math.max(0, anchor - 8);
  const generousEnd = Math.min(pageLength, generousStart + minGenerousLen);
  const expandedFallback = expandRangeToWordBoundaries(plainPageText, generousStart, generousEnd);

  return {
    ...expandedFallback,
    strategy: 'fallback',
  };
}

// Helper function to calculate page boundaries respecting word breaks
function calculatePageBoundaries(markdown, targetCharsPerPage) {
  if (!markdown || typeof markdown !== 'string') { // Added type check for markdown
    logger.warn("[calculatePageBoundaries] Markdown content is invalid or empty.");
    return [];
  }
  const boundaries = [];
  let currentOffset = 0;
  const totalLength = markdown.length;
  // Heuristic: Don't let pages become too small if a word break is found very early.
  // This means a page might be slightly larger than targetCharsPerPage if it prevents a tiny next page.
  const MIN_PAGE_CHARS = targetCharsPerPage * 0.5; // Page should be at least 50% of target

  const adjustBoundarySafely = (pageStart, proposedEnd) => {
    let safeEnd = proposedEnd;
    const segment = markdown.substring(pageStart, safeEnd);

    // Avoid splitting in the middle of fenced code blocks.
    const fenceMatches = segment.match(/```/g);
    const fenceCount = fenceMatches ? fenceMatches.length : 0;
    if (fenceCount % 2 === 1) {
      const nextFence = markdown.indexOf("```", safeEnd);
      if (nextFence !== -1 && nextFence - safeEnd <= targetCharsPerPage * 0.6) {
        const nextNewline = markdown.indexOf("\n", nextFence + 3);
        safeEnd = nextNewline !== -1 ? nextNewline + 1 : Math.min(nextFence + 3, totalLength);
      } else {
        const lastFence = segment.lastIndexOf("```");
        if (lastFence > 0) {
          safeEnd = pageStart + lastFence;
        }
      }
    }

    // Avoid splitting within an HTML tag.
    const tail = markdown.substring(pageStart, safeEnd);
    const lastOpen = tail.lastIndexOf("<");
    const lastClose = tail.lastIndexOf(">");
    if (lastOpen > lastClose) {
      safeEnd = pageStart + lastOpen;
    }

    // Keep the adjusted page from being too tiny.
    if (safeEnd - pageStart < MIN_PAGE_CHARS && proposedEnd - pageStart >= MIN_PAGE_CHARS) {
      safeEnd = proposedEnd;
    }
    return Math.max(pageStart + 1, Math.min(totalLength, safeEnd));
  };

  while (currentOffset < totalLength) {
    const pageStart = currentOffset;
    let potentialEnd = Math.min(pageStart + targetCharsPerPage, totalLength);
    let actualEnd = potentialEnd;

    if (potentialEnd < totalLength) { // If not the last character of the document
      let boundaryFound = false;
      // Search backwards from potentialEnd for a natural break (space)
      for (let i = potentialEnd; i > pageStart; i--) {
        if (/\s/.test(markdown[i-1])) { // Check character *before* potential cut point
          actualEnd = i; // End *before* the space if cutting, or *at* the space if space is end of word
          boundaryFound = true;
          break;
        }
      }

      if (!boundaryFound) {
        // No space found searching backwards. This means pageStart to potentialEnd is one long token.
        // Try to find the *next* space *after* potentialEnd, but not too far.
        let nextSpaceSearchLimit = Math.min(potentialEnd + targetCharsPerPage * 0.25, totalLength); // Search forward a bit
        let foundNextSpace = false;
        for (let i = potentialEnd; i < nextSpaceSearchLimit; i++) {
          if (/\s/.test(markdown[i])) {
            actualEnd = i + 1; // End after this space
            foundNextSpace = true;
            break;
          }
        }
        // If still no space found (very long word/URL), we have to take potentialEnd.
        // This might break the word if it's longer than targetCharsPerPage.
        if (!foundNextSpace) {
          actualEnd = potentialEnd; 
        }
      }
      
      // If the found boundary makes the current page too short, and it's not the end of the document,
      // prefer to take the original potentialEnd or even extend a bit if that helps the next page.
      // This logic can get very complex. A simpler rule: if actualEnd is too close to pageStart,
      // and we are not near the end of the document, just use potentialEnd.
      if ((actualEnd - pageStart) < MIN_PAGE_CHARS && (totalLength - pageStart) > targetCharsPerPage) {
         actualEnd = potentialEnd;
      }
    }
    
    // Prevent infinite loop if actualEnd doesn't advance
    if (actualEnd <= pageStart && pageStart < totalLength) {
        logger.warn(`[calculatePageBoundaries] actualEnd (${actualEnd}) did not advance from pageStart (${pageStart}). Forcing advance.`);
        actualEnd = Math.min(pageStart + targetCharsPerPage, totalLength);
    }
    
    // Ensure actualEnd does not exceed totalLength
    actualEnd = Math.min(actualEnd, totalLength);

    actualEnd = adjustBoundarySafely(pageStart, actualEnd);
    boundaries.push({ start: pageStart, end: actualEnd });
    currentOffset = actualEnd;

    if (boundaries.length > 10000) { // Safety break for very large documents / potential infinite loops
        logger.error("[calculatePageBoundaries] Exceeded 10000 page boundaries, breaking loop. Check content or logic.");
        break;
    }
  }
  logger.info(`[calculatePageBoundaries] Calculated ${boundaries.length} pages.`);
  return boundaries;
}

function BookView({
  setNavBarExtra = null,
  navBarActiveScrollRef = null,
  bumpNavBarScrollSync = null,
  mobileChromeHidden = false,
} = {}) {
  const { bookId } = useParams();
  const [bookData, setBookData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Refs for the scrollable container divs
  const bookPaneContainerRef = useRef(null);
  const isProgrammaticScroll = useRef(false);
  const [fullMarkdownContent, setFullMarkdownContent] = useState(''); // To store the full markdown as state

  const [selectedBookText, setSelectedBookText] = useState(null);
  const [selectedScrollPercentage, setSelectedScrollPercentage] = useState(null);
  const [selectedGlobalCharOffset, setSelectedGlobalCharOffset] = useState(null);

  const [currentPage, setCurrentPage] = useState(() => {
    const savedPosition = getStoredReadingPosition(bookId);
    if (savedPosition && typeof savedPosition.page === 'number') {
      logger.info(`[BookView - useState init] Initializing currentPage from localStorage: ${savedPosition.page}`);
      return savedPosition.page;
    }
    return 1;
  });
  const [totalPages, setTotalPages] = useState(1);
  const [currentPageContent, setCurrentPageContent] = useState(''); // Original content for logic
  const [highlightedPageContent, setHighlightedPageContent] = useState(''); // Content with highlights for rendering
  const [pageInput, setPageInput] = useState('');
  const [pageBoundaries, setPageBoundaries] = useState([]);
  const pageBoundariesRef = useRef([]);

  const [scrollToGlobalOffset, setScrollToGlobalOffset] = useState(null);
  const [pendingScrollOffsetInPage, setPendingScrollOffsetInPage] = useState(null);

  const [notes, setNotes] = useState([]); // State to store notes for the current book

  // Ref for the temporary highlight span used for scrolling to a note
  const scrollTargetHighlightRef = useRef(null);

  // State for Add Bookmark Modal
  const [showAddBookmarkModal, setShowAddBookmarkModal] = useState(false);
  const [showAllNotesModal, setShowAllNotesModal] = useState(false);
  const [activeNoteForModal, setActiveNoteForModal] = useState(null);
  const [newBookmarkName, setNewBookmarkName] = useState('');
  const [bookmarkError, setBookmarkError] = useState(null);
  const [bookmarks, setBookmarks] = useState([]); 
  const [pendingScrollToPercentage, setPendingScrollToPercentage] = useState(null); // New state for bookmark jump

  // State and Refs for Resizing (guide pane only; note pane is now popup)
  const bookViewContainerRef = useRef(null); // Ref for the main flex container
  const bookPaneAreaRef = useRef(null);      // Ref for the book-pane-area div

  const isResizingGuideMainActive = useRef(false); // For Guide Pane vs Main Content Area
  const dragStartX = useRef(0);

  const [showManageBookmarksModal, setShowManageBookmarksModal] = useState(false);
  const [notesLLMPopupMode, setNotesLLMPopupMode] = useState(null); // null | 'note' | 'llm'
  const [isMobileView, setIsMobileView] = useState(window.innerWidth <= 768);
  const [isBookmarkMenuOpen, setIsBookmarkMenuOpen] = useState(false);
  const bookmarkMenuRef = useRef(null); // For detecting clicks outside
  const [initialScrollTop, setInitialScrollTop] = useState(null); // For restoring scroll position

  // Close dropdown menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      const t = event.target;
      const inBookMenu =
        (bookViewMenuRef.current && bookViewMenuRef.current.contains(t)) ||
        (bookViewMenuPortalRef.current && bookViewMenuPortalRef.current.contains(t));
      if (!inBookMenu) {
        setIsBookViewMenuOpen(false);
      }
      if (bookmarkMenuRef.current && !bookmarkMenuRef.current.contains(t)) {
        setIsBookmarkMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // View mode: 'guide' = reading guide as main content, 'original' = original text as main content
  const [viewMode, setViewMode] = useState(() => getStoredReadingViewMode(bookId));

  // Show floating "Back to Reading Guide" when user navigated from guide via "View in original text"
  const [showBackToGuide, setShowBackToGuide] = useState(false);
  const [showScrollToTopButton, setShowScrollToTopButton] = useState(false);
  const navigatingFromGuideTextLinkRef = useRef(false);
  // Roadmap card id to scroll back to after "View in original text" → "Back to Reading Guide"
  const [guideReturnItemId, setGuideReturnItemId] = useState(null);

  // Guide scroll to restore when clicking "Back to Reading Guide" (saved when leaving via "View in original text")
  const [guideScrollToRestoreOnBack, setGuideScrollToRestoreOnBack] = useState(null);

  // Remember guide scroll position per page so we can restore when returning or changing page
  const [guideScrollPositionByPage, setGuideScrollPositionByPage] = useState({});
  const guideScrollContainerRef = useRef(null);
  const lastScrollToTopPageRef = useRef(null); // Only scroll book pane to top when page actually changed (not when only notes changed)
  const skipBookScrollRestoreOnPageChangeRef = useRef(false);
  const explicitPaginationInFlightRef = useRef(false);
  const explicitPaginationTargetPageRef = useRef(null);
  /** Bumped on explicit pagination so delayed scroll helpers (e.g. guide highlight) do not run stale timeouts. */
  const bookPaneScrollEpochRef = useRef(0);
  // Remember book (original) pane scroll per page when switching to guide so we can restore when switching back
  const [bookScrollPositionByPage, setBookScrollPositionByPage] = useState({});

  const getTrackedScrollContainers = useCallback(() => {
    const outer = bookPaneContainerRef.current;
    const inner = guideScrollContainerRef.current;
    if (viewMode === 'guide') {
      const active = inner || outer;
      return { outer, inner, active, containers: active ? [active] : [] };
    }
    return { outer, inner: null, active: outer, containers: outer ? [outer] : [] };
  }, [viewMode]);

  const getEffectiveScrollState = useCallback(() => {
    const { active, containers } = getTrackedScrollContainers();
    if (!active || containers.length === 0) {
      return null;
    }
    const top = active.scrollTop || 0;
    const maxScroll = Math.max(0, (active.scrollHeight || 0) - (active.clientHeight || 0));
    return { top, maxScroll, active, containers };
  }, [getTrackedScrollContainers]);

  const updateScrollToTopVisibility = useCallback(() => {
    const state = getEffectiveScrollState();
    const winY =
      typeof window !== 'undefined'
        ? window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
        : 0;
    const winMax =
      typeof window !== 'undefined'
        ? Math.max(
            0,
            Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
            ) - window.innerHeight,
          )
        : 0;
    const top = Math.max(state?.top ?? 0, winY);
    const maxScroll = Math.max(state?.maxScroll ?? 0, winMax);
    if (!state && maxScroll <= 0) {
      setShowScrollToTopButton(false);
      return;
    }
    setShowScrollToTopButton(maxScroll > 0 && top > SCROLL_TOP_REVEAL_PX);
  }, [getEffectiveScrollState]);

  const handleScrollToTop = useCallback(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = prefersReducedMotion ? 'auto' : 'smooth';
    const state = getEffectiveScrollState();
    if (state) {
      state.containers.forEach((el) => el.scrollTo({ top: 0, behavior }));
    }
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior });
    }
  }, [getEffectiveScrollState]);

  // Whole-book reading roadmap state
  const [readingRoadmap, setReadingRoadmap] = useState(null);
  const [guidesList, setGuidesList] = useState([]);
  const [activeGuideId, setActiveGuideId] = useState(DEFAULT_GUIDE_ID);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideError, setGuideError] = useState(null);
  const [hasRoadmap, setHasRoadmap] = useState(false);
  const [isGeneratingGuide, setIsGeneratingGuide] = useState(false);
  const [completedRoadmapIds, setCompletedRoadmapIds] = useState([]);
  const [graphLoadingById, setGraphLoadingById] = useState({});
  const [alternativeLoadingById, setAlternativeLoadingById] = useState({});
  const [outsiderLoadingById, setOutsiderLoadingById] = useState({});
  /** null | 'graphs' | 'shortcuts' | 'outsiders' — sequential bulk generation for roadmap cards */
  const [roadmapBulkJob, setRoadmapBulkJob] = useState(null);

  const [isOfflineSnapshot, setIsOfflineSnapshot] = useState(false);
  const [outboxPendingCount, setOutboxPendingCount] = useState(0);
  const [netOnline, setNetOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const blobUrlRegistryRef = useRef(new Set());

  const serverOffline = !netOnline || isOfflineSnapshot;

  const guideApiPath = useCallback(
    (suffix = '') => {
      const base = `/api/books/${bookId}/reading-guides/${encodeURIComponent(activeGuideId)}`;
      return suffix ? `${base}${suffix}` : base;
    },
    [bookId, activeGuideId],
  );

  const registerBlobUrl = useCallback((url) => {
    if (url && url.startsWith('blob:')) {
      blobUrlRegistryRef.current.add(url);
    }
  }, []);

  const refreshOutboxCount = useCallback(async () => {
    try {
      const n = await getOutboxCount();
      setOutboxPendingCount(n);
    } catch (_e) {
      setOutboxPendingCount(0);
    }
  }, []);

  // --- State for Reading Guide Search/Highlight ---
  const [guideSearchText, setGuideSearchText] = useState(null); // Text to search and highlight from reading guide
  const [guideSearchGlobalOffset, setGuideSearchGlobalOffset] = useState(null); // Stable offset target for guide highlight fallback
  const [guideSearchEndOffset, setGuideSearchEndOffset] = useState(null); // Stable end offset for exact quote highlight
  const [guideSegmentCutoffOffset, setGuideSegmentCutoffOffset] = useState(null); // Segment boundary marker in original text
  const guideSearchHighlightRef = useRef(null); // Ref for the highlighted element to scroll to
  // --- END State for Reading Guide Search/Highlight ---

  // State and Refs for Reading Guide Pane Resizing
  const [readingGuidePaneFlexBasis, setReadingGuidePaneFlexBasis] = useState('25%'); // Initial width

  // --- Font Control State (moved from BookPane) ---
  const [fontSize, setFontSize] = useState(16);
  const [lineHeight, setLineHeight] = useState(1.6);
  const FONT_SIZE_STEP = 1;
  const MIN_FONT_SIZE = 10;
  const MAX_FONT_SIZE = 32;
  const LINE_HEIGHT_STEP = 0.1;
  const MIN_LINE_HEIGHT = 1.2;
  const MAX_LINE_HEIGHT = 2.5;

  const increaseFontSize = () => {
    setFontSize(prevSize => Math.min(prevSize + FONT_SIZE_STEP, MAX_FONT_SIZE));
  };

  const decreaseFontSize = () => {
    setFontSize(prevSize => Math.max(prevSize - FONT_SIZE_STEP, MIN_FONT_SIZE));
  };

  const increaseLineHeight = () => {
    setLineHeight(prevHeight => parseFloat(Math.min(prevHeight + LINE_HEIGHT_STEP, MAX_LINE_HEIGHT).toFixed(2)));
  };

  const decreaseLineHeight = () => {
    setLineHeight(prevHeight => parseFloat(Math.max(prevHeight - LINE_HEIGHT_STEP, MIN_LINE_HEIGHT).toFixed(2)));
  };
  // --- END Font Control State ---

  const clearGuideDrivenScrollState = useCallback(() => {
    setGuideSearchText(null);
    setGuideSearchGlobalOffset(null);
    setGuideSearchEndOffset(null);
    setGuideSegmentCutoffOffset(null);
    setPendingScrollOffsetInPage(null);
    setPendingScrollToPercentage(null);
    setScrollToGlobalOffset(null);
  }, []);

  const beginExplicitPagination = useCallback((targetPage) => {
    bookPaneScrollEpochRef.current += 1;
    explicitPaginationInFlightRef.current = true;
    explicitPaginationTargetPageRef.current = targetPage;
    // Reset stale page marker so explicit pagination always re-applies top scroll.
    lastScrollToTopPageRef.current = null;
    // Prevent stale initial-position restore from overriding explicit page-top intent.
    setInitialScrollTop(null);
    // Explicit pagination should always land from the beginning of the target page.
    setGuideScrollToRestoreOnBack(null);
    setGuideScrollPositionByPage((prev) => ({ ...prev, [targetPage]: 0 }));
    setBookScrollPositionByPage((prev) => ({ ...prev, [targetPage]: 0 }));
    skipBookScrollRestoreOnPageChangeRef.current = true;
    navigatingFromGuideTextLinkRef.current = false;
    clearGuideDrivenScrollState();
  }, [clearGuideDrivenScrollState]);

  // --- Dropdown Menu State ---
  const [isBookViewMenuOpen, setIsBookViewMenuOpen] = useState(false);
  const bookViewMenuRef = useRef(null);
  const bookViewMenuButtonRef = useRef(null);
  const bookViewMenuPortalRef = useRef(null);
  const [bookViewMenuPopperStyle, setBookViewMenuPopperStyle] = useState(null);
  // --- END Dropdown Menu State ---

  const [bookControlsExpanded, setBookControlsExpanded] = useState(() => readStoredBookControlsExpanded());
  const setBookControlsExpandedPersist = useCallback((next) => {
    setBookControlsExpanded(next);
    try {
      window.sessionStorage.setItem(BOOK_CONTROLS_EXPANDED_KEY, next ? '1' : '0');
    } catch (_e) {
      /* ignore */
    }
  }, []);

  /** Viewport frame of the book pane area — used to float toolbar / callout above inner scrollers */
  const bookToolbarWrapperRef = useRef(null);
  const [bookPaneAreaFrame, setBookPaneAreaFrame] = useState(null);

  const handleRoadmapReturnFocusDone = useCallback(() => {
    setGuideReturnItemId(null);
  }, []);
  const readingGuidePaneAreaRef = useRef(null); // Ref for the reading-guide-pane-area div
  const initialReadingGuidePaneWidthPx = useRef(0);
  // dragStartX is already defined and can be reused if we ensure no overlap in active resizing
  // isResizing is also already defined, might need a separate one or careful management

  // --- NEW State for Content Reformatting ---
  const [isReformatting, setIsReformatting] = useState(false);
  const [reformatError, setReformatError] = useState(null);
  // --- END NEW State for Content Reformatting ---
  const isInitialMount = useRef(true);

  useLayoutEffect(() => {
    if (!bookPaneAreaRef.current || loading || !bookData) {
      setBookPaneAreaFrame(null);
      return undefined;
    }

    const area = bookPaneAreaRef.current;

    const updateLayout = () => {
      const r = area.getBoundingClientRect();
      const nextFrame = { left: r.left, width: r.width };
      setBookPaneAreaFrame((prev) => {
        if (
          prev &&
          prev.left === nextFrame.left &&
          prev.width === nextFrame.width
        ) {
          return prev;
        }
        return nextFrame;
      });
    };

    updateLayout();

    const roArea = new ResizeObserver(updateLayout);
    roArea.observe(area);

    let roToolbar = null;
    if (bookControlsExpanded && bookToolbarWrapperRef.current) {
      roToolbar = new ResizeObserver(updateLayout);
      roToolbar.observe(bookToolbarWrapperRef.current);
    }

    const onWin = () => updateLayout();
    window.addEventListener('resize', onWin);

    return () => {
      roArea.disconnect();
      if (roToolbar) roToolbar.disconnect();
      window.removeEventListener('resize', onWin);
    };
  }, [loading, bookData, bookControlsExpanded, viewMode]);

  useLayoutEffect(() => {
    if (!isBookViewMenuOpen) {
      setBookViewMenuPopperStyle(null);
      return undefined;
    }
    const btn = bookViewMenuButtonRef.current;
    if (!btn) {
      setBookViewMenuPopperStyle(null);
      return undefined;
    }
    const margin = 8;
    const update = () => {
      const r = btn.getBoundingClientRect();
      const gap = 4;
      const minW = Math.max(220, r.width);
      let left = r.left;
      if (left + minW > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - minW - margin);
      }
      const maxH = Math.max(120, window.innerHeight - r.bottom - gap - margin);
      setBookViewMenuPopperStyle({
        position: 'fixed',
        top: r.bottom + gap,
        left,
        minWidth: minW,
        maxHeight: maxH,
        overflowY: 'auto',
        zIndex: 10050,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [isBookViewMenuOpen, bookControlsExpanded, viewMode, bookPaneAreaFrame]);

  const applyBookPayload = useCallback((data, markdownOverride) => {
    const md = markdownOverride !== undefined ? markdownOverride : (data?.markdown_content || '');
    setBookData(data);
    if (data && md) {
      setFullMarkdownContent(md);
      const calculatedBoundaries = calculatePageBoundaries(md, APPROX_CHARS_PER_PAGE);
      setPageBoundaries(calculatedBoundaries);
      pageBoundariesRef.current = calculatedBoundaries;
      const numPages = Math.max(1, calculatedBoundaries.length);
      setTotalPages(numPages);
      const savedPosition = getStoredReadingPosition(bookId);
      setCurrentPage((cp) => {
        let next = cp > numPages ? 1 : cp;
        if (cp > numPages) {
          logger.warn(`[BookView - applyBookPayload] Page ${cp} out of bounds (${numPages}). Resetting to 1.`);
        }
        if (savedPosition && savedPosition.page === next && typeof savedPosition.scrollTop === 'number') {
          setInitialScrollTop(savedPosition.scrollTop);
        }
        return next;
      });
    } else {
      setFullMarkdownContent('');
      setPageBoundaries([]);
      pageBoundariesRef.current = [];
      setTotalPages(1);
    }
  }, [bookId]);

  const fetchBook = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = getStoredAuthToken();
      if (!token) {
        setError("Authentication token not found. Please log in.");
        setLoading(false);
        return;
      }
      const response = await fetch(`/api/books/${bookId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 401) {
          setError("Not authenticated. Please log in again.");
        } else if (response.status === 404) {
          setBookData(null);
          setLoading(false);
          return;
        }
        throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || response.statusText}`);
      }
      const data = await response.json();
      applyBookPayload(data, data.markdown_content);
      setIsOfflineSnapshot(false);
      try {
        await putBookMeta(bookId, { bookData: data, markdownContent: data.markdown_content || '' });
        if (data.markdown_content) {
          await prefetchMarkdownImages(bookId, data.markdown_content);
        }
      } catch (cacheErr) {
        logger.warn('[BookView - fetchBook] Cache persist failed:', cacheErr);
      }
    } catch (err) {
      logger.error('Failed to fetch book:', err);
      const tryCache =
        !navigator.onLine ||
        err.name === 'TypeError' ||
        (err.message && String(err.message).includes('Failed to fetch'));
      if (tryCache) {
        try {
          const meta = await getBookMeta(bookId);
          if (meta && meta.bookData && meta.markdownContent) {
            let md = meta.markdownContent;
            md = await rewriteMarkdownWithCachedImages(bookId, md, registerBlobUrl);
            applyBookPayload(meta.bookData, md);
            setIsOfflineSnapshot(true);
            setError(null);
          } else {
            if (!navigator.onLine) {
              setError('Offline and no cached copy found for this book yet. Reconnect once and open this book to enable offline reading.');
            } else {
              setError(`Failed to load book: ${err.message || 'Unknown error'}. No cached copy is available for fallback.`);
            }
            setBookData(null);
            setFullMarkdownContent('');
          }
        } catch (cacheErr) {
          logger.error('[BookView - fetchBook] Cache load failed:', cacheErr);
          if (!navigator.onLine) {
            setError('Offline and failed to read this book from local cache. Reconnect and reopen to refresh the offline copy.');
          } else {
            setError(`Failed to load book: ${err.message || 'Unknown error'}`);
          }
          setBookData(null);
          setFullMarkdownContent('');
        }
      } else {
        setError(`Failed to load book: ${err.message || 'Unknown error'}`);
        setBookData(null);
        setFullMarkdownContent('');
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchBookmarks = async () => {
    if (!bookId) return;
    try {
      const token = getStoredAuthToken();
      if (!token) {
        // setError("Authentication token not found for fetching bookmarks. Please log in."); // Or handle silently
        logger.warn("[BookView - fetchBookmarks] Auth token not found.");
        setBookmarks([]); // Clear bookmarks if not authenticated
        return;
      }
      const response = await fetch(`/api/bookmarks/book/${bookId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 401) {
          logger.warn("[BookView - fetchBookmarks] Not authenticated to fetch bookmarks.");
          setBookmarks([]);
        } else {
          throw new Error(`Failed to fetch bookmarks: ${errorData.detail || response.statusText}`);
        }
        return; // Stop further processing if not ok
      }
      let bookmarksData = await response.json();
      logger.info("Raw bookmarks data from API:", JSON.stringify(bookmarksData, null, 2)); // Log raw data

      // Ensure each bookmark object has an 'id' property.
      // Pydantic's `alias="_id"` for the `id` field in the `Bookmark` model
      // should mean that FastAPI returns "id" in the JSON.
      // However, if it's returning "_id" and not "id", we map it here.
      const processedBookmarks = bookmarksData.map(bookmark => {
        if (bookmark._id && !bookmark.id) { // If _id exists but id does not
          logger.warn(`[BookView - fetchBookmarks] Mapping _id to id for bookmark: ${bookmark._id}`);
          return { ...bookmark, id: String(bookmark._id) }; // Ensure id is a string
        }
        // If bookmark.id already exists, ensure it's a string (it should be from Pydantic)
        if (bookmark.id && typeof bookmark.id !== 'string') {
          logger.warn(`[BookView - fetchBookmarks] bookmark.id was not a string, converting: ${bookmark.id}`);
          return { ...bookmark, id: String(bookmark.id) };
        }
        return bookmark;
      });

      processedBookmarks.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      try {
        const ann = await getAnnotations(bookId);
        const merged = mergeAnnotationsByTimestamp({
          localBookmarks: ann?.bookmarks || [],
          localNotes: ann?.notes || [],
          serverBookmarks: processedBookmarks,
          serverNotes: ann?.notes || [],
        });
        setBookmarks(merged.bookmarks);
        setNotes(merged.notes);
        await putAnnotations(bookId, merged);
        logger.info("Processed and reconciled bookmarks:", merged.bookmarks);
      } catch (_e) { /* ignore */ }

    } catch (err) {
      logger.error('Error fetching bookmarks:', err);
      try {
        const ann = await getAnnotations(bookId);
        if (ann && Array.isArray(ann.bookmarks)) {
          setBookmarks(ann.bookmarks);
        } else {
          setBookmarks([]);
        }
      } catch (_e) {
        setBookmarks([]);
      }
    }
  };

  const handleDeleteBookmark = async (bookmarkIdToDelete) => {
    if (!window.confirm("Are you sure you want to delete this bookmark?")) {
      return;
    }
    logger.info(`[BookView - handleDeleteBookmark] Attempting to delete bookmark ID: ${bookmarkIdToDelete}`);
    try {
      const token = getStoredAuthToken();
      if (!token) {
        alert("Authentication token not found. Please log in to delete bookmarks.");
        logger.warn("[BookView - handleDeleteBookmark] Auth token not found.");
        return;
      }

      if (!navigator.onLine || isOfflineSnapshot) {
        setBookmarks((prev) => prev.filter((b) => b.id !== bookmarkIdToDelete));
        try {
          const ann = await getAnnotations(bookId);
          const nextBm = (ann?.bookmarks || []).filter((b) => b.id !== bookmarkIdToDelete);
          await putAnnotations(bookId, { bookmarks: nextBm, notes: ann?.notes || [] });
          if (isLocalId(bookmarkIdToDelete)) {
            await removePendingCreateBookmark(bookmarkIdToDelete);
          } else {
            await addOutboxEntry({
              type: 'delete_bookmark',
              bookId,
              payload: { bookmarkId: bookmarkIdToDelete },
            });
          }
          await refreshOutboxCount();
        } catch (_e) { /* ignore */ }
        return;
      }

      const response = await fetch(`/api/bookmarks/${bookmarkIdToDelete}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        if (response.status === 401) {
          alert("Not authenticated to delete bookmark. Please log in again.");
        } else if (response.status === 404) {
          throw new Error(`Bookmark not found (ID: ${bookmarkIdToDelete}). It might have already been deleted.`);
        }
        const errorData = await response.json().catch(() => ({ detail: "Failed to delete bookmark. Server error." }));
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }
      setBookmarks(prevBookmarks => prevBookmarks.filter(bookmark => bookmark.id !== bookmarkIdToDelete));
      logger.info(`Bookmark with ID ${bookmarkIdToDelete} deleted successfully from UI.`);
    } catch (err) {
      logger.error('Error deleting bookmark:', err);
      alert(`Error deleting bookmark: ${err.message}`);
    }
  };

  useEffect(() => {
    if (bookId) {
      // Reset initialScrollTop when bookId changes, so it only applies once per book load
      setInitialScrollTop(null);
      setIsOfflineSnapshot(false);
      fetchBook(); // fetchBook now handles restoring page and setting initialScrollTop
      fetchBookmarks();
      // setCurrentPage(1); // This is now handled by the useState initializer
      // setPageInput('1'); // pageInput updates based on currentPage effect
      setReadingRoadmap(null);
      setGuideError(null);
      setHasRoadmap(false);
      setCompletedRoadmapIds([]);
    }
  }, [bookId]);

  useEffect(() => {
    return () => {
      blobUrlRegistryRef.current.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch (_e) {
          /* ignore */
        }
      });
      blobUrlRegistryRef.current.clear();
    };
  }, [bookId]);

  useEffect(() => {
    refreshOutboxCount();
  }, [bookId, refreshOutboxCount]);

  useEffect(() => {
    const sync = () => setNetOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  useEffect(() => {
    const run = async () => {
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        try {
          await flushOutbox();
          await refreshOutboxCount();
        } catch (_e) {
          /* ignore */
        }
      }
    };
    run();
  }, []);

  // Persist viewMode to localStorage when it changes
  useEffect(() => {
    if (bookId) {
      setStoredReadingViewMode(bookId, viewMode);
    }
  }, [bookId, viewMode]);

  // Restore viewMode from localStorage when bookId changes
  useEffect(() => {
    if (bookId) {
      setViewMode(getStoredReadingViewMode(bookId));
    }
  }, [bookId]);

  const loadActiveGuideData = useCallback(
    async (guideId, token, localCache) => {
      const localEntry = getGuideEntry(localCache, guideId);
      const [guideResp, progressResp] = await Promise.all([
        fetch(`/api/books/${bookId}/reading-guides/${encodeURIComponent(guideId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`/api/books/${bookId}/reading-guides/${encodeURIComponent(guideId)}/progress`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      let completedIds = localEntry?.completedIds || [];
      let progressTouchedAt = localEntry?.progressTouchedAt || {};
      if (progressResp.ok) {
        const progressData = await progressResp.json();
        const reconciledProgress = reconcileGuideProgressState({
          localCompletedIds: localEntry?.completedIds || [],
          localProgressTouchedAt: localEntry?.progressTouchedAt || {},
          serverCompletedIds: progressData.completed_ids || [],
        });
        completedIds = reconciledProgress.completedIds;
        progressTouchedAt = reconciledProgress.progressTouchedAt;
      }
      setCompletedRoadmapIds(completedIds);

      if (guideResp.ok) {
        const data = await guideResp.json();
        if (data === null) {
          setReadingRoadmap(null);
          setHasRoadmap(false);
          return;
        }
        try {
          await putGuide(bookId, {
            roadmap: data,
            completedIds,
            progressTouchedAt,
            guideId,
            activeGuideId: guideId,
          });
          await cacheRoadmapGraphImages(bookId, data);
        } catch (_e) { /* ignore */ }
        const hydrated = await hydrateRoadmapWithCachedGraphs(bookId, data, registerBlobUrl);
        setReadingRoadmap(hydrated);
        setHasRoadmap(!!(data && data.items && data.items.length > 0));
        setGuideError(null);
      } else if (guideResp.status === 404) {
        setReadingRoadmap(null);
        setHasRoadmap(false);
      } else {
        const e = await guideResp.json().catch(() => ({ detail: `HTTP ${guideResp.status}` }));
        throw new Error(e.detail || 'Failed to load roadmap');
      }
    },
    [bookId, registerBlobUrl],
  );

  const fetchReadingRoadmap = useCallback(async () => {
    if (!bookId) return;
    setGuideLoading(true);
    setGuideError(null);
    try {
      const token = getStoredAuthToken();
      if (!token) throw new Error('Authentication token not found.');

      const listResp = await fetch(`/api/books/${bookId}/reading-guides`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      let summaries = [];
      if (listResp.ok) {
        summaries = await listResp.json();
      }
      setGuidesList(summaries || []);

      const localGuide = await getGuide(bookId);
      let nextActiveId =
        localGuide?.activeGuideId ||
        summaries[0]?.guide_id ||
        DEFAULT_GUIDE_ID;
      if (summaries.length && !summaries.some((s) => s.guide_id === nextActiveId)) {
        nextActiveId = summaries[0].guide_id;
      }
      setActiveGuideId(nextActiveId);

      if (summaries.length) {
        try {
          await putGuide(bookId, { guidesList: summaries, activeGuideId: nextActiveId });
        } catch (_e) { /* ignore */ }
        await loadActiveGuideData(nextActiveId, token, localGuide);
      } else {
        setReadingRoadmap(null);
        setHasRoadmap(false);
        setCompletedRoadmapIds([]);
      }
    } catch (err) {
      logger.error('[BookView - fetchReadingRoadmap] Failed:', err);
      const tryCache =
        !navigator.onLine ||
        err.name === 'TypeError' ||
        (err.message && String(err.message).includes('Failed to fetch'));
      if (tryCache) {
        try {
          const g = await getGuide(bookId);
          const entry = getGuideEntry(g, g?.activeGuideId);
          if (entry?.roadmap) {
            const hydrated = await hydrateRoadmapWithCachedGraphs(bookId, entry.roadmap, registerBlobUrl);
            setReadingRoadmap(hydrated);
            setActiveGuideId(g.activeGuideId || DEFAULT_GUIDE_ID);
            setGuidesList(
              (g.guides || []).map((item) => ({
                guide_id: item.guideId,
                name: item.name,
                custom_requirements: item.custom_requirements,
                item_count: item.roadmap?.items?.length || 0,
              })),
            );
            setCompletedRoadmapIds(entry.completedIds || []);
            setHasRoadmap(!!(entry.roadmap.items && entry.roadmap.items.length > 0));
            setGuideError(null);
          } else {
            setGuideError(err.message);
            setReadingRoadmap(null);
            setHasRoadmap(false);
          }
        } catch (_e) {
          setGuideError(err.message);
          setReadingRoadmap(null);
          setHasRoadmap(false);
        }
      } else {
        setGuideError(err.message);
        setReadingRoadmap(null);
        setHasRoadmap(false);
      }
    } finally {
      setGuideLoading(false);
    }
  }, [bookId, registerBlobUrl, loadActiveGuideData]);

  useEffect(() => {
    const onOnline = async () => {
      try {
        await flushOutbox();
        await refreshOutboxCount();
        if (!bookId || !getStoredAuthToken()) return;
        const token = getStoredAuthToken();
        const [bookmarksRes, notesRes] = await Promise.all([
          fetch(`/api/bookmarks/book/${bookId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`/api/notes/${bookId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        if (bookmarksRes.ok && notesRes.ok) {
          const [bookmarksData, notesData] = await Promise.all([
            bookmarksRes.json(),
            notesRes.json(),
          ]);
          const ann = await getAnnotations(bookId);
          const merged = mergeAnnotationsByTimestamp({
            localBookmarks: ann?.bookmarks || [],
            localNotes: ann?.notes || [],
            serverBookmarks: bookmarksData || [],
            serverNotes: notesData || [],
          });
          setBookmarks(merged.bookmarks);
          setNotes(merged.notes);
          await putAnnotations(bookId, merged);
        } else {
          if (bookmarksRes.ok) fetchBookmarks();
          if (notesRes.ok) {
            const notesData = await notesRes.json();
            notesData.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            const ann = await getAnnotations(bookId);
            const merged = mergeAnnotationsByTimestamp({
              localBookmarks: ann?.bookmarks || [],
              localNotes: ann?.notes || [],
              serverBookmarks: ann?.bookmarks || [],
              serverNotes: notesData,
            });
            setBookmarks(merged.bookmarks);
            setNotes(merged.notes);
            await putAnnotations(bookId, merged);
          }
        }
        if (viewMode === 'guide') {
          fetchReadingRoadmap();
        }
      } catch (_e) {
        /* ignore */
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [bookId, fetchReadingRoadmap, viewMode]);

  // Function to refresh signed URLs in markdown content (must be defined before handleGuideTextLink)
  const refreshImageUrls = useCallback(async () => {
    if (!bookId) return;
    if (isOfflineSnapshot || !navigator.onLine) return;
    try {
      const token = getStoredAuthToken();
      if (!token) {
        logger.warn("[BookView - refreshImageUrls] Auth token not found.");
        return;
      }
      const response = await fetch(`/api/books/${bookId}/refresh-image-urls`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.markdown_content) {
          setFullMarkdownContent(data.markdown_content);
          logger.info("[BookView - refreshImageUrls] Refreshed signed URLs in markdown content");
        }
      } else {
        logger.warn("[BookView - refreshImageUrls] Failed to refresh URLs, continuing with existing content");
      }
    } catch (err) {
      logger.error("[BookView - refreshImageUrls] Error refreshing URLs:", err);
    }
  }, [bookId, isOfflineSnapshot]);

  const handleSwitchGuide = useCallback(
    async (guideId) => {
      if (!bookId || !guideId || guideId === activeGuideId) return;
      setActiveGuideId(guideId);
      setGuideLoading(true);
      setGuideError(null);
      try {
        const token = getStoredAuthToken();
        if (!token) throw new Error('Authentication token not found.');
        const localGuide = await getGuide(bookId);
        await putGuide(bookId, { activeGuideId: guideId });
        await loadActiveGuideData(guideId, token, localGuide);
      } catch (err) {
        logger.error('[BookView - handleSwitchGuide] Failed:', err);
        setGuideError(err.message);
      } finally {
        setGuideLoading(false);
      }
    },
    [bookId, activeGuideId, loadActiveGuideData],
  );

  const handleCreateGuide = async ({ name, custom_requirements: customRequirements }) => {
    if (!bookId) return;
    if (!navigator.onLine || isOfflineSnapshot) {
      setGuideError('Roadmap generation requires an internet connection.');
      return;
    }
    if (guidesList.length >= MAX_READING_GUIDES) {
      setGuideError(`You can have at most ${MAX_READING_GUIDES} reading guides per book.`);
      return;
    }
    setIsGeneratingGuide(true);
    setGuideError(null);
    try {
      const token = getStoredAuthToken();
      if (!token) throw new Error('Authentication token not found.');
      const response = await fetch(`/api/books/${bookId}/reading-guides`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: name || undefined,
          custom_requirements: customRequirements || undefined,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail);
      }
      await fetchReadingRoadmap();
    } catch (err) {
      logger.error('[BookView - handleCreateGuide] Failed:', err);
      setGuideError(err.message);
    } finally {
      setIsGeneratingGuide(false);
    }
  };

  const handleDeleteGuide = async (guideId) => {
    if (!bookId || !guideId) return;
    if (!navigator.onLine || isOfflineSnapshot) {
      setGuideError('Deleting a guide requires an internet connection.');
      return;
    }
    setGuideError(null);
    try {
      const token = getStoredAuthToken();
      if (!token) throw new Error('Authentication token not found.');
      const response = await fetch(
        `/api/books/${bookId}/reading-guides/${encodeURIComponent(guideId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok && response.status !== 204) {
        const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail);
      }
      await fetchReadingRoadmap();
    } catch (err) {
      logger.error('[BookView - handleDeleteGuide] Failed:', err);
      setGuideError(err.message);
    }
  };

  const handleGenerateRoadmap = async () => {
    if (!bookId) return;
    if (!navigator.onLine || isOfflineSnapshot) {
      setGuideError('Roadmap generation requires an internet connection.');
      return;
    }
    setIsGeneratingGuide(true);
    setGuideError(null);

    try {
      const token = getStoredAuthToken();
      if (!token) throw new Error('Authentication token not found.');

      const hasActive = guidesList.some((g) => g.guide_id === activeGuideId);
      const url = hasActive
        ? guideApiPath('/generate')
        : `/api/books/${bookId}/reading-guides`;
      const method = 'POST';
      const body = hasActive ? undefined : JSON.stringify({ name: 'Reading Roadmap' });

      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail);
      }
      await fetchReadingRoadmap();
    } catch (err) {
      logger.error('[BookView - handleGenerateRoadmap] Failed:', err);
      setGuideError(err.message);
    } finally {
      setIsGeneratingGuide(false);
    }
  };

  const handleToggleRoadmapProgress = async (itemId, completed) => {
    if (!bookId || !itemId) return;
    if (!navigator.onLine || isOfflineSnapshot) {
      try {
        const g = await getGuide(bookId);
        const entry = getGuideEntry(g, activeGuideId);
        const localProgress = applyLocalProgressToggle({
          completedIds: completedRoadmapIds,
          progressTouchedAt: entry?.progressTouchedAt || {},
          itemId,
          completed,
        });
        const nextIds = localProgress.completedIds;
        setCompletedRoadmapIds(nextIds);
        if (entry?.roadmap) {
          await putGuide(bookId, {
            roadmap: entry.roadmap,
            completedIds: nextIds,
            progressTouchedAt: localProgress.progressTouchedAt,
            guideId: activeGuideId,
            activeGuideId,
          });
        }
        await addOutboxEntry({
          type: 'roadmap_progress',
          bookId,
          payload: { item_id: itemId, completed, guide_id: activeGuideId },
        });
        await refreshOutboxCount();
      } catch (err) {
        logger.error("[BookView - handleToggleRoadmapProgress] Offline persist failed:", err);
      }
      return;
    }
    try {
      const token = getStoredAuthToken();
      if (!token) throw new Error("Authentication token not found.");
      const response = await fetch(guideApiPath('/progress'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ item_id: itemId, completed }),
      });
      if (!response.ok) return;
      const data = await response.json();
      const g = await getGuide(bookId);
      const entry = getGuideEntry(g, activeGuideId);
      const reconciledProgress = reconcileGuideProgressState({
        localCompletedIds: entry?.completedIds || [],
        localProgressTouchedAt: entry?.progressTouchedAt || {},
        serverCompletedIds: data.completed_ids || [],
      });
      setCompletedRoadmapIds(reconciledProgress.completedIds);
      try {
        if (entry?.roadmap) {
          await putGuide(bookId, {
            roadmap: entry.roadmap,
            completedIds: reconciledProgress.completedIds,
            progressTouchedAt: reconciledProgress.progressTouchedAt,
            guideId: activeGuideId,
            activeGuideId,
          });
        }
      } catch (_e) { /* ignore */ }
    } catch (err) {
      logger.error("[BookView - handleToggleRoadmapProgress] Failed:", err);
    }
  };

  const generateGraphForCard = useCallback(async (cardId, options = {}) => {
    const { surfaceError = true } = options;
    if (!bookId || !cardId) return false;
    if (!navigator.onLine || isOfflineSnapshot) {
      if (surfaceError) {
        setGuideError('Graph generation requires an internet connection.');
      }
      return false;
    }
    setGraphLoadingById((prev) => ({ ...prev, [cardId]: true }));
    try {
      const token = getStoredAuthToken();
      if (!token) throw new Error("Authentication token not found.");
      const response = await fetch(guideApiPath(`/cards/${encodeURIComponent(cardId)}/graph`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail || "Failed to generate graph");
      }
      const data = await response.json();
      const graphUrl = data.graph_image_url;
      if (graphUrl) {
        const setGraph = (nodes) => (nodes || []).map((n) => ({
          ...n,
          graph_image_url: n.id === cardId ? graphUrl : n.graph_image_url,
          children: setGraph(n.children),
        }));
        setReadingRoadmap((prev) => {
          if (!prev) return prev;
          const updated = { ...prev, items: setGraph(prev.items) };
          (async () => {
            try {
              const gSnap = await getGuide(bookId);
              await putGuide(bookId, {
                roadmap: updated,
                completedIds: getGuideEntry(gSnap, activeGuideId)?.completedIds ?? completedRoadmapIds,
                guideId: activeGuideId,
                activeGuideId,
              });
              await cacheRoadmapGraphImages(bookId, updated);
              const hydrated = await hydrateRoadmapWithCachedGraphs(bookId, updated, registerBlobUrl);
              setReadingRoadmap(hydrated);
            } catch (_e) { /* ignore */ }
          })();
          return updated;
        });
      }
      return true;
    } catch (err) {
      logger.error("[BookView - generateGraphForCard] Failed:", err);
      if (surfaceError) {
        setGuideError(err.message);
      }
      return false;
    } finally {
      setGraphLoadingById((prev) => ({ ...prev, [cardId]: false }));
    }
  }, [bookId, activeGuideId, isOfflineSnapshot, completedRoadmapIds, registerBlobUrl, guideApiPath]);

  const handleGenerateCardGraph = async (cardId) => {
    await generateGraphForCard(cardId, { surfaceError: true });
  };

  const updateRoadmapAlternativeReading = useCallback((cardId, data) => {
    const alternativeReading = data?.alternative_reading;
    const sourceWordCount = Number.isFinite(data?.source_word_count) ? data.source_word_count : null;
    const shortcutWordCount = Number.isFinite(data?.shortcut_word_count) ? data.shortcut_word_count : null;
    if (!(typeof alternativeReading === 'string' && alternativeReading.trim())) {
      return false;
    }

    const setAlternative = (nodes) => (nodes || []).map((n) => ({
      ...n,
      alternative_reading: n.id === cardId ? alternativeReading : n.alternative_reading,
      alternative_source_word_count: n.id === cardId ? sourceWordCount : n.alternative_source_word_count,
      alternative_word_count: n.id === cardId ? shortcutWordCount : n.alternative_word_count,
      children: setAlternative(n.children),
    }));

    setReadingRoadmap((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, items: setAlternative(prev.items) };
      (async () => {
        try {
          const gSnap = await getGuide(bookId);
          await putGuide(bookId, {
            roadmap: updated,
            completedIds: getGuideEntry(gSnap, activeGuideId)?.completedIds ?? completedRoadmapIds,
            guideId: activeGuideId,
            activeGuideId,
          });
        } catch (_e) { /* ignore */ }
      })();
      return updated;
    });
    return true;
  }, [bookId, activeGuideId, completedRoadmapIds]);

  const generateAlternativeReadingForCard = useCallback(async (cardId, options = {}) => {
    const { surfaceError = true } = options;
    if (!bookId || !cardId) return false;
    if (!navigator.onLine || isOfflineSnapshot) {
      if (surfaceError) {
        setGuideError('Author Shortcut generation requires an internet connection.');
      }
      return false;
    }

    setAlternativeLoadingById((prev) => ({ ...prev, [cardId]: true }));
    try {
      const token = getStoredAuthToken();
      if (!token) throw new Error("Authentication token not found.");
      const response = await fetch(guideApiPath(`/cards/${encodeURIComponent(cardId)}/alternative-reading`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail || "Failed to generate alternative reading");
      }

      const data = await response.json();
      return updateRoadmapAlternativeReading(cardId, data);
    } catch (err) {
      logger.error("[BookView - generateAlternativeReadingForCard] Failed:", err);
      if (surfaceError) {
        setGuideError(err.message);
      }
      return false;
    } finally {
      setAlternativeLoadingById((prev) => ({ ...prev, [cardId]: false }));
    }
  }, [bookId, isOfflineSnapshot, updateRoadmapAlternativeReading, guideApiPath]);

  const handleGenerateAlternativeReading = async (cardId) => {
    await generateAlternativeReadingForCard(cardId, { surfaceError: true });
  };

  const updateRoadmapOutsiderGuide = useCallback((cardId, data) => {
    const outsiderGuide = data?.outsider_guide;
    const sourceWordCount = Number.isFinite(data?.source_word_count) ? data.source_word_count : null;
    const outsiderWordCount = Number.isFinite(data?.outsider_word_count) ? data.outsider_word_count : null;
    if (!(typeof outsiderGuide === 'string' && outsiderGuide.trim())) {
      return false;
    }

    const setOutsiderGuide = (nodes) => (nodes || []).map((n) => ({
      ...n,
      outsider_guide: n.id === cardId ? outsiderGuide : n.outsider_guide,
      outsider_source_word_count: n.id === cardId ? sourceWordCount : n.outsider_source_word_count,
      outsider_word_count: n.id === cardId ? outsiderWordCount : n.outsider_word_count,
      children: setOutsiderGuide(n.children),
    }));

    setReadingRoadmap((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, items: setOutsiderGuide(prev.items) };
      (async () => {
        try {
          const gSnap = await getGuide(bookId);
          await putGuide(bookId, {
            roadmap: updated,
            completedIds: getGuideEntry(gSnap, activeGuideId)?.completedIds ?? completedRoadmapIds,
            guideId: activeGuideId,
            activeGuideId,
          });
        } catch (_e) { /* ignore */ }
      })();
      return updated;
    });
    return true;
  }, [bookId, activeGuideId, completedRoadmapIds]);

  const generateOutsiderGuideForCard = useCallback(async (cardId, options = {}) => {
    const { surfaceError = true } = options;
    if (!bookId || !cardId) return false;
    if (!navigator.onLine || isOfflineSnapshot) {
      if (surfaceError) {
        setGuideError('Outsider Guide generation requires an internet connection.');
      }
      return false;
    }

    setOutsiderLoadingById((prev) => ({ ...prev, [cardId]: true }));
    try {
      const token = getStoredAuthToken();
      if (!token) throw new Error("Authentication token not found.");
      const response = await fetch(guideApiPath(`/cards/${encodeURIComponent(cardId)}/outsider-guide`), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail || "Failed to generate outsider guide");
      }

      const data = await response.json();
      return updateRoadmapOutsiderGuide(cardId, data);
    } catch (err) {
      logger.error("[BookView - generateOutsiderGuideForCard] Failed:", err);
      if (surfaceError) {
        setGuideError(err.message);
      }
      return false;
    } finally {
      setOutsiderLoadingById((prev) => ({ ...prev, [cardId]: false }));
    }
  }, [bookId, isOfflineSnapshot, updateRoadmapOutsiderGuide, guideApiPath]);

  const handleSendCardChat = useCallback(
    async (cardId, message) => {
      if (!bookId || !cardId || !message?.trim()) return null;
      if (!navigator.onLine || isOfflineSnapshot) {
        throw new Error('Chat requires an internet connection.');
      }
      const token = getStoredAuthToken();
      if (!token) throw new Error('Authentication token not found.');
      const response = await fetch(guideApiPath(`/cards/${encodeURIComponent(cardId)}/chat`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: message.trim() }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail || 'Chat failed');
      }
      const data = await response.json();
      return data.messages || [];
    },
    [bookId, isOfflineSnapshot, guideApiPath],
  );

  const handleLoadCardChat = useCallback(
    async (cardId) => {
      if (!bookId || !cardId) return [];
      if (!navigator.onLine || isOfflineSnapshot) return [];
      const token = getStoredAuthToken();
      if (!token) return [];
      const response = await fetch(guideApiPath(`/cards/${encodeURIComponent(cardId)}/chat`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.messages || [];
    },
    [bookId, isOfflineSnapshot, guideApiPath],
  );

  const handleClearCardChat = useCallback(
    async (cardId) => {
      if (!bookId || !cardId) return;
      if (!navigator.onLine || isOfflineSnapshot) {
        throw new Error('Clearing chat requires an internet connection.');
      }
      const token = getStoredAuthToken();
      if (!token) throw new Error('Authentication token not found.');
      const response = await fetch(guideApiPath(`/cards/${encodeURIComponent(cardId)}/chat`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail || 'Failed to clear chat');
      }
    },
    [bookId, isOfflineSnapshot, guideApiPath],
  );

  const handleGenerateOutsiderGuide = async (cardId) => {
    await generateOutsiderGuideForCard(cardId, { surfaceError: true });
  };

  const collectRoadmapCardIds = (nodes) => {
    const ids = [];
    const walk = (list) => {
      for (const node of list || []) {
        if (node?.id != null) ids.push(node.id);
        if (Array.isArray(node?.children) && node.children.length > 0) {
          walk(node.children);
        }
      }
    };
    walk(nodes);
    return ids;
  };

  const handleBulkRoadmapGenerate = async (kind) => {
    if (kind !== 'graph' && kind !== 'shortcut' && kind !== 'outsider') return;
    if (!bookId || !readingRoadmap?.items?.length) return;

    const cardIds = collectRoadmapCardIds(readingRoadmap.items);
    if (!cardIds.length) return;

    const jobKey = kind === 'graph' ? 'graphs' : kind === 'shortcut' ? 'shortcuts' : 'outsiders';
    const offlineMessage =
      kind === 'graph'
        ? 'Graph generation requires an internet connection.'
        : kind === 'shortcut'
          ? 'Author Shortcut generation requires an internet connection.'
          : 'Outsider Guide generation requires an internet connection.';

    if (!navigator.onLine || isOfflineSnapshot) {
      setGuideError(offlineMessage);
      return;
    }

    setGuideError(null);
    setRoadmapBulkJob(jobKey);
    try {
      let failed = 0;
      if (kind === 'graph') {
        for (const cardId of cardIds) {
          const ok = await generateGraphForCard(cardId, { surfaceError: false });
          if (!ok) failed += 1;
        }
        if (failed > 0) {
          setGuideError(`Generated ${cardIds.length - failed}/${cardIds.length} graphs. ${failed} failed.`);
        }
      } else if (kind === 'shortcut') {
        for (const cardId of cardIds) {
          const ok = await generateAlternativeReadingForCard(cardId, { surfaceError: false });
          if (!ok) failed += 1;
        }
        if (failed > 0) {
          setGuideError(`Generated ${cardIds.length - failed}/${cardIds.length} shortcuts. ${failed} failed.`);
        }
      } else {
        for (const cardId of cardIds) {
          const ok = await generateOutsiderGuideForCard(cardId, { surfaceError: false });
          if (!ok) failed += 1;
        }
        if (failed > 0) {
          setGuideError(`Generated ${cardIds.length - failed}/${cardIds.length} outsider guides. ${failed} failed.`);
        }
      }
    } finally {
      setRoadmapBulkJob(null);
    }
  };

  // --- NEW: Handler for clicking a document structure item or guide section ---
  const handleStructureItemClick = (offset) => {
    logger.info(`[BookView - handleStructureItemClick] Clicked item with global offset: ${offset}`);
    if (offset === null || offset === undefined || isNaN(offset)) {
      logger.warn(`[BookView - handleStructureItemClick] Invalid offset provided: ${offset}`);
      return;
    }
    const globalOffset = parseInt(offset, 10);
    if (globalOffset < 0) {
      logger.warn(`[BookView - handleStructureItemClick] Negative offset provided: ${globalOffset}`);
      return;
    }
    if (fullMarkdownContent && globalOffset > fullMarkdownContent.length) {
      logger.warn(`[BookView - handleStructureItemClick] Offset ${globalOffset} exceeds document length ${fullMarkdownContent.length}`);
      return;
    }
    if (guideScrollContainerRef.current) setGuideScrollPositionByPage(prev => ({ ...prev, [currentPage]: guideScrollContainerRef.current.scrollTop }));
    setShowBackToGuide(true);
    setViewMode('original');
    setScrollToGlobalOffset(globalOffset);
  };
  // --- END NEW Handler ---

  // --- NEW: Enhanced handler for TextLink objects with smooth scrolling and highlighting ---
  const handleGuideTextLink = useCallback((textLink) => {
    if (!textLink || typeof textLink !== 'object') {
      logger.warn('[BookView - handleGuideTextLink] Invalid textLink provided');
      return;
    }

    const { start_offset, end_offset, preview_text, key_quote } = textLink;
    let navigationOffset = start_offset;

    // Some guide ranges begin at a chunk boundary that can include trailing text
    // from the previous sentence. Nudge navigation forward by one sentence when possible.
    if (fullMarkdownContent && typeof start_offset === 'number' && start_offset >= 0 && start_offset < fullMarkdownContent.length) {
      const lookahead = fullMarkdownContent.slice(start_offset, start_offset + 320);
      const sentenceBoundary = lookahead.match(/[.!?]\s+/);
      if (sentenceBoundary && typeof sentenceBoundary.index === 'number') {
        const candidateOffset = start_offset + sentenceBoundary.index + sentenceBoundary[0].length;
        if (candidateOffset > start_offset && candidateOffset < fullMarkdownContent.length) {
          navigationOffset = candidateOffset;
        }
      }
    }

    // Prefer quote highlight text first, then infer from source offset, then fall back to preview.
    let textToHighlight = key_quote ? String(key_quote).replace(/\s+/g, ' ').trim() : null;
    if (!textToHighlight && fullMarkdownContent && start_offset >= 0 && start_offset < fullMarkdownContent.length) {
      // Keep extraction bounded and normalize whitespace so regex search stays stable.
      const fromOffset = fullMarkdownContent.slice(start_offset, start_offset + 500);
      const firstSentenceMatch = fromOffset.match(/^[^.!?]*[.!?]?/);
      textToHighlight = firstSentenceMatch ? firstSentenceMatch[0].trim() : null;
      if (textToHighlight) {
        textToHighlight = textToHighlight.replace(/\s+/g, ' ').trim();
      }
    }
    if (!textToHighlight && preview_text) {
      const m = preview_text.trim().match(/^[^.!?]*[.!?]?/);
      textToHighlight = m ? m[0].trim() : preview_text.trim();
      textToHighlight = textToHighlight.replace(/\s+/g, ' ').trim();
    }
    if (textToHighlight) setGuideSearchText(textToHighlight);
    setGuideSearchGlobalOffset(
      typeof navigationOffset === 'number' && !isNaN(navigationOffset) ? navigationOffset : null
    );
    const hasUsableExactRange =
      typeof start_offset === 'number' &&
      !isNaN(start_offset) &&
      typeof end_offset === 'number' &&
      !isNaN(end_offset) &&
      end_offset > start_offset &&
      (end_offset - start_offset) <= 600;
    setGuideSearchEndOffset(hasUsableExactRange ? end_offset : null);
    const hasUsableCutoff =
      typeof end_offset === 'number' &&
      !isNaN(end_offset) &&
      typeof start_offset === 'number' &&
      !isNaN(start_offset) &&
      end_offset > start_offset;
    setGuideSegmentCutoffOffset(hasUsableCutoff ? end_offset : null);

    logger.info(`[BookView - handleGuideTextLink] Navigating to offset ${navigationOffset} (raw: ${start_offset}) with preview: "${preview_text?.substring(0, 50)}..."`);

    // 1. Navigate to correct page if needed
    if (pageBoundaries && pageBoundaries.length > 0) {
      const pageInfo = getPageForOffset(navigationOffset, pageBoundaries);

      if (pageInfo && pageInfo.pageNumber !== currentPage) {
        logger.info(`[BookView - handleGuideTextLink] Switching to page ${pageInfo.pageNumber} for offset ${navigationOffset}`);
        isProgrammaticScroll.current = true;
        setCurrentPage(pageInfo.pageNumber);
        refreshImageUrls();
        setPendingScrollOffsetInPage(pageInfo.offsetInPage);
        setScrollToGlobalOffset(navigationOffset);
        setTimeout(() => {
          isProgrammaticScroll.current = false;
        }, 300);
        return;
      }
    }

    // 2. Same page: scroll to exact offset
    if (navigationOffset != null && !isNaN(navigationOffset)) {
      setScrollToGlobalOffset(navigationOffset);
    }
  }, [currentPage, pageBoundaries, refreshImageUrls, fullMarkdownContent]);

  // Effect to fetch whole-book roadmap when entering guide mode
  useEffect(() => {
    if (bookId && viewMode === 'guide') {
      fetchReadingRoadmap();
    } else if (viewMode !== 'guide') {
      setGuideError(null);
    }
  }, [bookId, fetchReadingRoadmap, viewMode]);

  // Clear floating "Back to Guide" only when user manually navigates pages, NOT when page changed due to "View in original text"
  const prevPageRef = useRef(currentPage);
  useEffect(() => {
    if (navigatingFromGuideTextLinkRef.current) {
      navigatingFromGuideTextLinkRef.current = false;
      prevPageRef.current = currentPage;
      return;
    }
    if (prevPageRef.current !== currentPage) {
      setShowBackToGuide(false);
      setGuideReturnItemId(null);
      prevPageRef.current = currentPage;
    }
  }, [currentPage]);

  // Persist reading guide scroll position as user scrolls (debounced) so it is remembered per page
  useEffect(() => {
    if (viewMode !== 'guide' || typeof currentPage !== 'number') return;
    let cleanup = () => {};
    const t = setTimeout(() => {
      const el = guideScrollContainerRef.current;
      if (!el) return;
      const saveGuideScroll = debounce(() => {
        if (guideScrollContainerRef.current) {
          setGuideScrollPositionByPage(prev => ({ ...prev, [currentPage]: guideScrollContainerRef.current.scrollTop }));
        }
      }, 150);
      el.addEventListener('scroll', saveGuideScroll, { passive: true });
      cleanup = () => {
        el.removeEventListener('scroll', saveGuideScroll);
        saveGuideScroll.cancel?.();
      };
    }, 0);
    return () => {
      clearTimeout(t);
      cleanup();
    };
  }, [viewMode, currentPage]);

  // Clear guideScrollToRestoreOnBack when leaving guide (user switched to original), so next guide visit uses per-page scroll
  useEffect(() => {
    if (viewMode === 'original' && guideScrollToRestoreOnBack != null) {
      setGuideScrollToRestoreOnBack(null);
    }
  }, [viewMode]);

  // Restore book (original) pane scroll when switching from Guide back to Original
  useEffect(() => {
    if (viewMode !== 'original' || !bookPaneContainerRef.current) return;
    if (explicitPaginationInFlightRef.current) return;
    if (skipBookScrollRestoreOnPageChangeRef.current) {
      skipBookScrollRestoreOnPageChangeRef.current = false;
      return;
    }
    const saved = bookScrollPositionByPage[currentPage];
    if (typeof saved !== 'number' || saved <= 0) return;
    const raf = requestAnimationFrame(() => {
      if (bookPaneContainerRef.current) {
        bookPaneContainerRef.current.scrollTop = saved;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [viewMode, currentPage, bookScrollPositionByPage]);

  const mainContentAreaRef = useRef(null); // Ref for the main content area (book + view mode)

  // Resizer Event Handlers
  // Note: The existing handleDocumentMouseMove, handleDocumentMouseUp, handleMouseDownOnResizer
  // were placeholders or part of an older/different resizer logic.
  // We are adding specific handlers for each resizer.

  // --- Reading Guide Pane Resizer Handlers ---
  const handleGuideResizeMouseMove = useCallback((e) => {
    if (!isResizingGuideMainActive.current || !bookViewContainerRef.current || !readingGuidePaneAreaRef.current) { // Use specific flag
      return;
    }
    e.preventDefault();

    const deltaX = e.clientX - dragStartX.current;
    let newGuidePaneWidthPx = initialReadingGuidePaneWidthPx.current + deltaX;

    const containerWidth = bookViewContainerRef.current.offsetWidth;
    // Ensure main content area also has a minimum width
    const minMainContentWidth = Math.max(200, containerWidth * 0.30); 
    const minGuidePaneWidth = Math.max(150, containerWidth * 0.15); // Min width for guide
    const maxGuidePaneWidth = containerWidth - minMainContentWidth; // Max width for guide

    newGuidePaneWidthPx = Math.max(minGuidePaneWidth, Math.min(newGuidePaneWidthPx, maxGuidePaneWidth));
    setReadingGuidePaneFlexBasis(`${newGuidePaneWidthPx}px`);
  }, [isResizingGuideMainActive, dragStartX, initialReadingGuidePaneWidthPx, bookViewContainerRef, readingGuidePaneAreaRef]); // Dependencies: isResizingGuideMainActive, dragStartX, initialReadingGuidePaneWidthPx, bookViewContainerRef, readingGuidePaneAreaRef

  const handleGuideResizeMouseUp = useCallback(() => {
    if (!isResizingGuideMainActive.current) { // Use specific flag
      return;
    }
    // Check which resizer was active if using a shared isResizing flag, or use separate flags.
    // For now, assuming isResizing is general.
    isResizingGuideMainActive.current = false; // Use specific flag
    document.body.classList.remove('resizing-no-select');
    document.removeEventListener('mousemove', handleGuideResizeMouseMove);
    document.removeEventListener('mouseup', handleGuideResizeMouseUp);
  }, [handleGuideResizeMouseMove]); // Dependency: handleGuideResizeMouseMove

  const handleMouseDownOnGuideResizer = useCallback((e) => {
    if (!readingGuidePaneAreaRef.current || !bookViewContainerRef.current) return;

    isResizingGuideMainActive.current = true; // Use specific flag
    dragStartX.current = e.clientX;
    initialReadingGuidePaneWidthPx.current = readingGuidePaneAreaRef.current.offsetWidth;
    e.preventDefault();

    document.body.classList.add('resizing-no-select');
    document.addEventListener('mousemove', handleGuideResizeMouseMove);
    document.addEventListener('mouseup', handleGuideResizeMouseUp);
  }, [handleGuideResizeMouseMove, handleGuideResizeMouseUp]); // Dependencies

  // Cleanup useEffect for global event listeners (related to the old resizer)
  useEffect(() => {
      // This cleanup is for the old resizer. The new ones (handleBookNoteResizeMouseUp and handleGuideResizeMouseUp) handle their own.
      return () => {
          // Example: if an old global listener was set up based on a shared isResizing.current,
          // it would be cleaned up here. Current setup doesn't require this specific cleanup
          // as listeners are added/removed in the mousedown/mouseup handlers directly.
      };
  }, []); // Empty dependency array as it refers to old handlers

  useEffect(() => {
    const checkMobileView = () => {
      setIsMobileView(window.innerWidth <= 768);
    };
    // checkMobileView(); // Already initialized in useState
    window.addEventListener('resize', checkMobileView);
    return () => window.removeEventListener('resize', checkMobileView);
  }, []);

  useLayoutEffect(() => {
    if (!navBarActiveScrollRef || !bumpNavBarScrollSync) {
      return undefined;
    }
    let next = null;
    if (isMobileView) {
      next = viewMode === 'guide'
        ? guideScrollContainerRef.current
        : bookPaneContainerRef.current;
    }
    const prev = navBarActiveScrollRef.current;
    navBarActiveScrollRef.current = next;
    if (prev !== next) {
      bumpNavBarScrollSync();
    }
    return () => {
      if (navBarActiveScrollRef.current) {
        navBarActiveScrollRef.current = null;
        bumpNavBarScrollSync();
      }
    };
  }, [
    viewMode,
    isMobileView,
    navBarActiveScrollRef,
    bumpNavBarScrollSync,
    guideLoading,
    readingRoadmap,
    currentPage,
  ]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (bookmarkMenuRef.current && !bookmarkMenuRef.current.contains(event.target)) {
        setIsBookmarkMenuOpen(false);
      }
    };

    if (isBookmarkMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    } else {
      document.removeEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isBookmarkMenuOpen]);


  // Fetch notes when bookId changes
  useEffect(() => {
    const fetchNotes = async () => {
      if (!bookId) return;
      try {
        const token = getStoredAuthToken();
        if (!token) {
          logger.warn("[BookView - fetchNotes] Auth token not found. Cannot fetch notes.");
          setNotes([]); // Clear notes if not authenticated
          return;
        }
        const response = await fetch(`/api/notes/${bookId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
        if (!response.ok) {
          if (response.status === 401) {
            logger.warn("[BookView - fetchNotes] Not authenticated to fetch notes.");
            setNotes([]);
          } else {
            throw new Error('Failed to fetch notes');
          }
          return;
        }
        const notesData = await response.json();
        // Sort notes by creation date or another relevant field if needed for consistent highlighting
        notesData.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        try {
          const ann = await getAnnotations(bookId);
          const merged = mergeAnnotationsByTimestamp({
            localBookmarks: ann?.bookmarks || [],
            localNotes: ann?.notes || [],
            serverBookmarks: ann?.bookmarks || [],
            serverNotes: notesData,
          });
          setBookmarks(merged.bookmarks);
          setNotes(merged.notes);
          await putAnnotations(bookId, merged);
        } catch (_e) { /* ignore */ }
      } catch (err) {
        logger.error('Error fetching notes:', err);
        try {
          const ann = await getAnnotations(bookId);
          if (ann && Array.isArray(ann.notes)) {
            setNotes(ann.notes);
          } else {
            setNotes([]);
          }
        } catch (_e) {
          setNotes([]);
        }
      }
    };

    fetchNotes();
  }, [bookId]);

  // Effect for handling pagination logic AND highlighting when content, currentPage, notes, or guideSearchText change
  useEffect(() => {
    logger.debug("[BookView - Page Content Effect] Running. Current Page:", currentPage, "Notes count:", notes.length, "PendingScrollOffsetInPage:", pendingScrollOffsetInPage, "PendingScrollToPercentage:", pendingScrollToPercentage);
    
    // Recalculate page boundaries whenever the full content changes
    let boundariesToUse = [];
    if (fullMarkdownContent) {
      const newBoundaries = calculatePageBoundaries(fullMarkdownContent, APPROX_CHARS_PER_PAGE);
      setPageBoundaries(newBoundaries);
      pageBoundariesRef.current = newBoundaries;
      setTotalPages(Math.max(1, newBoundaries.length));
      boundariesToUse = newBoundaries;
    } else {
      setPageBoundaries([]);
      pageBoundariesRef.current = [];
      setTotalPages(1);
    }

    // Use locally computed boundaries so we don't rely on stale pageBoundaries state (same run)
    if (fullMarkdownContent && boundariesToUse.length > 0) {
      const numPages = boundariesToUse.length;
      const validCurrentPage = Math.max(1, Math.min(currentPage, numPages || 1));
      
      if (currentPage !== validCurrentPage) {
        logger.warn(`[BookView - Page Content Effect] currentPage ${currentPage} was invalid for numPages ${numPages}. Setting to ${validCurrentPage}`);
        setCurrentPage(validCurrentPage);
        return;
      }
      
      const pageIndex = validCurrentPage - 1;
      if (pageIndex < 0 || pageIndex >= boundariesToUse.length) {
          logger.error(`[BookView - Page Content Effect] Invalid pageIndex ${pageIndex} for boundariesToUse length ${boundariesToUse.length}. CurrentPage: ${currentPage}`);
          setHighlightedPageContent("Error: Page data not found.");
          setCurrentPageContent("");
          return;
      }
      const { start: pageStartGlobalOffset, end: pageEndGlobalOffset } = boundariesToUse[pageIndex];
      
      const plainPageText = fullMarkdownContent.substring(pageStartGlobalOffset, pageEndGlobalOffset);
      setCurrentPageContent(plainPageText);
      logger.debug(`[BookView - Page Content Effect] Page ${validCurrentPage}: Global Offset [${pageStartGlobalOffset}-${pageEndGlobalOffset}]. Plain text (len: ${plainPageText.length}): "${plainPageText.substring(0, 100)}..."`);

      // --- NEW: Highlight text with notes and guide search ---
      // Filter and sort notes relevant to the current page.
      const notesOnPage = notes
        .filter(note =>
          note.global_character_offset !== null &&
          note.global_character_offset >= pageStartGlobalOffset &&
          note.global_character_offset < pageEndGlobalOffset &&
          note.source_text && note.source_text.length > 0
        )
        .sort((a, b) => a.global_character_offset - b.global_character_offset);

      // Prepare highlights array for both notes and guide search
      const highlights = [];

      // Add note highlights
      if (notesOnPage.length > 0) {
        logger.debug(`[BookView - Page Content Effect] Found ${notesOnPage.length} notes on page ${validCurrentPage}.`);

        const sortedNotes = notesOnPage.sort((a, b) => {
            const a_start = a.global_character_offset;
            const b_start = b.global_character_offset;
            if (a_start !== b_start) {
                return a_start - b_start;
            }
            return (b.source_text?.length || 0) - (a.source_text?.length || 0);
        });

        for (const note of sortedNotes) {
          const noteAnchorInPage = note.global_character_offset - pageStartGlobalOffset;
          const resolvedRange = resolveNoteHighlightRange(
            plainPageText,
            noteAnchorInPage,
            note.source_text
          );
          if (!resolvedRange) {
            continue;
          }
          const noteId = note.id || note._id;
          if (resolvedRange.strategy === 'fallback') {
            logger.info(
              `[BookView - Page Content Effect] Note ${noteId} used generous fallback highlight around offset ${note.global_character_offset}.`
            );
          }
          
          highlights.push({
            start: resolvedRange.start,
            end: resolvedRange.end,
            type: 'note',
            id: noteId,
            text: note.source_text
          });
        }
      }

      // Add guide search highlight if search text is provided
      // Note: If the text is on a different page, scrollToGlobalOffset will handle navigation
      // and this effect will re-run with the correct page content
      if (
        guideSearchGlobalOffset !== null &&
        guideSearchGlobalOffset !== undefined &&
        guideSearchEndOffset !== null &&
        guideSearchEndOffset !== undefined &&
        guideSearchEndOffset > guideSearchGlobalOffset
      ) {
        const exactStart = guideSearchGlobalOffset - pageStartGlobalOffset;
        const exactEnd = guideSearchEndOffset - pageStartGlobalOffset;
        if (exactStart >= 0 && exactStart < plainPageText.length) {
          highlights.push({
            start: exactStart,
            end: Math.min(exactEnd, plainPageText.length),
            type: 'guide-search',
            text: plainPageText.substring(exactStart, Math.min(exactEnd, plainPageText.length)),
          });
          logger.info(`[BookView - Page Content Effect] Applied exact guide highlight ${exactStart}-${Math.min(exactEnd, plainPageText.length)} on page ${validCurrentPage}`);
        }
      } else if (guideSearchText && guideSearchText.trim().length > 0) {
        const cleanSearchText = guideSearchText.trim().replace(/\s+/g, ' ');
        // Try to find the search text in the current page
        // Use case-insensitive search and handle variations in whitespace
        // Escape special regex characters but allow flexible whitespace matching
        const escapedText = cleanSearchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const searchRegex = new RegExp(escapedText.replace(/\s+/g, '\\s+'), 'gi');
        let match;
        const searchMatches = [];
        
        // Reset regex lastIndex to ensure we search from the beginning
        searchRegex.lastIndex = 0;
        while ((match = searchRegex.exec(plainPageText)) !== null) {
          searchMatches.push({
            start: match.index,
            end: match.index + match[0].length,
            type: 'guide-search',
            text: match[0]
          });
        }

        // If we found matches, add them to highlights (prefer first match or closest to expected offset)
        if (searchMatches.length > 0) {
          // If we have a global offset, try to find the match closest to it
          let bestMatch = searchMatches[0];
          const expectedGlobalOffset = (guideSearchGlobalOffset ?? scrollToGlobalOffset);
          if (expectedGlobalOffset !== null && expectedGlobalOffset !== undefined) {
            const expectedOffsetInPage = expectedGlobalOffset - pageStartGlobalOffset;
            // Only consider matches that are reasonably close to the expected offset (within 500 chars)
            const closeMatches = searchMatches.filter(m => Math.abs(m.start - expectedOffsetInPage) < 500);
            if (closeMatches.length > 0) {
              let minDistance = Math.abs(closeMatches[0].start - expectedOffsetInPage);
              bestMatch = closeMatches[0];
              for (const match of closeMatches) {
                const distance = Math.abs(match.start - expectedOffsetInPage);
                if (distance < minDistance) {
                  minDistance = distance;
                  bestMatch = match;
                }
              }
            }
          }
          
          highlights.push(bestMatch);
          logger.info(`[BookView - Page Content Effect] Found guide search text at position ${bestMatch.start} in page ${validCurrentPage} (${searchMatches.length} total matches)`);
        } else {
          // If not found on current page, check if we're waiting for page navigation
          const expectedGlobalOffset = (guideSearchGlobalOffset ?? scrollToGlobalOffset);
          if (expectedGlobalOffset !== null && expectedGlobalOffset !== undefined) {
            const expectedOffsetInPage = expectedGlobalOffset - pageStartGlobalOffset;
            if (expectedOffsetInPage < 0 || expectedOffsetInPage >= plainPageText.length) {
              logger.info(`[BookView - Page Content Effect] Guide search text not on current page ${validCurrentPage}, waiting for navigation to correct page`);
            } else {
              // Fallback: use expected offset to highlight the first sentence-sized chunk.
              const safeStart = Math.max(0, Math.min(expectedOffsetInPage, plainPageText.length - 1));
              const tail = plainPageText.slice(safeStart, safeStart + 240);
              const sentenceEnd = tail.match(/[.!?](\s|$)/);
              const fallbackLen = sentenceEnd && typeof sentenceEnd.index === 'number'
                ? Math.max(20, sentenceEnd.index + 1)
                : Math.max(20, Math.min(120, tail.length));
              const safeEnd = Math.max(safeStart + 1, Math.min(plainPageText.length, safeStart + fallbackLen));
              highlights.push({
                start: safeStart,
                end: safeEnd,
                type: 'guide-search',
                text: plainPageText.substring(safeStart, safeEnd)
              });
              logger.info(`[BookView - Page Content Effect] Guide-search text fallback highlight at ${safeStart}-${safeEnd} on page ${validCurrentPage}`);
            }
          } else {
            logger.warn(`[BookView - Page Content Effect] Guide search text not found in page ${validCurrentPage}: "${cleanSearchText.substring(0, 50)}"`);
          }
        }
      }

      // Sort all highlights by start position
      highlights.sort((a, b) => {
        if (a.start !== b.start) {
          return a.start - b.start;
        }
        return b.end - a.end; // Longer highlights first if same start
      });

      const cutoffInPage =
        guideSegmentCutoffOffset !== null &&
        guideSegmentCutoffOffset !== undefined &&
        guideSegmentCutoffOffset >= pageStartGlobalOffset &&
        guideSegmentCutoffOffset <= pageEndGlobalOffset
          ? Math.max(0, Math.min(plainPageText.length, guideSegmentCutoffOffset - pageStartGlobalOffset))
          : null;
      const cutoffMarkerHtml = '<span class="roadmap-cutoff-indicator" role="note" aria-label="Roadmap segment cutoff">Roadmap segment cutoff</span>';
      const escapeHtml = (text) => String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
      let cutoffInserted = false;
      const buildSegmentText = (start, end, shouldEscape = false) => {
        if (end <= start) return '';
        const normalizedStart = Math.max(0, Math.min(start, plainPageText.length));
        const normalizedEnd = Math.max(normalizedStart, Math.min(end, plainPageText.length));
        const hasCutoff =
          cutoffInPage !== null &&
          !cutoffInserted &&
          cutoffInPage >= normalizedStart &&
          cutoffInPage <= normalizedEnd;
        if (!hasCutoff) {
          const chunk = plainPageText.substring(normalizedStart, normalizedEnd);
          return shouldEscape ? escapeHtml(chunk) : chunk;
        }
        const split = Math.max(normalizedStart, Math.min(cutoffInPage, normalizedEnd));
        const before = plainPageText.substring(normalizedStart, split);
        const after = plainPageText.substring(split, normalizedEnd);
        cutoffInserted = true;
        const left = shouldEscape ? escapeHtml(before) : before;
        const right = shouldEscape ? escapeHtml(after) : after;
        return `${left}${cutoffMarkerHtml}${right}`;
      };

      // Apply highlights to text
      if (highlights.length > 0) {
        let highlightedText = '';
        let lastIndex = 0;

        for (const highlight of highlights) {
          if (highlight.start < lastIndex) {
            continue; // Skip overlapping highlights
          }

          highlightedText += buildSegmentText(lastIndex, highlight.start, false);
          
          if (highlight.type === 'note') {
            const textToHighlight = plainPageText.substring(highlight.start, Math.min(highlight.end, plainPageText.length));
            if (textToHighlight) {
              const escapedText = buildSegmentText(highlight.start, Math.min(highlight.end, plainPageText.length), true);
              highlightedText += `<mark class="note-highlight" data-note-id="${highlight.id}">${escapedText}</mark>`;
            }
          } else if (highlight.type === 'guide-search') {
            const textToHighlight = plainPageText.substring(highlight.start, Math.min(highlight.end, plainPageText.length));
            if (textToHighlight) {
              const escapedText = buildSegmentText(highlight.start, Math.min(highlight.end, plainPageText.length), true);
              highlightedText += `<mark class="guide-search-highlight">${escapedText}</mark>`;
            }
          }
          
          lastIndex = Math.min(highlight.end, plainPageText.length);
        }

        if (lastIndex < plainPageText.length) {
          highlightedText += buildSegmentText(lastIndex, plainPageText.length, false);
        } else if (!cutoffInserted && cutoffInPage === plainPageText.length) {
          highlightedText += cutoffMarkerHtml;
        }

        setHighlightedPageContent(highlightedText);
      } else {
        const plainWithCutoff = buildSegmentText(0, plainPageText.length, false);
        setHighlightedPageContent(
          !cutoffInserted && cutoffInPage === plainPageText.length
            ? `${plainWithCutoff}${cutoffMarkerHtml}`
            : plainWithCutoff
        );
      }
      
      const pageActuallyChanged = lastScrollToTopPageRef.current !== currentPage;
      const isExplicitPaginationPage =
        explicitPaginationInFlightRef.current &&
        explicitPaginationTargetPageRef.current === currentPage;

      if (isExplicitPaginationPage) {
        logger.debug("[BookView - Page Content Effect] Explicit pagination landed on page", currentPage, ". Forcing scroll to top.");
        lastScrollToTopPageRef.current = currentPage;
        isProgrammaticScroll.current = true;
        const pane = viewMode === 'guide' ? guideScrollContainerRef.current : bookPaneContainerRef.current;
        if (pane) {
          pane.scrollTop = 0;
          requestAnimationFrame(() => {
            const nextPane = viewMode === 'guide' ? guideScrollContainerRef.current : bookPaneContainerRef.current;
            if (!nextPane) return;
            nextPane.scrollTop = 0;
            requestAnimationFrame(() => {
              const finalPane = viewMode === 'guide' ? guideScrollContainerRef.current : bookPaneContainerRef.current;
              if (finalPane) finalPane.scrollTop = 0;
            });
          });
        }
        if (viewMode === 'guide') {
          setGuideScrollPositionByPage((prev) => ({ ...prev, [currentPage]: 0 }));
        } else {
          setBookScrollPositionByPage((prev) => ({ ...prev, [currentPage]: 0 }));
        }
        explicitPaginationInFlightRef.current = false;
        explicitPaginationTargetPageRef.current = null;
        setTimeout(() => {
          isProgrammaticScroll.current = false;
          logger.debug("[BookView - Page Content Effect] Reset isProgrammaticScroll after explicit pagination top scroll.");
        }, 120);
      } else if (bookPaneContainerRef.current && viewMode === 'original') {
        if (pendingScrollOffsetInPage === null && pendingScrollToPercentage === null) {
          if (pageActuallyChanged && !isProgrammaticScroll.current) {
              logger.debug("[BookView - Page Content Effect] Page changed to", currentPage, ". Scrolling to top.");
              lastScrollToTopPageRef.current = currentPage;
              isProgrammaticScroll.current = true;
              bookPaneContainerRef.current.scrollTop = 0;
              setTimeout(() => {
                  isProgrammaticScroll.current = false;
                  logger.debug("[BookView - Page Content Effect] Reset isProgrammaticScroll from scroll-to-top action.");
              }, 100);
          } else if (!pageActuallyChanged) {
              logger.debug("[BookView - Page Content Effect] Same page; not scrolling to top (e.g. note saved).");
          } else {
              logger.debug("[BookView - Page Content Effect] Scroll-to-top conditions met, BUT isProgrammaticScroll.current is true. Skipping.");
          }
        } else {
          logger.debug("[BookView - Page Content Effect] A scroll is pending. Skipping automatic scroll to top.");
        }
      }

    } else if (fullMarkdownContent && boundariesToUse.length === 0) {
        logger.warn("[BookView - Page Content Effect] fullMarkdownContent exists but pageBoundaries is empty. This might be initial load. Displaying placeholder or first chunk.");
        const tempEndOffset = Math.min(APPROX_CHARS_PER_PAGE, fullMarkdownContent.length);
        const tempPageText = fullMarkdownContent.substring(0, tempEndOffset);
        setCurrentPageContent(tempPageText);
        setHighlightedPageContent(tempPageText);
        if (totalPages !== 1) setTotalPages(1);
        if (currentPage !== 1) setCurrentPage(1);
    } else {
      logger.debug("[BookView - Page Content Effect] No fullMarkdownContent or pageBoundaries not ready. Clearing page content.");
      setCurrentPageContent('');
      setHighlightedPageContent('');
    }
  }, [fullMarkdownContent, currentPage, notes, pendingScrollOffsetInPage, pendingScrollToPercentage, guideSearchText, guideSearchGlobalOffset, guideSearchEndOffset, guideSegmentCutoffOffset, scrollToGlobalOffset, viewMode]);


  // Effect to apply initial scroll once content is ready
  useEffect(() => {
    const state = getEffectiveScrollState();
    if (initialScrollTop !== null && state?.active && highlightedPageContent) {
      logger.info(`[BookView - InitialScrollEffect] Applying initial scroll top: ${initialScrollTop}`);
      isProgrammaticScroll.current = true;
      state.active.scrollTop = initialScrollTop;
      setInitialScrollTop(null); // Clear after applying
      setTimeout(() => {
        isProgrammaticScroll.current = false;
        logger.debug("[BookView - InitialScrollEffect] Reset isProgrammaticScroll after initial scroll.");
      }, 150); // Delay to allow scroll to settle and prevent immediate sync issues
    }
  }, [initialScrollTop, highlightedPageContent, getEffectiveScrollState]); // Depends on highlightedPageContent to ensure page is rendered

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  const handlePageInputChange = (event) => {
    setPageInput(event.target.value);
  };

  const handleGoToPage = (event) => {
    if (event) event.preventDefault();
    const pageNum = parseInt(pageInput, 10);
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
      if (pageNum === currentPage) {
        setPageInput(String(currentPage));
        return;
      }
      beginExplicitPagination(pageNum);
      setCurrentPage(pageNum);
      // Refresh signed URLs when page changes
      refreshImageUrls();
    } else {
      setPageInput(String(currentPage)); 
      alert(`Please enter a page number between 1 and ${totalPages}.`);
    }
  };

  const handleTextSelect = ({ text: textFromBookPane, rangeDetails }) => { // MODIFIED SIGNATURE
    // const selection = window.getSelection(); // REMOVE THIS LINE

    // MODIFIED CONDITION: Use rangeDetails directly
    if (!textFromBookPane || textFromBookPane.trim() === "" || !rangeDetails || !bookPaneContainerRef.current) {
      setSelectedBookText(null);
      setSelectedGlobalCharOffset(null);
      setSelectedScrollPercentage(null);
      return;
    }

    // const range = selection.getRangeAt(0); // REMOVE THIS LINE
    const pageContainerElement = bookPaneContainerRef.current;

    // Use properties from the passed rangeDetails object
    let selStartNode = rangeDetails.startContainer;
    let selStartOffset = rangeDetails.startOffset;
    let selEndNode = rangeDetails.endContainer;
    let selEndOffset = rangeDetails.endOffset;

    // Helper to find the actual text node and offset if selection is on an element node
    function resolveToTextNode(containerNode, offsetInContainer) {
        if (containerNode.nodeType === Node.TEXT_NODE) {
            return { node: containerNode, offset: offsetInContainer };
        }
        // If selection is on an element, offsetInContainer is the index of the child node
        let cumulativeOffset = 0;
        let targetNode = containerNode;
        let targetOffset = 0;

        if (offsetInContainer < containerNode.childNodes.length) {
            targetNode = containerNode.childNodes[offsetInContainer];
            // Traverse down to the first text node
            while(targetNode && targetNode.nodeType !== Node.TEXT_NODE && targetNode.firstChild) {
                targetNode = targetNode.firstChild;
            }
            if (targetNode && targetNode.nodeType === Node.TEXT_NODE) {
                 targetOffset = 0; // Selection is at the start of this text node
            } else {
                // Fallback or complex case: try to find nearest text node or use parent
                logger.warn("[BookView - handleTextSelect] Complex selection boundary, could not resolve directly to text node start.");
                targetNode = containerNode; // Fallback to container
                targetOffset = 0;
            }
        } else if (containerNode.childNodes.length > 0) {
             // Selection is at the end of the container
            targetNode = containerNode.childNodes[containerNode.childNodes.length -1];
             // Traverse down to the last text node
            while(targetNode && targetNode.nodeType !== Node.TEXT_NODE && targetNode.lastChild) {
                targetNode = targetNode.lastChild;
            }
            if (targetNode && targetNode.nodeType === Node.TEXT_NODE) {
                targetOffset = targetNode.textContent.length; // Selection is at the end of this text node
            } else {
                logger.warn("[BookView - handleTextSelect] Complex selection boundary, could not resolve directly to text node end.");
                targetNode = containerNode; // Fallback to container
                targetOffset = containerNode.textContent.length;
            }
        }
        return { node: targetNode, offset: targetOffset };
    }

    const startDetails = resolveToTextNode(selStartNode, selStartOffset);
    selStartNode = startDetails.node;
    selStartOffset = startDetails.offset;

    const endDetails = resolveToTextNode(selEndNode, selEndOffset);
    selEndNode = endDetails.node;
    selEndOffset = endDetails.offset;
    
    logger.debug(`[BookView - handleTextSelect] Resolved Selection: StartNode:`, selStartNode, `StartOffset: ${selStartOffset}, EndNode:`, selEndNode, `EndOffset: ${selEndOffset}`);

    let startInPageRendered = -1;
    let endInPageRendered = -1;

    const walker = document.createTreeWalker(pageContainerElement, NodeFilter.SHOW_TEXT, null);
    let currentWalkerOffset = 0;
    let node;
    let foundStart = false;

    while ((node = walker.nextNode())) {
      const nodeLength = node.textContent.length;
      if (!foundStart && node === selStartNode) {
        startInPageRendered = currentWalkerOffset + selStartOffset;
        foundStart = true;
        // If selection is within this single node
        if (node === selEndNode) {
          endInPageRendered = currentWalkerOffset + selEndOffset;
          break; 
        }
      } else if (foundStart && node === selEndNode) {
        endInPageRendered = currentWalkerOffset + selEndOffset;
        break; 
      }
      currentWalkerOffset += nodeLength;
    }
    
    // If endInPageRendered is still -1 (e.g. selection spans to the very end of content)
    // and start was found, it implies the selection might go to the end of the last text node encountered by the walker.
    // Or if selection was empty and start/end are same point.
    if (startInPageRendered !== -1 && endInPageRendered === -1) {
        if (selStartNode === selEndNode && selStartOffset === selEndOffset) { // Empty selection at a point
            endInPageRendered = startInPageRendered;
        } else {
            // This might happen if selEndNode was not encountered or other edge cases.
            // A fallback: use the length of the visually selected text.
            logger.warn("[BookView - handleTextSelect] endInPageRendered not precisely determined by walker, using textFromBookPane.length as delta.");
            endInPageRendered = startInPageRendered + textFromBookPane.length;
        }
    }


    logger.debug(`[BookView - handleTextSelect] Calculated Rendered Offsets: startInPageRendered: ${startInPageRendered}, endInPageRendered: ${endInPageRendered}`);

    if (startInPageRendered !== -1 && endInPageRendered !== -1 && endInPageRendered >= startInPageRendered) {
      const rawMarkdownForPage = currentPageContent; // This is the raw Markdown for the current page
      const mdSegments = createMarkdownSegments(rawMarkdownForPage);
      logger.debug("[BookView - handleTextSelect] Markdown Segments for page:", mdSegments);

      const mappedStartInRawPage = mapRenderedToRawOffset(startInPageRendered, mdSegments);
      const mappedEndInRawPage = mapRenderedToRawOffset(endInPageRendered, mdSegments);
      logger.debug(`[BookView - handleTextSelect] Mapped Raw Offsets in Page: Start: ${mappedStartInRawPage}, End: ${mappedEndInRawPage}`);


      if (mappedStartInRawPage !== -1 && mappedEndInRawPage !== -1 && mappedEndInRawPage >= mappedStartInRawPage) {
        // Get current page's actual start offset from boundaries
        let currentPageStartOffset = 0; // Default for safety
        const pageIndex = currentPage - 1;
        const boundariesSource = pageBoundariesRef.current.length > 0 ? pageBoundariesRef.current : pageBoundaries;
        if (boundariesSource.length > 0 && pageIndex >= 0 && pageIndex < boundariesSource.length) {
            currentPageStartOffset = boundariesSource[pageIndex].start;
        } else {
            logger.warn(`[BookView - handleTextSelect] pageBoundaries not ready or invalid currentPage for offset calculation. Using fallback. CurrentPage: ${currentPage}, Boundaries Length: ${boundariesSource.length}`);
            currentPageStartOffset = (currentPage - 1) * APPROX_CHARS_PER_PAGE; // Fallback
        }

        const globalOffset = currentPageStartOffset + mappedStartInRawPage;
        
        // Set selectedBookText to the text from the selection (textFromBookPane)
        setSelectedBookText(textFromBookPane); 
        setSelectedGlobalCharOffset(globalOffset);
        logger.debug(`[BookView - handleTextSelect] Selected rendered text: "${textFromBookPane.substring(0,100)}...", Global raw offset for start: ${globalOffset}`);

      } else {
        logger.warn("[BookView - handleTextSelect] Failed to map rendered selection to raw markdown offsets or invalid range. Using visual selection and heuristic offset.");
        setSelectedBookText(textFromBookPane); 
        // Fallback globalOffset calculation
        let fallbackPageStartOffset = (currentPage - 1) * APPROX_CHARS_PER_PAGE;
        const pageIndex = currentPage - 1;
        const boundariesSource = pageBoundariesRef.current.length > 0 ? pageBoundariesRef.current : pageBoundaries;
        if (boundariesSource.length > 0 && pageIndex >= 0 && pageIndex < boundariesSource.length) {
            fallbackPageStartOffset = boundariesSource[pageIndex].start;
        }
        const fallbackGlobalOffset = fallbackPageStartOffset + startInPageRendered; 
        setSelectedGlobalCharOffset(fallbackGlobalOffset);
      }

      // Scroll percentage logic (remains as is)
      const element = bookPaneContainerRef.current;
      if (element && element.scrollHeight > element.clientHeight) {
        const pageScrollPercentage = element.scrollTop / (element.scrollHeight - element.clientHeight);
        setSelectedScrollPercentage(pageScrollPercentage);
      } else {
        setSelectedScrollPercentage(0);
      }

    } else {
      logger.warn("[BookView - handleTextSelect] Could not determine valid start/end in page rendered text. Storing visual selection only.");
      setSelectedBookText(textFromBookPane);
      setSelectedGlobalCharOffset(null);
      setSelectedScrollPercentage(null);
    }
  };

  const handleDeleteNote = async (noteIdToDelete) => {
    if (!window.confirm("Are you sure you want to delete this note?")) {
      return;
    }
    logger.info(`[BookView - handleDeleteNote] Attempting to delete note ID: ${noteIdToDelete}`);
    try {
      const token = getStoredAuthToken();
      if (!token) {
        alert("Authentication token not found.");
        return;
      }

      if (!navigator.onLine || isOfflineSnapshot) {
        setNotes((prev) => prev.filter((n) => (n._id || n.id) !== noteIdToDelete));
        try {
          const ann = await getAnnotations(bookId);
          const nextNotes = (ann?.notes || []).filter((n) => (n._id || n.id) !== noteIdToDelete);
          await putAnnotations(bookId, { bookmarks: ann?.bookmarks || [], notes: nextNotes });
          if (isLocalId(noteIdToDelete)) {
            await removePendingCreateNote(noteIdToDelete);
          } else {
            await addOutboxEntry({
              type: 'delete_note',
              bookId,
              payload: { noteId: noteIdToDelete },
            });
          }
          await refreshOutboxCount();
        } catch (_e) { /* ignore */ }
        return;
      }

      const response = await fetch(`/api/notes/${noteIdToDelete}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: "Failed to delete note." }));
        throw new Error(errorData.detail);
      }
      setNotes(prevNotes => prevNotes.filter(note => (note._id || note.id) !== noteIdToDelete));
      logger.info(`Note with ID ${noteIdToDelete} deleted successfully.`);
    } catch (err) {
      logger.error('Error deleting note:', err);
      alert(`Error deleting note: ${err.message}`);
    }
  };

  const handleHighlightClick = (noteId) => {
    const note = notes.find(n => (n._id || n.id) === noteId);
    if (note) {
      setActiveNoteForModal(note);
    } else {
      logger.warn(`[BookView - handleHighlightClick] Note with ID ${noteId} not found.`);
    }
  };

  const handleNoteClick = (navigationTarget) => {
    if (typeof navigationTarget === 'number') {
      if (navigationTarget !== null && navigationTarget !== undefined) {
        setScrollToGlobalOffset(navigationTarget);
      }
    } else if (typeof navigationTarget === 'object' && navigationTarget !== null && navigationTarget.pageNumber !== undefined) {
      const targetPage = navigationTarget.pageNumber;
      if (targetPage >= 1 && targetPage <= totalPages) {
        logger.info(`[BookView - handleNoteClick] Navigating to page ${targetPage} from note click.`);
        isProgrammaticScroll.current = true; // Prevent scroll sync issues
        setCurrentPage(targetPage);
        refreshImageUrls(); // Refresh signed URLs when page changes
        // The useEffect for currentPage changes will handle scrolling to top of the new page
        // and resetting isProgrammaticScroll.current.
        // Explicit scroll to top here might be redundant if page content effect handles it,
        // but can be added for immediate feedback if needed:
        if (bookPaneContainerRef.current) {
          bookPaneContainerRef.current.scrollTop = 0;
        }
        // Reset isProgrammaticScroll after a delay, similar to other programmatic scrolls
        setTimeout(() => {
          isProgrammaticScroll.current = false;
          logger.debug("[BookView - handleNoteClick page nav] Reset isProgrammaticScroll.");
        }, 150);
      } else {
        logger.warn(`[BookView - handleNoteClick] Invalid page number ${targetPage} from note click.`);
      }
    }
  };
  
  const handleNewNoteSaved = (newNote) => {
    logger.debug("[BookView - handleNewNoteSaved] Received new note:", newNote);
    const newNoteId = newNote ? (newNote.id || newNote._id) : null;

    if (newNote && newNoteId) {
      setNotes(prevNotes => {
        const noteExists = prevNotes.some(note => (note.id || note._id) === newNoteId);
        if (noteExists) {
            logger.warn("[BookView - handleNewNoteSaved] Note ID", newNoteId, "already exists in state. Not adding again.");
            return prevNotes;
        }
        const updatedNotes = [...prevNotes, newNote].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        logger.debug("[BookView - handleNewNoteSaved] Updated notes state with new note:", updatedNotes.map(n => (n.id || n._id)));
        return updatedNotes;
      });
      setNotesLLMPopupMode(null);
      setSelectedBookText(null);
      setSelectedGlobalCharOffset(null);
      setSelectedScrollPercentage(null);
    } else {
        logger.warn("[BookView - handleNewNoteSaved] Received invalid newNote object or note without ID:", newNote);
    }
  };

  const handleOfflineNoteSave = async (noteData) => {
    const clientId = newLocalId();
    const note = {
      id: clientId,
      _id: clientId,
      book_id: bookId,
      content: noteData.content,
      page_number: noteData.page_number,
      source_text: noteData.source_text,
      scroll_percentage: noteData.scroll_percentage,
      global_character_offset: noteData.global_character_offset,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      _localClientId: clientId,
    };
    setNotes((prev) => [...prev, note].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
    try {
      const ann = await getAnnotations(bookId);
      await putAnnotations(bookId, {
        bookmarks: ann?.bookmarks || [],
        notes: [...(ann?.notes || []), note],
      });
      await addOutboxEntry({
        type: 'create_note',
        bookId,
        payload: { clientId, ...noteData },
      });
      await refreshOutboxCount();
    } catch (e) {
      logger.error('[BookView - handleOfflineNoteSave]', e);
    }
    setNotesLLMPopupMode(null);
  };

  // Effect for scrolling to a note when scrollToGlobalOffset changes
  useEffect(() => {
    if (viewMode !== 'original' || scrollToGlobalOffset === null || !fullMarkdownContent || pageBoundaries.length === 0) { // Check pageBoundaries
      if (scrollToGlobalOffset !== null) {
        logger.debug(`[ScrollToNoteEffect] Aborting: viewMode=${viewMode}, scrollToGlobalOffset=${scrollToGlobalOffset}, fullMarkdownContent=${!!fullMarkdownContent}, pageBoundaries.length=${pageBoundaries.length}`);
      }
      return;
    }

    const targetGlobalOffset = scrollToGlobalOffset;
    logger.info(`[ScrollToNoteEffect] Attempting to scroll to global character offset: ${targetGlobalOffset}`);

    // Determine the target page and offset within that page using pageBoundaries
    let targetPageNum = -1;
    let offsetWithinTargetPage = -1;

    for (let i = 0; i < pageBoundaries.length; i++) {
        // Note: A selection/offset can be AT pageBoundaries[i].start
        // It is considered on page i+1 if targetGlobalOffset is in [start, end)
        // If targetGlobalOffset is exactly pageBoundaries[i].end, it's effectively the start of the next page,
        // unless it's the very end of the document.
        if (targetGlobalOffset >= pageBoundaries[i].start && targetGlobalOffset < pageBoundaries[i].end) {
            targetPageNum = i + 1;
            offsetWithinTargetPage = targetGlobalOffset - pageBoundaries[i].start;
            break;
        }
    }
    // Handle case where offset is exactly at the end of the last page's content
    if (targetPageNum === -1 && pageBoundaries.length > 0 && targetGlobalOffset === pageBoundaries[pageBoundaries.length - 1].end) {
        targetPageNum = pageBoundaries.length; // Belongs to the last page
        offsetWithinTargetPage = targetGlobalOffset - pageBoundaries[targetPageNum - 1].start;
    }
    
    if (targetPageNum === -1) {
        logger.warn(`[ScrollToNoteEffect] Could not determine target page for global offset ${targetGlobalOffset} using pageBoundaries. Total boundaries: ${pageBoundaries.length}. Last boundary end: ${pageBoundaries.length > 0 ? pageBoundaries[pageBoundaries.length-1].end : 'N/A'}. Attempting fallback.`);
        // Fallback (less accurate if page lengths vary significantly from APPROX_CHARS_PER_PAGE)
        targetPageNum = Math.floor(targetGlobalOffset / APPROX_CHARS_PER_PAGE) + 1;
        const fallbackPageStart = (targetPageNum - 1) * APPROX_CHARS_PER_PAGE;
        offsetWithinTargetPage = targetGlobalOffset - fallbackPageStart;
        logger.warn(`[ScrollToNoteEffect] Fallback: targetPageNum=${targetPageNum}, offsetWithinTargetPage=${offsetWithinTargetPage}`);
    }

    logger.debug(`[ScrollToNoteEffect] Target page: ${targetPageNum}, Offset within page (raw): ${offsetWithinTargetPage}`);

    // If the target page is not the current page, change the page
    if (targetPageNum !== currentPage && targetPageNum !== -1) { // Ensure targetPageNum is valid
      logger.info(`[ScrollToNoteEffect] Target page ${targetPageNum} is different from current page ${currentPage}. Setting current page and pending offset.`);
      setCurrentPage(targetPageNum);
      refreshImageUrls(); // Refresh signed URLs when page changes
      // The offsetWithinTargetPage is already calculated based on the raw markdown of that page.
      // The pendingScrollEffect will need to use this raw offset to find the visual scroll position.
      setPendingScrollOffsetInPage(offsetWithinTargetPage); 
      setScrollToGlobalOffset(null); 
      return;
    }
    
    if (targetPageNum === currentPage && bookPaneContainerRef.current) {
        logger.info(`[ScrollToNoteEffect] Already on target page ${currentPage}. Proceeding with scroll using raw offset ${offsetWithinTargetPage}.`);
        const bookElement = bookPaneContainerRef.current;
        const rawPageContent = currentPageContent; // This is already set for the current page
        const mdSegments = createMarkdownSegments(rawPageContent);

        // Helper function: mapRawToRenderedOffset (inverse of mapRenderedToRawOffset)
        // This function takes a raw character offset within a page's markdown
        // and returns the approximate corresponding rendered character offset.
        let targetRenderedOffsetInPage = 0;
        let accumulatedRawOffset = 0;
        let accumulatedRenderedOffset = 0;

        for (const segment of mdSegments) {
            if (accumulatedRawOffset + segment.rawContent.length >= offsetWithinTargetPage) {
                // Target raw offset is within or at the end of this segment
                const rawOffsetIntoSegment = offsetWithinTargetPage - accumulatedRawOffset;
                if (segment.type === 'text') {
                    const decodedContent = decodeHtmlEntities(segment.rawContent);
                    let renderedCharsInSegmentPart = 0;
                    // let rawCharsProcessedInSegment = 0; // This variable was unused in original thought process
                    let inSpace = false;
                    // Simplified mapping: find rendered length of the prefix of rawContent
                    const prefixRaw = segment.rawContent.substring(0, Math.min(rawOffsetIntoSegment, segment.rawContent.length));
                    const prefixDecoded = decodeHtmlEntities(prefixRaw);
                    let prefixRenderedLen = 0; 
                    inSpace = false; // Reset inSpace for each segment part
                    for(let charIdx = 0; charIdx < prefixDecoded.length; charIdx++) {
                        if (/\s/.test(prefixDecoded[charIdx])) { if (!inSpace) prefixRenderedLen++; inSpace = true; }
                        else { prefixRenderedLen++; inSpace = false; }
                    }
                    renderedCharsInSegmentPart = prefixRenderedLen;
                    accumulatedRenderedOffset += renderedCharsInSegmentPart;
                }
                // If segment is 'image', it adds to raw but not rendered for this mapping.
                break; // Found the segment containing the raw offset
            }
            // Accumulate full segment lengths if target is beyond this segment
            accumulatedRawOffset += segment.rawContent.length;
            if (segment.type === 'text') {
                const decodedContent = decodeHtmlEntities(segment.rawContent);
                let segmentRenderedLen = 0; let inSpace = false;
                for (let k = 0; k < decodedContent.length; k++) {
                    if (/\s/.test(decodedContent[k])) { if (!inSpace) segmentRenderedLen++; inSpace = true; }
                    else { segmentRenderedLen++; inSpace = false; }
                }
                accumulatedRenderedOffset += segmentRenderedLen;
            }
        }
        targetRenderedOffsetInPage = accumulatedRenderedOffset;
        logger.debug(`[ScrollToNoteEffect] Mapped raw offset ${offsetWithinTargetPage} to rendered offset ${targetRenderedOffsetInPage} for page ${currentPage}.`);
        
        // --- Start of TreeWalker logic from original effect, adapted ---
        if (scrollTargetHighlightRef.current && scrollTargetHighlightRef.current.parentNode) { 
            try {
                const parent = scrollTargetHighlightRef.current.parentNode;
                const textContent = scrollTargetHighlightRef.current.textContent || "";
                parent.replaceChild(document.createTextNode(textContent), scrollTargetHighlightRef.current);
            } catch (e) { logger.error("[ScrollToNoteEffect] Error cleaning up previous highlight span:", e); }
        }
        scrollTargetHighlightRef.current = null;

        const walker = document.createTreeWalker(bookElement, NodeFilter.SHOW_TEXT, null);
        let currentWalkerRenderedOffset = 0; // This walker counts RENDERED characters
        let textNode = null;
        let foundTargetNodeAndOffset = false;

        while ((textNode = walker.nextNode())) {
          const nodeTextContent = textNode.textContent || ''; // Use textContent for length
          const nodeRenderedLength = nodeTextContent.length; // Assuming textContent length is rendered length here

          if (currentWalkerRenderedOffset + nodeRenderedLength >= targetRenderedOffsetInPage) {
            const startOffsetInNodeRendered = targetRenderedOffsetInPage - currentWalkerRenderedOffset;
            
            if (startOffsetInNodeRendered >= 0 && startOffsetInNodeRendered <= nodeRenderedLength) {
              logger.info(`[ScrollToNoteEffect] Target text node found. Rendered offset in node: ${startOffsetInNodeRendered}.`);
              const range = document.createRange();
              range.setStart(textNode, startOffsetInNodeRendered);
              range.setEnd(textNode, startOffsetInNodeRendered); 
              
              const highlightRange = document.createRange();
              highlightRange.setStart(textNode, startOffsetInNodeRendered);
              const remainingNodeText = nodeTextContent.slice(startOffsetInNodeRendered);
              const sentenceEndMatch = remainingNodeText.match(/[.!?](\s|$)/);
              let highlightLen = 80;
              if (sentenceEndMatch && typeof sentenceEndMatch.index === 'number') {
                highlightLen = Math.max(20, sentenceEndMatch.index + 1);
              } else {
                highlightLen = Math.max(20, Math.min(120, remainingNodeText.length));
              }
              highlightRange.setEnd(textNode, Math.min(nodeRenderedLength, startOffsetInNodeRendered + highlightLen));

              const highlightSpan = document.createElement('span');
              highlightSpan.className = 'highlighted-note-scroll-target'; 
              
              try {
                highlightRange.surroundContents(highlightSpan);
                scrollTargetHighlightRef.current = highlightSpan; 
                let spanOffsetTop = 0;
                let currentElement = highlightSpan;
                while (currentElement && currentElement !== bookElement) {
                  spanOffsetTop += currentElement.offsetTop;
                  currentElement = currentElement.offsetParent;
                }
                isProgrammaticScroll.current = true;
                const scrollTopTarget = Math.max(0, spanOffsetTop - 20); 
                bookElement.scrollTop = scrollTopTarget;
                highlightSpan.style.transition = 'background-color 0.5s ease-out';
                highlightSpan.style.backgroundColor = 'var(--color-highlight-bg)'; 
                setTimeout(() => { if (highlightSpan) { highlightSpan.style.backgroundColor = ''; } }, 1500); 

              } catch (e) {
                logger.error("[ScrollToNoteEffect] Error inserting highlight span or scrolling (surroundContents failed):", e);
                // Fallback logic
                try {
                    const markerSpan = document.createElement("span");
                    markerSpan.className = 'highlighted-note-scroll-target-marker';
                    markerSpan.style.outline = "2px solid red"; 
                    markerSpan.style.backgroundColor = 'var(--color-error-bg)';
                    range.insertNode(markerSpan); 
                    scrollTargetHighlightRef.current = markerSpan;
                    let markerOffsetTop = 0;
                    let currentMarkerEl = markerSpan;
                    while (currentMarkerEl && currentMarkerEl !== bookElement) {
                        markerOffsetTop += currentMarkerEl.offsetTop;
                        currentMarkerEl = currentMarkerEl.offsetParent;
                    }
                    const markerScrollTopTarget = Math.max(0, markerOffsetTop - 20);
                    isProgrammaticScroll.current = true;
                    bookElement.scrollTop = markerScrollTopTarget;
                    setTimeout(() => { if (markerSpan) { markerSpan.style.outline = ""; markerSpan.style.backgroundColor = ""; } }, 1500);
                } catch (e2) { logger.error("[ScrollToNoteEffect] Fallback markerSpan also failed:", e2); }
              }
              foundTargetNodeAndOffset = true;
              break; 
            }
          }
          currentWalkerRenderedOffset += nodeRenderedLength;
        }
        // --- End of adapted TreeWalker logic ---
        if (!foundTargetNodeAndOffset) { 
            logger.warn(`[ScrollToNoteEffect] Could not find exact node for rendered offset ${targetRenderedOffsetInPage}. Scrolling to top.`);
            isProgrammaticScroll.current = true; bookElement.scrollTop = 0; 
        }
        setBookScrollPositionByPage(prev => ({ ...prev, [currentPage]: bookElement.scrollTop }));
        const timer = setTimeout(() => { isProgrammaticScroll.current = false; logger.debug("[ScrollToNoteEffect] Reset isProgrammaticScroll."); }, 300); 
        setScrollToGlobalOffset(null); 
        return () => { 
            clearTimeout(timer); 
            if (scrollTargetHighlightRef.current && scrollTargetHighlightRef.current.parentNode) {
                try {
                    const parent = scrollTargetHighlightRef.current.parentNode;
                    const textToRestore = scrollTargetHighlightRef.current.textContent || "";
                    parent.replaceChild(document.createTextNode(textToRestore), scrollTargetHighlightRef.current);
                } catch (e) { logger.error("[ScrollToNoteEffect] Cleanup error:", e); }
            }
            scrollTargetHighlightRef.current = null;
        };
    } else if (targetPageNum === currentPage && !bookPaneContainerRef.current) {
        logger.warn("[ScrollToNoteEffect] On target page, but bookPaneContainerRef is null.");
        setScrollToGlobalOffset(null);
    }

  }, [scrollToGlobalOffset, fullMarkdownContent, currentPage, currentPageContent, pageBoundaries, viewMode]); // Added pageBoundaries


  useEffect(() => {
    if (viewMode !== 'original') {
      return;
    }
    // This effect handles scrolling when a page changes due to a note click (scrollToGlobalOffset)
    // pendingScrollOffsetInPage is the RAW character offset within the NEWLY loaded currentPageContent
    if (pendingScrollOffsetInPage !== null && bookPaneContainerRef.current && (currentPageContent.length > 0 || pendingScrollOffsetInPage === 0) && pageBoundaries.length > 0) {
      const bookElement = bookPaneContainerRef.current;
      
      // Map pendingScrollOffsetInPage (raw) to a rendered offset for TreeWalker
      const rawPageContentForPending = currentPageContent;
      const mdSegmentsForPending = createMarkdownSegments(rawPageContentForPending);
      let targetRenderedOffsetForPending = 0;
      // --- Start of simplified mapping for pending scroll ---
        let accumulatedRaw = 0;
        let accumulatedRendered = 0;
        for (const seg of mdSegmentsForPending) {
            if (accumulatedRaw + seg.rawContent.length >= pendingScrollOffsetInPage) {
                const rawOffInSeg = pendingScrollOffsetInPage - accumulatedRaw;
                if (seg.type === 'text') {
                    const decCont = decodeHtmlEntities(seg.rawContent.substring(0, rawOffInSeg));
                    let rendLenPart = 0; let inSp = false;
                    for(let k=0; k<decCont.length; k++) { if(/\s/.test(decCont[k])){if(!inSp)rendLenPart++;inSp=true;}else{rendLenPart++;inSp=false;} }
                    accumulatedRendered += rendLenPart;
                }
                break;
            }
            accumulatedRaw += seg.rawContent.length;
            if (seg.type === 'text') {
                const decCont = decodeHtmlEntities(seg.rawContent);
                let rendLenSeg = 0; let inSp = false;
                for(let k=0; k<decCont.length; k++) { if(/\s/.test(decCont[k])){if(!inSp)rendLenSeg++;inSp=true;}else{rendLenSeg++;inSp=false;} }
                accumulatedRendered += rendLenSeg;
            }
        }
        targetRenderedOffsetForPending = accumulatedRendered;
      // --- End of simplified mapping ---
      logger.debug(`[PendingScrollEffect] Mapped raw pending offset ${pendingScrollOffsetInPage} to rendered ${targetRenderedOffsetForPending}`);


      const walker = document.createTreeWalker(bookElement, NodeFilter.SHOW_TEXT, null);
      let currentWalkerRenderedOffset = 0; // Walker counts rendered characters
      let textNode = null;
      let foundTargetNodeForPendingScroll = false;

      while ((textNode = walker.nextNode())) {
          const nodeTextContent = textNode.textContent || '';
          const nodeRenderedLength = nodeTextContent.length;

          if (currentWalkerRenderedOffset + nodeRenderedLength >= targetRenderedOffsetForPending) {
              const startOffsetInNodeRendered = targetRenderedOffsetForPending - currentWalkerRenderedOffset;
              if (startOffsetInNodeRendered >= 0 && startOffsetInNodeRendered <= nodeRenderedLength) {
                  logger.info(`[PendingScrollEffect] Target text node found for pending scroll. Rendered offset in node: ${startOffsetInNodeRendered}.`);
                  const range = document.createRange();
                  range.setStart(textNode, startOffsetInNodeRendered);
                  range.setEnd(textNode, startOffsetInNodeRendered);
                  const tempSpan = document.createElement('span');
                  try {
                      range.insertNode(tempSpan);
                      let spanOffsetTop = 0;
                      let currentElement = tempSpan;
                      while (currentElement && currentElement !== bookElement) {
                          spanOffsetTop += currentElement.offsetTop;
                          currentElement = currentElement.offsetParent;
                      }
                      isProgrammaticScroll.current = true;
                      const scrollTopTarget = Math.max(0, spanOffsetTop - 20);
                      bookElement.scrollTop = scrollTopTarget;
                      logger.info(`[PendingScrollEffect] Scrolled to pending offset. Target scrollTop: ${scrollTopTarget}`);
                      if (tempSpan.parentNode) tempSpan.parentNode.removeChild(tempSpan);
                  } catch (e) {
                      logger.error("[PendingScrollEffect] Error inserting temp span or scrolling:", e);
                      if (bookElement.scrollHeight > bookElement.clientHeight) {
                          const scrollRatio = targetRenderedOffsetForPending / bookElement.textContent.length; // Approximate ratio
                          const targetScrollTopFallback = scrollRatio * (bookElement.scrollHeight - bookElement.clientHeight);
                          isProgrammaticScroll.current = true;
                          bookElement.scrollTop = Math.max(0, targetScrollTopFallback -20);
                          logger.info(`[PendingScrollEffect] Fallback scroll to ratio. Target scrollTop: ${bookElement.scrollTop}`);
                      } else {
                          isProgrammaticScroll.current = true; bookElement.scrollTop = 0;
                      }
                  }
                  foundTargetNodeForPendingScroll = true;
                  break;
              }
          }
          currentWalkerRenderedOffset += nodeRenderedLength;
      }
      
      if (!foundTargetNodeForPendingScroll) {
          logger.warn(`[PendingScrollEffect] Could not find exact node for pending rendered offset ${targetRenderedOffsetForPending}. Scrolling to top of page.`);
          isProgrammaticScroll.current = true;
          bookElement.scrollTop = 0;
      }

      setBookScrollPositionByPage(prev => ({ ...prev, [currentPage]: bookElement.scrollTop }));
      setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
      setPendingScrollOffsetInPage(null); 
    } else if (pendingScrollOffsetInPage !== null && bookPaneContainerRef.current && currentPageContent.length === 0 && pendingScrollOffsetInPage === 0) {
        isProgrammaticScroll.current = true;
        bookPaneContainerRef.current.scrollTop = 0;
        setBookScrollPositionByPage(prev => ({ ...prev, [currentPage]: 0 }));
        setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
        setPendingScrollOffsetInPage(null);
    }
  }, [currentPageContent, pendingScrollOffsetInPage, pageBoundaries, currentPage, viewMode]); // Added pageBoundaries, currentPage for setBookScrollPositionByPage

  // Effect to scroll to guide search highlight after content is rendered
  useEffect(() => {
    if (explicitPaginationInFlightRef.current) {
      return undefined;
    }
    if ((guideSearchText || guideSearchGlobalOffset !== null) && bookPaneContainerRef.current && highlightedPageContent) {
      const epochAtSchedule = bookPaneScrollEpochRef.current;
      // Small delay to ensure DOM is updated with highlighted content
      const scrollTimeout = setTimeout(() => {
        if (bookPaneScrollEpochRef.current !== epochAtSchedule) return;
        if (explicitPaginationInFlightRef.current) return;
        const highlightElement = bookPaneContainerRef.current?.querySelector('.guide-search-highlight');
        if (highlightElement) {
          logger.info(`[BookView - GuideSearchScroll] Scrolling to guide search highlight`);
          // Use instant scroll so a later page change is not overridden by smooth scrolling.
          highlightElement.scrollIntoView({ behavior: 'auto', block: 'center' });
          // Store ref for potential future use
          guideSearchHighlightRef.current = highlightElement;
        } else {
          const preview = typeof guideSearchText === 'string' ? guideSearchText.substring(0, 50) : '';
          logger.warn(`[BookView - GuideSearchScroll] Guide search highlight element not found. Search text: "${preview}"`);
        }
      }, 200);
      
      return () => clearTimeout(scrollTimeout);
    }
  }, [guideSearchText, guideSearchGlobalOffset, highlightedPageContent]);

  // Keep guide highlight around long enough to be visible, then clear it.
  useEffect(() => {
    if (!guideSearchText && guideSearchGlobalOffset === null && guideSegmentCutoffOffset === null) return undefined;
    const cleanupTimer = setTimeout(() => {
      setGuideSearchText(null);
      setGuideSearchGlobalOffset(null);
      setGuideSearchEndOffset(null);
      setGuideSegmentCutoffOffset(null);
    }, 8000);
    return () => clearTimeout(cleanupTimer);
  }, [guideSearchText, guideSearchGlobalOffset, guideSegmentCutoffOffset]);

  useEffect(() => {
    // This effect applies scrolling when a pendingScrollToPercentage is set,
    // typically after a page change initiated by selecting a bookmark.
    // It waits for currentPageContent to be updated, indicating the new page is rendered.
    if (viewMode !== 'original') {
      return undefined;
    }
    if (pendingScrollToPercentage !== null && bookPaneContainerRef.current && (currentPageContent.length > 0 || pendingScrollToPercentage === 0) ) {
      const element = bookPaneContainerRef.current;
      logger.info(`[BookView - PendingScrollPercentageEffect] Applying scroll to percentage: ${pendingScrollToPercentage} on page ${currentPage}`);
      
      // Ensure isProgrammaticScroll is true before this scroll operation
      // It should have been set by handleBookmarkSelect
      if (!isProgrammaticScroll.current) {
        logger.warn("[BookView - PendingScrollPercentageEffect] isProgrammaticScroll was false. Setting to true.");
        isProgrammaticScroll.current = true;
      }

      if (element.scrollHeight > element.clientHeight) { // Check if scrollable
        const targetScrollTop = pendingScrollToPercentage * (element.scrollHeight - element.clientHeight);
        element.scrollTop = targetScrollTop;
        logger.debug(`[BookView - PendingScrollPercentageEffect] Scrolled to ${targetScrollTop}px`);
      } else { // Not scrollable or content fits
        element.scrollTop = 0; // Go to top if not scrollable
        logger.debug(`[BookView - PendingScrollPercentageEffect] Pane not scrollable. Scrolled to top.`);
      }
      
      // Reset pending scroll percentage
      setPendingScrollToPercentage(null);
      // Reset programmatic scroll flag after a short delay
      const timer = setTimeout(() => { 
        isProgrammaticScroll.current = false; 
        logger.debug("[BookView - PendingScrollPercentageEffect] Reset isProgrammaticScroll to false.");
      }, 150); // Increased delay slightly
      return () => clearTimeout(timer);
    } else if (pendingScrollToPercentage !== null) {
      logger.debug(`[BookView - PendingScrollPercentageEffect] Conditions not met for scroll: pendingScrollToPercentage=${pendingScrollToPercentage}, bookPaneContainerRef.current=${!!bookPaneContainerRef.current}, currentPageContent.length=${currentPageContent.length}`);
    }
  }, [currentPageContent, pendingScrollToPercentage, currentPage, viewMode]); // Dependencies remain the same

  // Debounced function to save reading position (primarily for scroll)
  const debouncedSaveReadingPosition = useCallback(
    debounce((bookIdToSave, pageToSave, scrollTopToSave) => {
      if (bookIdToSave && typeof pageToSave === 'number' && typeof scrollTopToSave === 'number') {
        const position = { page: pageToSave, scrollTop: scrollTopToSave };
        setStoredReadingPosition(bookIdToSave, position);
        logger.debug(`[BookView - SavePosition] Saved position for book ${bookIdToSave}: Page ${pageToSave}, ScrollTop ${scrollTopToSave}`);
      }
    }, 1000), // Debounce for 1 second
    []
  );

  // Effect to save reading position on scroll and page change
  useEffect(() => {
    const tracked = getEffectiveScrollState();
    const trackedElements = tracked?.containers || [];

    const handleScroll = () => {
      const state = getEffectiveScrollState();
      if (state?.active && !isProgrammaticScroll.current && bookId) {
        debouncedSaveReadingPosition(bookId, currentPage, state.active.scrollTop);
      }
    };

    // On initial mount, we don't want to overwrite the saved scroll position.
    // On subsequent runs of this effect (due to currentPage changing), it's a page turn,
    // so we save the new page with scrollTop 0.
    if (isInitialMount.current) {
      isInitialMount.current = false;
    } else {
      if (bookId && currentPage) {
          const position = { page: currentPage, scrollTop: 0 };
          setStoredReadingPosition(bookId, position);
          logger.debug(`[BookView - PageChange] Saved page ${currentPage} with scrollTop 0 for book ${bookId}`);
      }
    }

    trackedElements.forEach((el) => el.addEventListener('scroll', handleScroll, { passive: true }));

    return () => {
      trackedElements.forEach((el) => el.removeEventListener('scroll', handleScroll));
      debouncedSaveReadingPosition.cancel();
    };
  }, [bookId, currentPage, debouncedSaveReadingPosition, getEffectiveScrollState, viewMode, readingRoadmap]);


  const handleBookmarkSelect = (event) => {
    const selectedValueFromEvent = event.target.value;
    // Log the raw value from the event
    logger.info("[BookView - handleBookmarkSelect] Dropdown changed. event.target.value:", selectedValueFromEvent);

    // Log the structure of the first bookmark to verify 'id' field and its type
    if (bookmarks && bookmarks.length > 0) {
        logger.debug("[BookView - handleBookmarkSelect] First bookmark in state (bookmarks[0]):", JSON.stringify(bookmarks[0], null, 2));
        logger.debug(`[BookView - handleBookmarkSelect] Type of event.target.value: ${typeof selectedValueFromEvent}`);
        logger.debug(`[BookView - handleBookmarkSelect] Type of bookmarks[0].id: ${typeof bookmarks[0].id}, Value: ${bookmarks[0].id}`);
    } else {
        logger.debug("[BookView - handleBookmarkSelect] Bookmarks array is empty or not yet populated.");
    }

    if (!selectedValueFromEvent) { // Check if the placeholder ("Jump to Bookmark...") was re-selected or value is empty
        logger.debug("[BookView - handleBookmarkSelect] No valid bookmark ID selected (likely placeholder).");
        return;
    }

    const selectedBookmark = bookmarks.find(b => {
        // Explicitly compare as strings, though both should ideally be strings already
        // logger.debug(`[BookView - handleBookmarkSelect] Comparing in find: "${String(b.id)}" (type: ${typeof b.id}) with "${String(selectedValueFromEvent)}" (type: ${typeof selectedValueFromEvent})`);
        return String(b.id) === String(selectedValueFromEvent);
    });

    if (selectedBookmark) {
      logger.info(`[BookView - handleBookmarkSelect] Successfully found bookmark: ID=${selectedBookmark.id}, Name='${selectedBookmark.name}', Page=${selectedBookmark.page_number}, Scroll%=${selectedBookmark.scroll_percentage}`);

      isProgrammaticScroll.current = true;

      if (selectedBookmark.page_number !== currentPage) {
        logger.debug(`[BookView - handleBookmarkSelect] Target page ${selectedBookmark.page_number} is different. Changing page.`);
        if (selectedBookmark.scroll_percentage !== null && selectedBookmark.scroll_percentage !== undefined) {
          setPendingScrollToPercentage(selectedBookmark.scroll_percentage);
        } else {
          setPendingScrollToPercentage(0);
        }
        if (viewMode !== 'original') {
          setViewMode('original');
        }
        setCurrentPage(selectedBookmark.page_number);
        refreshImageUrls(); // Refresh signed URLs when page changes
      } else {
        logger.debug(`[BookView - handleBookmarkSelect] Already on target page ${currentPage}. Scrolling directly.`);
        const state = getEffectiveScrollState();
        if (state?.active) {
          const element = state.active;
          const targetScroll = selectedBookmark.scroll_percentage !== null && selectedBookmark.scroll_percentage !== undefined ? selectedBookmark.scroll_percentage : 0;
          if (element.scrollHeight > element.clientHeight) {
            element.scrollTop = targetScroll * (element.scrollHeight - element.clientHeight);
          } else {
            element.scrollTop = 0;
          }
          logger.debug(`[BookView - handleBookmarkSelect] Scrolled directly. Target scroll percentage: ${targetScroll}`);
        } else {
          logger.warn("[BookView - handleBookmarkSelect] No active scroll container. Cannot scroll directly.");
        }
        setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
      }
      if (event.target) {
        event.target.value = ""; // Reset dropdown to placeholder
      }
    } else {
      logger.warn(`[BookView - handleBookmarkSelect] Bookmark with ID "${selectedValueFromEvent}" not found in current bookmarks list. List length: ${bookmarks.length}`);
    }
  };

  const handlePreviousPage = () => {
    const newPage = Math.max(1, currentPage - 1);
    if (newPage === currentPage) {
      return;
    }
    beginExplicitPagination(newPage);
    setCurrentPage(newPage);
    // Refresh signed URLs when page changes
    refreshImageUrls();
  };

  const handleNextPage = () => {
    const newPage = Math.min(totalPages, currentPage + 1);
    if (newPage === currentPage) {
      return;
    }
    beginExplicitPagination(newPage);
    setCurrentPage(newPage);
    // Refresh signed URLs when page changes
    refreshImageUrls();
  };

  const openAddBookmarkModal = () => {
    setNewBookmarkName(''); // Clear previous name
    setBookmarkError(null); // Clear previous error
    setShowAddBookmarkModal(true);
  };

  const closeAddBookmarkModal = () => {
    setShowAddBookmarkModal(false);
  };

  const handleSaveBookmark = async () => {
    setBookmarkError(null); // Clear error if any

    let currentScrollPercentage = 0; // Default to 0
    const state = getEffectiveScrollState();
    if (state?.active) {
      const { scrollTop, scrollHeight, clientHeight } = state.active;
      if (scrollHeight > clientHeight) { // Avoid division by zero if not scrollable
        currentScrollPercentage = scrollTop / (scrollHeight - clientHeight); // Value between 0.0 and 1.0
      } else if (scrollHeight === clientHeight && scrollHeight > 0) { // Content fits perfectly or is empty but scrollable
        currentScrollPercentage = 0; // Or 1.0 if you consider a full view as 100% "scrolled"
      }
    }

    const bookmarkData = {
      book_id: bookId,
      name: newBookmarkName.trim() || null, // Allow empty name - backend will generate default
      page_number: currentPage, // Assumes currentPage state is correctly maintained
      scroll_percentage: currentScrollPercentage,
      global_character_offset: selectedGlobalCharOffset || null, // Include global character offset for line calculation
    };

    logger.debug("Attempting to save bookmark with data:", bookmarkData);

    try {
      const token = getStoredAuthToken();
      if (!token) {
        setBookmarkError("Authentication token not found. Please log in to save bookmarks.");
        logger.warn("[BookView - handleSaveBookmark] Auth token not found.");
        return;
      }

      if (!navigator.onLine || isOfflineSnapshot) {
        const clientId = newLocalId();
        const localBookmark = {
          ...bookmarkData,
          id: clientId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          _localClientId: clientId,
        };
        setBookmarks((prev) => [...prev, localBookmark].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
        try {
          const ann = await getAnnotations(bookId);
          const next = [...(ann?.bookmarks || []), localBookmark];
          await putAnnotations(bookId, { bookmarks: next, notes: ann?.notes || [] });
          await addOutboxEntry({
            type: 'create_bookmark',
            bookId,
            payload: { clientId, ...bookmarkData },
          });
          await refreshOutboxCount();
        } catch (_e) { /* ignore */ }
        closeAddBookmarkModal();
        return;
      }

      const response = await fetch('/api/bookmarks/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(bookmarkData),
      });

      if (!response.ok) {
        if (response.status === 401) {
          const errorData = await response.json().catch(() => ({}));
          logger.error("Failed to save bookmark - API error (401):", errorData);
          throw new Error(errorData.detail || "Not authenticated to save bookmark. Please log in again.");
        }
        const errorData = await response.json();
        logger.error("Failed to save bookmark - API error:", errorData);
        throw new Error(errorData.detail || "Failed to save bookmark");
      }

      const savedBookmark = await response.json();
      logger.info("Bookmark saved successfully:", savedBookmark);
      closeAddBookmarkModal();
      fetchBookmarks(); // Refresh bookmarks list after saving a new one
    } catch (error) {
      logger.error("Error saving bookmark:", error);
      setBookmarkError(error.message);
    }
  };

  // --- UPDATED: Handler for reformatting content ---
  const handleReformatPage = async () => {
    if (serverOffline) {
      alert('Reformatting requires an internet connection.');
      return;
    }
    const reformatTarget = selectedBookText ? "the selected text" : `page ${currentPage}`;
    const confirmMessage = `Are you sure you want to reformat ${reformatTarget}? This will permanently replace the content with an AI-generated version and cannot be undone.`;

    if (!window.confirm(confirmMessage)) {
        return;
    }

    setIsReformatting(true);
    setReformatError(null);

    try {
        const token = getStoredAuthToken();
        if (!token) {
            throw new Error("Authentication token not found. Please log in.");
        }

        const payload = {};
        if (selectedBookText && selectedGlobalCharOffset !== null) {
            payload.selected_text = selectedBookText;
            payload.global_char_offset = selectedGlobalCharOffset;
        }

        const response = await fetch(`/api/books/${bookId}/reformat-page/${currentPage}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
        }

        const updatedBook = await response.json();
        
        if (updatedBook && updatedBook.markdown_content) {
            logger.info("[BookView - handleReformatPage] Successfully received reformatted content.");
            // Update the full markdown content state. This will trigger the useEffect
            // that recalculates page boundaries and updates the current page's content.
            setFullMarkdownContent(updatedBook.markdown_content);
            
            // Clear selection after reformatting
            setSelectedBookText(null);
            setSelectedGlobalCharOffset(null);
            
        } else {
            throw new Error("Reformat operation did not return new content.");
        }

    } catch (err) {
        logger.error("Failed to reformat content:", err);
        setReformatError(err.message);
        alert(`Error reformatting content: ${err.message}`);
    } finally {
        setIsReformatting(false);
    }
  };

  const isGuideMode = viewMode === 'guide';
  const handleSwitchToOriginalFromGuide = useCallback(() => {
    if (guideScrollContainerRef.current) {
      setGuideScrollPositionByPage((prev) => ({
        ...prev,
        [currentPage]: guideScrollContainerRef.current.scrollTop,
      }));
    }
    setViewMode('original');
  }, [currentPage]);

  useEffect(() => {
    if (!setNavBarExtra) {
      return undefined;
    }
    if (viewMode === 'guide' && isMobileView) {
      setNavBarExtra(
        <div className="navbar-guide-extra">
          <h3 className="navbar-guide-extra-title">Reading Roadmap</h3>
          <button
            type="button"
            className="navbar-guide-extra-switch"
            onClick={handleSwitchToOriginalFromGuide}
          >
            Switch to Original Text
          </button>
        </div>,
      );
      return () => setNavBarExtra(null);
    }
    setNavBarExtra(null);
    return undefined;
  }, [setNavBarExtra, viewMode, isMobileView, handleSwitchToOriginalFromGuide]);

  const toggleViewMode = () => {
    if (isGuideMode) {
      if (guideScrollContainerRef.current) {
        setGuideScrollPositionByPage((prev) => ({
          ...prev,
          [currentPage]: guideScrollContainerRef.current.scrollTop,
        }));
      }
      setViewMode('original');
    } else {
      if (bookPaneContainerRef.current) {
        setBookScrollPositionByPage((prev) => ({ ...prev, [currentPage]: bookPaneContainerRef.current.scrollTop }));
        bookPaneContainerRef.current.scrollTop = 0;
      }
      setViewMode('guide');
    }
    setShowBackToGuide(false);
    setGuideReturnItemId(null);
  };

  const viewModeSwitchEl = (
    <button
      type="button"
      className={`view-mode-switch ${isGuideMode ? 'is-guide' : 'is-original'}`}
      onClick={toggleViewMode}
      role="switch"
      aria-checked={isGuideMode}
      aria-label={`Switch to ${isGuideMode ? 'Original Text' : 'Reading Guide'} mode`}
      title={`Current mode: ${isGuideMode ? 'Reading Guide' : 'Original Text'}. Click to switch.`}
    >
      <span className="view-mode-switch-track" aria-hidden="true">
        <span className="view-mode-switch-label view-mode-switch-label--guide">Guide</span>
        <span className="view-mode-switch-label view-mode-switch-label--original">Original</span>
      </span>
      <span className="view-mode-switch-thumb" aria-hidden="true" />
    </button>
  );

  const floatingToolbarStyle = useMemo(() => {
    if (!bookPaneAreaFrame) return undefined;
    return {
      position: 'fixed',
      top: FLOATING_TOOLBAR_TOP_PX,
      left: bookPaneAreaFrame.left,
      width: bookPaneAreaFrame.width,
      zIndex: 1200,
    };
  }, [bookPaneAreaFrame]);

  const collapseBookToolbar = useCallback(() => {
    setBookControlsExpandedPersist(false);
    setIsBookViewMenuOpen(false);
  }, [setBookControlsExpandedPersist]);

  const expandBookToolbar = useCallback(() => {
    setBookControlsExpandedPersist(true);
  }, [setBookControlsExpandedPersist]);

  useLayoutEffect(() => {
    let cancelled = false;
    let rafId = 0;
    let teardown = () => {};

    const bind = () => {
      const onScroll = () => updateScrollToTopVisibility();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);

      const { containers: panes } = getTrackedScrollContainers();
      panes.forEach((p) => p.addEventListener('scroll', onScroll, { passive: true }));
      const ros = panes.map((p) => {
        const ro = new ResizeObserver(onScroll);
        ro.observe(p);
        return ro;
      });
      onScroll();

      teardown = () => {
        panes.forEach((p) => p.removeEventListener('scroll', onScroll));
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        ros.forEach((ro) => ro.disconnect());
      };
      return panes.length > 0;
    };

    const attempt = (attemptsLeft) => {
      if (cancelled) return;
      teardown();
      teardown = () => {};
      const ok = bind();
      if (!ok && attemptsLeft > 0) {
        rafId = requestAnimationFrame(() => attempt(attemptsLeft - 1));
      }
    };

    attempt(viewMode === 'guide' ? 40 : 12);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      teardown();
    };
  }, [
    viewMode,
    currentPage,
    readingRoadmap,
    guideLoading,
    highlightedPageContent,
    getTrackedScrollContainers,
    updateScrollToTopVisibility,
  ]);

  if (loading) return <div style={{ padding: '20px' }}>Loading book...</div>;
  if (error) return <div style={{ padding: '20px', color: 'red' }}>Error loading book: {error}</div>;
  if (!bookData) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h2>Book Not Found</h2>
        <p>The book with ID "{bookId}" could not be found.</p>
        <div style={{ marginTop: '20px' }}>
          <Link to="/">Go back to the Book List</Link> | <Link to="/upload">Upload a New Book</Link>
        </div>
      </div>
    );
  }
  if (bookData.status !== 'completed') {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h2>{bookData.title || bookData.original_filename}</h2>
        <p>Status: {bookData.status || 'unknown'}</p>
        {(bookData.status === 'processing' || bookData.status === 'pending') && (
          <p>Processing your book...</p>
        )}
        {bookData.status === 'failed' && (
          <p style={{ color: 'red' }}>Processing failed.</p>
        )}
        <div style={{ marginTop: '20px' }}>
          <Link to="/">Go back to the Book List</Link> | <Link to="/upload">Upload a New Book</Link>
        </div>
      </div>
    );
  }
  if (bookData.status === 'completed' && !fullMarkdownContent) {
    return (
      <div style={{ padding: '20px', color: 'orange', textAlign: 'center' }}>
        <h2>{bookData.title || bookData.original_filename}</h2>
        <p>Status: Completed, but content could not be loaded.</p>
        <div style={{ marginTop: '20px' }}>
          <Link to="/">Go back to the Book List</Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className="book-view-container"
      ref={bookViewContainerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        flex: '1 1 0%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {serverOffline && (
        <div
          role="status"
          className="theme-offline-banner"
          style={{
            width: '100%',
            padding: '8px 16px',
            borderBottom: '1px solid var(--color-warning-text)',
            fontSize: '14px',
            flexShrink: 0,
            marginBottom: 0,
          }}
        >
          {outboxPendingCount > 0
            ? 'Offline — edits will sync when you’re back online.'
            : (isOfflineSnapshot
              ? 'Offline — showing cached book.'
              : 'Offline — this tab can keep reading current content, but uncached books require one online load first.')}
        </div>
      )}
      {/* Main Content Area (Book/Guide and Notes) */}
      <div
        className="main-content-area"
        ref={mainContentAreaRef} // Ref for the resizer context
        style={{
          flex: '1 1 0%',
          flexDirection: isMobileView ? 'column' : 'row',
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          minWidth: !isMobileView ? 0 : undefined,
        }}
      >
        {/* Book Pane Area */}
        <div 
          className="book-pane-area"
          ref={bookPaneAreaRef} // Ref for the resizable area
          style={{
            flex: '1 1 0%',
            width: isMobileView ? '100%' : undefined, // Full width on mobile
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {/* .book-pane-wrapper is the existing structure inside book-pane-area */}
          <div className="book-pane-wrapper">
            <div
              className="book-pane-container"
            >
              {floatingToolbarStyle && createPortal(
                <div
                  ref={bookToolbarWrapperRef}
                  className="book-floating-toolbar-shell"
                  style={floatingToolbarStyle}
                >
                  <div className={`book-floating-toolbar ${bookControlsExpanded ? 'is-expanded' : 'is-collapsed'}`}>
                    <div className="book-floating-toolbar-panel">
                      <div className="book-pane-controls-header">
                        <div className="left-controls-group">
                          <div className="book-view-menu-container" ref={bookViewMenuRef}>
                            <button
                              ref={bookViewMenuButtonRef}
                              type="button"
                              onClick={() => setIsBookViewMenuOpen((prev) => !prev)}
                              className="control-button book-view-menu-button"
                              aria-haspopup="true"
                              aria-expanded={isBookViewMenuOpen}
                            >
                              Menu <span className={`arrow ${isBookViewMenuOpen ? 'up' : 'down'}`} />
                            </button>
                            {isBookViewMenuOpen && bookViewMenuPopperStyle
                              ? createPortal(
                                <div
                                  ref={bookViewMenuPortalRef}
                                  className="book-view-dropdown-menu book-view-dropdown-menu--portal"
                                  style={bookViewMenuPopperStyle}
                                >
                                  {bookmarks.length > 0 && (
                                    <div className="dropdown-item-select-container">
                                      <label htmlFor="jump-to-bookmark-select-menu" className="sr-only">Jump to Bookmark</label>
                                      <select
                                        id="jump-to-bookmark-select-menu"
                                        onChange={(e) => { handleBookmarkSelect(e); setIsBookViewMenuOpen(false); }}
                                        className="bookmark-select dropdown-item-select control-button"
                                        defaultValue=""
                                        aria-label="Jump to bookmark"
                                      >
                                        <option value="" disabled>Jump to Bookmark...</option>
                                        {bookmarks.map((bookmark) => (
                                          <option key={bookmark.id} value={bookmark.id}>
                                            {bookmark.name ? `${bookmark.name} (P${bookmark.page_number})` : `Page ${bookmark.page_number} (Unnamed)`}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => { setShowManageBookmarksModal(true); setIsBookViewMenuOpen(false); }}
                                    className="dropdown-item control-button"
                                  >
                                    Manage Bookmarks
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { handleReformatPage(); setIsBookViewMenuOpen(false); }}
                                    className="dropdown-item control-button"
                                    disabled={isReformatting || serverOffline}
                                    title={selectedBookText ? 'Reformat selected text with AI.' : 'Reformat current page with AI. This cannot be undone.'}
                                  >
                                    {isReformatting ? 'Reformatting...' : (selectedBookText ? 'Reformat Selection' : 'Reformat Page')}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { setShowAllNotesModal(true); setIsBookViewMenuOpen(false); }}
                                    className="dropdown-item control-button"
                                  >
                                    Review Notes
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { setNotesLLMPopupMode('llm'); setIsBookViewMenuOpen(false); }}
                                    className="dropdown-item control-button"
                                  >
                                    Ask LLM
                                  </button>
                                </div>,
                                document.body,
                              )
                              : null}
                          </div>
                          {viewModeSwitchEl}
                          <button
                            type="button"
                            onClick={openAddBookmarkModal}
                            className="control-button"
                            title="Add a bookmark at current location"
                          >
                            Add Bookmark
                          </button>
                          <button
                            type="button"
                            onClick={() => setNotesLLMPopupMode('note')}
                            className="control-button"
                            title="Add a note at current selection or location"
                          >
                            Add note
                          </button>
                        </div>
                        {totalPages > 1 && (
                          <div className="pagination-controls header-pagination">
                            <button type="button" onClick={handlePreviousPage} disabled={currentPage === 1} className="control-button">
                              Previous
                            </button>
                            <form onSubmit={handleGoToPage} className="page-input-form">
                              <span> Page </span>
                              <input
                                type="number"
                                value={pageInput}
                                onChange={handlePageInputChange}
                                onBlur={handleGoToPage}
                                min="1"
                                max={totalPages}
                                className="page-input"
                              />
                              <span> of {totalPages} </span>
                            </form>
                            <button type="button" onClick={handleNextPage} disabled={currentPage === totalPages} className="control-button">
                              Next
                            </button>
                          </div>
                        )}
                        {totalPages <= 1 && <div className="pagination-controls-placeholder" />}
                        <div className="right-controls-group">
                          <div className="font-controls-group">
                            <button type="button" onClick={decreaseFontSize} className="font-control-btn" title="Decrease font size">A-</button>
                            <span className="font-controls-value">{fontSize}px</span>
                            <button type="button" onClick={increaseFontSize} className="font-control-btn" title="Increase font size">A+</button>
                            <span className="font-controls-separator" />
                            <button type="button" onClick={decreaseLineHeight} className="font-control-btn" title="Decrease line spacing">LH-</button>
                            <span className="font-controls-value">{lineHeight.toFixed(1)}</span>
                            <button type="button" onClick={increaseLineHeight} className="font-control-btn" title="Increase line spacing">LH+</button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="control-button book-toolbar-toggle-btn book-toolbar-toggle-btn--floating"
                      onClick={bookControlsExpanded ? collapseBookToolbar : expandBookToolbar}
                      aria-expanded={bookControlsExpanded}
                      aria-label={bookControlsExpanded ? 'Hide full toolbar' : 'Show full toolbar'}
                      title={bookControlsExpanded ? 'Hide full toolbar' : 'Show full toolbar'}
                    >
                      {bookControlsExpanded ? '▶' : '◀'}
                    </button>
                  </div>
                </div>,
                document.body,
              )}

              <div
                className={`book-pane-body${viewMode === 'guide' ? ' book-pane-body--guide-scroll' : ''}`}
                ref={bookPaneContainerRef}
              >
              {viewMode === 'guide' ? (
                <ReadingGuidePane
                  roadmap={readingRoadmap}
                  guidesList={guidesList}
                  activeGuideId={activeGuideId}
                  maxGuides={MAX_READING_GUIDES}
                  onSwitchGuide={handleSwitchGuide}
                  onCreateGuide={handleCreateGuide}
                  onDeleteGuide={handleDeleteGuide}
                  completedIds={completedRoadmapIds}
                  onGenerateRoadmap={handleGenerateRoadmap}
                  onToggleProgress={handleToggleRoadmapProgress}
                  isLoading={guideLoading}
                  error={guideError}
                  isVisible={true}
                  hasRoadmap={hasRoadmap}
                  isGenerating={isGeneratingGuide}
                  serverActionsDisabled={serverOffline}
                  onSendCardChat={handleSendCardChat}
                  onLoadCardChat={handleLoadCardChat}
                  onClearCardChat={handleClearCardChat}
                  onGuideTextLink={(textLink) => {
                    const scrollTop = guideScrollContainerRef.current?.scrollTop ?? 0;
                    setGuideScrollPositionByPage((prev) => ({ ...prev, [currentPage]: scrollTop }));
                    setGuideScrollToRestoreOnBack(scrollTop);
                    setGuideReturnItemId(textLink.sourceItemId != null ? String(textLink.sourceItemId) : null);
                    navigatingFromGuideTextLinkRef.current = true;
                    setShowBackToGuide(true);
                    setViewMode('original');
                    handleGuideTextLink(textLink);
                  }}
                  onGenerateGraph={handleGenerateCardGraph}
                  graphLoadingById={graphLoadingById}
                  onGenerateAlternativeReading={handleGenerateAlternativeReading}
                  onBulkGenerateRoadmap={handleBulkRoadmapGenerate}
                  alternativeLoadingById={alternativeLoadingById}
                  onGenerateOutsiderGuide={handleGenerateOutsiderGuide}
                  outsiderLoadingById={outsiderLoadingById}
                  roadmapBulkJob={roadmapBulkJob}
                  onSwitchToOriginal={handleSwitchToOriginalFromGuide}
                  scrollContainerRef={guideScrollContainerRef}
                  scrollPositionToRestore={guideScrollToRestoreOnBack ?? guideScrollPositionByPage[currentPage] ?? 0}
                  hideHeader={isMobileView && viewMode === 'guide'}
                  mobileChromeHidden={mobileChromeHidden}
                  embedInMainArea={true}
                  focusItemId={guideReturnItemId}
                  onRoadmapReturnFocusDone={handleRoadmapReturnFocusDone}
                />
              ) : (
                <BookPane
                  markdownContent={highlightedPageContent}
                  imageUrls={bookData.image_urls}
                  onTextSelect={handleTextSelect}
                  onHighlightClick={handleHighlightClick}
                  fontSize={fontSize}
                  lineHeight={lineHeight}
                />
              )}
              </div>
              {/* Floating "Back to Reading Guide" button when user navigated from guide */}
              {viewMode === 'original' && showBackToGuide && (
                <button
                  type="button"
                  className="back-to-guide-floating-btn"
                  onClick={() => {
                    if (bookPaneContainerRef.current) {
                      setBookScrollPositionByPage((prev) => ({ ...prev, [currentPage]: bookPaneContainerRef.current.scrollTop }));
                      bookPaneContainerRef.current.scrollTop = 0;
                    }
                    setViewMode('guide');
                    setShowBackToGuide(false);
                  }}
                >
                  Back to Reading Guide
                </button>
              )}
              {showScrollToTopButton &&
                typeof document !== 'undefined' &&
                createPortal(
                  <button
                    type="button"
                    className={`scroll-to-top-floating-btn ${viewMode === 'original' && showBackToGuide ? 'with-back-guide-btn' : ''}`}
                    onClick={handleScrollToTop}
                    aria-label="Scroll to top"
                    title="Scroll to top"
                  >
                    <span className="scroll-to-top-floating-btn__icon" aria-hidden="true">
                      ▲
                    </span>
                  </button>,
                  document.body,
                )}
            </div>
          </div>
        </div>

    </div> {/* End of main-content-area */}

    {/* Note popup modal */}
    {notesLLMPopupMode === 'note' && (
      <div className="modal-overlay" onClick={() => setNotesLLMPopupMode(null)}>
        <div className="modal-content note-llm-popup-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Add note</h2>
            <button onClick={() => setNotesLLMPopupMode(null)} className="close-button" aria-label="Close">✕</button>
          </div>
          <div className="modal-body modal-body-scrollable">
            <NotePane
              bookId={bookId}
              selectedBookText={selectedBookText}
              selectedScrollPercentage={selectedScrollPercentage}
              selectedGlobalCharOffset={selectedGlobalCharOffset}
              currentPage={currentPage}
              currentPageContent={currentPageContent}
              onNewNoteSaved={handleNewNoteSaved}
              offline={serverOffline}
              onOfflineNoteSave={handleOfflineNoteSave}
              mode="note"
              embedInModal
              onClose={() => setNotesLLMPopupMode(null)}
            />
          </div>
        </div>
      </div>
    )}

    {/* LLM popup modal */}
    {notesLLMPopupMode === 'llm' && (
      <div className="modal-overlay" onClick={() => setNotesLLMPopupMode(null)}>
        <div className="modal-content note-llm-popup-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Ask LLM</h2>
            <button onClick={() => setNotesLLMPopupMode(null)} className="close-button" aria-label="Close">✕</button>
          </div>
          <div className="modal-body modal-body-scrollable">
            <NotePane
              bookId={bookId}
              selectedBookText={selectedBookText}
              selectedScrollPercentage={selectedScrollPercentage}
              selectedGlobalCharOffset={selectedGlobalCharOffset}
              currentPage={currentPage}
              currentPageContent={currentPageContent}
              onNewNoteSaved={handleNewNoteSaved}
              offline={serverOffline}
              onOfflineNoteSave={handleOfflineNoteSave}
              mode="llm"
              embedInModal
              onClose={() => setNotesLLMPopupMode(null)}
            />
          </div>
        </div>
      </div>
    )}

    {/* Add Bookmark Modal - Rendered conditionally (MOVED HERE) */}
    {showAddBookmarkModal && (
      <div className="modal-overlay">
        <div className="modal-content">
          <h2>Add Bookmark</h2>
          <input
            type="text"
            value={newBookmarkName}
            onChange={(e) => setNewBookmarkName(e.target.value)}
            placeholder="Enter bookmark name (optional - default: Page X, Line Y)"
            className="bookmark-name-input"
            aria-label="Bookmark name"
          />
          {bookmarkError && <p className="error-message">{bookmarkError}</p>}
          <div className="modal-actions">
            <button onClick={handleSaveBookmark} className="button-primary">Save</button>
            <button onClick={closeAddBookmarkModal} className="button-secondary">Cancel</button>
          </div>
        </div>
      </div>
    )}

    {/* Manage Bookmarks Modal - (MOVED HERE) */}
    {showManageBookmarksModal && (
      <div className="modal-overlay">
        <div className="modal-content manage-bookmarks-modal">
          <h2>Manage Bookmarks</h2>
          {bookmarks.length === 0 ? (
            <p>No bookmarks to manage.</p>
          ) : (
            <ul className="manage-bookmarks-list">
              {bookmarks.map(bookmark => (
                <li key={bookmark.id} className="manage-bookmark-item">
                  <span>
                    {bookmark.name ? `${bookmark.name} (P${bookmark.page_number})` : `Page ${bookmark.page_number} (Unnamed)`}
                  </span>
                  <button
                    onClick={() => handleDeleteBookmark(bookmark.id)}
                    className="delete-button delete-bookmark-button"
                    title="Delete this bookmark"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <button onClick={() => setShowManageBookmarksModal(false)} className="button-secondary">Close</button>
          </div>
        </div>
      </div>
    )}

    {showAllNotesModal && (
      <AllNotesModal
        notes={notes}
        onClose={() => setShowAllNotesModal(false)}
        onNoteClick={handleNoteClick}
        onDeleteNote={handleDeleteNote}
      />
    )}

    {activeNoteForModal && (
      <NoteDisplayModal
        note={activeNoteForModal}
        onClose={() => setActiveNoteForModal(null)}
        onDelete={(noteId) => {
          handleDeleteNote(noteId);
          setActiveNoteForModal(null); // Close modal after deletion is initiated
        }}
      />
    )}
  </div> // End of book-view-container
  );
}

export default BookView;
