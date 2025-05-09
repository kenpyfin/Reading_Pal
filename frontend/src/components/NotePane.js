// Import forwardRef if not already imported
import React, { useState, useEffect, useRef, forwardRef } from 'react';
import './NotePane.css'; // Assuming you'll add some basic CSS

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
      source_text: selectedBookText || undefined,
      scroll_percentage: selectedScrollPercentage !== null && selectedScrollPercentage !== undefined ? parseFloat(selectedScrollPercentage.toFixed(4)) : undefined,
      global_character_offset: selectedGlobalCharOffset !== null && selectedGlobalCharOffset !== undefined ? selectedGlobalCharOffset : undefined, // INCLUDE THIS
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
      console.log('Note saved in NotePane:', savedNote);

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
      // Use global_character_offset for jumping if available, otherwise fall back to scroll_percentage
      if (note.global_character_offset !== null && note.global_character_offset !== undefined && onNoteClick) {
          onNoteClick(note.global_character_offset); // Pass global_character_offset
      } else if (note.scroll_percentage !== null && note.scroll_percentage !== undefined && onNoteClick) {
          // This part is a fallback and might need adjustment in BookView's handleNoteClick
          // if it strictly expects a global_character_offset.
          // For now, we assume onNoteClick can handle a percentage if offset is not available,
          // or BookView's handleNoteClick needs to be adapted.
          // However, the primary mechanism is now global_character_offset.
          console.warn("Note clicked without global_character_offset, attempting to use scroll_percentage. This may not be precise.");
          // To make this work, BookView's handleNoteClick would need to differentiate.
          // For now, let's prioritize global_character_offset.
          // If you want to support scroll_percentage as a fallback, BookView's handleNoteClick
          // would need to be more complex or you'd pass a different type of value.
          // Sticking to global_character_offset for now for the primary click action.
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

  if (error) {
    return <div className="note-pane" ref={ref} style={{ color: 'red' }}>Error loading notes: {error}</div>;
  }

  return (
    <div className="note-pane" ref={ref}> {/* Attach the ref */}
      <h2>Notes</h2>

      <div className="notes-list">
        {notes.length === 0 ? (
          <p>No notes yet. Add one below!</p>
        ) : (
          notes.map(note => (
            <div
                key={note.id}
                className={`note-item ${(note.global_character_offset !== null && note.global_character_offset !== undefined) ? 'clickable-note' : ''}`}
                onClick={() => handleNoteClickInternal(note)}
                style={{ cursor: (note.global_character_offset !== null && note.global_character_offset !== undefined) ? 'pointer' : 'default' }}
            >
              {note.source_text && (
                  <blockquote style={{ fontSize: '0.9em', color: '#555', borderLeft: '2px solid #ccc', paddingLeft: '10px', margin: '5px 0' }}>
                      {note.source_text}
                  </blockquote>
              )}
              <p>{note.content}</p>
              {/* <small>Offset: {note.global_character_offset}, Scroll %: {note.scroll_percentage !== null ? note.scroll_percentage.toFixed(2) : 'N/A'}</small> */}
            </div>
          ))
        )}
      </div>

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
        {selectedBookText && (
            <p style={{ fontSize: '0.9em', color: '#555', marginTop: '5px' }}>Note will be linked to selected text.</p>
        )}
        {(selectedScrollPercentage !== null || selectedGlobalCharOffset !== null) && (
            <p style={{ fontSize: '0.9em', color: '#555', marginTop: '5px' }}>Note will be linked to current location.</p>
        )}

      </div>

      <div className="llm-interaction">
        <h3>LLM Reading Assistance</h3>
        <h4 style={{ marginTop: '20px' }}>Ask a Question</h4>
        <textarea
            value={llmQuestion}
            onChange={(e) => setLlmQuestion(e.target.value)}
            placeholder="Ask a question about the book content or selected text..."
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
