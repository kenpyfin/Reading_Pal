// Import forwardRef if not already imported
import React, { useState, useEffect, useRef } from 'react'; // Removed forwardRef
import './NotePane.css'; // Ensure this CSS file is imported
import logger from '../utils/logger'; // Import logger

// NotePane no longer uses forwardRef as the ref is not passed from BookView for its root
const NotePane = ({ // Removed ref from props
  bookId,
  selectedBookText,
  selectedScrollPercentage,
  selectedGlobalCharOffset, // Make sure this prop is received
  onNoteClick,
  onNewNoteSaved, // ACCEPT THE NEW PROP
  isMobileContext, // New prop for mobile overlay context
  onClosePane // New prop to handle closing the pane in mobile overlay
}) => {
  const [notes, setNotes] = useState([]); // This state is local to NotePane for display
  const [newNoteContent, setNewNoteContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [currentNotesPage, setCurrentNotesPage] = useState(1);
  const notesPerPage = 6;

  // Add state variables for LLM interaction
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmQuestion, setLlmQuestion] = useState('');
  const [llmAskResponse, setLlmAskResponse] = useState(null);
  const [llmError, setLlmError] = useState(null);

  // Inside the NotePane component function:
  // ... after other state and function definitions ...

  const handleAddLlmResponseToNote = () => {
    if (llmAskResponse) {
      // Using a simpler separator for plain text appending
      const separator = "\n\n--- LLM Response ---\n"; 
      setNewNoteContent(prevContent => {
        if (prevContent.trim() === "") {
          return llmAskResponse; 
        }
        // Append with the separator
        return prevContent + separator + llmAskResponse;
      });
      logger.info("[NotePane] LLM response appended to new note content.");
    }
  };

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
        setCurrentNotesPage(1); // <<< ADD THIS LINE to reset page on book change
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
      setNotes(prevNotes => {
        const updatedNotesList = [...prevNotes, savedNote].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        
        // Calculate new total pages based on the updated list and go to the last page
        const newTotalPages = Math.ceil(updatedNotesList.length / notesPerPage);
        setCurrentNotesPage(newTotalPages); // <<< ADD THIS LINE

        return updatedNotesList;
      });
      
      // Call the callback prop to inform BookView
      if (onNewNoteSaved) {
        onNewNoteSaved(savedNote); // INFORM BookView
      }

      setNewNoteContent(''); // Clear the input field
      // selectedBookText, selectedScrollPercentage, selectedGlobalCharOffset are props.
      // BookView should manage clearing its own state for these if desired after a note is saved.
      // For example, BookView's handleNewNoteSaved could call setSelectedBookText(null), etc.

    } catch (err) {
      logger.error('Failed to save note:', err); // Use logger
      setError(`Failed to save note: ${err.message || 'Unknown error'}`);
    }
  };

  const handleDeleteNote = async (noteIdToDelete) => {
    if (!window.confirm("Are you sure you want to delete this note?")) {
      return;
    }
    logger.info(`[NotePane - handleDeleteNote] Attempting to delete note ID: ${noteIdToDelete}`);
    try {
      const response = await fetch(`/api/notes/${noteIdToDelete}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Note not found (ID: ${noteIdToDelete}). It might have already been deleted.`);
        }
        const errorData = await response.json().catch(() => ({ detail: "Failed to delete note. Server error." }));
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }
      setNotes(prevNotes => {
        const updatedNotesList = prevNotes.filter(note => note._id !== noteIdToDelete);
        
        // Adjust current page if necessary
        if (updatedNotesList.length > 0) {
          const newTotalPages = Math.ceil(updatedNotesList.length / notesPerPage);
          if (currentNotesPage > newTotalPages) {
            setCurrentNotesPage(newTotalPages);
          } else if (currentNotesPage === 0 && newTotalPages > 0) { // Should ideally not happen
            setCurrentNotesPage(1);
          }
        } else { // No notes left
          setCurrentNotesPage(1);
        }
        return updatedNotesList;
      });
      logger.info(`Note with ID ${noteIdToDelete} deleted successfully from UI.`);
    } catch (err) {
      logger.error('Error deleting note:', err);
      alert(`Error deleting note: ${err.message}`);
      setError(`Error deleting note: ${err.message}`);
    }
  };

  const handleNoteClickInternal = (note) => {
      // ADD THIS LOG
      logger.debug("[NotePane - handleNoteClickInternal] Clicked note object:", JSON.stringify(note, null, 2)); // Use logger
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

  const handleNextNotesPage = () => {
    setCurrentNotesPage(prevPage => Math.min(prevPage + 1, totalNotePages));
  };

  const handlePreviousNotesPage = () => {
    setCurrentNotesPage(prevPage => Math.max(prevPage - 1, 1));
  };


  if (loading) {
    return <div className="note-pane">Loading notes...</div>; // Removed ref
  }

  if (error && notes.length === 0) { // Show error only if there are no notes to display
    return <div className="note-pane" style={{ color: 'red' }}>Error loading notes: {error}</div>; // Removed ref
  }

  // Calculate notes for the current page
  const indexOfLastNote = currentNotesPage * notesPerPage;
  const indexOfFirstNote = indexOfLastNote - notesPerPage;
  const currentNotesToDisplay = notes.slice(indexOfFirstNote, indexOfLastNote);
  const totalNotePages = Math.ceil(notes.length / notesPerPage);

  return (
    <div className="note-pane"> {/* Removed ref, root div of NotePane */}
      {isMobileContext && (
        <div className="note-pane-mobile-header">
          <h2>Notes &amp; LLM Insights</h2>
          <button onClick={onClosePane} className="close-pane-button" aria-label="Close notes panel">
            ✕ Close
          </button>
        </div>
      )}
      {!isMobileContext && <h2>Notes &amp; LLM Insights</h2>}

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

      {/* LLM Reading Assistance Section - MOVED HERE */}
      <div className="llm-interaction">
        <h3>LLM Reading Assistance</h3>
        <textarea
            value={llmQuestion}
            onChange={(e) => setLlmQuestion(e.target.value)}
            placeholder="Ask a question about the book content or the selected text above..."
            rows="3"
        />
        <button onClick={handleAskLLM} disabled={llmLoading || !bookId || !llmQuestion.trim()}>
            {llmLoading ? 'Asking...' : 'Ask LLM'}
        </button>
        {llmError && <p className="error-message">{llmError}</p>}
        {llmAskResponse && (
            <div className="llm-response">
                <h4>LLM Response:</h4>
                <p>{llmAskResponse}</p>
                <button 
                  onClick={handleAddLlmResponseToNote} 
                  className="button-add-to-note"
                  style={{ marginTop: '10px' }}
                >
                  Add to Current Note
                </button>
            </div>
        )}
      </div>

      {/* Add New Note Section - NOW AFTER LLM */}
      <div className="new-note-form">
        <h3>Add New Note</h3>
        <textarea
          value={newNoteContent}
          onChange={(e) => setNewNoteContent(e.target.value)}
          placeholder="Write your note here, referencing the selected text above if any..."
          rows="4"
        />
        <button onClick={handleSaveNote} disabled={!newNoteContent.trim()}>
          Save Note
        </button>
      </div>
      
      <div className="notes-list">
        <h3>Saved Notes</h3>
        {error && notes.length > 0 && <p className="error-message">Error loading notes: {error}. Displaying cached notes.</p>}
        {notes.length === 0 && !loading && <p>No notes yet. Add one above!</p>}
        {currentNotesToDisplay.map(note => (
          <div
              key={note._id} // USE _id FOR KEY
              className={`note-item ${(note.global_character_offset !== null && note.global_character_offset !== undefined) ? 'clickable-note' : ''}`}
              // onClick is removed from here, moved to note-content-clickable div
          >
            <div className="note-actions"> {/* Wrapper for note content and delete button */}
                <div className="note-content-clickable" onClick={() => handleNoteClickInternal(note)}>
                    {note.source_text && (
                        <blockquote className="note-source-text">
                            <em>Source: "{note.source_text}"</em>
                        </blockquote>
                    )}
                    <p className="note-content-display">{note.content}</p>
                    <small className="note-meta-display">{new Date(note.created_at).toLocaleString()}</small>
                </div>
                <button
                  onClick={() => handleDeleteNote(note._id)} // USE _id FOR DELETION
                  className="delete-button delete-note-button"
                  title="Delete this note"
                >
                  ✕
                </button>
            </div>
          </div>
        ))}
        {/* Notes Pagination Controls */}
        {notes.length > notesPerPage && (
          <div className="notes-pagination-controls">
            <button onClick={handlePreviousNotesPage} disabled={currentNotesPage === 1}>
              Previous
            </button>
            <span>
              Page {currentNotesPage} of {totalNotePages}
            </span>
            <button onClick={handleNextNotesPage} disabled={currentNotesPage === totalNotePages}>
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}; // Removed forwardRef closing

export default NotePane;
