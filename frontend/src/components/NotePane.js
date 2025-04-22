import React, { useState, useEffect } from 'react';
// TODO: Import API functions for notes
// Assuming backend/api/notes.py and backend/db/mongodb.py have been updated for notes

function NotePane({ bookId, bookContent, onScrollSync }) { // Receive bookContent
  const [notes, setNotes] = useState([]);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [llmQuestion, setLlmQuestion] = useState(''); // State for LLM question input
  const [llmAskResponse, setLlmAskResponse] = useState(''); // State for LLM 'ask' response
  const [llmSummarizeResponse, setLlmSummarizeResponse] = useState(''); // State for LLM 'summarize' response
  const [llmLoading, setLlmLoading] = useState(false); // State for LLM loading
  const [llmError, setLlmError] = useState(null); // State for LLM error

  useEffect(() => {
    // TODO: Fetch notes for bookId on mount
    // fetchNotes(bookId).then(setNotes);
  }, [bookId]);

  const handleSaveNote = async () => {
    if (!newNoteContent.trim()) return;
    // TODO: Call API to save new note
    // const savedNote = await saveNote({ bookId, content: newNoteContent, ...positionInfo });
    // setNotes([...notes, savedNote]);
    setNewNoteContent('');
  };

  const handleAskLLM = async () => {
    if (!llmQuestion.trim()) {
      setLlmError("Please enter a question.");
      return;
    }
    if (!bookContent) {
        setLlmError("Book content not available to ask questions about.");
        return;
    }

    setLlmLoading(true);
    setLlmError(null);
    setLlmAskResponse(''); // Clear previous ask response

    try {
      // Call backend API for LLM question
      const response = await fetch('/llm/ask', { // Use relative path
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          book_id: bookId,
          text: llmQuestion, // The question itself
          // For 'ask', the backend fetches the full book content as context
          // We don't need to send the full content from the frontend here.
          // context: bookContent // Potentially send a chunk if needed, but backend fetches full
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'LLM ask request failed');
      }

      const data = await response.json();
      setLlmAskResponse(data.response);

    } catch (err) {
      console.error('LLM ask request failed:', err);
      setLlmError(`LLM ask request failed: ${err.message || 'Unknown error'}`);
    } finally {
      setLlmLoading(false);
    }
  };

  const handleSummarizeBook = async () => {
    if (!bookContent) {
        setLlmError("Book content not available to summarize.");
        return;
    }

    setLlmLoading(true);
    setLlmError(null);
    setLlmSummarizeResponse(''); // Clear previous summarize response

    try {
      // Call backend API for LLM summarization (of the whole book for now)
      const response = await fetch('/llm/summarize', { // Use relative path
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          book_id: bookId,
          text: bookContent, // Sending the full content to summarize
          // context is optional for summarize, backend might ignore it or use it
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'LLM summarize request failed');
      }

      const data = await response.json();
      setLlmSummarizeResponse(data.response);

    } catch (err) {
      console.error('LLM summarize request failed:', err);
      setLlmError(`LLM summarize request failed: ${err.message || 'Unknown error'}`);
    } finally {
      setLlmLoading(false);
    }
  };


  // TODO: Implement scroll tracking for synchronization
  // const handleScroll = (e) => {
  //   onScrollSync(e.target.scrollTop);
  // };

  return (
    <div className="note-pane">
      <h2>Notes & Insights</h2>
      {/* TODO: Display existing notes */}
      <div className="notes-list">
        {notes.map(note => (
          <div key={note.id} className="note-item">
            <p>{note.content}</p>
            {/* TODO: Add edit/delete buttons */}
          </div>
        ))}
      </div>

      {/* TODO: Add area for new notes */}
      <textarea
        value={newNoteContent}
        onChange={(e) => setNewNoteContent(e.target.value)}
        placeholder="Write a new note..."
      />
      <button onClick={handleSaveNote}>Save Note</button>

      {/* Add area for LLM interactions */}
      <div className="llm-interaction">
        <h3>LLM Reading Assistance</h3>

        {/* Summarize Button (summarizes whole book for now) */}
        <button onClick={handleSummarizeBook} disabled={llmLoading || !bookContent} style={{ marginBottom: '15px' }}>
             {llmLoading ? 'Summarizing...' : 'Summarize Book'}
        </button>
        {llmSummarizeResponse && (
            <div className="llm-response" style={{ marginTop: '10px', borderTop: '1px solid #eee', paddingTop: '10px' }}>
                <h4>Summary:</h4>
                <p>{llmSummarizeResponse}</p>
            </div>
        )}


        {/* Ask Question Area */}
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
    </div>
  );
}

export default NotePane;
