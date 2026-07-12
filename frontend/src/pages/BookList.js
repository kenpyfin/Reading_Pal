
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAuthHeaders } from '../utils/authRequest';
import {
  putBookListSnapshot,
  getBookListSnapshot,
  getBookSummariesFromMeta,
  mergeBookListSources,
  isRecoverableListFetchError,
  removeBookFromListSnapshot,
} from '../utils/offlineBookCache';

// --- ADD THIS LINE ---
console.log("[BookList.js SRC MODULE LEVEL] BookList.js module loaded"); 
// --- END OF ADDED LINE ---

const POLLING_INTERVAL = 5000;

const isInFlightStatus = (status) => status === 'processing' || status === 'pending';

function BookList() {
  // ... rest of the component ...
  console.log("[BookList.js SRC FUNCTION LEVEL] BookList component function executed (rendered or re-rendered)");

  const [books, setBooks] = useState([]);
  const booksRef = useRef(books);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [renamingId, setRenamingId] = useState(null); // New state for rename operation
  const [hoveredBookId, setHoveredBookId] = useState(null); // New state for hover
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalBooks, setTotalBooks] = useState(0);
  const PAGE_SIZE = 10;

  const [netOnline, setNetOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [fromOfflineCache, setFromOfflineCache] = useState(false);
  const [cachedBookCount, setCachedBookCount] = useState(0);
  const cachedAllBooksRef = useRef([]);
  const currentPageRef = useRef(currentPage);

  const listActionsReadOnly = !netOnline || fromOfflineCache;
  const offlinePaging = !netOnline || fromOfflineCache;
  const pagingTotal = offlinePaging ? cachedBookCount : totalBooks;

  useEffect(() => {
    booksRef.current = books;
  }, [books]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

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
    border: '1px solid var(--color-border-light)',
    borderRadius: '4px',
    cursor: 'pointer',
    backgroundColor: 'var(--color-bg-elevated)',
    color: 'var(--color-text)',
    transition: 'background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
    lineHeight: '1.5',
    boxShadow: 'var(--shadow-md)',
  };

  const renameButtonStyle = {
    ...baseButtonStyle,
  };

  const renameButtonHoverStyle = {
    backgroundColor: 'var(--color-bg-hover)',
    borderColor: 'var(--color-border)',
    boxShadow: 'var(--shadow-md)',
  };

  const deleteButtonStyle = {
    ...baseButtonStyle,
    color: 'var(--color-danger)',
    borderColor: 'var(--color-danger)',
  };

  const deleteButtonHoverStyle = {
    backgroundColor: 'var(--color-error-bg)',
    borderColor: 'var(--color-danger)',
    boxShadow: 'var(--shadow-md)',
  };
  // --- End of style definitions ---

  const applyOfflinePage = useCallback((page, allBooks) => {
    cachedAllBooksRef.current = allBooks;
    setCachedBookCount(allBooks.length);
    const skip = (page - 1) * PAGE_SIZE;
    setBooks(allBooks.slice(skip, skip + PAGE_SIZE));
  }, []);

  const loadOfflineBooks = useCallback(async (page) => {
    const snap = await getBookListSnapshot();
    const metaRows = await getBookSummariesFromMeta();
    const merged = mergeBookListSources(snap, metaRows);
    if (merged.length === 0) return false;
    const validPage = Math.max(1, Math.min(page, Math.ceil(merged.length / PAGE_SIZE) || 1));
    if (validPage !== page) {
      setCurrentPage(validPage);
    }
    applyOfflinePage(validPage, merged);
    setFromOfflineCache(true);
    setError(null);
    return true;
  }, [applyOfflinePage]);

  const fetchBooks = useCallback(async () => {
      console.log("[BookList.js SRC CONSOLE.LOG] Fetching books list from backend...");
      const authHeaders = getAuthHeaders();
      if (!authHeaders) {
          console.error("[BookList.js SRC CONSOLE.ERROR] No auth token found (rawToken is falsy). User might not be logged in.");
          setError("Authentication token not found. Please log in.");
          setLoading(false);
          return;
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (cachedAllBooksRef.current.length > 0) {
          applyOfflinePage(currentPage, cachedAllBooksRef.current);
          setFromOfflineCache(true);
          setError(null);
          setLoading(false);
          return;
        }
        const ok = await loadOfflineBooks(currentPage);
        if (!ok) {
          setError('Offline and no cached book list found. Reconnect once to load your library.');
        }
        setLoading(false);
        return;
      }

      const requestHeaders = {
          'Content-Type': 'application/json',
          ...authHeaders,
      };

      console.log("[BookList.js SRC CONSOLE.LOG] Request headers being sent to /api/books/:", JSON.stringify(requestHeaders));

      try {
          const skip = (currentPage - 1) * PAGE_SIZE;
          const response = await fetch(`/api/books/?skip=${skip}&limit=${PAGE_SIZE}`, {
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

          const totalCount = response.headers.get('X-Total-Count');
          let nextTotal = 0;
          if (totalCount !== null) {
              nextTotal = parseInt(totalCount, 10);
              setTotalBooks(nextTotal);
          }

          const data = await response.json();
          console.log(`[BookList.js SRC CONSOLE.LOG] Successfully fetched ${data.length} books.`);
          const activeBooks = data.filter(book => book.status !== 'failed');
          setBooks(activeBooks);
          setFromOfflineCache(false);
          setError(null);
          const snapshotTotal =
            nextTotal > 0 ? nextTotal : (currentPage - 1) * PAGE_SIZE + activeBooks.length;
          if (totalCount === null && snapshotTotal > 0) {
            setTotalBooks(snapshotTotal);
          }
          try {
            await putBookListSnapshot({
              books: activeBooks,
              totalBooks: snapshotTotal,
              currentPage,
            });
          } catch (snapErr) {
            console.warn('[BookList] Failed to persist list snapshot:', snapErr);
          }
      } catch (error) {
          console.error("[BookList.js SRC CONSOLE.ERROR] Error fetching books:", error);
          if (isRecoverableListFetchError(error)) {
            try {
              const ok = await loadOfflineBooks(currentPage);
              if (!ok) {
                setError(error.message || "Failed to load books. Please try again later.");
              }
            } catch (cacheErr) {
              console.error('[BookList] Offline cache load failed:', cacheErr);
              setError(error.message || "Failed to load books. Please try again later.");
            }
          } else {
            setError(error.message || "Failed to load books. Please try again later.");
          }
      } finally {
          setLoading(false);
      }
  }, [currentPage, applyOfflinePage, loadOfflineBooks]);

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
    setLoading(true);
    setError(null);
    fetchBooks();
  }, [currentPage, fetchBooks]);

  useEffect(() => {
    const syncOnline = () => setNetOnline(navigator.onLine);
    const onOnline = () => {
      syncOnline();
      if (getAuthHeaders()) {
        setLoading(true);
        fetchBooks();
      }
    };
    const onOffline = () => {
      syncOnline();
      loadOfflineBooks(currentPageRef.current).catch((err) => {
        console.warn('[BookList] Failed to load offline books on disconnect:', err);
      });
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [fetchBooks, loadOfflineBooks]);

  useEffect(() => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      if (fromOfflineCache) return;

      const hasPollable = books.some(
          (book) => isInFlightStatus(book.status) && book.job_id
      );
      if (!hasPollable) {
          console.log("No books pending or processing, stopping polling.");
          return;
      }

      console.log("Starting polling for pending/processing books...");
      const intervalId = setInterval(async () => {
          const pollableBooks = booksRef.current.filter(
              (book) => isInFlightStatus(book.status) && book.job_id
          );
          if (pollableBooks.length === 0) {
              return;
          }
          console.log("Polling for book status updates...");
          const statusUpdates = await Promise.all(
              pollableBooks.map((book) => checkBookStatus(book.id, book.job_id))
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
  }, [books, fromOfflineCache]);

  const handleDeleteBook = async (bookId, bookTitle, inFlight = false) => {
    if (listActionsReadOnly) {
      return;
    }
    const confirmMessage = inFlight
      ? `Stop processing and remove "${bookTitle}" from your library? Conversion may continue in the background, but the book will not appear here.`
      : `Are you sure you want to delete the book "${bookTitle}"? This action cannot be undone.`;
    if (!window.confirm(confirmMessage)) {
        return;
    }
    setDeletingId(bookId);
    setError(null);

    const authHeaders = getAuthHeaders();
    if (!authHeaders) {
        console.error("[BookList.js SRC CONSOLE.ERROR] No auth token found for delete operation.");
        setError("Authentication token not found. Please log in.");
        setDeletingId(null);
        return;
    }

    try {
        const response = await fetch(`/api/books/${bookId}`, {
            method: 'DELETE',
            headers: authHeaders,
        });
        if (response.status === 204) {
            setBooks(prevBooks => prevBooks.filter(book => book.id !== bookId));
            setTotalBooks((t) => Math.max(0, t - 1));
            try {
              await removeBookFromListSnapshot(bookId);
            } catch (snapErr) {
              console.warn('[BookList] Failed to update list snapshot after delete:', snapErr);
            }
            console.log(`Book "${bookTitle}" (ID: ${bookId}) deleted successfully.`);
        } else if (!response.ok) {
            const errorData = await response.json().catch(() => ({ detail: 'Failed to delete book and parse error response.' }));
            throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || 'Unknown error'}`);
        } else {
             console.warn(`Unexpected response status after delete: ${response.status}`);
        }
    } catch (err) {
        console.error(`Failed to delete book ${bookId}:`, err);
        const action = inFlight ? 'cancel' : 'delete';
        setError(`Failed to ${action} book "${bookTitle}": ${err.message}`);
    } finally {
        setDeletingId(null);
    }
  };

  const handleRenameBook = async (bookId, currentTitle) => {
    if (listActionsReadOnly) {
      return;
    }
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

    const authHeaders = getAuthHeaders();
    if (!authHeaders) {
        console.error("[BookList.js SRC CONSOLE.ERROR] No auth token found for rename operation.");
        setError("Authentication token not found. Please log in.");
        setRenamingId(null);
        return;
    }

    try {
        const response = await fetch(`/api/books/${bookId}/rename`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders,
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
    return <div className="theme-error-text" style={{ padding: '20px' }}>Error: {error}</div>;
  }


  return (
    <div className="book-list-container">
      <h2>Available Books</h2>
      {listActionsReadOnly && books.length > 0 && (
        <p className="theme-offline-banner">
          Offline — showing cached books. Rename and delete need a connection; use Previous/Next to browse cached pages.
        </p>
      )}
      {error && <p className="theme-error-text" style={{ marginBottom: '15px' }}>Error: {error}</p>}
      {books.length === 0 && !loading ? (
        <p>No books found. <Link to="/upload">Upload a book</Link> to get started!</p>
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
                borderBottom: '1px solid var(--color-border-light)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                transition: 'background-color 0.2s ease',
                backgroundColor: hoveredBookId === book.id ? 'var(--color-bg-hover)' : 'transparent',
              }}
            >
              <div className="book-list-item-main">
                {book.status === 'completed' ? (
                   <Link to={`/book/${book.id}`} className="book-list-title">
                      {book.title || book.original_filename}
                   </Link>
                ) : (
                   <span className="book-list-title">
                       {book.title || book.original_filename}
                   </span>
                )}
                {book.status !== 'completed' && (
                  <span className="book-status-badge" data-status={book.status || 'unknown'}>
                    ({book.status || 'unknown'}
                    {isInFlightStatus(book.status) && '...'})
                    {book.status === 'failed' && ' - Failed'}
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
                  disabled={listActionsReadOnly || renamingId === book.id || deletingId === book.id || isInFlightStatus(book.status)}
                  style={renamingId === book.id ? {...renameButtonStyle, backgroundColor: renameButtonHoverStyle.backgroundColor} : renameButtonStyle}
                  onMouseEnter={(e) => {
                    if (!(renamingId === book.id || deletingId === book.id || isInFlightStatus(book.status))) {
                        e.currentTarget.style.backgroundColor = renameButtonHoverStyle.backgroundColor;
                        e.currentTarget.style.borderColor = renameButtonHoverStyle.borderColor;
                        e.currentTarget.style.boxShadow = renameButtonHoverStyle.boxShadow;
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!(renamingId === book.id)) { // Keep active style if renaming
                        e.currentTarget.style.backgroundColor = renameButtonStyle.backgroundColor;
                        e.currentTarget.style.borderColor = renameButtonStyle.borderColor; 
                        e.currentTarget.style.boxShadow = baseButtonStyle.boxShadow;
                    }
                  }}
                >
                  {renamingId === book.id ? 'Renaming...' : 'Rename'}
                </button>
                <button
                  title={isInFlightStatus(book.status) ? 'Cancel processing' : 'Delete Book'}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteBook(
                      book.id,
                      book.title || book.original_filename,
                      isInFlightStatus(book.status)
                    );
                  }}
                  disabled={listActionsReadOnly || deletingId === book.id || renamingId === book.id}
                  style={deletingId === book.id ? {...deleteButtonStyle, backgroundColor: deleteButtonHoverStyle.backgroundColor} : deleteButtonStyle}
                   onMouseEnter={(e) => {
                    if (!(renamingId === book.id || deletingId === book.id)) {
                        e.currentTarget.style.backgroundColor = deleteButtonHoverStyle.backgroundColor;
                        e.currentTarget.style.borderColor = deleteButtonHoverStyle.borderColor;
                        e.currentTarget.style.boxShadow = deleteButtonHoverStyle.boxShadow;
                    }
                  }}
                  onMouseLeave={(e) => {
                     if (!(deletingId === book.id)) {
                        e.currentTarget.style.backgroundColor = deleteButtonStyle.backgroundColor;
                        e.currentTarget.style.borderColor = deleteButtonStyle.borderColor; 
                        e.currentTarget.style.boxShadow = baseButtonStyle.boxShadow;
                    }
                  }}
                >
                  {deletingId === book.id
                    ? (isInFlightStatus(book.status) ? 'Cancelling...' : 'Deleting...')
                    : (isInFlightStatus(book.status) ? 'Cancel' : 'Delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="pagination-container" style={{ 
          marginTop: '25px', 
          display: 'flex', 
          alignItems: 'center', 
          gap: '15px' 
      }}>
          <button 
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              style={{
                  ...baseButtonStyle,
                  opacity: currentPage === 1 ? 0.5 : 1,
                  cursor: currentPage === 1 ? 'not-allowed' : 'pointer'
              }}
          >
              Previous
          </button>
          
          <span style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
              Page <strong>{currentPage}</strong> of <strong>{Math.ceil(pagingTotal / PAGE_SIZE) || 1}</strong>
          </span>

          <button 
              onClick={() => setCurrentPage(p => p + 1)}
              disabled={currentPage * PAGE_SIZE >= pagingTotal}
              style={{
                  ...baseButtonStyle,
                  opacity: currentPage * PAGE_SIZE >= pagingTotal ? 0.5 : 1,
                  cursor: currentPage * PAGE_SIZE >= pagingTotal ? 'not-allowed' : 'pointer'
              }}
          >
              Next
          </button>
          
          <span style={{ fontSize: '12px', color: 'var(--color-text-subtle)', marginLeft: 'auto' }}>
              {offlinePaging ? `Cached: ${cachedBookCount} books` : `Total: ${totalBooks} books`}
          </span>
      </div>

      <div className="upload-link-container">
         <Link to="/upload">Upload a New Book</Link>
      </div>
    </div>
  );
}

export default BookList;
