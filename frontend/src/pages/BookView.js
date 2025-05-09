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
    if (fullMarkdownContent.current) {
      const totalChars = fullMarkdownContent.current.length;
      const numPages = Math.max(1, Math.ceil(totalChars / CHARACTERS_PER_PAGE));
      setTotalPages(numPages); // Update total pages

      const validCurrentPage = Math.max(1, Math.min(currentPage, numPages));
      if (currentPage !== validCurrentPage) {
        setCurrentPage(validCurrentPage); // Adjust if out of bounds
        return; // Let the effect re-run with the corrected currentPage
      }
      
      const start = (validCurrentPage - 1) * CHARACTERS_PER_PAGE;
      const end = start + CHARACTERS_PER_PAGE;
      let pageContent = fullMarkdownContent.current.substring(start, end);
      setCurrentPageContent(pageContent); // Store original page content

      // Apply highlighting
      let tempHighlightedContent = pageContent;
      if (notes.length > 0) {
        // Sort notes by global_character_offset in descending order
        // to avoid issues with nested or overlapping highlights when replacing.
        // Highlighting longer matches first or those appearing later in the text first can be safer.
        // Or, more robustly, process replacements on a copy and track offset changes.
        // For simplicity, if source_text is unique enough, order might not be critical.
        // Let's sort by offset to be somewhat systematic.
        const sortedNotesForHighlighting = [...notes].sort((a, b) => {
            if (a.global_character_offset === undefined || a.global_character_offset === null) return 1;
            if (b.global_character_offset === undefined || b.global_character_offset === null) return -1;
            return a.global_character_offset - b.global_character_offset;
        });

        sortedNotesForHighlighting.forEach(note => {
          // Ensure note.source_text and global_character_offset are valid
          if (note.source_text && note.source_text.trim() !== "" && note.global_character_offset !== undefined && note.global_character_offset !== null) {
            const escapedSourceText = escapeRegExp(note.source_text);
            // Important: The regex needs to be applied to the current state of tempHighlightedContent,
            // but the offsets are relative to the original fullMarkdownContent.
            // This simple replace might fail if source_text is not unique or if highlights alter indices.
            
            const noteStartOffset = note.global_character_offset;
            const noteEndOffset = noteStartOffset + note.source_text.length;

            // Check if the note's global character range overlaps with the current page's global character range
            if ( (noteStartOffset >= start && noteStartOffset < end) || // Note starts on this page
                 (noteEndOffset > start && noteEndOffset <= end) ||   // Note ends on this page
                 (noteStartOffset < start && noteEndOffset > end)      // Note spans this page
            ) {
              // Calculate the position of the source_text *within the current pageContent*
              const startOnPage = Math.max(0, noteStartOffset - start);
              const endOnPage = Math.min(CHARACTERS_PER_PAGE, noteEndOffset - start);
              
              // Extract the text to be highlighted from the *original* pageContent
              // to avoid issues with already highlighted content
              const textToHighlightOnPage = pageContent.substring(startOnPage, endOnPage);

              if (textToHighlightOnPage && textToHighlightOnPage.trim() !== "") {
                const regex = new RegExp(escapeRegExp(textToHighlightOnPage), 'g');
                tempHighlightedContent = tempHighlightedContent.replace(regex, (match) => 
                  `<span class="highlighted-note-text" data-note-id="${note.id}">${match}</span>`
                );
              }
            }
          }
        });
      }
      setHighlightedPageContent(tempHighlightedContent);
      
      if (bookPaneRef.current) {
        if (pendingScrollOffsetInPage === null) {
            isProgrammaticScroll.current = true;
            bookPaneRef.current.scrollTop = 0;
            setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        }
      }
    } else {
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

  const handleTextSelect = (text) => {
    setSelectedBookText(text);
    if (bookPaneRef.current && text) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        
        const preSelectionRange = range.cloneRange();
        const contentContainer = bookPaneRef.current.querySelector('.book-pane'); 
        if (contentContainer) {
            preSelectionRange.selectNodeContents(contentContainer);
            preSelectionRange.setEnd(range.startContainer, range.startOffset);
            
            // This calculation of startInPage needs to be robust against existing HTML tags.
            // A simple .toString().length on a range within mixed HTML/text content
            // might not accurately reflect character offset in the original markdown.
            // For now, we proceed with this, acknowledging its limitations.
            // A more complex solution would involve mapping selection back to the raw currentPageContent.
            const startInPage = preSelectionRange.toString().length; 
            
            const globalOffset = (currentPage - 1) * CHARACTERS_PER_PAGE + startInPage;
            setSelectedGlobalCharOffset(globalOffset);
        } else {
            setSelectedGlobalCharOffset(null);
        }

        const element = bookPaneRef.current;
        if (element.scrollHeight > element.clientHeight) {
            // Calculate scroll percentage based on the start of the selection
            // This is an approximation. A more precise way might involve the position of the range.
            const pageScrollPercentage = element.scrollTop / (element.scrollHeight - element.clientHeight);
            setSelectedScrollPercentage(pageScrollPercentage);
        } else {
            setSelectedScrollPercentage(0);
        }
      } else {
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
    if (newNote) {
      setNotes(prevNotes => {
        const updatedNotes = [...prevNotes, newNote];
        // Re-sort by creation date or another consistent criterion
        updatedNotes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        return updatedNotes;
      });
      // Optionally, clear selection after note is saved
      // setSelectedBookText(null);
      // setSelectedGlobalCharOffset(null);
      // setSelectedScrollPercentage(null);
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
