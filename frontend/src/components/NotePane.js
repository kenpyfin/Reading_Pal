import React, { useState, useEffect } from 'react';
// TODO: Import API functions for notes and LLM

function NotePane({ bookId, onScrollSync }) {
  const [notes, setNotes] = useState([]);
  const [newNoteContent, setNewNoteContent] = useState('');
  // TODO: State for LLM interaction results

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

  // TODO: Implement scroll tracking for synchronization
  // const handleScroll = (e) => {
  //   onScrollSync(e.target.scrollTop);
  // };

  // TODO: Implement LLM interaction functions (e.g., handleSummarize, handleAsk)

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

      {/* TODO: Add area for LLM interactions */}
      {/* <div className="llm-interaction">
        <button onClick={handleSummarize}>Summarize Selected Text</button>
        <input placeholder="Ask a question..." />
        <button onClick={handleAsk}>Ask LLM</button>
        <div className="llm-response">...</div>
      </div> */}
    </div>
  );
}

export default NotePane;
