import React, { useState } from 'react';
// TODO: Import API function for PDF upload

function PdfUploadForm() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [title, setTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
    setError(null);
    setSuccess(null);
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
    setSuccess(null);

    const formData = new FormData();
    formData.append('file', selectedFile);
    if (title) {
      formData.append('title', title);
    }

    try {
      // TODO: Call backend API for PDF upload
      // const response = await uploadPdfApi(formData);
      // console.log('Upload successful:', response);
      // setSuccess("PDF uploaded and processing started!");
      // TODO: Redirect to book view or show progress

      // Placeholder success
      console.log('Placeholder upload logic');
      setSuccess("PDF upload placeholder successful. Check console.");

    } catch (err) {
      console.error('Upload failed:', err);
      setError(`Upload failed: ${err.message || 'Unknown error'}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="pdf-upload-form">
      <h2>Upload PDF</h2>
      <input type="file" accept=".pdf" onChange={handleFileChange} />
      <input
        type="text"
        value={title}
        onChange={handleTitleChange}
        placeholder="Optional: Enter book title"
      />
      <button onClick={handleUpload} disabled={!selectedFile || uploading}>
        {uploading ? 'Uploading...' : 'Upload and Process'}
      </button>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {success && <p style={{ color: 'green' }}>{success}</p>}
      {selectedFile && <p>Selected file: {selectedFile.name}</p>}
    </div>
  );
}

export default PdfUploadForm;
