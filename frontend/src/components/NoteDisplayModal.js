import React from 'react';
import './NoteDisplayModal.css';

const NoteDisplayModal = ({ note, onClose, onDelete }) => {
  if (!note) {
    return null;
  }

  const handleDelete = () => {
    if (onDelete) {
      // The confirmation is handled by the parent function for consistency
      onDelete(note._id || note.id);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content note-display-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Note</h2>
          <button onClick={onClose} className="close-button">✕</button>
        </div>
        <div className="modal-body">
          {note.source_text && note.source_text !== `Context: Page ${note.page_number}` && (
            <blockquote className="note-source-text">
              <em>Source: "{note.source_text}"</em>
            </blockquote>
          )}
          <p className="note-content-display">{note.content}</p>
          <small className="note-meta-display">
            On Page: {note.page_number} | {new Date(note.created_at).toLocaleString()}
          </small>
        </div>
        <div className="modal-footer">
          <button onClick={handleDelete} className="delete-button-modal">
            Delete Note
          </button>
        </div>
      </div>
    </div>
  );
};

export default NoteDisplayModal;
