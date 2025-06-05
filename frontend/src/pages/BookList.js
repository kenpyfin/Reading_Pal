
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

// --- ADD THIS LINE ---
console.log("[BookList.js SRC MODULE LEVEL] BookList.js module loaded"); 
// --- END OF ADDED LINE ---

const POLLING_INTERVAL = 5000;

function BookList() {
  // ... rest of the component ...
  console.log("[BookList.js SRC FUNCTION LEVEL] BookList component function executed (rendered or re-rendered)");

  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [renamingId, setRenamingId] = useState(null); // New state for rename operation
  const [hoveredBookId, setHoveredBookId] = useState(null); // New state for hover

  // --- Style definitions for buttons and actions container ---
  const actionsContainerBaseStyle = {
    position: 'absolute',
    right: '10px',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    transition: 'opacity 0.2s ease-in-out, visibility 0.2s ease-in-out',
    opacity: 0,
    visibility: 'hidden',
    zIndex: 1, // Ensure buttons are above other elements if any overlap
  };

  const actionsContainerVisibleStyle = {
    opacity: 1,
    visibility: 'visible',
  };

  const baseButtonStyle = {
    padding: '6px 10px',
    fontSize: '13px',
    border: '1px solid #d9d9d9',
    borderRadius: '4px',
    cursor: 'pointer',
    backgroundColor: '#ffffff',
    transition: 'background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
    lineHeight: '1.5',
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  };
  
  const renameButtonStyle = {
    ...baseButtonStyle,
    color: '#333',
  };
  
  const renameButtonHoverStyle = { // Specific hover style for rename button
    backgroundColor: '#f0f0f0', // Lighter grey
    borderColor: '#c0c0c0',
    boxShadow: '0 2px 4px rgba(0,0,0,0.07)',
  };

  const deleteButtonStyle = {
    ...baseButtonStyle,
    color: '#ff4d4f',
    borderColor: '#ff7875',
  };

  const deleteButtonHoverStyle = { // Specific hover style for delete button
    backgroundColor: '#fff1f0',
    borderColor: '#ff4d4f',
    boxShadow: '0 2px 4px rgba(0,0,0,0.07)',
  };
  // --- End of style definitions ---

  // Function to fetch the list of books from the backend
  const fetchBooks = async () => {
      console.log("[BookList.js SRC CONSOLE.LOG] Fetching books list from backend...");
      const rawToken = localStorage.getItem('authToken'); // Retrieve the token

      if (!rawToken) {
          console.error("[BookList.js SRC CONSOLE.ERROR] No auth token found (rawToken is falsy). User might not be logged in.");
          setError("Authentication token not found. Please log in.");
          setLoading(false); // Stop loading as we can't proceed
          // Optionally, redirect to login page here
          // navigate('/login'); 
          return;
      }

      // Sanitize token: remove potential leading/trailing whitespace and newlines
      // which might cause issues with header formation or parsing.
      let token = rawToken.trim().replace(/(\r\n|\n|\r)/gm, "");

      // Explicitly check for string "null" or "undefined" which might be stored in localStorage
      if (!token || token === "null" || token === "undefined") {
          console.error(`[BookList.js SRC CONSOLE.ERROR] Auth token is invalid after sanitization or is a problematic string. Sanitized token value: '${token}'. User might not be logged in or token is invalid.`);
          setError("Authentication token is invalid. Please log in again.");
          setLoading(false);
          return;
      }
      
      console.log(`[BookList.js SRC CONSOLE.LOG] Attempting to use sanitized auth token (first 20 chars): '${token.substring(0, 20)}...'`);

      const requestHeaders = {
          'Content-Type': 'application/json'
          // Authorization header will be added below
      };

      if (token) {
          requestHeaders['Authorization'] = `Bearer ${token}`;
      } else {
          console.error("[BookList.js SRC CONSOLE.ERROR] Critical error: Token became null or empty just before setting Authorization header. Aborting fetch.");
          setError("Authentication error. Please log in again.");
          setLoading(false);
          return;
      }

      console.log("[BookList.js SRC CONSOLE.LOG] Request headers being sent to /api/books/:", JSON.stringify(requestHeaders));

      try {
          const response = await fetch('/api/books/', {
              headers: requestHeaders
          });
          if (!response.ok) {
              const errorText = await response.text(); 
              console.error(`[BookList.js SRC CONSOLE.ERROR] HTTP error fetching books: ${response.status} - ${errorText}`);
              let detail = errorText;
              try {
                  const errorJson = JSON.parse(errorText);
                  detail = errorJson.detail || errorText;
              } catch (e) {
                  // Not JSON, use raw text
              }
              throw new Error(`HTTP error! status: ${response.status} - ${detail}`);
          }
          const data = await response.json();
          console.log(`[BookList.js SRC CONSOLE.LOG] Successfully fetched ${data.length} books.`);
          const activeBooks = data.filter(book => book.status !== 'failed');
          setBooks(activeBooks);
          setError(null); // Clear any previous error on successful fetch
      } catch (error) {
          console.error("[BookList.js SRC CONSOLE.ERROR] Error fetching books:", error);
          setError(error.message || "Failed to load books. Please try again later.");
          // Do not set books to [] here, allow existing books to be displayed if any
      } finally {
          setLoading(false);
      }
  };

  const checkBookStatus = async (bookId, jobId) => {
      if (!jobId) return null;
      try {
          const response = await fetch(`/api/books/status/${jobId}`);
          if (!response.ok) {
              const errorData = await response.json();
              console.error(`Failed to check status for job ${jobId} (Book ID: ${bookId}):`, errorData.detail || response.statusText);
              return null;
          }
          const updatedBookData = await response.json();
          console.log(`Status update received for job ${jobId} (Book ID: ${bookId}):`, updatedBookData);
          return updatedBookData;
      } catch (err) {
          console.error(`Error during status check for job ${jobId} (Book ID: ${bookId}):`, err);
          return null;
      }
  };

  useEffect(() => {
    setLoading(true); // Set loading true only on initial mount fetch
    setError(null);
    fetchBooks();
  }, []);

  useEffect(() => {
      const pollableBooks = books.filter(book =>
          (book.status === 'processing' || book.status === 'pending') && book.job_id
      );
      if (pollableBooks.length === 0) {
          console.log("No books pending or processing, stopping polling.");
          return;
      }
      console.log(`Found ${pollableBooks.length} books pending/processing. Starting polling...`);
      const intervalId = setInterval(async () => {
          console.log("Polling for book status updates...");
          const statusUpdates = await Promise.all(
              pollableBooks.map(book => checkBookStatus(book.id, book.job_id)) // Use book.id (which is _id string)
          );
          const updatesByJobId = new Map();
          statusUpdates.filter(update => update && update.job_id).forEach(update => {
              updatesByJobId.set(update.job_id, update);
          });
          if (updatesByJobId.size > 0) {
              setBooks(currentBooks => {
                  let changed = false;
                  const nextBooks = currentBooks.map(book => {
                      const update = updatesByJobId.get(book.job_id);
                      if (update && book.status !== update.status) {
                          console.log(`Updating book ${book.id} (job ${book.job_id}) status from ${book.status} to ${update.status}`);
                          changed = true;
                          return {
                              ...book,
                              status: update.status,
                              ...(update.message && { message: update.message }),
                          };
                      }
                      return book;
                  });
                  return changed ? nextBooks : currentBooks;
              });
          }
      }, POLLING_INTERVAL);
      return () => {
          console.log("Clearing polling interval.");
          clearInterval(intervalId);
      };
  }, [books]);

  const handleDeleteBook = async (bookId, bookTitle) => {
    if (!window.confirm(`Are you sure you want to delete the book "${bookTitle}"? This action cannot be undone.`)) {
        return;
    }
    setDeletingId(bookId);
    setError(null); // Clear previous errors
    try {
        const response = await fetch(`/api/books/${bookId}`, {
            method: 'DELETE',
        });
        if (response.status === 204) { // Successfully deleted
            setBooks(prevBooks => prevBooks.filter(book => book.id !== bookId));
            console.log(`Book "${bookTitle}" (ID: ${bookId}) deleted successfully.`);
        } else if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: 'Failed to delete book and parse error response.' }));
            throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || 'Unknown error'}`);
        } else {
             console.warn(`Unexpected response status after delete: ${response.status}`);
             setBooks(prevBooks => prevBooks.filter(book => book.id !== bookId)); // Fallback
        }
    } catch (err) {
        console.error(`Failed to delete book ${bookId}:`, err);
        setError(`Failed to delete book "${bookTitle}": ${err.message}`);
    } finally {
        setDeletingId(null);
    }
  };

  const handleRenameBook = async (bookId, currentTitle) => {
    const newTitle = window.prompt("Enter the new title for the book:", currentTitle);
    if (newTitle === null || newTitle.trim() === "" || newTitle.trim() === currentTitle) {
        if (newTitle !== null && newTitle.trim() !== "" && newTitle.trim() === currentTitle) {
            console.log("New title is the same as the current title. No action taken.");
        } else {
            console.log("Rename cancelled or new title is empty.");
        }
        return;
    }

    setRenamingId(bookId);
    setError(null); // Clear previous errors
    try {
        const response = await fetch(`/api/books/${bookId}/rename`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ new_title: newTitle.trim() }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: 'Failed to rename book and parse error response.' }));
            throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || 'Unknown error'}`);
        }

        const updatedBook = await response.json(); // Backend returns the updated book object
        setBooks(prevBooks => prevBooks.map(book => (book.id === bookId ? updatedBook : book)));
        console.log(`Book "${currentTitle}" (ID: ${bookId}) renamed to "${updatedBook.title}" successfully.`);

    } catch (err) {
        console.error(`Failed to rename book ${bookId}:`, err);
        setError(`Failed to rename book "${currentTitle}": ${err.message}`);
    } finally {
        setRenamingId(null);
    }
  };

  if (loading && books.length === 0) { // Show loading only if books array is empty initially
    return <div style={{ padding: '20px' }}>Loading books...</div>;
  }

  // Display error message, but still render the book list if books are available
  if (error && books.length === 0) { // Only show full page error if no books can be displayed
    return <div style={{ padding: '20px', color: 'red' }}>Error: {error}</div>;
  }


  return (
    <div className="book-list-container" style={{ fontFamily: 'Arial, sans-serif', padding: '20px' }}>
      <h2 style={{ marginBottom: '20px', color: '#333' }}>Available Books</h2>
      {error && <p style={{ color: 'red', marginBottom: '15px' }}>Error: {error}</p>} {/* Display error message above list */}
      {books.length === 0 && !loading ? (
        <p>No books found. <Link to="/upload" style={{ color: '#007bff' }}>Upload a PDF</Link> to get started!</p>
      ) : (
        <ul style={{ listStyleType: 'none', paddingLeft: '0' }}>
          {books.map(book => (
            // Use book.id for the key and the URL - this is the MongoDB _id string from backend
            // The backend /api/books/ endpoint maps _id to id.
            console.log("Rendering list item for book:", book, "ID:", book.id),
            <li
              key={book.id} // Use book.id (which is the string representation of _id)
              onMouseEnter={() => setHoveredBookId(book.id)}
              onMouseLeave={() => setHoveredBookId(null)}
              style={{
                position: 'relative', // Needed for absolute positioning of actions
                padding: '12px 15px',
                borderBottom: '1px solid #e0e0e0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                transition: 'background-color 0.2s ease',
                backgroundColor: hoveredBookId === book.id ? '#f9f9f9' : 'transparent',
              }}
            >
              <div style={{ flexGrow: 1, marginRight: '100px' }}> {/* Ensure space for buttons */}
                {book.status === 'completed' ? (
                   <Link to={`/book/${book.id}`} style={{ textDecoration: 'none', color: '#007bff', fontWeight: '500' }}>
                      {book.title || book.original_filename}
                   </Link>
                ) : (
                   <span style={{ color: '#555', fontWeight: '500' }}>
                       {book.title || book.original_filename}
                       <span data-status={book.status || 'unknown'} style={{ marginLeft: '8px', fontSize: '0.9em', color: '#777' }}>
                           {' '}({book.status || 'unknown'}
                           {(book.status === 'processing' || book.status === 'pending') && '...'})
                           {book.status === 'failed' && ' - Failed'}
                       </span>
                   </span>
                )}
              </div>

              <div
                style={{
                  ...actionsContainerBaseStyle,
                  ...(hoveredBookId === book.id ? actionsContainerVisibleStyle : {}),
                }}
              >
                <button
                  title="Rename Book"
                  onClick={(e) => { e.stopPropagation(); handleRenameBook(book.id, book.title || book.original_filename);}}
                  disabled={renamingId === book.id || deletingId === book.id || book.status === 'processing' || book.status === 'pending'}
                  style={renamingId === book.id ? {...renameButtonStyle, backgroundColor: renameButtonHoverStyle.backgroundColor} : renameButtonStyle}
                  onMouseEnter={(e) => {
                    if (!(renamingId === book.id || deletingId === book.id || book.status === 'processing' || book.status === 'pending')) {
                        e.currentTarget.style.backgroundColor = renameButtonHoverStyle.backgroundColor;
                        e.currentTarget.style.borderColor = renameButtonHoverStyle.borderColor;
                        e.currentTarget.style.boxShadow = renameButtonHoverStyle.boxShadow;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!(renamingId === book.id)) { // Keep active style if renaming
                        e.currentTarget.style.backgroundColor = renameButtonStyle.backgroundColor;
                        e.currentTarget.style.borderColor = renameButtonStyle.border; // Should be renameButtonStyle.borderColor or baseButtonStyle.border
                        e.currentTarget.style.boxShadow = baseButtonStyle.boxShadow;
                    }
                  }}
                >
                  {renamingId === book.id ? 'Renaming...' : 'Rename'}
                </button>
                <button
                  title="Delete Book"
                  onClick={(e) => { e.stopPropagation(); handleDeleteBook(book.id, book.title || book.original_filename);}}
                  disabled={deletingId === book.id || renamingId === book.id || book.status === 'processing' || book.status === 'pending'}
                  style={deletingId === book.id ? {...deleteButtonStyle, backgroundColor: deleteButtonHoverStyle.backgroundColor} : deleteButtonStyle}
                   onMouseEnter={(e) => {
                    if (!(renamingId === book.id || deletingId === book.id || book.status === 'processing' || book.status === 'pending')) {
                        e.currentTarget.style.backgroundColor = deleteButtonHoverStyle.backgroundColor;
                        e.currentTarget.style.borderColor = deleteButtonHoverStyle.borderColor;
                        e.currentTarget.style.boxShadow = deleteButtonHoverStyle.boxShadow;
                    }
                  }}
                  onMouseLeave={(e) => {
                     if (!(deletingId === book.id)) { // Keep active style if deleting
                        e.currentTarget.style.backgroundColor = deleteButtonStyle.backgroundColor;
                        e.currentTarget.style.borderColor = deleteButtonStyle.border; // Should be deleteButtonStyle.borderColor or baseButtonStyle.border
                        e.currentTarget.style.boxShadow = baseButtonStyle.boxShadow;
                    }
                  }}
                >
                  {deletingId === book.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="upload-link-container" style={{ marginTop: '25px' }}>
         <Link to="/upload" style={{
             display: 'inline-block',
             padding: '10px 15px',
             backgroundColor: '#007bff',
             color: 'white',
             textDecoration: 'none',
             borderRadius: '4px'
         }}>Upload a New PDF</Link>
      </div>
    </div>
  );
}

export default BookList;
