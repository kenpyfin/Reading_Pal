import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom'; // Assuming react-router-dom for routing
import BookPane from '../components/BookPane';
import NotePane from '../components/NotePane'; // Keep import for future phase

function BookView() {
  const { bookId } = useParams(); // Get bookId from URL
  const [bookData, setBookData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
  // const handleScrollSync = (scrollTop) => {
  //   // Adjust scroll position of the other pane
  // };

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
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
         <BookPane
           markdownContent={bookData.markdown_content} // Pass markdown content
           imageUrls={bookData.image_urls} // Pass image URLs
           // onScroll={handleScrollSync} // Pass scroll handler
         />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', borderLeft: '1px solid #ccc' }}>
         {/* NotePane will be implemented in a later phase */}
         <NotePane
           bookId={bookId} // Pass bookId to NotePane
           bookContent={bookData.markdown_content} // Pass book content to NotePane for LLM context
           // onScrollSync={handleScrollSync} // Pass scroll handler
         />
         {/* Remove placeholder div */}
         {/* <div>Note Pane Placeholder</div> */}
      </div>
    </div>
  );
}

export default BookView;
