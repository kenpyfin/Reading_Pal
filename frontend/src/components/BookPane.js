import React, { forwardRef, useState, useCallback } from 'react'; // Added useCallback
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw'; // Import rehype-raw
import remarkMath from 'remark-math'; // Import remark-math
import rehypeKatex from 'rehype-katex'; // Import rehype-katex
import 'katex/dist/katex.min.css'; // Import KaTeX CSS

const BookPane = forwardRef(({ markdownContent, imageUrls, onTextSelect, onHighlightClick, fontSize = 16, lineHeight = 1.6 }, ref) => {

  const handlePaneClick = useCallback((event) => {
    let target = event.target;
    while (target && target !== event.currentTarget) {
      if (target.classList.contains('note-highlight') && target.dataset.noteId) {
        if (onHighlightClick) {
          onHighlightClick(target.dataset.noteId);
        }
        return;
      }
      target = target.parentElement;
    }
  }, [onHighlightClick]);

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

    let transformedUri = uri;

    // If the URI already starts with /images/, it's correctly formatted.
    if (uri.startsWith('/images/')) {
      transformedUri = uri;
    }
    // Check if this is an absolute filesystem path that contains /images/app/ or /images/public/
    // Extract just the /images/... portion
    else if (uri.includes('/images/app/')) {
      const imagesAppIndex = uri.indexOf('/images/app/');
      transformedUri = uri.substring(imagesAppIndex);
    }
    else if (uri.includes('/images/public/')) {
      const imagesPublicIndex = uri.indexOf('/images/public/');
      transformedUri = uri.substring(imagesPublicIndex);
    }
    // If the URI starts with a single slash (but not '/images/'),
    // it implies an absolute path on the server. Prepend /images to make it web-accessible
    // relative to the /images route, preserving the rest of the path.
    // e.g., "/some_folder/image.png" becomes "/images/some_folder/image.png"
    else if (uri.startsWith('/')) {
      transformedUri = `/images${uri}`;
    }
    // For relative paths (e.g., "image.png" or "subdir/image.png")
    // Prepend /images/ to make it relative to the /images route.
    else {
      transformedUri = `/images/${uri}`;
    }

    // For app images, transform to API endpoint
    // Note: The backend now generates signed URLs, so we just need to transform the path
    // If the URL already has query parameters (signed URL), preserve them
    if (transformedUri.startsWith('/images/app/')) {
      // Transform to API endpoint
      transformedUri = transformedUri.replace('/images/app/', '/api/books/images/app/');
    }

    return transformedUri;
  };

  return (
    // Add position: 'relative' to allow absolute positioning of children
    <div
      className="book-pane"
      ref={ref}
      onMouseUp={handleMouseUp}
      onTouchEnd={handleTouchEnd}
      onClick={handlePaneClick}
      style={{ position: 'relative' }}
    >
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
              // Transform app image URLs to use API endpoint
              // (This handles HTML img tags that bypass transformImageUri)
              // Note: Backend now generates signed URLs, so we just transform the path
              let src = props.src || '';
              if (src.startsWith('/images/app/')) {
                // Transform to API endpoint (preserve any query parameters from signed URL)
                src = src.replace('/images/app/', '/api/books/images/app/');
              }
              return <img {...props} src={src} alt={props.alt || ''} style={{ maxWidth: '100%', height: 'auto' }} />;
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
