import React from 'react';
// TODO: Import markdown rendering library (e.g., react-markdown)

function BookPane({ markdownContent, images }) {
  // TODO: Implement markdown rendering
  // TODO: Handle image URLs (e.g., prepend backend URL)
  // TODO: Implement scroll tracking for synchronization

  return (
    <div className="book-pane">
      <h2>Book Content</h2>
      {/* TODO: Render markdown */}
      <div dangerouslySetInnerHTML={{ __html: markdownContent || "<p>No content loaded.</p>" }} />
      {/* Note: dangerouslySetInnerHTML is used here as a simple placeholder.
           A proper markdown renderer like react-markdown is recommended. */}
      {/* TODO: Display images */}
      {/* {images.map(img => <img key={img.filename} src={`/images/${img.filename}`} alt={img.filename} />)} */}
    </div>
  );
}

export default BookPane;
