import React, { useState } from 'react';
import './AllNotesModal.css';

const AllNotesModal = ({ notes, onClose, onNoteClick, onDeleteNote }) => {
  const [currentNotesPage, setCurrentNotesPage] = useState(1);
  const notesPerPage = 5;

  if (!notes) {
    return null;
  }

  const handleNoteClickInternal = (note) => {
    if (onNoteClick) {
      if (note.global_character_offset !== null && note.global_character_offset !== undefined) {
        onNoteClick(note.global_character_offset);
      } else if (note.page_number !== null && note.page_number !== undefined) {
        onNoteClick({ pageNumber: note.page_number });
      }
    }
    onClose();
  };

  const handleDeleteClick = (noteId) => {
    if (onDeleteNote) {
      onDeleteNote(noteId);
    }
  };

  const indexOfLastNote = currentNotesPage * notesPerPage;
  const indexOfFirstNote = indexOfLastNote - notesPerPage;
  const currentNotesToDisplay = notes.slice(indexOfFirstNote, indexOfLastNote);
  const totalNotePages = Math.ceil(notes.length / notesPerPage);

  const handleNextNotesPage = () => {
    setCurrentNotesPage(prevPage => Math.min(prevPage + 1, totalNotePages));
  };

  const handlePreviousNotesPage = () => {
    setCurrentNotesPage(prevPage => Math.max(prevPage - 1, 1));
  };


  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content all-notes-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>All Saved Notes</h2>
          <button onClick={onClose} className="close-button">✕</button>
        </div>
        <div className="modal-body">
          {notes.length === 0 ? (
            <p>No notes have been saved for this book yet.</p>
          ) : (
            <>
              <div className="notes-list-modal">
                {currentNotesToDisplay.map(note => (
                  <div key={note._id || note.id} className="note-item-modal">
                     <div className="note-actions">
                        <div className="note-content-clickable" onClick={() => handleNoteClickInternal(note)} title="Click to jump to this note's location">
                             {note.page_number && (
                                <p className="note-page-context-indicator">
                                    <em>From Page: {note.page_number}</em>
                                </p>
                            )}
                            {note.source_text && note.source_text !== `Context: Page ${note.page_number}` && (
                                <blockquote className="note-source-text">
                                    <em>Source: "{note.source_text}"</em>
                                </blockquote>
                            )}
                            <p className="note-content-display">{note.content}</p>
                            <small className="note-meta-display">{new Date(note.created_at).toLocaleString()}</small>
                        </div>
                        <button onClick={() => handleDeleteClick(note._id || note.id)} className="delete-button delete-note-button" title="Delete this note">
                            ✕
                        </button>
                    </div>
                  </div>
                ))}
              </div>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AllNotesModal;
