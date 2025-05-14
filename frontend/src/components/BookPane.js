import React, { forwardRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw'; // Import rehype-raw

const BookPane = forwardRef(({ markdownContent, imageUrls, onTextSelect }, ref) => {
  const [fontSize, setFontSize] = useState(16); // Default font size in pixels

  const increaseFontSize = () => {
    setFontSize(prevSize => prevSize + 1);
  };

  const decreaseFontSize = () => {
    setFontSize(prevSize => Math.max(10, prevSize - 1)); // Prevent font size from becoming too small
  };

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

    // If the URI already starts with /images/, it's likely already processed
    // by the pdf-service/backend to be a web-accessible path.
    if (uri.startsWith('/images/')) {
      return uri;
    }

    // Fallback for other cases (e.g., relative paths if any slip through, or just filenames)
    // This handles cases where URI might be an absolute path from the PDF service's
    // perspective (e.g., "/pdf_service_storage/images/image.png") or just a filename
    // (e.g., "image.png").
    const filename = uri.substring(uri.lastIndexOf('/') + 1);

    // Prepend the public path for images served by Nginx.
    return `/images/${filename}`;
  };

  return (
    <div className="book-pane" ref={ref} onMouseUp={handleMouseUp}>
      <div className="font-controls" style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
        <button onClick={decreaseFontSize} style={{ marginRight: '5px' }}>A-</button>
        <span style={{ margin: '0 10px' }}>{fontSize}px</span>
        <button onClick={increaseFontSize} style={{ marginLeft: '5px' }}>A+</button>
        <h2 style={{ marginLeft: '20px', marginBottom: '0' }}>Book Content</h2>
      </div>
      <div style={{ fontSize: `${fontSize}px` }}> {/* Apply font size here */}
        {markdownContent ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]} 
          transformImageUri={transformUri} // USE THE UPDATED TRANSFORM FUNCTION
          children={markdownContent}
          components={{
            img: ({ node, ...props }) => {
              // props.src will now be correctly formatted by transformUri
              return <img {...props} style={{ maxWidth: '100%', height: 'auto' }} />;
            },
          }}
        />
        ) : (
          <p>No content loaded.</p>
        )}
      </div>
    </div>
  );
});

export default BookPane;
