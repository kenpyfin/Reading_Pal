import React, { forwardRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw'; // Import rehype-raw

const BookPane = forwardRef(({ markdownContent, imageUrls, onTextSelect }, ref) => {
  const [fontSize, setFontSize] = useState(16); // Default font size in pixels
  const FONT_SIZE_STEP = 1;
  const MIN_FONT_SIZE = 10;
  const MAX_FONT_SIZE = 32;

  const increaseFontSize = () => {
    setFontSize(prevSize => Math.min(prevSize + FONT_SIZE_STEP, MAX_FONT_SIZE));
  };

  const decreaseFontSize = () => {
    setFontSize(prevSize => Math.max(MIN_FONT_SIZE, prevSize - FONT_SIZE_STEP));
  };

  const handleMouseUp = () => {
    const selection = window.getSelection();
    const selectedText = selection.toString(); // Removed .trim()
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
    // Add position: 'relative' to allow absolute positioning of children
    <div className="book-pane" ref={ref} onMouseUp={handleMouseUp} style={{ position: 'relative', paddingTop: '40px' /* Add padding to prevent overlap */ }}>
      {/* Adjusted font controls styling and placement */}
      <div 
        className="font-controls" 
        style={{ 
          position: 'absolute', 
          top: '10px', 
          right: '10px', 
          display: 'flex', 
          alignItems: 'center',
          zIndex: 10 // Ensure it's above the markdown content
        }}
      >
        <button onClick={decreaseFontSize} style={{ marginRight: '5px' }}>A-</button>
        <span style={{ margin: '0 10px', fontSize: '14px' /* Slightly smaller display for the size itself */ }}>{fontSize}px</span>
        <button onClick={increaseFontSize} style={{ marginLeft: '5px' }}>A+</button>
        {/* Removed <h2>Book Content</h2> */}
      </div>
      {/* Apply font size to this div which wraps the markdown content */}
      <div style={{ fontSize: `${fontSize}px` }}> 
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
