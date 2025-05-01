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
      // The data now includes 'status' and 'job_id' from the backend list endpoint
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
          // Call the new backend status endpoint which proxies to the PDF service
          // This endpoint returns the PDF service's status format
          const response = await fetch(`/api/books/status/${jobId}`);

          if (!response.ok) {
              // Log the error but don't necessarily stop polling or mark as failed immediately
              // The backend status endpoint should handle cases where the job ID is not found
              // or the PDF service is down.
              const errorData = await response.json();
              console.error(`Failed to check status for job ${jobId} (Book ID: ${bookId}):`, errorData.detail || response.statusText);
              // Return null if status check fails or job not found in PDF service
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

  // Polling effect for books that are 'processing' or 'pending'
  useEffect(() => {
      // Find books that are currently processing or pending from the *current* state
      const pollableBooks = books.filter(book =>
          (book.status === 'processing' || book.status === 'pending') && book.job_id
      );

      if (pollableBooks.length === 0) {
          console.log("No books pending or processing, stopping polling.");
          return; // No interval needed, or clear existing one
      }

      console.log(`Found ${pollableBooks.length} books pending/processing. Starting polling...`);

      // Set up the polling interval
      const intervalId = setInterval(async () => {
          console.log("Polling for book status updates...");

          // Fetch status for all pollable books concurrently
          // checkBookStatus fetches from /api/books/status/{job_id}
          // which returns the PDF service status format: { success, message, job_id, status, title?, file_path?, images? }
          const statusUpdates = await Promise.all(
              pollableBooks.map(book => checkBookStatus(book.id, book.job_id)) // Pass book.id for logging, job_id for the fetch
          );

          // Filter out failed status checks (null results from checkBookStatus)
          // and create a map keyed by job_id for easy lookup
          const updatesByJobId = new Map();
          statusUpdates.filter(update => update && update.job_id).forEach(update => {
              updatesByJobId.set(update.job_id, update);
          });

          if (updatesByJobId.size > 0) {
              setBooks(currentBooks => {
                  let changed = false; // Flag to track if state actually changed
                  const nextBooks = currentBooks.map(book => {
                      const update = updatesByJobId.get(book.job_id);

                      // If there's an update for this book's job_id AND the status is different
                      if (update && book.status !== update.status) {
                          console.log(`Updating book ${book.id} (job ${book.job_id}) status from ${book.status} to ${update.status}`);
                          changed = true;
                          // Update ONLY the status. Other details (filenames) are updated
                          // in the DB by the backend /status endpoint. A subsequent fetch
                          // or page navigation will get the updated details.
                          return {
                              ...book, // Keep original book data (id, title, original_filename, job_id)
                              status: update.status, // Update the status
                              // Optionally update message if available in status response
                              ...(update.message && { message: update.message }),
                              // Do NOT merge file_path, images, or title from the status update here.
                              // The /api/books/{book_id} endpoint will provide the final data
                              // including markdown_content and image_urls once status is 'completed'.
                          };
                      }
                      return book; // Keep the current book data if no update or status hasn't changed
                  });

                  // Only update state if something actually changed
                  return changed ? nextBooks : currentBooks;
              });
          }
          // If no successful updates were received, the interval continues if there are still processing books
          // (checked at the start of the next tick).

      }, POLLING_INTERVAL); // Poll every POLLING_INTERVAL milliseconds

      // Cleanup function to clear the interval when the component unmounts
      // or when the list of pollable books changes (e.g., all finish)
      return () => {
          console.log("Clearing polling interval.");
          clearInterval(intervalId);
      };

  // Dependency array includes 'books' so the effect re-runs if the book list changes
  // (e.g., a new book is added, or a book's status changes causing pollableBooks to change)
  }, [books]);


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
              {/* Only make the link clickable if the book is completed */}
              {book.status === 'completed' ? (
                 <Link to={`/book/${book.id}`}>{book.title || book.original_filename}</Link>
              ) : (
                 <span>{book.title || book.original_filename}</span>
              )}
              {/* Display the processing status */}
              {/* Add data-status attribute for CSS targeting */}
              <span data-status={book.status || 'unknown'}>
                  {book.status || 'unknown'} {/* Display status text */}
                  {(book.status === 'processing' || book.status === 'pending') && '...'} {/* Add ellipsis for processing/pending */}
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
