import React from 'react';
import './ReadingGuidePane.css';
import logger from '../utils/logger';

const ReadingGuidePane = ({
  guideContent, // This will now be a string (the guide for the current page) or null
  onGenerateGuide, // New prop: function to call when "Generate" is clicked
  isLoading, // Loading state for fetching or generating guide
  error, // Error message if fetching/generating fails
  onClose,
  isVisible,
  hasGuideForCurrentPage, // New prop: boolean to indicate if a guide exists for the current page
  isGenerating, // New prop: boolean to indicate if generation is in progress (for button text/state)
}) => {
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
    <div className={`reading-guide-pane ${isVisible ? 'visible' : ''}`}>
      <div className="reading-guide-header">
        <h3>Reading Guide (Current Page)</h3>
        {onClose && (
          <button onClick={onClose} className="close-guide-pane-btn" aria-label="Close Reading Guide">
            &times;
          </button>
        )}
      </div>
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
          // Display the guide content as pre-formatted text or render markdown if it's complex
          <div className="guide-text-content" style={{ whiteSpace: 'pre-wrap' }}>
            {guideContent}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReadingGuidePane;
