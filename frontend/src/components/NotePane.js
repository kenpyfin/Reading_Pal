// Import forwardRef if not already imported
import React, { useState, useEffect, useRef, forwardRef } from 'react';
import './NotePane.css'; // Assuming you'll add some basic CSS

// Wrap the component with forwardRef and accept new props
const NotePane = forwardRef(({ bookId, selectedBookText, selectedScrollPercentage, onNoteClick }, ref) => { // ACCEPT NEW PROPS
  const [notes, setNotes] = useState([]);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Add state variables for LLM interaction
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmQuestion, setLlmQuestion] = useState('');
  const [llmAskResponse, setLlmAskResponse] = useState(null);
  const [llmSummarizeResponse, setLlmSummarizeResponse] = useState(null);
  const [llmError, setLlmError] = useState(null);


  // --- Enhancement 1: REMOVE or COMMENT OUT this useEffect block ---
  // This effect is what was pre-filling the new note content.
  /*
  useEffect(() => {
    if (selectedBookText !== null) { // Only update if text is selected or cleared
      setNewNoteContent(selectedBookText || ''); // Use selected text, or clear if null
    }
  }, [selectedBookText]); // Dependency on selectedBookText prop
  */
  // The new note input will now remain empty by default.


  // Fetch notes when bookId changes
  useEffect(() => {
    const fetchNotes = async () => {
      if (!bookId) return;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/notes/${bookId}`);
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`HTTP error! status: ${response.status} - ${errorData.detail || response.statusText}`);
        }
        const data = await response.json();
        // Sort notes by creation date if not already sorted by backend
        const sortedNotes = data.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        setNotes(sortedNotes);
      } catch (err) {
        console.error('Failed to fetch notes:', err);
        setError(`Failed to load notes: ${err.message || 'Unknown error'}`);
      } finally {
        setLoading(false);
      }
    };

    fetchNotes();
  }, [bookId]);

  const handleSaveNote = async () => {
    if (!newNoteContent.trim()) return;

    const noteData = {
      book_id: bookId,
      content: newNoteContent.trim(),
      source_text: selectedBookText || undefined, // Include source_text if available
      // --- Enhancement 2: Include the captured scroll percentage ---
      scroll_percentage: selectedScrollPercentage || undefined, // INCLUDE THE PERCENTAGE
    };

    try {
      const response = await fetch('/api/notes/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(noteData),
      });

      if (!response.ok) {
         const errorData = await response.json();
         throw new Error(errorData.detail || 'Failed to save note');
      }

      const savedNote = await response.json();
      console.log('Note saved:', savedNote);
      // Add the new note to the state and sort
      setNotes(prevNotes => [...prevNotes, savedNote].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
      setNewNoteContent(''); // Clear the input field
      // Note: selectedBookText and selectedScrollPercentage are cleared by the parent (BookView) via prop update
      // when a new selection is made or selection is cleared.

    } catch (err) {
      console.error('Failed to save note:', err);
      setError(`Failed to save note: ${err.message || 'Unknown error'}`);
    }
  };

  // --- Enhancement 2: Add handler for Note Click ---
  const handleNoteClickInternal = (note) => { // Use a different name to avoid conflict with prop
      // Check if the note has a scroll percentage and the handler is provided by the parent
      if (note.scroll_percentage !== null && note.scroll_percentage !== undefined && onNoteClick) {
          onNoteClick(note.scroll_percentage); // Call the handler passed from parent (BookView)
      }
  };


  // Add handleSummarizeBook function (keep as is)
  const handleSummarizeBook = async () => {
    if (!bookId) return;
    setLlmLoading(true);
    setLlmAskResponse(null);
    setLlmSummarizeResponse(null);
    setLlmError(null);

    try {
      const response = await fetch('/api/llm/summarize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ book_id: bookId }),
      });

      const data = await response.json();

      if (!response.ok) {
         throw new Error(data.detail || data.response || `HTTP error! status: ${response.status}`);
      }

      setLlmSummarizeResponse(data.response);

    } catch (err) {
      console.error('Failed to summarize book:', err);
      setLlmError(`Failed to summarize: ${err.message || 'Unknown error'}`);
    } finally {
      setLlmLoading(false);
    }
  };

  // Add handleAskLLM function (keep as is)
  const handleAskLLM = async () => {
    if (!bookId || !llmQuestion.trim()) {
        setLlmError("Please enter a question.");
        return;
    }
    setLlmLoading(true);
    setLlmAskResponse(null);
    setLlmSummarizeResponse(null);
    setLlmError(null);

    try {
      const response = await fetch('/api/llm/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ book_id: bookId, text: llmQuestion.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
         throw new Error(data.detail || data.response || `HTTP error! status: ${response.status}`);
      }

      setLlmAskResponse(data.response);

    } catch (err) {
      console.error('Failed to ask LLM:', err);
      setLlmError(`Failed to get LLM response: ${err.message || 'Unknown error'}`);
    } finally {
      setLlmLoading(false);
    }
  };


  if (loading) {
    return <div className="note-pane" ref={ref}>Loading notes...</div>;
  }

  if (error) {
    return <div className="note-pane" ref={ref} style={{ color: 'red' }}>Error loading notes: {error}</div>;
  }

  return (
    <div className="note-pane" ref={ref}> {/* Attach the ref */}
      <h2>Notes</h2>

      {/* Display existing notes */}
      <div className="notes-list">
        {notes.length === 0 ? (
          <p>No notes yet. Add one below!</p>
        ) : (
          notes.map(note => (
            // --- Enhancement 2: Make note item clickable ---
            // Add onClick handler and a class for styling cursor
            <div
                key={note.id}
                className={`note-item ${note.scroll_percentage !== null ? 'clickable-note' : ''}`} // Add class if clickable
                onClick={() => handleNoteClickInternal(note)} // CALL THE INTERNAL HANDLER
                style={{ cursor: note.scroll_percentage !== null ? 'pointer' : 'default' }} // Change cursor
            >
              {/* Display source text if available */}
              {note.source_text && (
                  <blockquote style={{ fontSize: '0.9em', color: '#555', borderLeft: '2px solid #ccc', paddingLeft: '10px', margin: '5px 0' }}>
                      {note.source_text}
                  </blockquote>
              )}
              <p>{note.content}</p>
              {/* Optional: Display timestamp, edit/delete buttons */}
              {/* <small>{new Date(note.created_at).toLocaleString()}</small> */}
              {/* Optional: Display scroll percentage for debugging */}
              {/* {note.scroll_percentage !== null && <small>Scroll: {note.scroll_percentage.toFixed(2)}</small>} */}
            </div>
          ))
        )}
      </div>

      {/* Input for new note */}
      <div className="new-note-form">
        <h3>Add New Note</h3>
        <textarea
          value={newNoteContent}
          onChange={(e) => setNewNoteContent(e.target.value)}
          placeholder="Write your note here..."
          rows="4"
          style={{ width: '100%', marginBottom: '10px' }}
        />
        <button onClick={handleSaveNote} disabled={!newNoteContent.trim()}>
          Save Note
        </button>
        {/* Optional: Add an indicator if the note is based on selection */}
        {selectedBookText && (
            <p style={{ fontSize: '0.9em', color: '#555', marginTop: '5px' }}>Note will be linked to selected text.</p>
        )}
         {/* Optional: Add an indicator if scroll percentage was captured */}
        {selectedScrollPercentage !== null && (
            <p style={{ fontSize: '0.9em', color: '#555', marginTop: '5px' }}>Note will be linked to scroll position.</p>
        )}

      </div>

      {/* LLM Interaction section */}
      <div className="llm-interaction">
        <h3>LLM Reading Assistance</h3>
        <button onClick={handleSummarizeBook} disabled={llmLoading || !bookId} style={{ marginBottom: '15px' }}>
             {llmLoading ? 'Summarizing...' : 'Summarize Book'}
        </button>
        {llmSummarizeResponse && (
            <div className="llm-response" style={{ marginTop: '10px', borderTop: '1px solid #eee', paddingTop: '10px' }}>
                <h4>Summary:</h4>
                <p>{llmSummarizeResponse}</p>
            </div>
        )}
        <h4 style={{ marginTop: '20px' }}>Ask a Question</h4>
        <textarea
            value={llmQuestion}
            onChange={(e) => setLlmQuestion(e.target.value)}
            placeholder="Ask a question about the book content..."
            rows="3"
            style={{ width: '100%', marginBottom: '10px' }}
        />
        <button onClick={handleAskLLM} disabled={llmLoading || !bookId || !llmQuestion.trim()}>
            {llmLoading ? 'Asking...' : 'Ask LLM'}
        </button>
        {llmError && <p style={{ color: 'red' }}>{llmError}</p>}
        {llmAskResponse && (
            <div className="llm-response" style={{ marginTop: '15px', borderTop: '1px solid #eee', paddingTop: '10px' }}>
                <h4>LLM Response:</h4>
                <p>{llmAskResponse}</p>
            </div>
        )}
      </div>
    </div>
  );
});

export default NotePane;
