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

  // Function to transform image URIs from Markdown into accessible paths
  const transformUri = (uri) => {
    if (!uri) return uri; // Return original if URI is empty or null

    // Extract the filename from the URI.
    // This handles cases where URI might be an absolute path from the PDF service's
    // perspective (e.g., "/pdf_service_storage/images/image.png") or just a filename
    // (e.g., "image.png").
    const filename = uri.substring(uri.lastIndexOf('/') + 1);

    // Prepend the public path for images served by Nginx.
    // This assumes Nginx is configured to serve images from a specific directory
    // (e.g., the mounted IMAGES_PATH) under the "/images/" route.
    return `/images/${filename}`;
  };

  return (
    <div className="book-pane" ref={ref} onMouseUp={handleMouseUp}>
      <h2>Book Content</h2>
      {markdownContent ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]} // ADD THIS PLUGIN to allow raw HTML (our span)
          transformImageUri={transformUri} // USE THE TRANSFORM FUNCTION HERE
          children={markdownContent}
          components={{
            img: ({ node, ...props }) => {
              // After transformImageUri, props.src will be the correct public URL
              // (e.g., /images/filename.png)
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
