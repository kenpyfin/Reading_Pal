import React, { useState, useEffect, useRef } from 'react';
import './NotePane.css'; // Assuming you'll add some basic CSS

// Remove LLM related state and handlers for Phase 3 completion
// import { useState, useEffect } from 'react'; // Keep useState, useEffect
// import { useState, useEffect, useRef } from 'react'; // Keep useRef

function NotePane({ bookId, onNotePaneScroll }) { // Removed bookContent, onScrollSync
  const [notes, setNotes] = useState([]);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const notePaneRef = useRef(null); // Ref for the scrollable div

  // Fetch notes when bookId changes
  useEffect(() => {
    const fetchNotes = async () => {
      if (!bookId) return;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/notes/${bookId}`); // Use relative path
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
  }, [bookId]); // Dependency array includes bookId

  const handleSaveNote = async () => {
    if (!newNoteContent.trim()) return;

    const noteData = {
      book_id: bookId,
      content: newNoteContent.trim(),
      // TODO: Add position info (e.g., scroll percentage, section ID) later
    };

    try {
      const response = await fetch('/notes', { // Use relative path for POST
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

    } catch (err) {
      console.error('Failed to save note:', err);
      setError(`Failed to save note: ${err.message || 'Unknown error'}`);
    }
  };

  // Handle scroll event for synchronization
  const handleScroll = () => {
    if (notePaneRef.current && onNotePaneScroll) {
      onNotePaneScroll(notePaneRef.current);
    }
  };

  if (loading) {
    return <div className="note-pane">Loading notes...</div>;
  }

  if (error) {
    return <div className="note-pane" style={{ color: 'red' }}>Error loading notes: {error}</div>;
  }

  return (
    <div className="note-pane" ref={notePaneRef} onScroll={handleScroll}>
      <h2>Notes</h2>

      {/* Display existing notes */}
      <div className="notes-list">
        {notes.length === 0 ? (
          <p>No notes yet. Add one below!</p>
        ) : (
          notes.map(note => (
            <div key={note.id} className="note-item">
              <p>{note.content}</p>
              {/* Optional: Display timestamp, edit/delete buttons */}
              {/* <small>{new Date(note.created_at).toLocaleString()}</small> */}
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
      </div>

      {/* LLM Interaction section - Commented out for Phase 3 completion */}
      {/*
      <div className="llm-interaction">
        <h3>LLM Reading Assistance</h3>
        <button onClick={handleSummarizeBook} disabled={llmLoading || !bookContent} style={{ marginBottom: '15px' }}>
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
        <button onClick={handleAskLLM} disabled={llmLoading || !bookContent}>
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
      */}
    </div>
  );
}

export default NotePane;
