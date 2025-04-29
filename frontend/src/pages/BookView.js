import React, { useEffect, useState, useRef } from 'react'; // Import useRef
import { useParams, Link } from 'react-router-dom'; // Import Link for navigation
import BookPane from '../components/BookPane'; // Import the updated BookPane
import NotePane from '../components/NotePane'; // Keep import for future phase

function BookView() {
  const { bookId } = useParams(); // Get bookId from URL
  const [bookData, setBookData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Refs for scroll synchronization
  const bookPaneRef = useRef(null);
  const notePaneRef = useRef(null);

  // State to hold text selected in the BookPane
  const [selectedBookText, setSelectedBookText] = useState(null);

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
  };

  // TODO: Implement scroll synchronization logic between panes
  // This is a placeholder function. Actual implementation needs to map
  // scroll positions between the two panes, which might have different heights
  // and content structures.
  const handleScrollSync = (scrollingPaneRef, targetPaneRef) => {
      if (!scrollingPaneRef.current || !targetPaneRef.current) return;

      // Basic percentage-based sync (might not be accurate for all content)
      const scrollingElement = scrollingPaneRef.current;
      const targetElement = targetPaneRef.current;

      const scrollPercentage = scrollingElement.scrollTop / (scrollingElement.scrollHeight - scrollingElement.clientHeight);

      // Prevent infinite loop by checking if the target is already close to the desired position
      const targetScrollTop = scrollPercentage * (targetElement.scrollHeight - targetElement.clientHeight);
      if (Math.abs(targetElement.scrollTop - targetScrollTop) > 5) { // Use a small threshold
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

  // CHANGE: Improve the "Book not found" message
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
         ref={bookPaneRef} // Attach ref
         style={{ flex: 1, overflowY: 'auto', padding: '20px' }}
         onScroll={handleBookPaneScroll} // Add scroll handler
         // Pass the ref and the text selection handler to BookPane
      >
         <BookPane
           markdownContent={bookData.markdown_content} // Pass markdown content
           imageUrls={bookData.image_urls} // Pass image URLs
           onTextSelect={handleTextSelect} // Pass the text selection handler
         />
      </div>
      {/* Note Pane */}
      <div
         ref={notePaneRef} // Attach ref
         style={{ flex: 1, overflowY: 'auto', padding: '20px', borderLeft: '1px solid #ccc' }}
         onScroll={handleNotePaneScroll} // Add scroll handler
      >
         <NotePane
           bookId={bookId} // Pass bookId to NotePane
           selectedBookText={selectedBookText} // Pass the selected text to NotePane
           bookContent={bookData.markdown_content} // Pass book content to NotePane for LLM context
           // NotePane now uses forwardRef, so we pass the ref prop directly
           ref={notePaneRef}
         />
      </div>
    </div>
  );
}

export default BookView;
