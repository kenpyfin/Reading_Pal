import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom'; // Import useNavigate
import { getAuthHeaders } from '../utils/authRequest';

// Timeout for upload initiation only (returns job_id; MinerU runs in background).
const UPLOAD_TIMEOUT_MS = 600000; // 10 minutes — large scans need time to reach pdf_service

function PdfUploadForm() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [netOnline, setNetOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const navigate = useNavigate(); // Get the navigate function

  useEffect(() => {
    const sync = () => setNetOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  const handleFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
    setError(null);
  };

  const handleTitleChange = (event) => {
    setTitle(event.target.value);
  };

  const handleUpload = async () => {
    if (!netOnline) {
      setError('Upload requires an internet connection.');
      return;
    }
    if (!selectedFile) {
      setError("Please select a supported ebook/document file.");
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
    const authHeaders = getAuthHeaders();
    if (!authHeaders) {
        console.error("[PdfUploadForm] No auth token found for upload.");
        setError("Authentication token not found. Please log in again.");
        setUploading(false);
        return;
    }

    const requestHeaders = {
        // 'Content-Type': 'multipart/form-data' is NOT set here.
        // The browser will automatically set it correctly with the boundary
        // when FormData is used as the body.
        ...authHeaders,
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
          setError(
            `Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000} seconds while starting processing. ` +
              'Large files may need longer; try again or check pdf_service logs.'
          );
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
      <h2>Upload New Book</h2>
      {!netOnline && (
        <p className="theme-offline-banner" style={{ textAlign: 'center' }}>
          Upload requires a connection to the server. You can still read cached books from the book list.
        </p>
      )}
      {error && <p className="theme-error-text" style={{ textAlign: 'center', marginBottom: '15px' }}>{error}</p>}

      {/* Form Fields Styling */}
      <div style={{ marginBottom: '15px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <label htmlFor="pdf-file" style={{ marginBottom: '5px', fontWeight: '500' }}>Choose ebook/document file:</label>
        <input
          type="file"
          id="pdf-file"
          accept=".pdf,.epub,.mobi,.azw,.azw3,.docx,.txt,.html,.htm"
          onChange={handleFileChange}
          disabled={uploading || !netOnline}
          style={{ border: '1px solid var(--color-input-border)', padding: '8px', borderRadius: '4px', maxWidth: '400px', width: '100%', backgroundColor: 'var(--color-input-bg)', color: 'var(--color-text)' }}
        />
        {selectedFile && <p style={{ fontSize: '0.9em', marginTop: '5px', color: 'var(--color-text-muted)' }}>Selected: {selectedFile.name}</p>}
      </div>

      <div style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <label htmlFor="pdf-title" style={{ marginBottom: '5px', fontWeight: '500' }}>Optional Title:</label>
        <input
          type="text"
          id="pdf-title"
          value={title}
          onChange={handleTitleChange}
          placeholder="Leave blank to use filename"
          disabled={uploading || !netOnline}
          style={{ border: '1px solid var(--color-input-border)', padding: '8px', borderRadius: '4px', maxWidth: '400px', width: '100%', backgroundColor: 'var(--color-input-bg)', color: 'var(--color-text)' }}
        />
      </div>

      <div style={{ textAlign: 'center' }}>
        <button
          onClick={handleUpload}
          disabled={!selectedFile || uploading || !netOnline}
          className="pdf-upload-submit-btn"
          style={{
            display: 'inline-block',
            padding: '10px 20px',
            backgroundColor: (!selectedFile || uploading || !netOnline) ? 'var(--color-border)' : 'var(--color-primary)',
            color: 'var(--color-on-accent)',
            textDecoration: 'none',
            border: 'none',
            borderRadius: '5px',
            fontWeight: '500',
            cursor: (!selectedFile || uploading || !netOnline) ? 'not-allowed' : 'pointer',
            transition: 'background-color 0.2s ease-in-out',
          }}
        >
          {uploading ? 'Uploading...' : 'Upload and Process'}
        </button>
      </div>
    </div>
  );
}

export default PdfUploadForm;
