import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom'; // Assuming react-router-dom is used for navigation
import logger from '../utils/logger'; // Assuming a logger utility exists

function BookList() {
    const [books, setBooks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null); // Add error state

    // Function to fetch the list of books from the backend
    const fetchBooks = async () => {
        logger.info("Fetching books list from backend...");
        const rawToken = localStorage.getItem('authToken'); // Retrieve the token

        if (!rawToken) {
            logger.error("No auth token found (rawToken is falsy). User might not be logged in.");
            setError("Authentication token not found. Please log in.");
            setLoading(false); // Stop loading as we can't proceed
            // Optionally, redirect to login page here
            // navigate('/login'); 
            return;
        }

        // Sanitize token: remove potential leading/trailing whitespace and newlines
        // which might cause issues with header formation or parsing.
        const token = rawToken.trim().replace(/(\r\n|\n|\r)/gm, "");

        if (!token) { // Check token again after sanitization
            logger.error("Auth token became empty after sanitization. User might not be logged in or token is invalid.");
            setError("Authentication token is invalid. Please log in again.");
            setLoading(false);
            return;
        }

        try {
            const response = await fetch('/api/books/', {
                headers: {
                    'Authorization': `Bearer ${token}`, // Add the Authorization header
                    'Content-Type': 'application/json' // Good practice to include, though not strictly needed for GET
                }
            });
            if (!response.ok) {
                // Handle HTTP errors
                const errorText = await response.text();
                logger.error(`HTTP error fetching books: ${response.status} - ${errorText}`);
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            logger.info(`Successfully fetched ${data.length} books.`);
            // Filter out books with status 'failed' as per PDR
            const activeBooks = data.filter(book => book.status !== 'failed');
            setBooks(activeBooks);
            setError(null); // Clear any previous errors
        } catch (error) {
            logger.error("Error fetching books:", error);
            setError("Failed to load books. Please try again later."); // Set error state
        } finally {
            setLoading(false);
        }
    };

    // Effect to fetch books on component mount and set up polling
    useEffect(() => {
        fetchBooks(); // Initial fetch when component mounts

        // Set up interval for polling the entire book list from the backend
        // The backend's list endpoint will now reflect the status updates from the callback
        const intervalId = setInterval(fetchBooks, 10000); // Poll every 10 seconds (adjust as needed)

        // Cleanup function to clear the interval when the component unmounts
        return () => clearInterval(intervalId);

    }, []); // Empty dependency array means this runs once on mount and cleans up on unmount

    if (loading) {
        return <div>Loading books...</div>;
    }

    if (error) {
        return <div className="error-message">Error: {error}</div>;
    }

    if (books.length === 0) {
        return <div>No books found. Upload a PDF to get started!</div>;
    }

    return (
        <div className="book-list-container">
            <h1>My Books</h1>
            <ul className="book-list">
                {books.map(book => (
                    <li key={book.id} className={`book-item status-${book.status}`}>
                        {/* Only make the link clickable if status is 'completed' */}
                        {book.status === 'completed' ? (
                            <Link to={`/book/${book.id}`} className="book-title-link">
                                {book.title}
                            </Link>
                        ) : (
                            <span className="book-title-text">{book.title}</span>
                        )}
                        <span className="book-status">Status: {book.status}</span>
                        {book.status === 'processing' && (
                            <span className="status-indicator">...</span> // Simple indicator
                        )}
                         {book.status === 'failed' && book.processing_error && (
                            <span className="error-details" title={book.processing_error}>Error Details</span>
                        )}
                    </li>
                ))}
            </ul>
            {/* Add a link or button to the upload page if needed */}
            {/* <Link to="/upload">Upload New Book</Link> */}
        </div>
    );
}

export default BookList;
