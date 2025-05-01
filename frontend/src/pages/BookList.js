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
      console.log("Initial fetch /api/books/ data:", data); // ADDED LOG: Log initial data
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
          // Note: This endpoint returns status based on job_id, not book_id
          const response = await fetch(`/api/books/status/${jobId}`);

          if (!response.ok) {
              // Log the error but don't necessarily stop polling or mark as failed immediately
              // The backend status endpoint should handle cases where the job ID is not found
              // or the PDF service is down.
              const errorData = await response.json();
              console.error(`Failed to check status for job ${jobId} (Book ID: ${bookId}):`, errorData.detail || response.statusText);
              // Return null if status check fails
              return null;
          }

          const updatedBookData = await response.json();
          console.log(`Status update received for job ${jobId} (Book ID: ${bookId}):`, updatedBookData); // ADDED LOG: Log status update data

          // The response from /api/books/status/{job_id} contains job_id, status, etc.
          // It does NOT contain the MongoDB _id (which is book.id here).
          // We need to return the data received from the status endpoint.
          return updatedBookData;

      } catch (err) {
          console.error(`Error during status check for job ${jobId} (Book ID: ${bookId}):`, err);
          // Return null if status check fails
          return null;
      }
  };


  // Initial fetch when the component mounts
  useEffect(() => {
    fetchBooks();
  }, []); // Empty dependency array means this runs once on component mount

  // Polling effect for books that are 'processing'
  useEffect(() => {
      // Find books that are currently processing from the *current* state
      const processingBooks = books.filter(book => book.status === 'processing' && book.job_id);

      if (processingBooks.length === 0) {
          // No books are processing, no need to poll
          console.log("No books processing, stopping polling.");
          return; // No interval needed, or clear existing one
      }

      console.log(`Found ${processingBooks.length} books processing. Starting polling...`);

      // Set up the polling interval
      const intervalId = setInterval(async () => {
          console.log("Polling for book status updates...");

          // Fetch status for all processing books concurrently
          const statusUpdates = await Promise.all(
              processingBooks.map(book => checkBookStatus(book.id, book.job_id)) // Pass book.id for logging, job_id for the fetch
          );

          // Filter out failed status checks and create a map keyed by job_id
          const updatesByJobId = new Map();
          statusUpdates.filter(update => update && update.job_id).forEach(update => {
              updatesByJobId.set(update.job_id, update);
          });

          if (updatesByJobId.size > 0) {
              setBooks(currentBooks => {
                  const nextBooks = currentBooks.map(book => {
                      console.log("Processing book in map (before update):", book); // ADDED LOG: Log book before update
                      const update = updatesByJobId.get(book.job_id);

                      // If there's an update for this book's job_id
                      if (update) {
                          console.log("Found update for book's job_id:", update); // ADDED LOG: Log the update object
                          // Merge the update data into the existing book object, preserving book.id
                          // Only update status and message, and potentially title/filepath/images if completed
                          // The /api/books/{book_id} endpoint is responsible for providing image_urls
                          // Check if status has changed or if it's now completed
                          if (book.status !== update.status || update.status === 'completed') {
                               console.log(`Updating book ${book.id} (job ${book.job_id}) status from ${book.status} to ${update.status}`);
                               const updatedBook = {
                                   ...book, // Keep original book data, including the correct 'id'
                                   status: update.status,
                                   message: update.message, // Update message
                                   // Only add/update these fields if they are present in the status response
                                   // and the status is completed (or changing to completed)
                                   // Use !== undefined to correctly handle empty strings or nulls if they were valid states
                                   ...(update.title !== undefined && { title: update.title }),
                                   ...(update.file_path !== undefined && { file_path: update.file_path }),
                                   ...(update.images !== undefined && { images: update.images }),
                               };
                               console.log("Resulting updated book object:", updatedBook); // ADDED LOG: Log the result of the merge
                               return updatedBook;
                          }
                      }
                      console.log("No update or status unchanged for book, keeping original:", book); // ADDED LOG: Log if no update applied
                      return book; // Keep the current book data if no update for this job_id or status hasn't changed
                  });

                  // The check for stopping polling is handled by the `processingBooks.length === 0` check
                  // at the start of the *next* interval tick, after the state update has potentially occurred.
                  // If setBooks caused all books to no longer be 'processing', the next interval tick
                  // will see processingBooks.length === 0 and clear the interval.

                  console.log("Next books state array:", nextBooks); // ADDED LOG: Log the final array for the next state
                  return nextBooks;
              });
          }
          // If no successful updates were received, the interval continues if there are still processing books
          // (checked at the start of the next tick).

      }, POLLING_INTERVAL); // Poll every POLLING_INTERVAL milliseconds

      // Cleanup function to clear the interval when the component unmounts
      // or when the list of processing books changes (e.g., all finish)
      return () => {
          console.log("Clearing polling interval.");
          clearInterval(intervalId);
      };

  }, [books]); // Dependency array includes 'books' so the effect re-runs if the book list changes
  // This is necessary because the list of 'processingBooks' to poll needs to be
  // re-evaluated whenever the 'books' state changes (e.g., a book finishes processing).


  if (loading) {
    return <div style={{ padding: '20px' }}>Loading books...</div>;
  }

  if (error) {
    return <div style={{ padding: '20px', color: 'red' }}>Error: {error}</div>;
  }

  return (
    <div className="book-list-container"> {/* Use the class for styling */}
      <h2>Available Books</h2>
      {books.length === 0 ? (
        <p>No books found. <Link to="/upload">Upload a PDF</Link> to get started!</p>
      ) : (
        <ul>
          {books.map(book => (
            // Use Link to navigate to the BookView page for each book
            // Use book.id for the key and the URL - this is the MongoDB _id
            // ADDED LOG: Log book.id and book object before rendering list item
            console.log("Rendering list item for book:", book, "ID:", book.id),
            <li key={book.id}>
              {/* Always render the link, regardless of status */}
              {/* The BookView component handles displaying status if not processed */}
              <Link to={`/book/${book.id}`}>{book.title || book.original_filename}</Link>
              {/* Display the processing status */}
              {/* Add data-status attribute for CSS targeting */}
              <span data-status={book.status || 'unknown'}>
                  {book.status || 'unknown'} {/* Display status text */}
                  {book.status === 'processing' && '...'} {/* Add ellipsis for processing */}
                  {book.status === 'failed' && ' - Failed'} {/* Simplified failed message */}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Wrap the Upload Link in a div with the specified class */}
      <div className="upload-link-container">
         <Link to="/upload">Upload a New PDF</Link>
      </div>
    </div>
  );
}

export default BookList;
