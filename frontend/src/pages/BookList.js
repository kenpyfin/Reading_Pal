import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom'; // Import Link for navigation

// Define polling interval (e.g., every 5 seconds)
const POLLING_INTERVAL = 5000; // 5 seconds

function BookList() {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Function to fetch the list of books
  const fetchBooks = async () => {
    setLoading(true);
    setError(null);
    try {
      // Call backend API to fetch the list of books
      // Use the /api prefix as configured in the backend and nginx
      const response = await fetch('/api/books/'); // Fetch from the root books endpoint

      if (!response.ok) {
         const errorData = await response.json();
         throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || response.statusText}`);
      }
      const data = await response.json();
      // The data now includes 'status' and 'job_id'
      setBooks(data);

    } catch (err) {
      console.error('Failed to fetch books:', err);
      setError(`Failed to load books: ${err.message || 'Unknown error'}`);
      setBooks([]); // Clear books on error
    } finally {
      setLoading(false);
    }
  };

  // Function to check the status of a single book by its job_id
  const checkBookStatus = async (bookId, jobId) => {
      if (!jobId) return null; // Cannot check status without a job ID

      try {
          // Call the new backend status endpoint
          const response = await fetch(`/api/books/status/${jobId}`);

          if (!response.ok) {
              // Log the error but don't necessarily stop polling or mark as failed immediately
              // The backend status endpoint should handle cases where the job ID is not found
              // or the PDF service is down.
              const errorData = await response.json();
              console.error(`Failed to check status for job ${jobId} (Book ID: ${bookId}):`, errorData.detail || response.statusText);
              // Return null or the existing book data if status check fails
              return null;
          }

          const updatedBookData = await response.json();
          console.log(`Status update for job ${jobId} (Book ID: ${bookId}): ${updatedBookData.status}`);

          // Return the updated book data
          return updatedBookData;

      } catch (err) {
          console.error(`Error during status check for job ${jobId} (Book ID: ${bookId}):`, err);
          // Return null or the existing book data if status check fails
          return null;
      }
  };


  // Initial fetch when the component mounts
  useEffect(() => {
    fetchBooks();
  }, []); // Empty dependency array means this runs once on component mount

  // Polling effect for books that are 'processing'
  useEffect(() => {
      // Find books that are currently processing
      const processingBooks = books.filter(book => book.status === 'processing' && book.job_id);

      if (processingBooks.length === 0) {
          // No books are processing, no need to poll
          console.log("No books processing, stopping polling.");
          return; // No interval needed
      }

      console.log(`Found ${processingBooks.length} books processing. Starting polling...`);

      // Set up the polling interval
      const intervalId = setInterval(async () => {
          console.log("Polling for book status updates...");
          const updatedBooks = await Promise.all(
              processingBooks.map(book => checkBookStatus(book.id, book.job_id))
          );

          // Filter out null responses (failed status checks) and update state
          const successfulUpdates = updatedBooks.filter(book => book !== null);

          if (successfulUpdates.length > 0) {
              setBooks(currentBooks => {
                  // Create a map of updated books by ID for easy lookup
                  const updatedBooksMap = new Map(successfulUpdates.map(book => [book.id, book]));

                  // Map over current books, replacing with updated data if available
                  const nextBooks = currentBooks.map(book => {
                      if (updatedBooksMap.has(book.id)) {
                          const updatedBook = updatedBooksMap.get(book.id);
                          // Only update if the status has actually changed or new data (like filenames) is available
                          if (book.status !== updatedBook.status || updatedBook.markdown_filename || updatedBook.image_filenames.length > 0) {
                              console.log(`Updating book ${book.id} status from ${book.status} to ${updatedBook.status}`);
                              return updatedBook; // Use the full updated book object
                          }
                      }
                      return book; // Keep the current book data if no update or status hasn't changed
                  });

                  return nextBooks;
              });
          }

          // Re-filter processing books after potential updates
          const stillProcessing = successfulUpdates.filter(book => book && book.status === 'processing');
          if (stillProcessing.length === 0 && processingBooks.length > 0) {
              console.log("All processing books have finished or failed. Stopping polling.");
              // If no books are still processing among those we checked, clear the interval
              clearInterval(intervalId);
          }

      }, POLLING_INTERVAL); // Poll every POLLING_INTERVAL milliseconds

      // Cleanup function to clear the interval when the component unmounts
      // or when the list of processing books changes (e.g., all finish)
      return () => {
          console.log("Clearing polling interval.");
          clearInterval(intervalId);
      };

  }, [books]); // Dependency array includes 'books' so the effect re-runs if the book list changes


  if (loading) {
    return <div style={{ padding: '20px' }}>Loading books...</div>;
  }

  if (error) {
    return <div style={{ padding: '20px', color: 'red' }}>Error: {error}</div>;
  }

  return (
    <div className="book-list-container" style={{ padding: '20px' }}>
      <h2>Available Books</h2>
      {books.length === 0 ? (
        <p>No books found. <Link to="/upload">Upload a PDF</Link> to get started!</p>
      ) : (
        <ul>
          {books.map(book => (
            // Use Link to navigate to the BookView page for each book
            // Use book.id for the key and the URL
            <li key={book.id}>
              {/* Always render the link, regardless of status */}
              <Link to={`/book/${book.id}`}>{book.title || book.original_filename}</Link>
              {/* Display the processing status */}
              <span style={{ marginLeft: '10px', fontSize: '0.9em', color: '#555' }}>
                  ({book.status || 'unknown'}) {/* Added fallback for status */}
                  {book.status === 'processing' && '...'} {/* Add ellipsis for processing */}
                  {book.status === 'failed' && ' - Check logs'} {/* Add message for failed */}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: '20px' }}>
         <Link to="/upload">Upload a New PDF</Link>
      </div>
    </div>
  );
}

export default BookList;
