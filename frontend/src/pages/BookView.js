import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import BookPane from '../components/BookPane';
import NotePane from '../components/NotePane';
import { debounce } from 'lodash';
import './BookView.css';
import logger from '../utils/logger'; // Ensure logger is imported

const APPROX_CHARS_PER_PAGE = 5000; // Approximate target characters per page

// Function to escape regex special characters
function escapeRegExp(string) {
  if (typeof string !== 'string') {
    return '';
  }
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
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

function BookView() {
  const { bookId } = useParams();
  const [bookData, setBookData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Refs for the scrollable container divs
  const bookPaneContainerRef = useRef(null);
  const notePaneContainerRef = useRef(null);
  const isProgrammaticScroll = useRef(false);
  const fullMarkdownContent = useRef(''); // To store the full markdown

  const [selectedBookText, setSelectedBookText] = useState(null);
  const [selectedScrollPercentage, setSelectedScrollPercentage] = useState(null);
  const [selectedGlobalCharOffset, setSelectedGlobalCharOffset] = useState(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPageContent, setCurrentPageContent] = useState(''); // Original content for logic
  const [highlightedPageContent, setHighlightedPageContent] = useState(''); // Content with highlights for rendering
  const [pageInput, setPageInput] = useState('');
  const [pageBoundaries, setPageBoundaries] = useState([]);

  const [scrollToGlobalOffset, setScrollToGlobalOffset] = useState(null);
  const [pendingScrollOffsetInPage, setPendingScrollOffsetInPage] = useState(null);

  const [notes, setNotes] = useState([]); // State to store notes for the current book

  // Ref for the temporary highlight span used for scrolling to a note
  const scrollTargetHighlightRef = useRef(null);

  // State for Add Bookmark Modal
  const [showAddBookmarkModal, setShowAddBookmarkModal] = useState(false);
  const [newBookmarkName, setNewBookmarkName] = useState('');
  const [bookmarkError, setBookmarkError] = useState(null);
  const [bookmarks, setBookmarks] = useState([]); 
  const [pendingScrollToPercentage, setPendingScrollToPercentage] = useState(null); // New state for bookmark jump

  // State and Refs for Resizing
  const [bookPaneFlexBasis, setBookPaneFlexBasis] = useState('50%'); // Initial width as percentage
  const bookViewContainerRef = useRef(null); // Ref for the main flex container
  const bookPaneAreaRef = useRef(null);      // Ref for the book-pane-area div

  const isResizing = useRef(false);
  const dragStartX = useRef(0);
  const initialBookPaneWidthPx = useRef(0);

  const [showManageBookmarksModal, setShowManageBookmarksModal] = useState(false); // ADD THIS STATE
  const [isNotePaneVisible, setIsNotePaneVisible] = useState(true); // For desktop side-by-side
  const [showNotesPanelOnMobile, setShowNotesPanelOnMobile] = useState(false); // For mobile overlay
  const [isMobileView, setIsMobileView] = useState(window.innerWidth <= 768); // ADD THIS LINE, initialize directly
  const [isBookmarkMenuOpen, setIsBookmarkMenuOpen] = useState(false);
  const bookmarkMenuRef = useRef(null); // For detecting clicks outside


  const fetchBook = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('authToken');
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
        const errorData = await response.json();
        if (response.status === 401) { // Handle specific 401 error
          setError("Not authenticated. Please log in again.");
          // Optionally, redirect to login or clear token
          // localStorage.removeItem('authToken'); 
          // window.location.href = '/login';
        } else if (response.status === 404) {
          setBookData(null);
          return;
        }
        throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || response.statusText}`);
      }
      const data = await response.json();
      setBookData(data);
      if (data && data.markdown_content) {
        fullMarkdownContent.current = data.markdown_content;
        // Calculate page boundaries
        const calculatedBoundaries = calculatePageBoundaries(fullMarkdownContent.current, APPROX_CHARS_PER_PAGE);
        setPageBoundaries(calculatedBoundaries);
        setTotalPages(Math.max(1, calculatedBoundaries.length)); // Ensure totalPages is at least 1
        // setCurrentPage(1); // Ensure currentPage is reset to 1 when new book loads
      } else {
        fullMarkdownContent.current = '';
        setPageBoundaries([]);
        setTotalPages(1);
        // setCurrentPage(1);
      }
    } catch (err) {
      logger.error('Failed to fetch book:', err);
      setError(`Failed to load book: ${err.message || 'Unknown error'}`);
      setBookData(null);
      fullMarkdownContent.current = '';
    } finally {
      setLoading(false);
    }
  };

  const fetchBookmarks = async () => {
    if (!bookId) return;
    try {
      const token = localStorage.getItem('authToken');
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
      setBookmarks(processedBookmarks);
      logger.info("Processed and set bookmarks:", processedBookmarks);

    } catch (err) {
      logger.error('Error fetching bookmarks:', err);
      setBookmarks([]); // Reset bookmarks on error
    }
  };

  const handleDeleteBookmark = async (bookmarkIdToDelete) => {
    if (!window.confirm("Are you sure you want to delete this bookmark?")) {
      return;
    }
    logger.info(`[BookView - handleDeleteBookmark] Attempting to delete bookmark ID: ${bookmarkIdToDelete}`);
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        alert("Authentication token not found. Please log in to delete bookmarks.");
        logger.warn("[BookView - handleDeleteBookmark] Auth token not found.");
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
      fetchBook();
      fetchBookmarks();
      setCurrentPage(1); // Reset to page 1 for new book
      setPageInput('1'); // Reset page input field
    }
  }, [bookId]);

  // Resizer Event Handlers
  const handleDocumentMouseMove = useCallback((e) => {
      if (!isResizing.current || !bookViewContainerRef.current || !bookPaneAreaRef.current) {
          return;
      }
      e.preventDefault();

      const deltaX = e.clientX - dragStartX.current;
      let newWidthPx = initialBookPaneWidthPx.current + deltaX;

      const containerWidth = bookViewContainerRef.current.offsetWidth;
      // Define minimum width for each pane (e.g., 200px or 20% of container width, whichever is larger)
      const minPaneWidth = Math.max(200, containerWidth * 0.20); 
      const maxPaneWidth = containerWidth - minPaneWidth; 

      newWidthPx = Math.max(minPaneWidth, Math.min(newWidthPx, maxPaneWidth));
      setBookPaneFlexBasis(`${newWidthPx}px`); // Set flex-basis in pixels
  }, []); 

  const handleDocumentMouseUp = useCallback(() => {
      if (!isResizing.current) {
          return;
      }
      isResizing.current = false;
      document.body.classList.remove('resizing-no-select');
      document.removeEventListener('mousemove', handleDocumentMouseMove);
      document.removeEventListener('mouseup', handleDocumentMouseUp);
  }, [handleDocumentMouseMove]); 

  const handleMouseDownOnResizer = useCallback((e) => {
      if (!bookPaneAreaRef.current) return;

      isResizing.current = true;
      dragStartX.current = e.clientX;
      initialBookPaneWidthPx.current = bookPaneAreaRef.current.offsetWidth;
      e.preventDefault(); 

      document.body.classList.add('resizing-no-select');
      document.addEventListener('mousemove', handleDocumentMouseMove);
      document.addEventListener('mouseup', handleDocumentMouseUp);
  }, [handleDocumentMouseMove, handleDocumentMouseUp]);

  // Cleanup useEffect for global event listeners
  useEffect(() => {
      return () => {
          if (isResizing.current) {
              document.body.classList.remove('resizing-no-select');
              document.removeEventListener('mousemove', handleDocumentMouseMove);
              document.removeEventListener('mouseup', handleDocumentMouseUp);
          }
      };
  }, [handleDocumentMouseMove, handleDocumentMouseUp]);

  useEffect(() => { // ADD THIS useEffect BLOCK
    const checkMobileView = () => {
      setIsMobileView(window.innerWidth <= 768);
    };
    // checkMobileView(); // Already initialized in useState
    window.addEventListener('resize', checkMobileView);
    return () => window.removeEventListener('resize', checkMobileView);
  }, []);

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
        const token = localStorage.getItem('authToken');
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
        setNotes(notesData);
      } catch (err) {
        logger.error('Error fetching notes:', err);
        setNotes([]); // Reset notes on error
      }
    };

    fetchNotes();
  }, [bookId]);

  // Effect for handling pagination logic AND highlighting when bookData, currentPage, or notes change
  useEffect(() => {
    logger.debug("[BookView - Page Content Effect] Running. Current Page:", currentPage, "Notes count:", notes.length, "PendingScrollOffsetInPage:", pendingScrollOffsetInPage, "PendingScrollToPercentage:", pendingScrollToPercentage, "PageBoundaries Length:", pageBoundaries.length);
    if (fullMarkdownContent.current && pageBoundaries.length > 0) { // Check pageBoundaries
      const numPages = totalPages; // Use totalPages from state (derived from pageBoundaries)

      const validCurrentPage = Math.max(1, Math.min(currentPage, numPages || 1));
      if (currentPage !== validCurrentPage) {
        logger.warn(`[BookView - Page Content Effect] currentPage ${currentPage} was invalid for numPages ${numPages}. Setting to ${validCurrentPage}`);
        setCurrentPage(validCurrentPage); 
        return; 
      }
      
      const pageIndex = validCurrentPage - 1;
      if (pageIndex < 0 || pageIndex >= pageBoundaries.length) {
          logger.error(`[BookView - Page Content Effect] Invalid pageIndex ${pageIndex} for pageBoundaries length ${pageBoundaries.length}. CurrentPage: ${currentPage}`);
          setHighlightedPageContent("Error: Page data not found.");
          setCurrentPageContent("");
          return;
      }
      const { start: pageStartGlobalOffset, end: pageEndGlobalOffset } = pageBoundaries[pageIndex];
      
      const plainPageText = fullMarkdownContent.current.substring(pageStartGlobalOffset, pageEndGlobalOffset);
      setCurrentPageContent(plainPageText); 
      logger.debug(`[BookView - Page Content Effect] Page ${validCurrentPage}: Global Offset [${pageStartGlobalOffset}-${pageEndGlobalOffset}]. Plain text (len: ${plainPageText.length}): "${plainPageText.substring(0, 100)}..."`);

      // REMOVE NOTE HIGHLIGHTING LOGIC:
      // The entire block that filters `relevantNotes` and builds `newHighlightedString`
      // by adding <span class="highlighted-note-text">...</span> is removed.
      // Instead, just set highlightedPageContent to plainPageText.
      setHighlightedPageContent(plainPageText);
      logger.debug(`[BookView - Page Content Effect] Set page content without note highlighting.`);
      
      // Conditional scroll to top:
      if (bookPaneContainerRef.current) {
        if (pendingScrollOffsetInPage === null && pendingScrollToPercentage === null) {
            if (!isProgrammaticScroll.current) { 
                logger.debug("[BookView - Page Content Effect] Conditions met for scroll-to-top. Scrolling to top.");
                isProgrammaticScroll.current = true; 
                bookPaneContainerRef.current.scrollTop = 0;
                setTimeout(() => { 
                    isProgrammaticScroll.current = false; 
                    logger.debug("[BookView - Page Content Effect] Reset isProgrammaticScroll from scroll-to-top action.");
                }, 100); 
            } else {
                logger.debug("[BookView - Page Content Effect] Scroll-to-top conditions met, BUT isProgrammaticScroll.current is true. Skipping.");
            }
        } else {
            logger.debug("[BookView - Page Content Effect] A scroll is pending. Skipping automatic scroll to top.");
        }
      }

    } else if (fullMarkdownContent.current && pageBoundaries.length === 0) {
        logger.warn("[BookView - Page Content Effect] fullMarkdownContent exists but pageBoundaries is empty. This might be initial load. Displaying placeholder or first chunk.");
        // Fallback: display first chunk if boundaries aren't ready (should be brief)
        const tempEndOffset = Math.min(APPROX_CHARS_PER_PAGE, fullMarkdownContent.current.length);
        const tempPageText = fullMarkdownContent.current.substring(0, tempEndOffset);
        setCurrentPageContent(tempPageText);
        setHighlightedPageContent(tempPageText);
        if (totalPages !== 1) setTotalPages(1); // Temporary total pages
        if (currentPage !== 1) setCurrentPage(1); // Temporary current page
    } else { // No fullMarkdownContent.current or other invalid state
      logger.debug("[BookView - Page Content Effect] No fullMarkdownContent or pageBoundaries not ready. Clearing page content.");
      setCurrentPageContent('');
      setHighlightedPageContent('');
      // setTotalPages(1); // Keep totalPages as is, or reset if book becomes invalid
      // setCurrentPage(1); 
    }
  // Add pendingScrollToPercentage to the dependency array
  }, [bookData, currentPage, notes, pendingScrollOffsetInPage, pendingScrollToPercentage, pageBoundaries, totalPages]); // Added pageBoundaries and totalPages


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
      setCurrentPage(pageNum);
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
        if (pageBoundaries.length > 0 && pageIndex >= 0 && pageIndex < pageBoundaries.length) {
            currentPageStartOffset = pageBoundaries[pageIndex].start;
        } else {
            logger.warn(`[BookView - handleTextSelect] pageBoundaries not ready or invalid currentPage for offset calculation. Using fallback. CurrentPage: ${currentPage}, Boundaries Length: ${pageBoundaries.length}`);
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
        if (pageBoundaries.length > 0 && pageIndex >= 0 && pageIndex < pageBoundaries.length) {
            fallbackPageStartOffset = pageBoundaries[pageIndex].start;
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

  const handleNoteClick = (globalCharOffsetOfNote) => {
    if (globalCharOffsetOfNote !== null && globalCharOffsetOfNote !== undefined) {
      setScrollToGlobalOffset(globalCharOffsetOfNote);
    }
  };
  
  const handleNewNoteSaved = (newNote) => {
    logger.debug("[BookView - handleNewNoteSaved] Received new note:", newNote);
    if (newNote && newNote.id) { 
      setNotes(prevNotes => {
        const noteExists = prevNotes.some(note => note.id === newNote.id);
        if (noteExists) {
            logger.warn("[BookView - handleNewNoteSaved] Note ID", newNote.id, "already exists in state. Not adding again.");
            return prevNotes;
        }
        const updatedNotes = [...prevNotes, newNote].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        logger.debug("[BookView - handleNewNoteSaved] Updated notes state with new note:", updatedNotes.map(n => n.id));
        return updatedNotes;
      });
    } else {
        logger.warn("[BookView - handleNewNoteSaved] Received invalid newNote object or note without ID:", newNote);
    }
  };

  // Effect for scrolling to a note when scrollToGlobalOffset changes
  useEffect(() => {
    if (scrollToGlobalOffset === null || !fullMarkdownContent.current || pageBoundaries.length === 0) { // Check pageBoundaries
      if (scrollToGlobalOffset !== null) {
        logger.debug(`[ScrollToNoteEffect] Aborting: scrollToGlobalOffset=${scrollToGlobalOffset}, fullMarkdownContent.current=${!!fullMarkdownContent.current}, pageBoundaries.length=${pageBoundaries.length}`);
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
              highlightRange.setEnd(textNode, Math.min(nodeRenderedLength, startOffsetInNodeRendered + 5)); 

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
                highlightSpan.style.backgroundColor = 'rgba(255, 255, 0, 0.5)'; 
                setTimeout(() => { if (highlightSpan) { highlightSpan.style.backgroundColor = ''; } }, 1500); 

              } catch (e) {
                logger.error("[ScrollToNoteEffect] Error inserting highlight span or scrolling (surroundContents failed):", e);
                // Fallback logic
                try {
                    const markerSpan = document.createElement("span");
                    markerSpan.className = 'highlighted-note-scroll-target-marker';
                    markerSpan.style.outline = "2px solid red"; 
                    markerSpan.style.backgroundColor = "rgba(255, 0, 0, 0.2)";
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

  }, [scrollToGlobalOffset, fullMarkdownContent, currentPage, currentPageContent, pageBoundaries]); // Added pageBoundaries


  useEffect(() => {
    // This effect handles scrolling when a page changes due to a note click (scrollToGlobalOffset)
    // pendingScrollOffsetInPage is the RAW character offset within the NEWLY loaded currentPageContent
    if (pendingScrollOffsetInPage !== null && bookPaneContainerRef.current && currentPageContent.length > 0 && pageBoundaries.length > 0) {
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

      setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
      setPendingScrollOffsetInPage(null); 
    } else if (pendingScrollOffsetInPage !== null && bookPaneContainerRef.current && currentPageContent.length === 0 && pendingScrollOffsetInPage === 0) {
        isProgrammaticScroll.current = true;
        bookPaneContainerRef.current.scrollTop = 0;
        setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
        setPendingScrollOffsetInPage(null);
    }
  }, [currentPageContent, pendingScrollOffsetInPage, pageBoundaries]); // Added pageBoundaries

  useEffect(() => {
    // This effect applies scrolling when a pendingScrollToPercentage is set,
    // typically after a page change initiated by selecting a bookmark.
    // It waits for currentPageContent to be updated, indicating the new page is rendered.
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
      // This delay should be longer than any potential debounce in syncScroll
      const timer = setTimeout(() => { 
        isProgrammaticScroll.current = false; 
        logger.debug("[BookView - PendingScrollPercentageEffect] Reset isProgrammaticScroll to false.");
      }, 150); // Increased delay slightly
      return () => clearTimeout(timer);
    } else if (pendingScrollToPercentage !== null) {
      logger.debug(`[BookView - PendingScrollPercentageEffect] Conditions not met for scroll: pendingScrollToPercentage=${pendingScrollToPercentage}, bookPaneContainerRef.current=${!!bookPaneContainerRef.current}, currentPageContent.length=${currentPageContent.length}`);
    }
  }, [currentPageContent, pendingScrollToPercentage, currentPage]); // Dependencies remain the same


  const syncScroll = useCallback(
    debounce((scrollingPaneRef, targetPaneRef) => {
      // if (isProgrammaticScroll.current) { // Original check, might be too simple
      //   return;
      // }

      if (!scrollingPaneRef.current || !targetPaneRef.current) return;

      const scrollingElement = scrollingPaneRef.current;
      const targetElement = targetPaneRef.current;

      // If the pane being scrolled is not actually scrollable, don't attempt to sync.
      if (scrollingElement.scrollHeight <= scrollingElement.clientHeight) return;
      
      const scrollPercentage = scrollingElement.scrollTop / (scrollingElement.scrollHeight - scrollingElement.clientHeight);
      
      let targetScrollTop;
      if (targetElement.scrollHeight > targetElement.clientHeight) {
        targetScrollTop = scrollPercentage * (targetElement.scrollHeight - targetElement.clientHeight);
      } else {
        // If target is not scrollable, decide where to "place" it based on source scroll.
        // e.g., if source is scrolled past halfway, show bottom of target, else top.
        targetScrollTop = scrollPercentage > 0.5 ? targetElement.scrollHeight : 0;
      }

      // Only scroll if the difference is significant, to avoid jitter
      if (Math.abs(targetElement.scrollTop - targetScrollTop) > 5) { 
        // If a major programmatic scroll (like a bookmark jump) is already in progress,
        // this syncScroll is a secondary adjustment. It should occur, but not
        // take over the isProgrammaticScroll flag from the primary operation.
        const primaryScrollInProgress = isProgrammaticScroll.current;

        if (!primaryScrollInProgress) {
            // If no primary scroll is happening, this sync is its own programmatic scroll.
            isProgrammaticScroll.current = true;
        }
        
        targetElement.scrollTop = targetScrollTop;

        if (!primaryScrollInProgress) {
            // Only let syncScroll reset the flag if it was the one to set it.
            setTimeout(() => { isProgrammaticScroll.current = false; }, 50); 
        }
      }
    }, 50), // Debounce time
    [] // No dependencies, as it uses refs and isProgrammaticScroll.current
  );

  useEffect(() => {
    const bookElement = bookPaneContainerRef.current; // Use container ref
    const noteElement = notePaneContainerRef.current; // Use container ref

    if (bookElement && noteElement) {
      const debouncedBookScroll = () => syncScroll(bookPaneContainerRef, notePaneContainerRef);
      const debouncedNoteScroll = () => syncScroll(notePaneContainerRef, bookPaneContainerRef);

      bookElement.addEventListener('scroll', debouncedBookScroll);
      noteElement.addEventListener('scroll', debouncedNoteScroll);

      return () => {
        bookElement.removeEventListener('scroll', debouncedBookScroll);
        noteElement.removeEventListener('scroll', debouncedNoteScroll);
        debouncedBookScroll.cancel(); 
        debouncedNoteScroll.cancel();
      };
    }
  }, [syncScroll]); 

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
        setCurrentPage(selectedBookmark.page_number);
      } else {
        logger.debug(`[BookView - handleBookmarkSelect] Already on target page ${currentPage}. Scrolling directly.`);
        if (bookPaneContainerRef.current) {
          const element = bookPaneContainerRef.current;
          const targetScroll = selectedBookmark.scroll_percentage !== null && selectedBookmark.scroll_percentage !== undefined ? selectedBookmark.scroll_percentage : 0;
          if (element.scrollHeight > element.clientHeight) {
            element.scrollTop = targetScroll * (element.scrollHeight - element.clientHeight);
          } else {
            element.scrollTop = 0;
          }
          logger.debug(`[BookView - handleBookmarkSelect] Scrolled directly. Target scroll percentage: ${targetScroll}`);
        } else {
          logger.warn("[BookView - handleBookmarkSelect] bookPaneContainerRef.current is null. Cannot scroll directly.");
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
    setCurrentPage((prev) => Math.max(1, prev - 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
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
    if (!newBookmarkName.trim()) {
      setBookmarkError("Bookmark name cannot be empty.");
      return;
    }
    setBookmarkError(null); // Clear error if any

    let currentScrollPercentage = 0; // Default to 0
    if (bookPaneContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = bookPaneContainerRef.current;
      if (scrollHeight > clientHeight) { // Avoid division by zero if not scrollable
        currentScrollPercentage = scrollTop / (scrollHeight - clientHeight); // Value between 0.0 and 1.0
      } else if (scrollHeight === clientHeight && scrollHeight > 0) { // Content fits perfectly or is empty but scrollable
        currentScrollPercentage = 0; // Or 1.0 if you consider a full view as 100% "scrolled"
      }
    }

    const bookmarkData = {
      book_id: bookId,
      name: newBookmarkName.trim(),
      page_number: currentPage, // Assumes currentPage state is correctly maintained
      scroll_percentage: currentScrollPercentage,
    };

    logger.debug("Attempting to save bookmark with data:", bookmarkData);

    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        setBookmarkError("Authentication token not found. Please log in to save bookmarks.");
        logger.warn("[BookView - handleSaveBookmark] Auth token not found.");
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
      // Optionally, refresh bookmarks list here if displaying them on BookView
      // setBookmarks(prevBookmarks => [...prevBookmarks, savedBookmark].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
      logger.info("Bookmark saved successfully:", savedBookmark);
      closeAddBookmarkModal();
      fetchBookmarks(); // Refresh bookmarks list after saving a new one
    } catch (error) {
      logger.error("Error saving bookmark:", error);
      setBookmarkError(error.message);
    }
  };

  const toggleNotePaneVisibility = () => {
    if (isMobileView) {
      setShowNotesPanelOnMobile(prev => !prev);
    } else {
      setIsNotePaneVisible(prev => !prev);
    }
  };

  if (loading) return <div style={{ padding: '20px' }}>Loading book...</div>;
  if (error) return <div style={{ padding: '20px', color: 'red' }}>Error loading book: {error}</div>;
  if (!bookData) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h2>Book Not Found</h2>
        <p>The book with ID "{bookId}" could not be found.</p>
        <div style={{ marginTop: '20px' }}>
          <Link to="/">Go back to the Book List</Link> | <Link to="/upload">Upload a New PDF</Link>
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
          <Link to="/">Go back to the Book List</Link> | <Link to="/upload">Upload a New PDF</Link>
        </div>
      </div>
    );
  }
  if (bookData.status === 'completed' && !fullMarkdownContent.current) {
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
      style={{ flexDirection: isMobileView ? 'column' : 'row' }} // ADD/MODIFY THIS STYLE PROP
    >
        {/* Add Bookmark Modal - Rendered conditionally */}
        {showAddBookmarkModal && (
          <div className="modal-overlay">
            <div className="modal-content">
              <h2>Add Bookmark</h2>
              <input
                type="text"
                value={newBookmarkName}
                onChange={(e) => setNewBookmarkName(e.target.value)}
                placeholder="Enter bookmark name"
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

      {/* Manage Bookmarks Modal - ADD THIS */}
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

        {/* Book Pane Area */}
        <div 
          className="book-pane-area"
          ref={bookPaneAreaRef} // Ref for the resizable area
          style={{
            flexBasis: !isMobileView && isNotePaneVisible ? bookPaneFlexBasis : '100%', // Desktop width, or full if mobile/notes hidden
            width: isMobileView ? '100%' : undefined, // Full width on mobile
            height: '100%', // Occupy full height of its flex container part
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: isMobileView ? 'relative' : undefined, // Needed if note pane is absolute child for some reason
          }}
        >
          {/* .book-pane-wrapper is the existing structure inside book-pane-area */}
          <div className="book-pane-wrapper">
            {/* --- MODIFIED Controls Header for Book Pane --- */}
            <div className="book-pane-controls-header">
              {/* Left: Bookmark Dropdown Menu */}
              <div className="bookmark-menu-container" ref={bookmarkMenuRef}>
                <button 
                  onClick={() => setIsBookmarkMenuOpen(prev => !prev)} 
                  className="control-button bookmark-menu-button"
                  aria-haspopup="true"
                  aria-expanded={isBookmarkMenuOpen}
                >
                  Bookmarks <span className={`arrow ${isBookmarkMenuOpen ? 'up' : 'down'}`}></span>
                </button>
                {isBookmarkMenuOpen && (
                  <div className="bookmark-dropdown-menu">
                    <button 
                      onClick={() => { openAddBookmarkModal(); setIsBookmarkMenuOpen(false); }} 
                      className="dropdown-item control-button" // Added control-button for consistent styling
                    >
                      Add Bookmark
                    </button>
                    {bookmarks.length > 0 && (
                      <div className="dropdown-item-select-container"> {/* Wrapper for select */}
                        <label htmlFor="jump-to-bookmark-select" className="sr-only">Jump to Bookmark</label>
                        <select
                          id="jump-to-bookmark-select"
                          onChange={(e) => { handleBookmarkSelect(e); setIsBookmarkMenuOpen(false); }}
                          className="bookmark-select dropdown-item-select control-button" // Added control-button
                          defaultValue=""
                          aria-label="Jump to bookmark"
                        >
                          <option value="" disabled>Jump to Bookmark...</option>
                          {bookmarks.map((bookmark, index) => (
                            <option key={bookmark.id} value={bookmark.id}>
                              {bookmark.name ? `${bookmark.name} (P${bookmark.page_number})` : `Page ${bookmark.page_number} (Unnamed)`}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <button 
                      onClick={() => { setShowManageBookmarksModal(true); setIsBookmarkMenuOpen(false); }} 
                      className="dropdown-item control-button" // Added control-button
                    >
                      Manage Bookmarks
                    </button>
                  </div>
                )}
              </div>

              {/* Center: Pagination Controls - MOVED HERE */}
              {totalPages > 1 && (
                <div className="pagination-controls header-pagination"> {/* Added header-pagination class */}
                  <button onClick={handlePreviousPage} disabled={currentPage === 1} className="control-button">
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
                  <button onClick={handleNextPage} disabled={currentPage === totalPages} className="control-button">
                    Next
                  </button>
                </div>
              )}
              {/* Placeholder for pagination if totalPages <= 1 to maintain layout balance */}
              {totalPages <= 1 && <div className="pagination-controls-placeholder"></div>}


              {/* Right: Toggle Notes Button */}
              <div className="right-controls-group"> {/* New wrapper for right-aligned items */}
                <button onClick={toggleNotePaneVisibility} className="control-button">
                  {isMobileView
                    ? (showNotesPanelOnMobile ? 'Hide Notes' : 'Show Notes')
                    : (isNotePaneVisible ? 'Hide Notes' : 'Show Notes')}
                </button>
              </div>
            </div>
            {/* --- END OF MODIFIED Controls Header --- */}

            {/* The BookPane container itself */}
            <div className="book-pane-container" ref={bookPaneContainerRef}>
              <BookPane
                markdownContent={highlightedPageContent} 
                imageUrls={bookData.image_urls}
                onTextSelect={handleTextSelect}
              />
            </div>
            {/* The original pagination block was here and is now removed */}
          </div>
        </div>

        {/* Resizer Handle - Conditionally Render */}
        {isNotePaneVisible && !isMobileView && ( // MODIFIED THIS CONDITION
          <div className="resizer-handle" onMouseDown={handleMouseDownOnResizer}></div>
        )}

        {/* Desktop: Note Pane Area - side-by-side */}
        {!isMobileView && isNotePaneVisible && (
          <div
            className="note-pane-area" // Existing class for desktop
            style={{
              flexGrow: 1,
              flexShrink: 1,
              flexBasis: '0%', // Grow to fill remaining space from bookPaneFlexBasis
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderLeft: '1px solid #ccc', // Always has left border on desktop
            }}
          >
            <div className="note-pane-wrapper">
              <div className="note-pane-container" ref={notePaneContainerRef}>
                <NotePane
                  bookId={bookId}
                  selectedBookText={selectedBookText}
                  selectedScrollPercentage={selectedScrollPercentage}
                  selectedGlobalCharOffset={selectedGlobalCharOffset}
                  onNoteClick={handleNoteClick}
                  onNewNoteSaved={handleNewNoteSaved}
                  // No mobile-specific props needed for desktop version
                />
              </div>
            </div>
          </div>
        )}

        {/* Mobile: Note Pane Area - Overlay */}
        {isMobileView && showNotesPanelOnMobile && (
          <div className="note-pane-area-mobile-overlay"> {/* New class for overlay styling */}
            {/* The wrapper and container structure can be similar if NotePane is self-contained */}
            <div className="note-pane-wrapper">
              <div className="note-pane-container" ref={notePaneContainerRef}> {/* Still need ref for scrolling */}
                <NotePane
                  bookId={bookId}
                  selectedBookText={selectedBookText}
                  selectedScrollPercentage={selectedScrollPercentage}
                  selectedGlobalCharOffset={selectedGlobalCharOffset}
                  onNoteClick={handleNoteClick}
                  onNewNoteSaved={handleNewNoteSaved}
                  isMobileContext={true} // Indicate mobile overlay context
                  onClosePane={toggleNotePaneVisibility} // Pass the toggle function to close
                />
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

export default BookView;
