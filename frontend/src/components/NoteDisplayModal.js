import React from 'react';
import ReaderDialog from './ReaderDialog';
import './NoteDisplayModal.css';

const NoteDisplayModal = ({ note, onClose, onDelete }) => {
  if (!note) {
    return null;
  }

  const handleDelete = () => {
    if (onDelete) {
      onDelete(note._id || note.id);
    }
  };

  return (
    <ReaderDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Note"
      size="content"
      className="note-display-modal"
    >
      {note.source_text && note.source_text !== `Context: Page ${note.page_number}` && (
        <blockquote className="note-source-text">
          <em>Source: "{note.source_text}"</em>
        </blockquote>
      )}
      <p className="note-content-display">{note.content}</p>
      <small className="note-meta-display">
        On Page: {note.page_number} | {new Date(note.created_at).toLocaleString()}
      </small>
      <div className="modal-footer">
        <button onClick={handleDelete} className="delete-button-modal">
          Delete Note
        </button>
      </div>
    </ReaderDialog>
  );
};

export default NoteDisplayModal;
