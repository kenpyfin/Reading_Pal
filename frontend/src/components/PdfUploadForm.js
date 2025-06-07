import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom'; // Import useNavigate

// Define timeout duration for upload in milliseconds
const UPLOAD_TIMEOUT_MS = 60000; // 60 seconds

function PdfUploadForm() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate(); // Get the navigate function

  const handleFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
    setError(null);
  };

  const handleTitleChange = (event) => {
    setTitle(event.target.value);
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setError("Please select a PDF file.");
      return;
    }

    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', selectedFile);
    if (title) {
      formData.append('title', title);
    }

    // --- Add AbortController and timeout ---
    const controller = new AbortController();
    const signal = controller.signal;
    let timeoutId = null;

    // --- MODIFICATION START: Add Authorization Header ---
    const rawToken = localStorage.getItem('authToken');
    if (!rawToken) {
        console.error("[PdfUploadForm] No auth token found for upload.");
        setError("Authentication token not found. Please log in again.");
        setUploading(false);
        return;
    }
    let token = rawToken.trim().replace(/(\r\n|\n|\r)/gm, "");
    if (!token || token === "null" || token === "undefined") {
        console.error(`[PdfUploadForm] Invalid auth token for upload. Sanitized token: '${token}'`);
        setError("Authentication token is invalid. Please log in again.");
        setUploading(false);
        return;
    }
    console.log(`[PdfUploadForm] Using token for upload: '${token.substring(0,20)}...'`);

    const requestHeaders = {
        // 'Content-Type': 'multipart/form-data' is NOT set here.
        // The browser will automatically set it correctly with the boundary
        // when FormData is used as the body.
        'Authorization': `Bearer ${token}`
    };
    // --- MODIFICATION END ---

    try {
      timeoutId = setTimeout(() => {
          console.log(`Upload timed out after ${UPLOAD_TIMEOUT_MS}ms`);
          controller.abort(); 
      }, UPLOAD_TIMEOUT_MS);

      const response = await fetch('/api/books/upload', {
        method: 'POST',
        headers: requestHeaders, // --- MODIFICATION: Add headers ---
        body: formData,
        signal: signal, 
      });

      if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null; 
      }

      if (!response.ok) {
        let errorDetail = 'Upload failed';
        try {
            const errorData = await response.json();
            // --- MODIFICATION: Check for specific "Not authenticated" message ---
            if (response.status === 401 && errorData.detail && errorData.detail.toLowerCase().includes("not authenticated")) {
                errorDetail = "Not authenticated. Please log in again.";
            } else {
                errorDetail = errorData.detail || JSON.stringify(errorData);
            }
        } catch (parseError) {
            errorDetail = `Upload failed: Received non-JSON response (Status: ${response.status})`;
            console.error("Failed to parse error response as JSON:", parseError);
        }
        throw new Error(errorDetail);
      }

      const bookData = await response.json();
      console.log('Upload initiated successfully, processing started:', bookData);
      alert(`Upload started for "${bookData.title || bookData.original_filename}". It will appear in the book list shortly with status "${bookData.status}".`);
      navigate('/'); 

    } catch (err) {
      if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null; 
      }
      // Check if the error is an AbortError (due to timeout)
      if (err.name === 'AbortError') {
          console.error('Upload aborted due to timeout:', err);
          setError(`Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000} seconds. Please check your connection and try again.`);
      } else {
          console.error('Upload failed:', err);
          setError(`Upload failed: ${err.message || 'Unknown error'}`);
      }
      // Reset uploading state only if there was an error (including abort)
      setUploading(false);
    } finally {
      // The timeout is cleared in both the try and catch blocks now.
      // No need to clear it again here.
    }
  };

  return (
    // --- Use consistent styling from BookList ---
    <div className="book-list-container"> {/* Reuse container style */}
      <h2>Upload New PDF</h2>
      {error && <p style={{ color: 'red', textAlign: 'center', marginBottom: '15px' }}>{error}</p>}

      {/* Form Fields Styling */}
      <div style={{ marginBottom: '15px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <label htmlFor="pdf-file" style={{ marginBottom: '5px', fontWeight: '500' }}>Choose PDF File:</label>
        <input
          type="file"
          id="pdf-file"
          accept=".pdf"
          onChange={handleFileChange}
          disabled={uploading}
          style={{ border: '1px solid #ccc', padding: '8px', borderRadius: '4px', maxWidth: '400px', width: '100%' }}
        />
        {selectedFile && <p style={{ fontSize: '0.9em', marginTop: '5px', color: '#555' }}>Selected: {selectedFile.name}</p>}
      </div>

      <div style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <label htmlFor="pdf-title" style={{ marginBottom: '5px', fontWeight: '500' }}>Optional Title:</label>
        <input
          type="text"
          id="pdf-title"
          value={title}
          onChange={handleTitleChange}
          placeholder="Leave blank to use filename"
          disabled={uploading}
          style={{ border: '1px solid #ccc', padding: '8px', borderRadius: '4px', maxWidth: '400px', width: '100%' }}
        />
      </div>

      {/* Button Styling */}
      <div style={{ textAlign: 'center' }}> {/* Center the button */}
        <button
          onClick={handleUpload}
          disabled={!selectedFile || uploading}
          // --- Reuse button style from BookList upload link ---
          style={{
            display: 'inline-block',
            padding: '10px 20px',
            backgroundColor: (!selectedFile || uploading) ? '#ccc' : '#007bff', // Grey out when disabled
            color: 'white',
            textDecoration: 'none',
            border: 'none', // Remove default border
            borderRadius: '5px',
            fontWeight: '500',
            cursor: (!selectedFile || uploading) ? 'not-allowed' : 'pointer', // Change cursor when disabled
            transition: 'background-color 0.2s ease-in-out',
          }}
          onMouseOver={(e) => { if (!(!selectedFile || uploading)) e.currentTarget.style.backgroundColor = '#0056b3'; }} // Hover effect only if enabled
          onMouseOut={(e) => { if (!(!selectedFile || uploading)) e.currentTarget.style.backgroundColor = '#007bff'; }} // Restore color on mouse out
        >
          {uploading ? 'Uploading...' : 'Upload and Process'}
        </button>
      </div>
    </div>
  );
}

export default PdfUploadForm;
