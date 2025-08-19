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
  currentPage, // ADDED: Current page number from BookView
  currentPageContent, // ADDED: Raw markdown content of the current page from BookView
  onNewNoteSaved, // ACCEPT THE NEW PROP
  isMobileContext, // New prop for mobile overlay context
  onClosePane // New prop to handle closing the pane in mobile overlay
}) => {
  const [newNoteContent, setNewNoteContent] = useState('');
  const [isPageNoteMode, setIsPageNoteMode] = useState(true);
  const [error, setError] = useState(null);

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

  useEffect(() => {
    if (selectedBookText) {
      setIsPageNoteMode(false);
    } else {
      setIsPageNoteMode(true);
    }
  }, [selectedBookText]);

  const handleSaveNote = async () => {
    if (!newNoteContent.trim()) return;

    let noteData = {
      book_id: bookId,
      content: newNoteContent.trim(),
      page_number: currentPage, // Always include the current page number
    };

    if (isPageNoteMode) {
      // For page-specific notes, we don't link to a specific text selection
      noteData.source_text = `Context: Page ${currentPage}`;
      noteData.scroll_percentage = undefined;
      noteData.global_character_offset = undefined;
    } else {
      // For selection-based notes, include the selection details
      noteData.source_text = selectedBookText || undefined;
      noteData.scroll_percentage = selectedScrollPercentage !== null && selectedScrollPercentage !== undefined ? parseFloat(selectedScrollPercentage.toFixed(4)) : undefined;
      noteData.global_character_offset = selectedGlobalCharOffset;
    }

    logger.debug("[NotePane - handleSaveNote] Sending noteData to backend:", noteData); // Use logger


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
      
      if (onNewNoteSaved) {
        onNewNoteSaved(savedNote);
      }

      setNewNoteContent('');

    } catch (err) {
      logger.error('Failed to save note:', err);
      setError(`Failed to save note: ${err.message || 'Unknown error'}`);
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
          context: isPageNoteMode ? (currentPageContent || null) : (selectedBookText || null),
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

  return (
    <div className="note-pane">
      {isMobileContext && (
        <div className="note-pane-mobile-header">
          <h2>Notes &amp; LLM Insights</h2>
          <button onClick={onClosePane} className="close-pane-button" aria-label="Close notes panel">
            ✕ Close
          </button>
        </div>
      )}
      {!isMobileContext && <h2>Notes &amp; LLM Insights</h2>}

      {/* ADDED: Dedicated area for displaying selected text or page context */}
      <div className="note-context-selection">
        <label htmlFor="page-note-mode-toggle">
          <input
            type="checkbox"
            id="page-note-mode-toggle"
            checked={isPageNoteMode}
            onChange={(e) => setIsPageNoteMode(e.target.checked)}
          />
          Note for current page (Page {currentPage || 'N/A'})
        </label>
      </div>

      {isPageNoteMode ? (
        <div className="selected-text-display page-context-display">
          <h4>Context:</h4>
          <p>Current Page: {currentPage || 'N/A'}</p>
          {/* Optionally, you could show a snippet of currentPageContent here, but the request was to show page number */}
        </div>
      ) : (
        selectedBookText && (
          <div
            className="selected-text-display clickable-selection"
            title="Click to jump to this location in the book"
          >
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
        )
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
        {error && <p className="error-message">{error}</p>}
      </div>
    </div>
  );
}; // Removed forwardRef closing

export default NotePane;
