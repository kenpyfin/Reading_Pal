import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom'; // Import useNavigate

function PdfUploadForm() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  // --- REMOVE success state ---
  // const [success, setSuccess] = useState(null);
  const navigate = useNavigate(); // Get the navigate function

  const handleFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
    setError(null);
    // --- REMOVE success state update ---
    // setSuccess(null);
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
    // --- REMOVE success state update ---
    // setSuccess(null);

    const formData = new FormData();
    formData.append('file', selectedFile);
    if (title) {
      formData.append('title', title);
    }

    try {
      // Call backend API for PDF upload
      // Use /api/books/upload to match Nginx proxy configuration
      const response = await fetch('/api/books/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        // Attempt to parse error response if it's JSON, otherwise use generic message
        let errorDetail = 'Upload failed';
        try {
            const errorData = await response.json();
            errorDetail = errorData.detail || JSON.stringify(errorData);
        } catch (parseError) {
            // If parsing fails, the response body might not be JSON (e.g., HTML error page)
            errorDetail = `Upload failed: Received non-JSON response (Status: ${response.status})`;
            console.error("Failed to parse error response as JSON:", parseError);
        }
        throw new Error(errorDetail);
      }

      // Backend confirmed upload initiation
      const bookData = await response.json();
      console.log('Upload initiated successfully, processing started:', bookData);

      // --- REMOVE success message state update ---
      // setSuccess(`PDF uploaded successfully. Processing started (Job ID: ${bookData.job_id}). You will be redirected to the book list.`);

      // --- REMOVE setTimeout and navigate immediately ---
      // setTimeout(() => {
      //     navigate('/'); // Navigate to the book list after a short delay
      // }, 2000);
      // --- ADD Immediate Navigation ---
      // Optional: Add a non-blocking notification here (e.g., toast) if desired
      // alert(`Upload started for "${bookData.title || bookData.original_filename}". It will appear in the list shortly.`); // Example using alert
      navigate('/'); // Navigate immediately to the book list

    } catch (err) {
      console.error('Upload failed:', err);
      setError(`Upload failed: ${err.message || 'Unknown error'}`);
      // Reset uploading state only if there was an error
      setUploading(false);
    } finally {
      // --- REMOVE setUploading(false) here ---
      // If successful, navigation happens and component unmounts.
      // If error, it's reset in the catch block.
      // setUploading(false);
    }
  };

  return (
    // --- Use consistent styling from BookList ---
    <div className="book-list-container"> {/* Reuse container style */}
      <h2>Upload New PDF</h2>
      {error && <p style={{ color: 'red', textAlign: 'center', marginBottom: '15px' }}>{error}</p>}
      {/* Remove success message display */}
      {/* {success && <p style={{ color: 'green' }}>{success}</p>} */}

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
