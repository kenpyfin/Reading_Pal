import React, { useEffect, useState, useRef } from 'react'; // Import useRef
import { useParams, Link } from 'react-router-dom'; // Import Link for navigation
import BookPane from '../components/BookPane'; // Import the updated BookPane
import NotePane from '../components/NotePane'; // Keep import for future phase
// Assuming you have a CSS file for BookView layout
// import './BookView.css'; // Uncomment if you have this file

function BookView() {
  const { bookId } = useParams(); // Get bookId from URL
  const [bookData, setBookData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Refs for scroll synchronization and direct element access
  const bookPaneRef = useRef(null);
  const notePaneRef = useRef(null);

  // State to hold the currently selected text from the book pane
  const [selectedBookText, setSelectedBookText] = useState(null);
  // Add state to hold the scroll percentage when text is selected
  const [selectedScrollPercentage, setSelectedScrollPercentage] = useState(null); // ADD THIS LINE

  // Add state to trigger scrolling in the book pane from NotePane clicks
  const [scrollToPercentage, setScrollToPercentage] = useState(null); // ADD THIS LINE


  useEffect(() => {
    const fetchBook = async () => {
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

      } catch (err) {
        console.error('Failed to fetch book:', err);
        setError(`Failed to load book: ${err.message || 'Unknown error'}`);
      } finally {
        setLoading(false);
      }
    };

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
  const handleNoteClick = (percentage) => { // ADD THIS FUNCTION
      // This function is called by NotePane when a note is clicked
      if (percentage !== null && percentage !== undefined) {
          setScrollToPercentage(percentage); // Set state to trigger scroll effect in BookPane
      }
  };

  // Add useEffect to scroll the book pane when scrollToPercentage changes
  useEffect(() => { // ADD THIS useEffect
      if (scrollToPercentage !== null && bookPaneRef.current) {
          const bookElement = bookPaneRef.current;
          // Calculate the target scroll position from the percentage
          const targetScrollTop = scrollToPercentage * (bookElement.scrollHeight - bookElement.clientHeight);

          // Use INSTANT scrolling for direct jump
          bookElement.scrollTo({
              top: targetScrollTop,
              // Change behavior from 'smooth' to 'instant'
              behavior: 'instant' // CHANGE THIS LINE
          });

          // Reset the state after scrolling so it can be triggered again
          // Keep this line so clicking the same note after scrolling away works
          setScrollToPercentage(null);
      }
  }, [scrollToPercentage, bookPaneRef]); // Depend on scrollToPercentage and bookPaneRef


  // Basic percentage-based scroll synchronization (keep as is)
  const handleScrollSync = (scrollingPaneRef, targetPaneRef) => {
      if (!scrollingPaneRef.current || !targetPaneRef.current) return;

      const scrollingElement = scrollingPaneRef.current;
      const targetElement = targetPaneRef.current;

      const scrollPercentage = scrollingElement.scrollTop / (scrollingElement.scrollHeight - scrollingElement.clientHeight);

      const targetScrollTop = scrollPercentage * (targetElement.scrollHeight - targetElement.clientHeight);
      if (Math.abs(targetElement.scrollTop - targetScrollTop) > 5) {
           targetElement.scrollTop = targetScrollTop;
      }
  };

  const handleBookPaneScroll = () => {
      handleScrollSync(bookPaneRef, notePaneRef);
  };

  const handleNotePaneScroll = () => {
      handleScrollSync(notePaneRef, bookPaneRef);
  };


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

  return (
    <div className="book-view-container" style={{ display: 'flex', height: '100vh' }}>
      {/* Book Pane */}
      <div
         ref={bookPaneRef}
         style={{ flex: 1, overflowY: 'auto', padding: '20px' }}
         onScroll={handleBookPaneScroll}
      >
         <BookPane
           markdownContent={bookData.markdown_content}
           imageUrls={bookData.image_urls}
           onTextSelect={handleTextSelect} // Pass the text selection handler
         />
      </div>
      {/* Note Pane */}
      <div
         ref={notePaneRef}
         style={{ flex: 1, overflowY: 'auto', padding: '20px', borderLeft: '1px solid #ccc' }}
         onScroll={handleNotePaneScroll}
      >
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
