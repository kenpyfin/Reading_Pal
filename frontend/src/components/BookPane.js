import React, { forwardRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw'; // Import rehype-raw

const BookPane = forwardRef(({ markdownContent, imageUrls, onTextSelect }, ref) => {
  const handleMouseUp = () => {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    if (onTextSelect) {
      onTextSelect(selectedText.length > 0 ? selectedText : null);
    }
  };

  return (
    <div className="book-pane" ref={ref} onMouseUp={handleMouseUp}>
      <h2>Book Content</h2>
      {markdownContent ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]} // ADD THIS PLUGIN to allow raw HTML (our span)
          children={markdownContent}
          components={{
            img: ({ node, ...props }) => {
              // The backend provides URLs like /images/{filename}
              // We can use them directly if the static route is set up
              return <img {...props} style={{ maxWidth: '100%', height: 'auto' }} />;
            },
          }}
        />
      ) : (
        <p>No content loaded.</p>
      )}
    </div>
  );
});

export default BookPane;
