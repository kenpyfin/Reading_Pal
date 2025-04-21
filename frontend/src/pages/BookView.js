import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom'; // Assuming react-router-dom for routing
import BookPane from '../components/BookPane';
import NotePane from '../components/NotePane';
// TODO: Import API function to fetch book data

function BookView() {
  const { bookId } = useParams(); // Get bookId from URL
  const [bookData, setBookData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchBook = async () => {
      try {
        // TODO: Call backend API to fetch book data
        // const data = await fetchBookApi(bookId);
        // setBookData(data);

        // Placeholder data
        const placeholderData = {
          title: `Book ${bookId}`,
          markdown_content: `# Title of Book ${bookId}\n\nThis is some **placeholder** markdown content.\n\nIt includes a list:\n\n- Item 1\n- Item 2\n\nAnd maybe an image placeholder:\n\n![Placeholder Image](/images/placeholder.png)\n\nMore text here.`,
          images: [{ filename: 'placeholder.png', path: '/images/placeholder.png' }], // Example image path
          file_path: `/path/to/markdown/${bookId}.md`
        };
        setBookData(placeholderData);

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
           markdownContent={bookData.markdown_content}
           images={bookData.images}
           // onScroll={handleScrollSync} // Pass scroll handler
         />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', borderLeft: '1px solid #ccc' }}>
         <NotePane
           bookId={bookId}
           // onScrollSync={handleScrollSync} // Pass scroll handler
         />
      </div>
    </div>
  );
}

export default BookView;
