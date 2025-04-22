import React from 'react';
import ReactMarkdown from 'react-markdown'; // Import react-markdown
import remarkGfm from 'remark-gfm'; // Import remark-gfm for GitHub Flavored Markdown

function BookPane({ markdownContent, imageUrls }) {
  // TODO: Implement scroll tracking for synchronization

  return (
    <div className="book-pane">
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
}

export default BookPane;
