import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom'; // Import Link for navigation

function BookList() {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
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
        setBooks(data);

      } catch (err) {
        console.error('Failed to fetch books:', err);
        setError(`Failed to load books: ${err.message || 'Unknown error'}`);
      } finally {
        setLoading(false);
      }
    };

    fetchBooks();
  }, []); // Empty dependency array means this runs once on component mount

  if (loading) {
    return <div>Loading books...</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  return (
    <div className="book-list-container">
      <h2>Available Books</h2>
      {books.length === 0 ? (
        <p>No books found. <Link to="/upload">Upload a PDF</Link> to get started!</p>
      ) : (
        <ul>
          {books.map(book => (
            // Use Link to navigate to the BookView page for each book
            // CHANGE: Use book._id here to get the actual ID string from the JSON response
            <li key={book.id}> {/* key={book.id} is fine because React uses the Pydantic 'id' field */}
              <Link to={`/book/${book._id}`}>{book.title || book.original_filename}</Link> {/* Use book._id for the URL */}
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
