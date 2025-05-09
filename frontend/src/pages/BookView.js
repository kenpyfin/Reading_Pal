import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import BookPane from '../components/BookPane';
import NotePane from '../components/NotePane';
import { debounce } from 'lodash';
import './BookView.css';

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

  const bookPaneRef = useRef(null);
  const notePaneRef = useRef(null);
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
      console.error('Failed to fetch book:', err);
      setError(`Failed to load book: ${err.message || 'Unknown error'}`);
      setBookData(null);
      fullMarkdownContent.current = '';
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (bookId) {
      fetchBook();
    }
  }, [bookId]);

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
        console.error('Error fetching notes:', err);
        setNotes([]); // Reset notes on error
      }
    };

    fetchNotes();
  }, [bookId]);

  // Effect for handling pagination logic AND highlighting when bookData, currentPage, or notes change
  useEffect(() => {
    console.log("[BookView - Highlighting Effect] Running. Current Page:", currentPage, "Notes count:", notes.length);
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
      console.log(`[BookView - Highlighting Effect] Page ${currentPage}: Global Offset Range [${pageStartGlobalOffset} - ${pageEndGlobalOffset})`);
      
      const plainPageText = fullMarkdownContent.current.substring(pageStartGlobalOffset, pageEndGlobalOffset);
      setCurrentPageContent(plainPageText); 
      console.log(`[BookView - Highlighting Effect] Plain text for page ${currentPage} (len: ${plainPageText.length}): "${plainPageText.substring(0, 100)}..."`);


      // Apply highlighting
      if (notes && notes.length > 0) {
        const relevantNotes = notes
          .filter(note => {
            if (note.global_character_offset === undefined || note.global_character_offset === null || !note.source_text || note.source_text.length === 0) {
              return false;
            }
            const noteStartGlobal = note.global_character_offset;
            const noteEndGlobal = noteStartGlobal + note.source_text.length;
            // Check for overlap: (StartA < EndB) and (StartB < EndA)
            const overlaps = Math.max(pageStartGlobalOffset, noteStartGlobal) < Math.min(pageEndGlobalOffset, noteEndGlobal);
            if (!overlaps) {
                // console.log(`[BookView - Highlighting Effect] Note ID ${note.id} (offset ${noteStartGlobal}, len ${note.source_text.length}) does NOT overlap with page range [${pageStartGlobalOffset}-${pageEndGlobalOffset})`);
            }
            return overlaps;
          })
          .sort((a, b) => a.global_character_offset - b.global_character_offset); // Sort by start offset
        
        console.log(`[BookView - Highlighting Effect] Found ${relevantNotes.length} relevant notes for page ${currentPage}:`, relevantNotes.map(n => ({id: n.id, offset: n.global_character_offset, len: n.source_text.length })));

        let newHighlightedString = "";
        let lastProcessedIndexInPage = 0; // Tracks position in plainPageText

        relevantNotes.forEach(note => {
          console.log(`[BookView - Highlighting Effect] Processing note ID ${note.id}: global_offset=${note.global_character_offset}, source_text_len=${note.source_text?.length}, source_text (first 30): "${note.source_text?.substring(0,30)}"`);
          const noteStartGlobal = note.global_character_offset;
          const noteLength = note.source_text.length; 

          let noteStartInPage = noteStartGlobal - pageStartGlobalOffset;
          
          // Append the part of plainPageText before the current note's highlight
          // Ensure noteStartInPage is not less than lastProcessedIndexInPage to handle overlapping notes correctly (though current sort helps)
          const actualSegmentStartInPage = Math.max(noteStartInPage, lastProcessedIndexInPage);
          
          if (actualSegmentStartInPage > lastProcessedIndexInPage) {
            newHighlightedString += plainPageText.substring(lastProcessedIndexInPage, actualSegmentStartInPage);
            console.log(`[BookView - Highlighting Effect] Appended pre-text for note ${note.id}: from ${lastProcessedIndexInPage} to ${actualSegmentStartInPage}`);
          }
          
          // Determine the actual segment of the note's source_text that is visible on this page
          // The start of the highlight within the page's plain text
          const highlightSegmentStartOnPage = Math.max(0, noteStartInPage);

          // The end of the highlight within the page's plain text
          // It's the minimum of: (note's end relative to page start) AND (page's end)
          const highlightSegmentEndOnPage = Math.min(
            noteStartInPage + noteLength, // note's end relative to page start
            plainPageText.length          // page's end
          );
          
          // Ensure we only try to highlight if the segment is valid and actually on this page
          if (highlightSegmentStartOnPage < highlightSegmentEndOnPage && highlightSegmentStartOnPage < plainPageText.length) {
            const textToHighlight = plainPageText.substring(highlightSegmentStartOnPage, highlightSegmentEndOnPage);
            console.log(`[BookView - Highlighting Effect] Highlighting for note ${note.id}: from ${highlightSegmentStartOnPage} to ${highlightSegmentEndOnPage}. Text: "${textToHighlight.substring(0,50)}..."`);
            newHighlightedString += `<span class="highlighted-note-text" data-note-id="${note.id}">${textToHighlight}</span>`;
            lastProcessedIndexInPage = highlightSegmentEndOnPage;
          } else {
             console.log(`[BookView - Highlighting Effect] Skipping highlight for note ${note.id} as its segment [${highlightSegmentStartOnPage}-${highlightSegmentEndOnPage}] is not valid or not on page.`);
             // If we skipped, ensure lastProcessedIndexInPage is at least where this note would have started,
             // to prevent reprocessing this area if it didn't actually add text.
             lastProcessedIndexInPage = Math.max(lastProcessedIndexInPage, actualSegmentStartInPage);
          }
        });

        // Append any remaining text after the last highlight
        if (lastProcessedIndexInPage < plainPageText.length) {
          newHighlightedString += plainPageText.substring(lastProcessedIndexInPage);
          console.log(`[BookView - Highlighting Effect] Appended post-text: from ${lastProcessedIndexInPage} to ${plainPageText.length}`);
        }
        
        console.log(`[BookView - Highlighting Effect] Final newHighlightedString for page ${currentPage} (first 100 chars): "${newHighlightedString.substring(0,100)}..."`);
        setHighlightedPageContent(newHighlightedString);

      } else { // No notes or no relevant notes
        console.log(`[BookView - Highlighting Effect] No notes to highlight on page ${currentPage}, setting plain text.`);
        setHighlightedPageContent(plainPageText); 
      }
      
      if (bookPaneRef.current) {
        if (pendingScrollOffsetInPage === null) {
            isProgrammaticScroll.current = true;
            bookPaneRef.current.scrollTop = 0;
            setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        }
      }
    } else { // No fullMarkdownContent.current
      setCurrentPageContent('');
      setHighlightedPageContent('');
      setTotalPages(1);
      setCurrentPage(1);
    }
  // Add `notes` and `pendingScrollOffsetInPage` to dependency array
  }, [bookData, currentPage, notes, pendingScrollOffsetInPage]); // fullMarkdownContent.current is a ref, not a state/prop for deps


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

    if (bookPaneRef.current && textFromBookPane && textFromBookPane.trim() !== "") {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const bookPaneElement = bookPaneRef.current; // This is div.book-pane-container

        // Calculate character offset from the start of the bookPaneElement to the start of the selection
        // let charCount = 0; // Not used in this version
        // let foundStart = false; // Not used in this version

        // Create a range that spans from the start of bookPaneElement to the start of the selection
        // const preSelectionRange = document.createRange(); // Not used in this version
        // preSelectionRange.selectNodeContents(bookPaneElement); // Select all content within bookPaneElement
        // preSelectionRange.setEnd(range.startContainer, range.startOffset); // Set end to selection start

        // The toString().length of this preSelectionRange can be a good approximation of the character offset
        // *within the rendered content of the current page*.
        // This will include characters from existing highlight spans if any.
        // This is an issue if we need an offset relative to *plain text*.

        // For a more accurate offset relative to PLAIN TEXT (currentPageContent):
        // We still need to map the DOM selection to the plain text.
        // The most robust way is to iterate text nodes.

        let startInPage = -1;
        const container = bookPaneRef.current; // The element whose plain text content matches currentPageContent
                                             // (or should, if highlighting is done carefully)
        
        if (container) {
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
            let currentOffset = 0;
            let textNode;
            let selectionStartNode = range.startContainer;
            let selectionStartOffset = range.startOffset;

            // If selection starts in an element node (e.g., a span), find the actual text node and offset
            if (selectionStartNode.nodeType !== Node.TEXT_NODE) {
                // This can happen if selection starts at the boundary of an element.
                // Try to find the first text node within or after.
                // This part can get complex. For simplicity, if it's not a text node,
                // the offset might be less accurate with the simple walker.
                // A common case: selection starts in a <span>. range.startContainer is the <span>.
                // We need to find the text node inside it or the next text node.
                let child = selectionStartNode.firstChild;
                let tempOffset = 0; // Tracks character offset within the children of selectionStartNode
                
                // Iterate through children of the element node (selectionStartNode)
                // to find the text node that contains the start of the selection
                // and adjust selectionStartOffset to be relative to that text node.
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
                                return true; // Found
                            }
                            currentDomOffset += childNode.textContent.length;
                        } else if (childNode.nodeType === Node.ELEMENT_NODE) {
                            if (findTextNodeRecursive(childNode, targetDomOffset - currentDomOffset)) {
                                return true; // Found in recursion
                            }
                            // If not found in recursion, add its textContent length to currentDomOffset
                            // This assumes textContent length is a good proxy for DOM offset contribution
                            currentDomOffset += childNode.textContent.length; 
                        }
                    }
                    return false; // Not found in this branch
                }

                if (range.startContainer.nodeType === Node.ELEMENT_NODE) {
                    findTextNodeRecursive(range.startContainer, range.startOffset);
                }
                
                if (!foundTextNode) {
                    // Fallback or warning if we couldn't pinpoint the text node.
                    // This might happen if selection is in an empty element or complex structure.
                    console.warn("[BookView - handleTextSelect] Could not precisely map element selection to a text node. Offset might be less accurate.");
                    // As a rough fallback, we might try to use preSelectionRange.toString().length,
                    // but this is what we are trying to avoid due to its own inaccuracies.
                    // For now, we'll proceed, and if startInPage remains -1, it will be handled.
                }
            }


            while ((textNode = walker.nextNode())) {
                if (textNode === selectionStartNode) {
                    startInPage = currentOffset + selectionStartOffset;
                    break;
                }
                // Only count text that is not part of our highlight spans for offset calculation
                // This check is tricky because the walker gives us raw text nodes.
                // If a highlight span splits a text node, the walker sees multiple text nodes.
                // The key is that `currentPageContent` is the *source of truth* for plain text.
                // The `global_character_offset` should always refer to this plain text.
                currentOffset += textNode.textContent.length;
            }
        }

        console.log("[BookView - handleTextSelect] Selection Text:", `"${textFromBookPane}"`);
        console.log("[BookView - handleTextSelect] Calculated startInPage (DOM Walker):", startInPage);

        if (startInPage !== -1) {
            const globalOffset = (currentPage - 1) * CHARACTERS_PER_PAGE + startInPage;
            
            // Get the canonical selected text from fullMarkdownContent using the calculated globalOffset
            // and the length of the user's visual selection.
            const canonicalSelectedText = fullMarkdownContent.current.substring(globalOffset, globalOffset + textFromBookPane.length);
            
            setSelectedBookText(canonicalSelectedText); // Store the canonical version
            setSelectedGlobalCharOffset(globalOffset);
            console.log("[BookView - handleTextSelect] Successfully calculated: globalOffset:", globalOffset);
            console.log("[BookView - handleTextSelect] canonicalSelectedText (length " + canonicalSelectedText.length + "):", `"${canonicalSelectedText}"`);
            
            const element = bookPaneRef.current; // This is div.book-pane-container
            if (element.scrollHeight > element.clientHeight) {
                const pageScrollPercentage = element.scrollTop / (element.scrollHeight - element.clientHeight);
                setSelectedScrollPercentage(pageScrollPercentage);
            } else {
                setSelectedScrollPercentage(0);
            }
        } else {
            console.warn("[BookView - handleTextSelect] DOM Walker failed to find selection start. Note location data (global offset) will not be set. Selected text will still be available for LLM.");
            setSelectedBookText(textFromBookPane); // Keep user's visual selection for LLM
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

  // Handler for clicking a note in NotePane, expects global character offset
  const handleNoteClick = (globalCharOffsetOfNote) => {
    if (globalCharOffsetOfNote !== null && globalCharOffsetOfNote !== undefined) {
      setScrollToGlobalOffset(globalCharOffsetOfNote);
    }
  };
  
  // Handler to be called when a new note is saved in NotePane
  const handleNewNoteSaved = (newNote) => {
    console.log("[BookView - handleNewNoteSaved] Received new note:", newNote);
    if (newNote && newNote.id) { // Ensure newNote is valid
      setNotes(prevNotes => {
        // Prevent adding duplicates if this handler is somehow called multiple times with the same note
        const noteExists = prevNotes.some(note => note.id === newNote.id);
        if (noteExists) {
            console.warn("[BookView - handleNewNoteSaved] Note ID", newNote.id, "already exists in state. Not adding again.");
            return prevNotes;
        }
        const updatedNotes = [...prevNotes, newNote].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        console.log("[BookView - handleNewNoteSaved] Updated notes state with new note:", updatedNotes.map(n => n.id));
        return updatedNotes;
      });
    } else {
        console.warn("[BookView - handleNewNoteSaved] Received invalid newNote object or note without ID:", newNote);
    }
  };


  useEffect(() => {
    if (scrollToGlobalOffset === null || !fullMarkdownContent.current) return;

    const targetGlobalOffset = scrollToGlobalOffset;
    const targetPage = Math.floor(targetGlobalOffset / CHARACTERS_PER_PAGE) + 1;
    const offsetWithinPage = targetGlobalOffset % CHARACTERS_PER_PAGE;

    if (targetPage !== currentPage) {
      setCurrentPage(targetPage);
      setPendingScrollOffsetInPage(offsetWithinPage);
    } else {
      // Current page is already correct, just scroll
      if (bookPaneRef.current && currentPageContent.length > 0) {
        const bookElement = bookPaneRef.current;
        // Ensure scrollHeight is greater than clientHeight to avoid division by zero or negative scroll values
        if (bookElement.scrollHeight > bookElement.clientHeight) {
            // Calculate scroll position based on character offset within the current page's original content
            const scrollRatio = offsetWithinPage / currentPageContent.length;
            const targetScrollTop = scrollRatio * (bookElement.scrollHeight - bookElement.clientHeight);
            
            isProgrammaticScroll.current = true;
            bookElement.scrollTo({ top: targetScrollTop, behavior: 'smooth' }); // Changed to 'smooth'
            setTimeout(() => { isProgrammaticScroll.current = false; }, 300); // Increased timeout for smooth scroll
        } else { 
            // Content is shorter than the view, scroll to top
            isProgrammaticScroll.current = true;
            bookElement.scrollTo({ top: 0, behavior: 'smooth' });
            setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
        }
      }
    }
    setScrollToGlobalOffset(null); // Reset after processing
  }, [scrollToGlobalOffset, currentPage, currentPageContent.length, fullMarkdownContent]); // Added fullMarkdownContent

  useEffect(() => {
    if (pendingScrollOffsetInPage !== null && bookPaneRef.current && currentPageContent.length > 0) {
      const bookElement = bookPaneRef.current;
      if (bookElement.scrollHeight > bookElement.clientHeight) {
        const scrollRatio = pendingScrollOffsetInPage / currentPageContent.length;
        const targetScrollTop = scrollRatio * (bookElement.scrollHeight - bookElement.clientHeight);

        isProgrammaticScroll.current = true;
        bookElement.scrollTo({ top: targetScrollTop, behavior: 'smooth' }); // Changed to 'smooth'
        setTimeout(() => { isProgrammaticScroll.current = false; }, 300); // Increased timeout
      } else {
        isProgrammaticScroll.current = true;
        bookElement.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => { isProgrammaticScroll.current = false; }, 300);
      }
      setPendingScrollOffsetInPage(null); // Reset after scrolling
    }
  }, [currentPageContent, pendingScrollOffsetInPage]); // currentPageContent implies current page is loaded


  const syncScroll = useCallback(
    debounce((scrollingPaneRef, targetPaneRef) => {
      if (isProgrammaticScroll.current) {
        return;
      }
      if (!scrollingPaneRef.current || !targetPaneRef.current) return;

      const scrollingElement = scrollingPaneRef.current;
      const targetElement = targetPaneRef.current;

      if (scrollingElement.scrollHeight <= scrollingElement.clientHeight) return;
      // Allow target to be scrolled even if it's shorter, to sync to top/bottom
      // if (targetElement.scrollHeight <= targetElement.clientHeight) return; 

      const scrollPercentage = scrollingElement.scrollTop / (scrollingElement.scrollHeight - scrollingElement.clientHeight);
      
      let targetScrollTop;
      if (targetElement.scrollHeight > targetElement.clientHeight) {
        targetScrollTop = scrollPercentage * (targetElement.scrollHeight - targetElement.clientHeight);
      } else {
        // If target is not scrollable, sync to top if source is at top, else to bottom
        targetScrollTop = scrollPercentage > 0.5 ? targetElement.scrollHeight : 0;
      }


      if (Math.abs(targetElement.scrollTop - targetScrollTop) > 5) { // Threshold to prevent jitter
        isProgrammaticScroll.current = true;
        targetElement.scrollTop = targetScrollTop;
        setTimeout(() => { isProgrammaticScroll.current = false; }, 50); // Shorter timeout for sync
      }
    }, 50), // Debounce time
    []
  );

  useEffect(() => {
    const bookElement = bookPaneRef.current;
    const noteElement = notePaneRef.current;

    if (bookElement && noteElement) {
      const debouncedBookScroll = () => syncScroll(bookPaneRef, notePaneRef);
      const debouncedNoteScroll = () => syncScroll(notePaneRef, bookPaneRef);

      bookElement.addEventListener('scroll', debouncedBookScroll);
      noteElement.addEventListener('scroll', debouncedNoteScroll);

      return () => {
        bookElement.removeEventListener('scroll', debouncedBookScroll);
        noteElement.removeEventListener('scroll', debouncedNoteScroll);
        debouncedBookScroll.cancel(); // Cancel lodash debounce on unmount
        debouncedNoteScroll.cancel();
      };
    }
  }, [syncScroll]); // syncScroll is memoized by useCallback

  const handlePreviousPage = () => {
    setCurrentPage((prev) => Math.max(1, prev - 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
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
    <div className="book-view-container">
        <div className="book-pane-wrapper">
          <div className="book-pane-container" ref={bookPaneRef}>
            <BookPane
              markdownContent={highlightedPageContent} // USE HIGHLIGHTED CONTENT
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
                onBlur={handleGoToPage} // Or use a submit button for the form
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
        <div className="note-pane-wrapper">
          <div className="note-pane-container" ref={notePaneRef}>
            <NotePane
              bookId={bookId}
              selectedBookText={selectedBookText}
              selectedScrollPercentage={selectedScrollPercentage}
              selectedGlobalCharOffset={selectedGlobalCharOffset} // Pass this down
              onNoteClick={handleNoteClick} // Renamed from onNoteClickInternal for clarity
              onNewNoteSaved={handleNewNoteSaved} // PASS THE NEW PROP
            />
          </div>
        </div>
    </div>
  );
}

export default BookView;
