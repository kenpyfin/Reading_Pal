import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css'; // Import KaTeX CSS
import './ReadingGuidePane.css';
import logger from '../utils/logger';

const MIN_STRUCTURE_HEIGHT = 50; // Minimum height for the structure section in pixels
const DEFAULT_STRUCTURE_HEIGHT = 150; // Default height

const ReadingGuidePane = ({
  guideContent, // This will now be a string (the guide for the current page) or null
  onGenerateGuide, // New prop: function to call when "Generate" is clicked
  isLoading, // Loading state for fetching or generating guide
  error, // Error message if fetching/generating fails
  onClose,
  isVisible,
  hasGuideForCurrentPage, // New prop: boolean to indicate if a guide exists for the current page
  isGenerating, // New prop: boolean to indicate if generation is in progress (for button text/state)
  documentStructure, // New prop: array of {text, level, offset}
  onStructureItemClick, // New prop: function to handle structure item click
}) => {
  const [structureSectionHeight, setStructureSectionHeight] = useState(DEFAULT_STRUCTURE_HEIGHT);
  const readingGuidePaneRef = useRef(null);
  const isResizingStructureRef = useRef(false);
  const dragStartYRef = useRef(0);
  const initialStructureHeightRef = useRef(0);

  const handleMouseDownOnStructureResizer = useCallback((e) => {
    e.preventDefault();
    isResizingStructureRef.current = true;
    dragStartYRef.current = e.clientY;
    initialStructureHeightRef.current = structureSectionHeight;
    document.body.classList.add('resizing-no-select-vertical'); // Optional: for cursor styling

    const handleMouseMove = (event) => {
      if (!isResizingStructureRef.current || !readingGuidePaneRef.current) return;
      const deltaY = event.clientY - dragStartYRef.current;
      let newHeight = initialStructureHeightRef.current + deltaY;

      const paneTotalHeight = readingGuidePaneRef.current.offsetHeight;
      const maxStructureHeight = paneTotalHeight * 0.5; // 50% of total pane height

      const effectiveMaxHeight = Math.max(MIN_STRUCTURE_HEIGHT, maxStructureHeight);

      newHeight = Math.max(MIN_STRUCTURE_HEIGHT, Math.min(newHeight, effectiveMaxHeight));
      setStructureSectionHeight(newHeight);
    };

    const handleMouseUp = () => {
      isResizingStructureRef.current = false;
      document.body.classList.remove('resizing-no-select-vertical');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [structureSectionHeight]);

  useEffect(() => {
    const currentPaneRef = readingGuidePaneRef.current;
    if (!currentPaneRef) return;

    const observer = new ResizeObserver(entries => {
      for (let entry of entries) {
        const paneTotalHeight = entry.contentRect.height;
        const maxStructureHeight = paneTotalHeight * 0.5;
        if (structureSectionHeight > maxStructureHeight) {
          setStructureSectionHeight(Math.max(MIN_STRUCTURE_HEIGHT, maxStructureHeight));
        }
      }
    });

    observer.observe(currentPaneRef);
    return () => {
      if (currentPaneRef) { // Check if ref still exists on cleanup
        observer.unobserve(currentPaneRef);
      }
    };
  }, [structureSectionHeight]);


  if (!isVisible) {
    return null;
  }

  const handleGenerateClick = () => {
    logger.debug('[ReadingGuidePane] Generate/Regenerate button clicked.');
    if (onGenerateGuide) {
      onGenerateGuide();
    }
  };

  return (
    <div className={`reading-guide-pane ${isVisible ? 'visible' : ''}`} ref={readingGuidePaneRef}>
      <div className="reading-guide-header">
        <h3>Reading Guide (Current Page)</h3>
        {onClose && (
          <button onClick={onClose} className="close-guide-pane-btn" aria-label="Close Reading Guide">
            &times;
          </button>
        )}
      </div>

      {/* Document Structure Section */}
      {documentStructure && documentStructure.length > 0 && (
        <div 
          className="document-structure-section"
          style={{ height: `${structureSectionHeight}px` }} // Apply height, overflowY: 'auto' is not present
        >
          <h4>Document Structure</h4>
          <ul className="document-structure-list">
            {documentStructure.map((item, index) => (
              <li
                key={index}
                className={`structure-item level-${item.level}`}
                style={{ paddingLeft: `${(item.level - 1) * 15}px` }} // Indent based on level
                onClick={() => onStructureItemClick && onStructureItemClick(item.offset)}
                role="button"
                tabIndex={0} // Make it focusable
                onKeyPress={(e) => { if (e.key === 'Enter' || e.key === ' ') onStructureItemClick && onStructureItemClick(item.offset);}} // Keyboard accessible
                title={`Go to: ${item.text}`} // Add title for better UX
              >
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      
      {documentStructure && documentStructure.length > 0 && (
        <div 
          className="structure-resizer-handle"
          onMouseDown={handleMouseDownOnStructureResizer}
          title="Resize document structure area"
        ></div>
      )}

      <div className="reading-guide-actions">
        <button
          onClick={handleGenerateClick}
          disabled={isLoading || isGenerating}
          className="generate-guide-btn"
        >
          {isGenerating ? 'Generating...' : (hasGuideForCurrentPage ? 'Regenerate Guide' : 'Generate Guide')}
        </button>
      </div>
      <div className="reading-guide-content">
        {isLoading && <p>Loading guide...</p>}
        {error && <p className="error-message">Error: {error}</p>}
        {!isLoading && !error && !guideContent && !hasGuideForCurrentPage && (
          <p>No guide available for this page. Click "Generate Guide" to create one.</p>
        )}
        {!isLoading && !error && !guideContent && hasGuideForCurrentPage && (
          // This case might occur if a guide exists but content is empty string
          <p>Guide for this page is empty or not yet loaded. Try regenerating.</p>
        )}
        {!isLoading && !error && guideContent && (
          <div className="guide-text-content">
            <ReactMarkdown
              children={guideContent}
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeRaw, rehypeKatex]}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default ReadingGuidePane;
