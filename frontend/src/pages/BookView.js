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
        notes.forEach(note => {
          // Ensure note.source_text and global_character_offset are valid
          if (note.source_text && note.source_text.trim() !== "" && note.global_character_offset !== undefined) {
            const escapedSourceText = escapeRegExp(note.source_text);
            const regex = new RegExp(escapedSourceText, 'g');
            
            const noteStartOffset = note.global_character_offset;
            const noteEndOffset = noteStartOffset + note.source_text.length;

            // Check if the note's global character range overlaps with the current page's global character range
            if ( (noteStartOffset >= start && noteStartOffset < end) || // Note starts on this page
                 (noteEndOffset > start && noteEndOffset <= end) ||   // Note ends on this page
                 (noteStartOffset < start && noteEndOffset > end)      // Note spans this page
            ) {
              // Only attempt replacement if the note's range overlaps with the current page
              tempHighlightedContent = tempHighlightedContent.replace(regex, (match) => 
                `<span class="highlighted-note-text" data-note-id="${note.id}">${match}</span>`
              );
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
            
            // Calculate startInPage carefully, considering existing HTML highlights
            // This is tricky because preSelectionRange.toString() will give plain text
            // We need to count characters in the *original* markdown, not the highlighted HTML
            // For now, this calculation might be slightly off if selection is within/around highlights
            // A more robust way would be to map selection back to original unhighlighted content.
            // This is a known complexity. For now, we use the text length.
            const startInPage = preSelectionRange.toString().length;
            
            const globalOffset = (currentPage - 1) * CHARACTERS_PER_PAGE + startInPage;
            setSelectedGlobalCharOffset(globalOffset);
        } else {
            setSelectedGlobalCharOffset(null);
        }

        const element = bookPaneRef.current;
        if (element.scrollHeight > element.clientHeight) {
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

  const handleNoteClick = (globalOffset) => {
    if (globalOffset !== null && globalOffset !== undefined) {
      setScrollToGlobalOffset(globalOffset);
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
      if (bookPaneRef.current && currentPageContent.length > 0) { // Use currentPageContent for length
        const bookElement = bookPaneRef.current;
        if (bookElement.scrollHeight > bookElement.clientHeight) {
            const scrollRatio = offsetWithinPage / currentPageContent.length; // Use original content length
            const targetScrollTop = scrollRatio * (bookElement.scrollHeight - bookElement.clientHeight);
            
            isProgrammaticScroll.current = true;
            bookElement.scrollTo({ top: targetScrollTop, behavior: 'instant' });
            setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        } else { 
            isProgrammaticScroll.current = true;
            bookElement.scrollTo({ top: 0, behavior: 'instant' });
            setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
        }
      }
    }
    setScrollToGlobalOffset(null);
  }, [scrollToGlobalOffset, currentPage, currentPageContent.length]); // Add dependencies

  useEffect(() => {
    if (pendingScrollOffsetInPage !== null && bookPaneRef.current && currentPageContent.length > 0) {
      const bookElement = bookPaneRef.current;
      if (bookElement.scrollHeight > bookElement.clientHeight) {
        const scrollRatio = pendingScrollOffsetInPage / currentPageContent.length; // Use original content length
        const targetScrollTop = scrollRatio * (bookElement.scrollHeight - bookElement.clientHeight);

        isProgrammaticScroll.current = true;
        bookElement.scrollTo({ top: targetScrollTop, behavior: 'instant' });
        setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
      } else {
        isProgrammaticScroll.current = true;
        bookElement.scrollTo({ top: 0, behavior: 'instant' });
        setTimeout(() => { isProgrammaticScroll.current = false; }, 100);
      }
      setPendingScrollOffsetInPage(null);
    }
  }, [currentPageContent, pendingScrollOffsetInPage]);


  const syncScroll = useCallback(
    debounce((scrollingPaneRef, targetPaneRef) => {
      if (isProgrammaticScroll.current) {
        return;
      }
      if (!scrollingPaneRef.current || !targetPaneRef.current) return;

      const scrollingElement = scrollingPaneRef.current;
      const targetElement = targetPaneRef.current;

      if (scrollingElement.scrollHeight <= scrollingElement.clientHeight) return;
      if (targetElement.scrollHeight <= targetElement.clientHeight) return;

      const scrollPercentage = scrollingElement.scrollTop / (scrollingElement.scrollHeight - scrollingElement.clientHeight);
      const targetScrollTop = scrollPercentage * (targetElement.scrollHeight - targetElement.clientHeight);

      if (Math.abs(targetElement.scrollTop - targetScrollTop) > 5) {
        isProgrammaticScroll.current = true;
        targetElement.scrollTop = targetScrollTop;
        setTimeout(() => { isProgrammaticScroll.current = false; }, 50);
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
        <div className="note-pane-wrapper">
          <div className="note-pane-container" ref={notePaneRef}>
            <NotePane
              bookId={bookId}
              selectedBookText={selectedBookText}
              selectedScrollPercentage={selectedScrollPercentage}
              selectedGlobalCharOffset={selectedGlobalCharOffset}
              onNoteClick={handleNoteClick}
            />
          </div>
        </div>
    </div>
  );
}

export default BookView;
