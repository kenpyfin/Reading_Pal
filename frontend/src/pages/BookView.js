import React, { useEffect, useState, useRef, useCallback } from 'react'; // Import useCallback
import { useParams, Link } from 'react-router-dom'; // Import Link for navigation
import BookPane from '../components/BookPane'; // Import the updated BookPane
import NotePane from '../components/NotePane'; // Keep import for future phase
import { debounce } from 'lodash'; // Import debounce
import './BookView.css'; // Assuming you have a CSS file for BookView layout

function BookView() {
  const { bookId } = useParams(); // Get bookId from URL
  const [bookData, setBookData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Refs for scroll synchronization and direct element access
  const bookPaneRef = useRef(null);
  const notePaneRef = useRef(null);

  // Ref to track if the scroll was programmatic (from clicking a note)
  const isProgrammaticScroll = useRef(false); // ADD THIS REF

  // State to hold the currently selected text from the book pane
  const [selectedBookText, setSelectedBookText] = useState(null);
  // Add state to hold the scroll percentage when text is selected
  const [selectedScrollPercentage, setSelectedScrollPercentage] = useState(null);

  // Add state to trigger scrolling in the book pane from NotePane clicks
  const [scrollToPercentage, setScrollToPercentage] = useState(null);


  // Function to fetch book data
  const fetchBook = async () => {
    setLoading(true);
    setError(null);
    try {
      // Call backend API to fetch book data
      // Added /api prefix based on backend routing
      const response = await fetch(`/api/books/${bookId}`); // Use relative path with /api

      if (!response.ok) {
         const errorData = await response.json();
         // Check if the error is specifically 404 Not Found
         if (response.status === 404) {
             // Set bookData to null explicitly for the "not found" state
             setBookData(null);
             // No need to set a specific error message here, the !bookData check handles it
             return; // Stop processing
         }
         // For other errors, throw the error
         throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || response.statusText}`);
      }
      const data = await response.json();
      setBookData(data);
      console.log("Fetched book data:", data); // Log fetched data

    } catch (err) {
      console.error('Failed to fetch book:', err);
      setError(`Failed to load book: ${err.message || 'Unknown error'}`);
      setBookData(null); // Ensure bookData is null on error
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch when bookId changes
  useEffect(() => {
    if (bookId) {
      fetchBook();
    }
  }, [bookId]);

  // Handler for text selection in BookPane
  const handleTextSelect = (text) => {
      setSelectedBookText(text);
      // Capture the current scroll percentage of the book pane when text is selected
      if (bookPaneRef.current) {
          const element = bookPaneRef.current;
          // Calculate percentage: current scroll / (total scrollable height)
          // total scrollable height = scrollHeight - clientHeight
          const percentage = element.scrollTop / (element.scrollHeight - element.clientHeight);
          setSelectedScrollPercentage(percentage); // CAPTURE THE PERCENTAGE
      } else {
          setSelectedScrollPercentage(null); // Reset if ref is not available
      }
  };

  // Add handler for clicking a note in the NotePane
  const handleNoteClick = (percentage) => {
      // This function is called by NotePane when a note is clicked
      if (percentage !== null && percentage !== undefined) {
          setScrollToPercentage(percentage); // Set state to trigger scroll effect in BookPane
      }
  };

  // Add useEffect to scroll the book pane when scrollToPercentage changes
  useEffect(() => {
      if (scrollToPercentage !== null && bookPaneRef.current) {
          const bookElement = bookPaneRef.current;
          // Calculate the target scroll position from the percentage
          const targetScrollTop = scrollToPercentage * (bookElement.scrollHeight - bookElement.clientHeight);

          // Set the programmatic scroll flag BEFORE scrolling
          isProgrammaticScroll.current = true;

          // Use INSTANT scrolling for direct jump
          bookElement.scrollTo({
              top: targetScrollTop,
              behavior: 'instant'
          });

          // Reset the state AFTER scrolling so it can be triggered again
          // Keep this line so clicking the same note after scrolling away works
          setScrollToPercentage(null);

          // Reset the programmatic scroll flag AFTER a short delay
          // This delay should be longer than the scroll duration (instant is very short)
          // but allows the scroll event handler to run first and see the flag.
          setTimeout(() => {
              isProgrammaticScroll.current = false;
          }, 100); // A small delay (e.g., 100ms) should be sufficient

      }
  }, [scrollToPercentage]); // Depend on scrollToPercentage


  // Debounced scroll synchronization function
  const syncScroll = useCallback(
      debounce((scrollingPaneRef, targetPaneRef) => {
          // Check the programmatic scroll flag
          if (isProgrammaticScroll.current) {
              // If this scroll was initiated programmatically, do NOT sync the other pane
              // The flag will be reset shortly after the programmatic scroll completes.
              return;
          }

          if (!scrollingPaneRef.current || !targetPaneRef.current) return;

          const scrollingElement = scrollingPaneRef.current;
          const targetElement = targetPaneRef.current;

          const scrollPercentage = scrollingElement.scrollTop / (scrollingElement.scrollHeight - scrollingElement.clientHeight);

          const targetScrollTop = scrollPercentage * (targetElement.scrollHeight - targetElement.clientHeight);

          // Only update if the difference is significant to avoid infinite loops
          // and allow for slight variations in scrollable height calculation
          if (Math.abs(targetElement.scrollTop - targetScrollTop) > 5) { // Threshold of 5 pixels
               // Set the programmatic scroll flag BEFORE updating the target pane's scroll
               // This prevents the target pane's scroll handler from syncing back
               isProgrammaticScroll.current = true;
               targetElement.scrollTop = targetScrollTop;
               // Reset the flag immediately after setting scrollTop for the target pane
               // The target pane's scroll event handler will see this flag set.
               // A very short timeout might be safer if setting scrollTop is async,
               // but typically it's synchronous. Let's stick to immediate reset for now.
               isProgrammaticScroll.current = false; // Reset immediately after setting
          }
      }, 50), // Debounce delay (e.g., 50ms)
      [] // Empty dependency array for useCallback
  );

  // Attach scroll listeners using useEffect and refs
  useEffect(() => {
      const bookElement = bookPaneRef.current;
      const noteElement = notePaneRef.current;

      if (bookElement && noteElement) {
          // Create debounced handlers that call the shared syncScroll logic
          const debouncedBookScroll = () => syncScroll(bookPaneRef, notePaneRef);
          const debouncedNoteScroll = () => syncScroll(notePaneRef, bookPaneRef);

          // Add event listeners
          bookElement.addEventListener('scroll', debouncedBookScroll);
          noteElement.addEventListener('scroll', debouncedNoteScroll);

          // Cleanup function to remove listeners
          return () => {
              bookElement.removeEventListener('scroll', debouncedBookScroll);
              noteElement.removeEventListener('scroll', debouncedNoteScroll);
              // Also cancel any pending debounced calls
              debouncedBookScroll.cancel();
              debouncedNoteScroll.cancel();
          };
      }
      // Re-run effect if refs change (though they shouldn't after initial render)
  }, [syncScroll]); // Dependency on syncScroll memoized function


  if (loading) {
    return <div style={{ padding: '20px' }}>Loading book...</div>;
  }

  if (error) {
    return <div style={{ padding: '20px', color: 'red' }}>Error loading book: {error}</div>;
  }

  if (!bookData) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h2>Book Not Found</h2>
        <p>The book with ID "{bookId}" could not be found.</p>
        <p>It might have been deleted or the link is incorrect.</p>
        <div style={{ marginTop: '20px' }}>
          <Link to="/">Go back to the Book List</Link>
          <span style={{ margin: '0 10px' }}>|</span>
          <Link to="/upload">Upload a New PDF</Link>
        </div>
      </div>
    );
  }

  // Check the book status before rendering content
  // MODIFICATION: Change 'processed' to 'completed'
  if (bookData.status !== 'completed') {
      return (
          <div style={{ padding: '20px', textAlign: 'center' }}>
              <h2>{bookData.title || bookData.original_filename}</h2>
              <p>Status: {bookData.status || 'unknown'}</p> {/* Added fallback */}
              {(bookData.status === 'processing' || bookData.status === 'pending') && ( // Check for pending too
                  <p>Processing your book... This may take a few minutes (or longer) for large files.</p>
              )}
              {bookData.status === 'failed' && (
                  <p style={{ color: 'red' }}>Processing failed. Please try uploading again or check the backend logs.</p>
              )}
              {/* Removed 'uploaded' check as it's covered by 'pending' */}
              <div style={{ marginTop: '20px' }}>
                <Link to="/">Go back to the Book List</Link>
                <span style={{ margin: '0 10px' }}>|</span>
                <Link to="/upload">Upload a New PDF</Link>
              </div>
          </div>
      );
  }

  // MODIFICATION: Explicitly check for 'completed' status here as well
  // If status is 'completed' but content is missing (shouldn't happen if backend is correct)
  if (bookData.status === 'completed' && !bookData.markdown_content) {
       return (
           <div style={{ padding: '20px', color: 'orange', textAlign: 'center' }}>
               <h2>{bookData.title || bookData.original_filename}</h2>
               <p>Status: Completed, but content could not be loaded.</p>
               <p>The markdown file might be missing or unreadable on the server.</p>
               <div style={{ marginTop: '20px' }}>
                 <Link to="/">Go back to the Book List</Link>
               </div>
           </div>
       );
  }


  // Render the dual pane view only if the book is completed and content is available
  return (
    <div className="book-view-container"> {/* Use the CSS class for layout */}
      {/* Book Pane */}
      <div className="book-pane-container" ref={bookPaneRef}> {/* Use CSS class and attach ref */}
         <BookPane
           markdownContent={bookData.markdown_content}
           imageUrls={bookData.image_urls}
           onTextSelect={handleTextSelect} // Pass the text selection handler
         />
      </div>
      {/* Note Pane */}
      <div className="note-pane-container" ref={notePaneRef}> {/* Use CSS class and attach ref */}
         <NotePane
           bookId={bookId}
           selectedBookText={selectedBookText} // Pass the selected text
           selectedScrollPercentage={selectedScrollPercentage} // PASS THE CAPTURED PERCENTAGE
           onNoteClick={handleNoteClick} // PASS THE NOTE CLICK HANDLER
           // NotePane now uses forwardRef, so we pass the ref prop directly
           ref={notePaneRef}
         />
      </div>
    </div>
  );
}

export default BookView;
