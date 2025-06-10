import React, { forwardRef, useState, useCallback } from 'react'; // Added useCallback
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw'; // Import rehype-raw
import remarkMath from 'remark-math'; // Import remark-math
import rehypeKatex from 'rehype-katex'; // Import rehype-katex
import 'katex/dist/katex.min.css'; // Import KaTeX CSS

const BookPane = forwardRef(({ markdownContent, imageUrls, onTextSelect }, ref) => {
  const [fontSize, setFontSize] = useState(16); // Default font size in pixels
  const FONT_SIZE_STEP = 1;
  const MIN_FONT_SIZE = 10;
  const MAX_FONT_SIZE = 32;

  // --- NEW: State and constants for Line Height ---
  const [lineHeight, setLineHeight] = useState(1.6); // Default line height (unitless multiplier)
  const LINE_HEIGHT_STEP = 0.1;
  const MIN_LINE_HEIGHT = 1.2;
  const MAX_LINE_HEIGHT = 2.5;
  // --- END NEW ---

  const increaseFontSize = () => {
    setFontSize(prevSize => Math.min(prevSize + FONT_SIZE_STEP, MAX_FONT_SIZE));
  };

  const decreaseFontSize = () => {
    setFontSize(prevSize => Math.max(MIN_FONT_SIZE, prevSize - FONT_SIZE_STEP));
  };

  // --- NEW: Functions to adjust line height ---
  const increaseLineHeight = () => {
    setLineHeight(prevHeight => parseFloat(Math.min(prevHeight + LINE_HEIGHT_STEP, MAX_LINE_HEIGHT).toFixed(2)));
  };

  const decreaseLineHeight = () => {
    setLineHeight(prevHeight => parseFloat(Math.max(MIN_LINE_HEIGHT, prevHeight - LINE_HEIGHT_STEP).toFixed(2)));
  };
  // --- END NEW ---

  const processSelection = useCallback(() => {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0) {
      if (onTextSelect) {
        onTextSelect(null); // Pass null for no selection object
      }
      return;
    }
    
    if (selection.isCollapsed) {
      if (onTextSelect) {
        onTextSelect(null); // Pass null for no selection object
      }
      return;
    }

    const originalRange = selection.getRangeAt(0).cloneRange();

    selection.collapse(originalRange.startContainer, originalRange.startOffset);
    selection.modify('move', 'backward', 'word');
    selection.modify('extend', 'forward', 'word');
    const startWordRange = selection.getRangeAt(0).cloneRange();

    selection.collapse(originalRange.endContainer, originalRange.endOffset);
    selection.modify('move', 'backward', 'word');
    selection.modify('extend', 'forward', 'word');
    const endWordRange = selection.getRangeAt(0).cloneRange();

    const finalSnapRange = document.createRange();
    finalSnapRange.setStart(startWordRange.startContainer, startWordRange.startOffset);
    finalSnapRange.setEnd(endWordRange.endContainer, endWordRange.endOffset);

    selection.removeAllRanges();
    selection.addRange(finalSnapRange);

    const selectedText = selection.toString();

    if (onTextSelect) {
      if (selectedText.length > 0) {
        // Get the current range of the (snapped) selection
        const currentRange = selection.getRangeAt(0);
        const selectionData = {
          text: selectedText,
          rangeDetails: {
            startContainer: currentRange.startContainer,
            startOffset: currentRange.startOffset,
            endContainer: currentRange.endContainer,
            endOffset: currentRange.endOffset,
          },
        };
        onTextSelect(selectionData);
      } else {
        onTextSelect(null); // Pass null if snapped selection is empty
      }
    }
  }, [onTextSelect]); // Added onTextSelect to useCallback dependencies

  const handleMouseUp = () => {
    processSelection();
  };

  const handleTouchEnd = () => {
    // It's common for touch events to sometimes trigger mouse events.
    // processSelection itself is idempotent regarding multiple calls if selection is same.
    // Consider adding a small delay or a flag if double processing becomes an issue,
    // but for now, direct call is simplest.
    processSelection();
  };

  // Function to transform image URIs from Markdown into accessible paths
  const transformUri = (uri) => {
    if (!uri) return uri;

    // Check for absolute URLs (http, https, data URIs) - these should be used as-is.
    if (/^(https?:|data:)/i.test(uri)) {
      return uri;
    }

    // If the URI already starts with /images/, it's correctly formatted.
    if (uri.startsWith('/images/')) {
      return uri;
    }

    // If the URI starts with a single slash (but not '/images/'),
    // it implies an absolute path on the server. Prepend /images to make it web-accessible
    // relative to the /images route, preserving the rest of the path.
    // e.g., "/some_folder/image.png" becomes "/images/some_folder/image.png"
    if (uri.startsWith('/')) {
      return `/images${uri}`;
    }

    // For relative paths (e.g., "image.png" or "subdir/image.png")
    // Prepend /images/ to make it relative to the /images route.
    return `/images/${uri}`;
  };

  return (
    // Add position: 'relative' to allow absolute positioning of children
    <div 
      className="book-pane" 
      ref={ref} 
      onMouseUp={handleMouseUp} 
      onTouchEnd={handleTouchEnd} // ADDED onTouchEnd
      style={{ position: 'relative', paddingTop: '40px' /* Add padding to prevent overlap */ }}
    >
      {/* Adjusted font controls styling and placement */}
      <div 
        className="font-controls" 
        style={{ 
          position: 'absolute', 
          top: '10px', 
          right: '10px', 
          display: 'flex', 
          alignItems: 'center',
          zIndex: 10,
          backgroundColor: 'rgba(255, 255, 255, 0.8)', // Optional: slight background for better visibility
          padding: '3px 5px',                         // Optional: padding for the control box
          borderRadius: '4px'                         // Optional: rounded corners
        }}
      >
        {/* Font Size Controls */}
        <button onClick={decreaseFontSize} className="font-control-btn" title="Decrease font size">A-</button>
        <span style={{ margin: '0 8px', fontSize: '13px', minWidth: '40px', textAlign: 'center' }}>{fontSize}px</span>
        <button onClick={increaseFontSize} className="font-control-btn" title="Increase font size">A+</button>

        {/* --- NEW: Line Height Controls --- */}
        <span style={{ borderLeft: '1px solid #ccc', height: '20px', margin: '0 10px' }}></span> {/* Separator */}
        
        <button onClick={decreaseLineHeight} className="font-control-btn" title="Decrease line spacing">LH-</button>
        <span style={{ margin: '0 8px', fontSize: '13px', minWidth: '35px', textAlign: 'center' }}>{lineHeight.toFixed(1)}</span>
        <button onClick={increaseLineHeight} className="font-control-btn" title="Increase line spacing">LH+</button>
        {/* --- END NEW --- */}
      </div>
      
      {/* Apply font size AND line height to this div which wraps the markdown content */}
      <div style={{ fontSize: `${fontSize}px`, lineHeight: lineHeight /* Apply unitless line height */ }}> 
        {markdownContent ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]} // Add remarkMath
            rehypePlugins={[rehypeRaw, rehypeKatex]} // Add rehypeKatex
            transformImageUri={transformUri} // USE THE UPDATED TRANSFORM FUNCTION
            children={markdownContent}
            components={{
            img: ({ node, ...props }) => {
              // props.src will now be correctly formatted by transformUri
              return <img {...props} style={{ maxWidth: '100%', height: 'auto' }} />;
            },
            table: ({ node, ...props }) => {
              // Apply styles to prevent tables from being cut off across page breaks
              return <table {...props} style={{ breakInside: 'avoid-page', pageBreakInside: 'avoid' }} />;
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
