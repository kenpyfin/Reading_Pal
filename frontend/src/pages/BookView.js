import React, { useEffect, useState, useRef } from 'react'; // Import useRef
import { useParams } from 'react-router-dom'; // Assuming react-router-dom for routing
import BookPane from '../components/BookPane';
import NotePane from '../components/NotePane'; // Keep import for future phase

function BookView() {
  const { bookId } = useParams(); // Get bookId from URL
  const [bookData, setBookData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Refs for scroll synchronization
  const bookPaneRef = useRef(null);
  const notePaneRef = useRef(null);

  useEffect(() => {
    const fetchBook = async () => {
      try {
        // Call backend API to fetch book data
        // Added /api prefix based on backend routing
        const response = await fetch(`/api/books/${bookId}`); // Use relative path with /api

        if (!response.ok) {
           const errorData = await response.json();
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
    return <div>Loading book...</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  if (!bookData) {
    return <div>Book not found.</div>;
  }

  return (
    <div className="book-view-container" style={{ display: 'flex', height: '100vh' }}>
      {/* Book Pane */}
      <div
         ref={bookPaneRef} // Attach ref
         style={{ flex: 1, overflowY: 'auto', padding: '20px' }}
         onScroll={handleBookPaneScroll} // Add scroll handler
      >
         <BookPane
           markdownContent={bookData.markdown_content} // Pass markdown content
           imageUrls={bookData.image_urls} // Pass image URLs
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
           bookContent={bookData.markdown_content} // Pass book content to NotePane for LLM context
           // NotePane now uses forwardRef, so we pass the ref prop directly
           ref={notePaneRef}
         />
      </div>
    </div>
  );
}

export default BookView;
