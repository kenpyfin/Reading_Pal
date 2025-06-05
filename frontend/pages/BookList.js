import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom'; // Assuming react-router-dom is used for navigation
// import logger from '../utils/logger'; // Assuming a logger utility exists

function BookList() {
    const [books, setBooks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null); // Add error state

    // Function to fetch the list of books from the backend
    const fetchBooks = async () => {
        console.log("[BookList.js CONSOLE.LOG] Fetching books list from backend...");
        const rawToken = localStorage.getItem('authToken'); // Retrieve the token

        if (!rawToken) {
            console.error("[BookList.js CONSOLE.ERROR] No auth token found (rawToken is falsy). User might not be logged in.");
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
            console.error(`[BookList.js CONSOLE.ERROR] Auth token is invalid after sanitization or is a problematic string. Sanitized token value: '${token}'. User might not be logged in or token is invalid.`);
            setError("Authentication token is invalid. Please log in again.");
            setLoading(false);
            return;
        }
        
        console.log(`[BookList.js CONSOLE.LOG] Attempting to use sanitized auth token (first 20 chars): '${token.substring(0, 20)}...'`);

        // --- MODIFICATION START ---
        const requestHeaders = {
            'Content-Type': 'application/json'
            // Authorization header will be added below
        };

        // This check is somewhat redundant given the earlier checks, 
        // but ensures token is valid right before header construction for fetch.
        if (token) {
            requestHeaders['Authorization'] = `Bearer ${token}`;
        } else {
            // This block should ideally not be reached if prior checks are effective.
            console.error("[BookList.js CONSOLE.ERROR] Critical error: Token became null or empty just before setting Authorization header. Aborting fetch.");
            setError("Authentication error. Please log in again.");
            setLoading(false);
            return;
        }

        console.log("[BookList.js CONSOLE.LOG] Request headers being sent to /api/books/:", JSON.stringify(requestHeaders));
        // --- MODIFICATION END ---

        try {
            const response = await fetch('/api/books/', {
                // --- MODIFICATION: Use the constructed requestHeaders object ---
                headers: requestHeaders
            });
            if (!response.ok) {
                const errorText = await response.text(); // Read error text for better logging
                console.error(`[BookList.js CONSOLE.ERROR] HTTP error fetching books: ${response.status} - ${errorText}`);
                // Try to parse errorText as JSON if backend sends structured errors
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
            console.log(`[BookList.js CONSOLE.LOG] Successfully fetched ${data.length} books.`);
            const activeBooks = data.filter(book => book.status !== 'failed');
            setBooks(activeBooks);
            setError(null);
        } catch (error) {
            console.error("[BookList.js CONSOLE.ERROR] Error fetching books:", error);
            setError(error.message || "Failed to load books. Please try again later.");
        } finally {
            setLoading(false);
        }
    };

    // ... useEffect and the rest of the component ...
    useEffect(() => {
        fetchBooks(); 

        const intervalId = setInterval(fetchBooks, 10000); 

        return () => clearInterval(intervalId);

    }, []);


    if (loading) {
        return <div>Loading books...</div>;
    }

    if (error) {
        // Display the error message, which might now include more detail from the server
        return <div className="error-message">Error: {error}</div>;
    }

    // ... rest of the return statement ...
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
