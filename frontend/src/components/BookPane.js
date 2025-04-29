import React, { forwardRef } from 'react'; // Import forwardRef
import ReactMarkdown from 'react-markdown'; // Import react-markdown
import remarkGfm from 'remark-gfm'; // Import remark-gfm for GitHub Flavored Markdown

// Wrap the component with forwardRef
const BookPane = forwardRef(({ markdownContent, imageUrls, onTextSelect }, ref) => { // Accept onTextSelect prop and ref
  // Function to handle text selection
  const handleMouseUp = () => {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    // Call the parent component's handler with the selected text or null if selection is empty
    if (onTextSelect) { // Check if the prop is provided
      onTextSelect(selectedText.length > 0 ? selectedText : null);
    }
  };

  return (
    <div className="book-pane" ref={ref} onMouseUp={handleMouseUp}> {/* Attach ref and onMouseUp listener */}
      <h2>Book Content</h2>
      {markdownContent ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]} // Enable GitHub Flavored Markdown
          children={markdownContent}
          components={{
            // Custom renderer for images to ensure correct src paths
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

// Export the component wrapped with forwardRef
export default BookPane;
