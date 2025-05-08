import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import BookPane from '../components/BookPane';
import NotePane from '../components/NotePane';
import { debounce } from 'lodash';
import './BookView.css';

const CHARACTERS_PER_PAGE = 5000; // Define characters per page

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
  // selectedScrollPercentage is relative to the current page view
  const [selectedScrollPercentage, setSelectedScrollPercentage] = useState(null);
  // selectedGlobalCharOffset is relative to the full document
  const [selectedGlobalCharOffset, setSelectedGlobalCharOffset] = useState(null);


  // State for pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPageContent, setCurrentPageContent] = useState('');

  // State for scrolling to a note's location
  const [scrollToGlobalOffset, setScrollToGlobalOffset] = useState(null);
  const [pendingScrollOffsetInPage, setPendingScrollOffsetInPage] = useState(null);

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
        // setCurrentPage(1); // Reset to page 1 on new book load - handled by effect
      } else {
        fullMarkdownContent.current = '';
        setTotalPages(1);
        // setCurrentPage(1); // Reset to page 1
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

  // Effect for handling pagination logic when bookData or currentPage changes
  useEffect(() => {
    if (fullMarkdownContent.current) {
      const totalChars = fullMarkdownContent.current.length;
      const numPages = Math.max(1, Math.ceil(totalChars / CHARACTERS_PER_PAGE));
      setTotalPages(numPages); // Update total pages

      // Ensure currentPage is within valid bounds
      const validCurrentPage = Math.max(1, Math.min(currentPage, numPages));
      if (currentPage !== validCurrentPage) {
        setCurrentPage(validCurrentPage); // Adjust if out of bounds
        return; // Let the effect re-run with the corrected currentPage
      }
      
      const start = (validCurrentPage - 1) * CHARACTERS_PER_PAGE;
      const end = start + CHARACTERS_PER_PAGE;
      setCurrentPageContent(fullMarkdownContent.current.substring(start, end));
      
      if (bookPaneRef.current) {
        // Reset scroll position when page content changes, unless a pending scroll is active
        if (pendingScrollOffsetInPage === null) {
            isProgrammaticScroll.current = true;
            bookPaneRef.current.scrollTop = 0;
            setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        }
      }
    } else {
      setCurrentPageContent('');
      setTotalPages(1);
      setCurrentPage(1);
    }
  }, [bookData, currentPage, fullMarkdownContent.current]); // fullMarkdownContent.current won't trigger re-render, bookData dependency is key


  const handleTextSelect = (text) => {
    setSelectedBookText(text);
    if (bookPaneRef.current && text) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        
        // Calculate character offset within the current page
        const preSelectionRange = range.cloneRange();
        // Ensure preSelectionRange considers only the content of BookPane
        // Assuming BookPane's direct child is where markdown is rendered.
        // If BookPane has multiple children, this might need adjustment or a specific target div.
        const contentContainer = bookPaneRef.current.querySelector('.book-pane'); // Or more specific if BookPane wraps content
        if (contentContainer) {
            preSelectionRange.selectNodeContents(contentContainer);
            preSelectionRange.setEnd(range.startContainer, range.startOffset);
            const startInPage = preSelectionRange.toString().length;
            
            const globalOffset = (currentPage - 1) * CHARACTERS_PER_PAGE + startInPage;
            setSelectedGlobalCharOffset(globalOffset);
        } else {
            setSelectedGlobalCharOffset(null); // Fallback if container not found
        }

        // Calculate scroll percentage relative to current page view
        const element = bookPaneRef.current;
        if (element.scrollHeight > element.clientHeight) {
            const pageScrollPercentage = element.scrollTop / (element.scrollHeight - element.clientHeight);
            setSelectedScrollPercentage(pageScrollPercentage);
        } else {
            setSelectedScrollPercentage(0); // Or null if no scrollbar
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

  // onNoteClick now receives a globalCharacterOffset from NotePane
  const handleNoteClick = (globalOffset) => {
    if (globalOffset !== null && globalOffset !== undefined) {
      setScrollToGlobalOffset(globalOffset);
    }
  };

  // useEffect to handle scrolling when scrollToGlobalOffset changes (e.g., note clicked)
  useEffect(() => {
    if (scrollToGlobalOffset === null || !fullMarkdownContent.current) return;

    const targetGlobalOffset = scrollToGlobalOffset;
    const targetPage = Math.floor(targetGlobalOffset / CHARACTERS_PER_PAGE) + 1;
    const offsetWithinPage = targetGlobalOffset % CHARACTERS_PER_PAGE;

    if (targetPage !== currentPage) {
      // Navigate to the target page
      setCurrentPage(targetPage);
      // Store the intended offset for when the new page loads
      setPendingScrollOffsetInPage(offsetWithinPage);
    } else {
      // Already on the correct page, scroll directly
      if (bookPaneRef.current && currentPageContent.length > 0) {
        const bookElement = bookPaneRef.current;
        // Ensure scrollHeight is greater than clientHeight to avoid division by zero or NaN
        if (bookElement.scrollHeight > bookElement.clientHeight) {
            const scrollRatio = offsetWithinPage / currentPageContent.length;
            const targetScrollTop = scrollRatio * (bookElement.scrollHeight - bookElement.clientHeight);
            
            isProgrammaticScroll.current = true;
            bookElement.scrollTo({ top: targetScrollTop, behavior: 'instant' });
            setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        } else { // If no scrollbar, content is fully visible, effectively at scrollTop 0
            isProgrammaticScroll.current = true;
            bookElement.scrollTo({ top: 0, behavior: 'instant' });
            setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        }
      }
    }
    setScrollToGlobalOffset(null); // Reset trigger
  }, [scrollToGlobalOffset]); // Only trigger on scrollToGlobalOffset

  // New useEffect to handle scrolling AFTER page content has updated due to currentPage change
  useEffect(() => {
    if (pendingScrollOffsetInPage !== null && bookPaneRef.current && currentPageContent.length > 0) {
      const bookElement = bookPaneRef.current;
      // Ensure the content for the currentPage is now reflected in currentPageContent
      if (bookElement.scrollHeight > bookElement.clientHeight) {
        const scrollRatio = pendingScrollOffsetInPage / currentPageContent.length;
        const targetScrollTop = scrollRatio * (bookElement.scrollHeight - bookElement.clientHeight);

        isProgrammaticScroll.current = true;
        bookElement.scrollTo({ top: targetScrollTop, behavior: 'instant' });
        setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
      } else {
        isProgrammaticScroll.current = true;
        bookElement.scrollTo({ top: 0, behavior: 'instant' });
        setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
      }
      setPendingScrollOffsetInPage(null); // Clear pending scroll
    }
  }, [currentPageContent, pendingScrollOffsetInPage]); // Trigger when page content or pending offset changes


  const syncScroll = useCallback(
    debounce((scrollingPaneRef, targetPaneRef) => {
      if (isProgrammaticScroll.current) {
        return;
      }
      if (!scrollingPaneRef.current || !targetPaneRef.current) return;

      const scrollingElement = scrollingPaneRef.current;
      const targetElement = targetPaneRef.current;

      // Ensure scrollHeight is greater than clientHeight to avoid division by zero
      if (scrollingElement.scrollHeight <= scrollingElement.clientHeight) return;
      if (targetElement.scrollHeight <= targetElement.clientHeight) return;


      const scrollPercentage = scrollingElement.scrollTop / (scrollingElement.scrollHeight - scrollingElement.clientHeight);
      const targetScrollTop = scrollPercentage * (targetElement.scrollHeight - targetElement.clientHeight);

      if (Math.abs(targetElement.scrollTop - targetScrollTop) > 5) {
        isProgrammaticScroll.current = true;
        targetElement.scrollTop = targetScrollTop;
        setTimeout(() => { isProgrammaticScroll.current = false; }, 50); // Reset after a short delay
      }
    }, 50),
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
        debouncedBookScroll.cancel();
        debouncedNoteScroll.cancel();
      };
    }
  }, [syncScroll]);

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
  if (bookData.status === 'completed' && !fullMarkdownContent.current) { // Check fullMarkdownContent ref
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
      {/* <div className="main-content-area"> This div might be useful if you have sidebars outside book/note panes */}
        <div className="book-pane-wrapper"> {/* Wrapper for BookPane and its controls */}
          <div className="book-pane-container" ref={bookPaneRef}>
            <BookPane
              // Pass current page's content to BookPane
              markdownContent={currentPageContent} 
              imageUrls={bookData.image_urls} // Image URLs are global, not per page
              onTextSelect={handleTextSelect}
              // ref={bookPaneRef} // forwardRef handles this
            />
          </div>
          <div className="pagination-controls">
            <button onClick={handlePreviousPage} disabled={currentPage === 1}>
              Previous
            </button>
            <span> Page {currentPage} of {totalPages} </span>
            <button onClick={handleNextPage} disabled={currentPage === totalPages}>
              Next
            </button>
          </div>
        </div>
        <div className="note-pane-wrapper"> {/* Wrapper for NotePane */}
          <div className="note-pane-container" ref={notePaneRef}>
            <NotePane
              bookId={bookId}
              selectedBookText={selectedBookText}
              selectedScrollPercentage={selectedScrollPercentage} // Relative to current page
              selectedGlobalCharOffset={selectedGlobalCharOffset} // Absolute offset
              onNoteClick={handleNoteClick} // Expects globalCharOffset
              // ref={notePaneRef} // forwardRef handles this
            />
          </div>
        </div>
      {/* </div> */}
    </div>
  );
}

export default BookView;

