// Import forwardRef if not already imported
import React, { useState, useEffect, useRef, forwardRef } from 'react';
import './NotePane.css'; // Ensure this CSS file is imported

// Wrap the component with forwardRef and accept new props
const NotePane = forwardRef(({
  bookId,
  selectedBookText,
  selectedScrollPercentage,
  selectedGlobalCharOffset, // Make sure this prop is received
  onNoteClick,
  onNewNoteSaved // ACCEPT THE NEW PROP
}, ref) => {
  const [notes, setNotes] = useState([]); // This state is local to NotePane for display
  const [newNoteContent, setNewNoteContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Add state variables for LLM interaction
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmQuestion, setLlmQuestion] = useState('');
  const [llmAskResponse, setLlmAskResponse] = useState(null);
  const [llmError, setLlmError] = useState(null);


  // Fetch notes when bookId changes (for NotePane's internal display)
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
        console.error('Failed to fetch notes for NotePane:', err);
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
      source_text: selectedBookText || undefined, // This is the selected plain text
      scroll_percentage: selectedScrollPercentage !== null && selectedScrollPercentage !== undefined ? parseFloat(selectedScrollPercentage.toFixed(4)) : undefined,
      global_character_offset: selectedGlobalCharOffset, // This comes from BookView
    };
    console.log("[NotePane - handleSaveNote] Sending noteData to backend:", noteData);


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
      console.log('[NotePane - handleSaveNote] Received savedNote from backend:', savedNote);


      // Update NotePane's local list of notes for display
      setNotes(prevNotes => [...prevNotes, savedNote].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
      
      // Call the callback prop to inform BookView
      if (onNewNoteSaved) {
        onNewNoteSaved(savedNote); // INFORM BookView
      }

      setNewNoteContent(''); // Clear the input field
      // selectedBookText, selectedScrollPercentage, selectedGlobalCharOffset are props.
      // BookView should manage clearing its own state for these if desired after a note is saved.
      // For example, BookView's handleNewNoteSaved could call setSelectedBookText(null), etc.

    } catch (err) {
      console.error('Failed to save note:', err);
      setError(`Failed to save note: ${err.message || 'Unknown error'}`);
    }
  };

  const handleNoteClickInternal = (note) => {
      // Use global_character_offset for jumping if available
      if (note.global_character_offset !== null && note.global_character_offset !== undefined && onNoteClick) {
          onNoteClick(note.global_character_offset); // Pass global_character_offset
      }
  };


  const handleAskLLM = async () => {
    if (!bookId || !llmQuestion.trim()) {
        setLlmError("Please enter a question.");
        return;
    }
    setLlmLoading(true);
    setLlmAskResponse(null);
    setLlmError(null);

    try {
      const response = await fetch('/api/llm/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          book_id: bookId,
          question: llmQuestion.trim(),
          context: selectedBookText || null, 
        }),
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

  if (error && notes.length === 0) { // Show error only if there are no notes to display
    return <div className="note-pane" ref={ref} style={{ color: 'red' }}>Error loading notes: {error}</div>;
  }

  return (
    <div className="note-pane" ref={ref}> {/* Attach the ref */}
      <h2>Notes & LLM Insights</h2>

      {/* ADDED: Dedicated area for displaying selected text */}
      {selectedBookText && (
        <div className="selected-text-display">
          <h4>Selected Text from Book:</h4>
          <blockquote>
            {selectedBookText}
          </blockquote>
          {(selectedScrollPercentage !== null || selectedGlobalCharOffset !== null) && (
            <p className="location-info">
              This text is linked to the current location in the book.
            </p>
          )}
        </div>
      )}

      <div className="new-note-form">
        <h3>Add New Note</h3>
        <textarea
          value={newNoteContent}
          onChange={(e) => setNewNoteContent(e.target.value)}
          placeholder="Write your note here, referencing the selected text above if any..."
          rows="4"
          // Inline style removed, will be handled by CSS
        />
        <button onClick={handleSaveNote} disabled={!newNoteContent.trim()}>
          Save Note
        </button>
        {/* REMOVED conditional messages about linking, now covered by selected-text-display */}
      </div>

      <div className="llm-interaction">
        <h3>LLM Reading Assistance</h3>
        {/* <h4 style={{ marginTop: '20px' }}>Ask a Question</h4> REMOVED - Redundant with section H3 */}
        <textarea
            value={llmQuestion}
            onChange={(e) => setLlmQuestion(e.target.value)}
            placeholder="Ask a question about the book content or the selected text above..."
            rows="3"
            // Inline style removed, will be handled by CSS
        />
        <button onClick={handleAskLLM} disabled={llmLoading || !bookId || !llmQuestion.trim()}>
            {llmLoading ? 'Asking...' : 'Ask LLM'}
        </button>
        {llmError && <p className="error-message">{llmError}</p>}
        {llmAskResponse && (
            <div className="llm-response">
                <h4>LLM Response:</h4>
                <p>{llmAskResponse}</p>
            </div>
        )}
      </div>
      
      <div className="notes-list">
        <h3>Saved Notes</h3>
        {error && notes.length > 0 && <p className="error-message">Error loading notes: {error}. Displaying cached notes.</p>}
        {notes.length === 0 && !loading && <p>No notes yet. Add one above!</p>}
        {notes.map(note => (
          <div
              key={note.id}
              className={`note-item ${(note.global_character_offset !== null && note.global_character_offset !== undefined) ? 'clickable-note' : ''}`}
              onClick={() => handleNoteClickInternal(note)}
              // Inline style for cursor removed, will be handled by CSS
          >
            {note.source_text && (
                <blockquote className="note-source-text"> {/* ADDED className */}
                    <em>Source: "{note.source_text}"</em>
                </blockquote>
            )}
            <p className="note-content-display">{note.content}</p> {/* ADDED className */}
            <small className="note-meta-display">{new Date(note.created_at).toLocaleString()}</small> {/* ADDED className */}
          </div>
        ))}
      </div>
    </div>
  );
});

export default NotePane;
