import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import BookPane from '../components/BookPane';
import NotePane from '../components/NotePane';
import { debounce } from 'lodash';
import './BookView.css';
import logger from '../utils/logger'; // Ensure logger is imported

const CHARACTERS_PER_PAGE = 5000; // Define characters per page

// Function to escape regex special characters
function escapeRegExp(string) {
  if (typeof string !== 'string') {
    return '';
  }
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
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


  const fetchBook = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/books/${bookId}`);
      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 404) {
          setBookData(null);
          return;
        }
        throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || response.statusText}`);
      }
      const data = await response.json();
      setBookData(data);
      if (data && data.markdown_content) {
        fullMarkdownContent.current = data.markdown_content;
        const totalChars = fullMarkdownContent.current.length;
        const numPages = Math.max(1, Math.ceil(totalChars / CHARACTERS_PER_PAGE));
        setTotalPages(numPages);
      } else {
        fullMarkdownContent.current = '';
        setTotalPages(1);
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
      const response = await fetch(`/api/bookmarks/book/${bookId}`);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to fetch bookmarks: ${errorData.detail || response.statusText}`);
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
      const response = await fetch(`/api/bookmarks/${bookmarkIdToDelete}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        if (response.status === 404) {
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


  // Fetch notes when bookId changes
  useEffect(() => {
    const fetchNotes = async () => {
      if (!bookId) return;
      try {
        const response = await fetch(`/api/notes/${bookId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch notes');
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
    logger.debug("[BookView - Highlighting Effect] Running. Current Page:", currentPage, "Notes count:", notes.length, "PendingScrollOffsetInPage:", pendingScrollOffsetInPage, "PendingScrollToPercentage:", pendingScrollToPercentage);
    if (fullMarkdownContent.current) {
      const totalChars = fullMarkdownContent.current.length;
      const numPages = Math.max(1, Math.ceil(totalChars / CHARACTERS_PER_PAGE));
      // setTotalPages(numPages); // Already set when bookData loads

      const validCurrentPage = Math.max(1, Math.min(currentPage, numPages || 1));
      if (currentPage !== validCurrentPage) {
        setCurrentPage(validCurrentPage); 
        return; 
      }
      
      const pageStartGlobalOffset = (validCurrentPage - 1) * CHARACTERS_PER_PAGE;
      const pageEndGlobalOffset = pageStartGlobalOffset + CHARACTERS_PER_PAGE;
      // logger.debug(`[BookView - Highlighting Effect] Page ${currentPage}: Global Offset Range [${pageStartGlobalOffset} - ${pageEndGlobalOffset})`); // Redundant with below
      
      const plainPageText = fullMarkdownContent.current.substring(pageStartGlobalOffset, pageEndGlobalOffset);
      setCurrentPageContent(plainPageText); 
      logger.debug(`[BookView - Highlighting Effect] Plain text for page ${currentPage} (len: ${plainPageText.length}): "${plainPageText.substring(0, 100)}..."`);


      // Apply highlighting (existing logic for notes)
      if (notes && notes.length > 0) {
        // ... (existing note highlighting logic remains unchanged) ...
        // (Make sure this logic correctly sets setHighlightedPageContent(newHighlightedString);)
        const relevantNotes = notes
          .filter(note => {
            if (note.global_character_offset === undefined || note.global_character_offset === null || !note.source_text || note.source_text.length === 0) {
              return false;
            }
            const noteStartGlobal = note.global_character_offset;
            const noteEndGlobal = noteStartGlobal + note.source_text.length;
            const overlaps = Math.max(pageStartGlobalOffset, noteStartGlobal) < Math.min(pageEndGlobalOffset, noteEndGlobal);
            return overlaps;
          })
          .sort((a, b) => a.global_character_offset - b.global_character_offset);
        
        let newHighlightedString = "";
        let lastProcessedIndexInPage = 0;

        relevantNotes.forEach(note => {
          const noteStartGlobal = note.global_character_offset;
          const noteLength = note.source_text.length; 
          let noteStartInPage = noteStartGlobal - pageStartGlobalOffset;
          const actualSegmentStartInPage = Math.max(noteStartInPage, lastProcessedIndexInPage);
          
          if (actualSegmentStartInPage > lastProcessedIndexInPage) {
            newHighlightedString += plainPageText.substring(lastProcessedIndexInPage, actualSegmentStartInPage);
          }
          
          const highlightSegmentStartOnPage = Math.max(0, noteStartInPage);
          const highlightSegmentEndOnPage = Math.min(noteStartInPage + noteLength, plainPageText.length);
          
          if (highlightSegmentStartOnPage < highlightSegmentEndOnPage && highlightSegmentStartOnPage < plainPageText.length) {
            const textToHighlight = plainPageText.substring(highlightSegmentStartOnPage, highlightSegmentEndOnPage);
            newHighlightedString += `<span class="highlighted-note-text" data-note-id="${note.id}">${textToHighlight}</span>`;
            lastProcessedIndexInPage = highlightSegmentEndOnPage;
          } else {
             lastProcessedIndexInPage = Math.max(lastProcessedIndexInPage, actualSegmentStartInPage);
          }
        });

        if (lastProcessedIndexInPage < plainPageText.length) {
          newHighlightedString += plainPageText.substring(lastProcessedIndexInPage);
        }
        setHighlightedPageContent(newHighlightedString);

      } else { // No notes or no relevant notes
        logger.debug(`[BookView - Highlighting Effect] No notes to highlight on page ${currentPage}, setting plain text.`);
        setHighlightedPageContent(plainPageText); 
      }
      
      // Conditional scroll to top:
      if (bookPaneContainerRef.current) {
        // This effect should scroll to top IF:
        // 1. No note-specific scroll is pending for this page load (pendingScrollOffsetInPage is null).
        // 2. No bookmark-specific scroll percentage is pending for this page load (pendingScrollToPercentage is null).
        // 3. AND no other programmatic scroll has *just* occurred (isProgrammaticScroll.current is false).
        if (pendingScrollOffsetInPage === null && pendingScrollToPercentage === null) {
            if (!isProgrammaticScroll.current) { // Check if another scroll isn't already in progress/just finished
                logger.debug("[BookView - Highlighting Effect] Conditions met for scroll-to-top (no pending offset/percentage, and no other recent programmatic scroll). Scrolling to top.");
                isProgrammaticScroll.current = true; // This effect is now initiating a programmatic scroll
                bookPaneContainerRef.current.scrollTop = 0;
                // Reset isProgrammaticScroll after this effect's action
                setTimeout(() => { 
                    isProgrammaticScroll.current = false; 
                    logger.debug("[BookView - Highlighting Effect] Reset isProgrammaticScroll from scroll-to-top action.");
                }, 100); // Short delay for this specific action
            } else {
                logger.debug("[BookView - Highlighting Effect] Conditions for scroll-to-top met (no pending offset/percentage), BUT isProgrammaticScroll.current is true. Assuming another action just scrolled. Skipping scroll-to-top by this effect.");
                // If another action (e.g., same-page bookmark jump) set isProgrammaticScroll.current to true,
                // that action is responsible for resetting it. This effect should not interfere.
            }
        } else {
            logger.debug("[BookView - Highlighting Effect] A scroll (offset for note, or percentage for bookmark on new page) is pending. Skipping automatic scroll to top by Highlighting Effect.");
        }
      }
    } else { // No fullMarkdownContent.current
      setCurrentPageContent('');
      setHighlightedPageContent('');
      setTotalPages(1);
      setCurrentPage(1); // Reset to page 1 if content disappears
    }
  // Add pendingScrollToPercentage to the dependency array
  }, [bookData, currentPage, notes, pendingScrollOffsetInPage, pendingScrollToPercentage]);


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

  const handleTextSelect = (textFromBookPane) => { // textFromBookPane is selection.toString()
    setSelectedBookText(textFromBookPane); // Store the selected text as is

    if (bookPaneContainerRef.current && textFromBookPane && textFromBookPane.trim() !== "") {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const bookPaneElement = bookPaneContainerRef.current; // This is div.book-pane-container

        let startInPage = -1;
        const container = bookPaneContainerRef.current; 
        
        if (container) {
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
            let currentOffset = 0;
            let textNode;
            let selectionStartNode = range.startContainer;
            let selectionStartOffset = range.startOffset;

            if (selectionStartNode.nodeType !== Node.TEXT_NODE) {
                let foundTextNode = false;
                function findTextNodeRecursive(node, targetDomOffset) {
                    let currentDomOffset = 0;
                    for (let i = 0; i < node.childNodes.length; i++) {
                        const childNode = node.childNodes[i];
                        if (childNode.nodeType === Node.TEXT_NODE) {
                            if (currentDomOffset + childNode.textContent.length >= targetDomOffset) {
                                selectionStartNode = childNode;
                                selectionStartOffset = targetDomOffset - currentDomOffset;
                                foundTextNode = true;
                                return true; 
                            }
                            currentDomOffset += childNode.textContent.length;
                        } else if (childNode.nodeType === Node.ELEMENT_NODE) {
                            if (findTextNodeRecursive(childNode, targetDomOffset - currentDomOffset)) {
                                return true; 
                            }
                            currentDomOffset += childNode.textContent.length; 
                        }
                    }
                    return false; 
                }

                if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
                    findTextNodeRecursive(range.startContainer, range.startOffset);
                }
                
                if (!foundTextNode) {
                    logger.warn("[BookView - handleTextSelect] Could not precisely map element selection to a text node. Offset might be less accurate.");
                }
            }


            while ((textNode = walker.nextNode())) {
                if (textNode === selectionStartNode) {
                    startInPage = currentOffset + selectionStartOffset;
                    break;
                }
                currentOffset += textNode.textContent.length;
            }
        }

        logger.debug("[BookView - handleTextSelect] Selection Text:", `"${textFromBookPane}"`);
        logger.debug("[BookView - handleTextSelect] Calculated startInPage (DOM Walker):", startInPage);

        if (startInPage !== -1) {
            const globalOffset = (currentPage - 1) * CHARACTERS_PER_PAGE + startInPage;
            
            const canonicalSelectedText = fullMarkdownContent.current.substring(globalOffset, globalOffset + textFromBookPane.length);
            
            setSelectedBookText(canonicalSelectedText); 
            setSelectedGlobalCharOffset(globalOffset);
            logger.debug("[BookView - handleTextSelect] Successfully calculated: globalOffset:", globalOffset);
            logger.debug("[BookView - handleTextSelect] canonicalSelectedText (length " + canonicalSelectedText.length + "):", `"${canonicalSelectedText}"`);
            
            const element = bookPaneContainerRef.current; 
            if (element.scrollHeight > element.clientHeight) {
                const pageScrollPercentage = element.scrollTop / (element.scrollHeight - element.clientHeight);
                setSelectedScrollPercentage(pageScrollPercentage);
            } else {
                setSelectedScrollPercentage(0);
            }
        } else {
            logger.warn("[BookView - handleTextSelect] DOM Walker failed to find selection start. Note location data (global offset) will not be set. Selected text will still be available for LLM.");
            setSelectedBookText(textFromBookPane); 
            setSelectedGlobalCharOffset(null);
            setSelectedScrollPercentage(null);
        }
      } else {
        setSelectedBookText(null);
        setSelectedGlobalCharOffset(null);
        setSelectedScrollPercentage(null);
      }
    } else {
      setSelectedBookText(null);
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
    if (scrollToGlobalOffset === null || !fullMarkdownContent.current) {
      if (scrollToGlobalOffset !== null) {
        logger.debug(`[ScrollToNoteEffect] Aborting: scrollToGlobalOffset=${scrollToGlobalOffset}, fullMarkdownContent.current=${!!fullMarkdownContent.current}`);
      }
      return;
    }

    const targetGlobalOffset = scrollToGlobalOffset;
    logger.info(`[ScrollToNoteEffect] Attempting to scroll to global character offset: ${targetGlobalOffset}`);

    // Determine the target page and offset within that page
    const targetPageNum = Math.floor(targetGlobalOffset / CHARACTERS_PER_PAGE) + 1;
    const offsetWithinTargetPage = targetGlobalOffset % CHARACTERS_PER_PAGE;
    logger.debug(`[ScrollToNoteEffect] Target page: ${targetPageNum}, Offset within page: ${offsetWithinTargetPage}`);

    // If the target page is not the current page, change the page
    // The actual scrolling will happen in the effect that depends on `currentPageContent` and `pendingScrollOffsetInPage`
    if (targetPageNum !== currentPage) {
      logger.info(`[ScrollToNoteEffect] Target page ${targetPageNum} is different from current page ${currentPage}. Setting current page and pending offset.`);
      setCurrentPage(targetPageNum);
      setPendingScrollOffsetInPage(offsetWithinTargetPage); // This will be picked up by the other useEffect
      setScrollToGlobalOffset(null); // Reset after initiating page change
      return;
    }

    // If already on the correct page, proceed to scroll within this page
    logger.info(`[ScrollToNoteEffect] Already on target page ${currentPage}. Proceeding with scroll.`);
    
    if (!bookPaneContainerRef.current) {
        logger.warn("[ScrollToNoteEffect] bookPaneContainerRef.current is null. Cannot scroll.");
        setScrollToGlobalOffset(null); // Reset
        return;
    }
    const bookElement = bookPaneContainerRef.current;

    // Cleanup previous scroll target highlight
    if (scrollTargetHighlightRef.current && scrollTargetHighlightRef.current.parentNode) {
      try {
        const parent = scrollTargetHighlightRef.current.parentNode;
        const textContent = scrollTargetHighlightRef.current.textContent || "";
        parent.replaceChild(document.createTextNode(textContent), scrollTargetHighlightRef.current);
        logger.debug("[ScrollToNoteEffect] Cleaned up previous scroll target highlight span.");
      } catch (e) {
        logger.error("[ScrollToNoteEffect] Error cleaning up previous scroll target highlight span:", e);
      }
    }
    scrollTargetHighlightRef.current = null;


    // Find the text node and character offset to scroll to
    const walker = document.createTreeWalker(bookElement, NodeFilter.SHOW_TEXT, null);
    let accumulatedOffset = 0;
    let textNode = null;
    let foundTargetNodeAndOffset = false;

    while ((textNode = walker.nextNode())) {
      const nodeText = textNode.textContent || '';
      const nodeLength = nodeText.length;

      if (accumulatedOffset + nodeLength >= offsetWithinTargetPage) {
        const startOffsetInNode = offsetWithinTargetPage - accumulatedOffset;
        
        if (startOffsetInNode >= 0 && startOffsetInNode <= nodeLength) { // Ensure valid offset
          logger.info(`[ScrollToNoteEffect] Target text node found. Offset in node: ${startOffsetInNode}. Node content (start): "${nodeText.substring(0, 30)}..."`);
          
          const range = document.createRange();
          range.setStart(textNode, startOffsetInNode);
          range.setEnd(textNode, startOffsetInNode); 
          
          const highlightRange = document.createRange();
          highlightRange.setStart(textNode, startOffsetInNode);
          highlightRange.setEnd(textNode, Math.min(nodeLength, startOffsetInNode + 5)); 

          const highlightSpan = document.createElement('span');
          highlightSpan.className = 'highlighted-note-scroll-target'; 
          
          try {
            highlightRange.surroundContents(highlightSpan);
            scrollTargetHighlightRef.current = highlightSpan; 
            logger.debug("[ScrollToNoteEffect] Inserted highlight span for scroll target:", highlightSpan.textContent);

            let spanOffsetTop = 0;
            let currentElement = highlightSpan;
            while (currentElement && currentElement !== bookElement) {
              spanOffsetTop += currentElement.offsetTop;
              currentElement = currentElement.offsetParent;
            }
            
            logger.info(`[ScrollToNoteEffect] Calculated spanOffsetTop: ${spanOffsetTop}px relative to bookPane.`);

            isProgrammaticScroll.current = true;
            const scrollTopTarget = Math.max(0, spanOffsetTop - 20); 
            bookElement.scrollTop = scrollTopTarget;
            
            logger.info(`[ScrollToNoteEffect] Programmatically scrolled bookPane to: ${scrollTopTarget}px.`);
            
            highlightSpan.style.transition = 'background-color 0.5s ease-out';
            highlightSpan.style.backgroundColor = 'rgba(255, 255, 0, 0.5)'; 
            setTimeout(() => {
                if (highlightSpan) {
                    highlightSpan.style.backgroundColor = ''; 
                }
            }, 1500); 


          } catch (e) {
            logger.error("[ScrollToNoteEffect] Error inserting highlight span or scrolling (surroundContents failed):", e, "Node:", textNode, "Offset:", startOffsetInNode);
            // Fallback logic
            try {
                const markerSpan = document.createElement("span");
                markerSpan.className = 'highlighted-note-scroll-target-marker'; 
                
                // ADD TEMPORARY VISUAL CUE FOR THE MARKER SPAN
                markerSpan.style.outline = "2px solid red"; // Distinct visual cue
                markerSpan.style.backgroundColor = "rgba(255, 0, 0, 0.2)"; // Light red background

                range.insertNode(markerSpan); // Insert the (empty) marker span
                scrollTargetHighlightRef.current = markerSpan; // Store ref for cleanup
                
                let markerOffsetTop = 0;
                let currentMarkerEl = markerSpan;
                while (currentMarkerEl && currentMarkerEl !== bookElement) {
                    markerOffsetTop += currentMarkerEl.offsetTop;
                    currentMarkerEl = currentMarkerEl.offsetParent;
                }
                const markerScrollTopTarget = Math.max(0, markerOffsetTop - 20);
                
                isProgrammaticScroll.current = true; // Set before scrolling
                bookElement.scrollTop = markerScrollTopTarget;
                logger.info("[ScrollToNoteEffect] Fallback: Used markerSpan and direct scroll. Scrolled to:", markerScrollTopTarget);

                // REMOVE TEMPORARY VISUAL CUE AFTER A DELAY
                setTimeout(() => {
                    if (markerSpan) {
                        markerSpan.style.outline = "";
                        markerSpan.style.backgroundColor = "";
                    }
                }, 1500); // Keep cue for 1.5 seconds

            } catch (e2) {
                logger.error("[ScrollToNoteEffect] Fallback markerSpan insertion/scroll also failed:", e2);
            }
          }
          foundTargetNodeAndOffset = true;
          break; 
        }
      }
      accumulatedOffset += nodeLength;
    }

    if (!foundTargetNodeAndOffset) {
      logger.warn(`[ScrollToNoteEffect] Could not find the exact text node and offset for page offset: ${offsetWithinTargetPage}. Total characters processed on page: ${accumulatedOffset}. Scrolling to top of page.`);
      isProgrammaticScroll.current = true;
      bookElement.scrollTop = 0; 
    }

    const timer = setTimeout(() => {
      isProgrammaticScroll.current = false;
      logger.debug("[ScrollToNoteEffect] Reset isProgrammaticScroll to false after timeout.");
    }, 300); 

    setScrollToGlobalOffset(null); 

    return () => {
      clearTimeout(timer);
      if (scrollTargetHighlightRef.current && scrollTargetHighlightRef.current.parentNode) {
        try {
          const parent = scrollTargetHighlightRef.current.parentNode;
          const textToRestore = scrollTargetHighlightRef.current.textContent || "";
          parent.replaceChild(document.createTextNode(textToRestore), scrollTargetHighlightRef.current);
          logger.debug("[ScrollToNoteEffect] Cleanup: Replaced/Removed scroll target highlight span.");
        } catch (e) {
          logger.error("[ScrollToNoteEffect] Cleanup: Error removing scroll target highlight span:", e);
        }
      }
      scrollTargetHighlightRef.current = null;
    };
  }, [scrollToGlobalOffset, fullMarkdownContent, currentPage, currentPageContent]);


  useEffect(() => {
    if (pendingScrollOffsetInPage !== null && bookPaneContainerRef.current && currentPageContent.length > 0) {
      const bookElement = bookPaneContainerRef.current;
      // The DOM needs to be updated with currentPageContent before we can find the offset.
      // This effect runs *after* currentPageContent is updated and the DOM reflects it.
      
      // Find the text node and character offset to scroll to, similar to the main scroll effect
      const walker = document.createTreeWalker(bookElement, NodeFilter.SHOW_TEXT, null);
      let accumulatedOffset = 0;
      let textNode = null;
      let foundTargetNodeForPendingScroll = false;

      while ((textNode = walker.nextNode())) {
          const nodeText = textNode.textContent || '';
          const nodeLength = nodeText.length;

          if (accumulatedOffset + nodeLength >= pendingScrollOffsetInPage) {
              const startOffsetInNode = pendingScrollOffsetInPage - accumulatedOffset;
              if (startOffsetInNode >= 0 && startOffsetInNode <= nodeLength) {
                  logger.info(`[PendingScrollEffect] Target text node found for pending scroll. Offset in node: ${startOffsetInNode}.`);
                  
                  const range = document.createRange();
                  range.setStart(textNode, startOffsetInNode);
                  range.setEnd(textNode, startOffsetInNode);

                  const tempSpan = document.createElement('span'); // Temporary, non-highlighted marker
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
                      
                      // Clean up the temporary span
                      if (tempSpan.parentNode) {
                          tempSpan.parentNode.removeChild(tempSpan);
                      }
                  } catch (e) {
                      logger.error("[PendingScrollEffect] Error inserting temp span or scrolling:", e);
                      // Fallback: scroll based on ratio if precise DOM manipulation fails
                      if (bookElement.scrollHeight > bookElement.clientHeight) {
                          const scrollRatio = pendingScrollOffsetInPage / currentPageContent.length;
                          const targetScrollTopFallback = scrollRatio * (bookElement.scrollHeight - bookElement.clientHeight);
                          isProgrammaticScroll.current = true;
                          bookElement.scrollTop = Math.max(0, targetScrollTopFallback -20);
                          logger.info(`[PendingScrollEffect] Fallback scroll to ratio. Target scrollTop: ${bookElement.scrollTop}`);
                      } else {
                          isProgrammaticScroll.current = true;
                          bookElement.scrollTop = 0;
                      }
                  }
                  foundTargetNodeForPendingScroll = true;
                  break;
              }
          }
          accumulatedOffset += nodeLength;
      }
      
      if (!foundTargetNodeForPendingScroll) {
          logger.warn(`[PendingScrollEffect] Could not find exact node for pending offset ${pendingScrollOffsetInPage}. Scrolling to top of page.`);
          isProgrammaticScroll.current = true;
          bookElement.scrollTop = 0;
      }

      setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
      setPendingScrollOffsetInPage(null); // Reset after scrolling
    } else if (pendingScrollOffsetInPage !== null && bookPaneContainerRef.current && currentPageContent.length === 0 && pendingScrollOffsetInPage === 0) {
        // Handle case where page is empty and offset is 0 (scroll to top)
        isProgrammaticScroll.current = true;
        bookPaneContainerRef.current.scrollTop = 0;
        setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
        setPendingScrollOffsetInPage(null);
    }
  }, [currentPageContent, pendingScrollOffsetInPage]); 

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
      const response = await fetch('/api/bookmarks/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bookmarkData),
      });

      if (!response.ok) {
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
    <div className="book-view-container" ref={bookViewContainerRef}> {/* Add ref to the main container */}
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
            flexBasis: bookPaneFlexBasis,
            flexShrink: 0, // Prevent shrinking beyond flex-basis
            display: 'flex', // To make its child (.book-pane-wrapper) fill it
            flexDirection: 'column',
            overflow: 'hidden' // Important
          }}
        >
          {/* .book-pane-wrapper is the existing structure inside book-pane-area */}
          <div className="book-pane-wrapper"> 
            {/* Controls Header for Book Pane - ADD THIS SECTION */}
            <div className="book-pane-controls-header">
              <button onClick={openAddBookmarkModal} className="control-button">
                Add Bookmark
              </button>
              {/* Add Bookmark Dropdown */}
              {bookmarks.length > 0 && (
                <select 
                  onChange={handleBookmarkSelect} 
                  className="bookmark-select control-button" // Added control-button for consistent styling
                  defaultValue="" // Ensure placeholder is selected initially
                  aria-label="Jump to bookmark"
                >
                  <option value="" disabled>Jump to Bookmark...</option>
                  {bookmarks.map((bookmark, index) => {
                    // ADD THIS LOG to see what's being assigned to the value attribute
                    logger.debug(`[BookView - Rendering Bookmark Option ${index}] ID: "${bookmark.id}", Type: ${typeof bookmark.id}, Name: "${bookmark.name}"`);
                    return (
                      <option key={bookmark.id} value={bookmark.id}>
                        {bookmark.name ? `${bookmark.name} (P${bookmark.page_number})` : `Page ${bookmark.page_number} (Unnamed)`}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
            {/* Add Manage Bookmarks Button */}
            <button onClick={() => setShowManageBookmarksModal(true)} className="control-button">
              Manage Bookmarks
            </button>
          </div>

            <div className="book-pane-container" ref={bookPaneContainerRef}> {/* Ref for scrollable content */}
              <BookPane
                markdownContent={highlightedPageContent} 
                imageUrls={bookData.image_urls}
                onTextSelect={handleTextSelect}
              />
            </div>
            <div className="pagination-controls">
              <button onClick={handlePreviousPage} disabled={currentPage === 1}>
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
              <button onClick={handleNextPage} disabled={currentPage === totalPages}>
                Next
              </button>
            </div>
          </div>
        </div>

        {/* Resizer Handle */}
        <div className="resizer-handle" onMouseDown={handleMouseDownOnResizer}></div>

        {/* New wrapper for note pane area to control its flex properties */}
        <div 
          className="note-pane-area"
          style={{
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: '0%', // Allow it to grow into remaining space
            display: 'flex', // To make its child (.note-pane-wrapper) fill it
            flexDirection: 'column',
            overflow: 'hidden' // Important
          }}
        >
          {/* .note-pane-wrapper is the existing structure inside note-pane-area */}
          <div className="note-pane-wrapper"> 
            <div className="note-pane-container" ref={notePaneContainerRef}> {/* Ref for scrollable content */}
              <NotePane
                bookId={bookId}
                selectedBookText={selectedBookText}
                selectedScrollPercentage={selectedScrollPercentage}
                selectedGlobalCharOffset={selectedGlobalCharOffset} 
                onNoteClick={handleNoteClick} 
                onNewNoteSaved={handleNewNoteSaved} 
              />
            </div>
          </div>
        </div>
    </div>
  );
}

export default BookView;
