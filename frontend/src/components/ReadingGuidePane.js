import React from 'react';
import './ReadingGuidePane.css'; // We'll create this CSS file later
import logger from '../utils/logger';

const ReadingGuidePane = ({
  guideContent,
  onItemClick,
  isLoading,
  error,
  onClose, // For mobile view to close the pane
  isVisible, // To control main visibility for animations or specific styling
}) => {
  if (!isVisible) {
    return null;
  }

  const handleItemClick = (pageNumber) => {
    logger.debug(`[ReadingGuidePane] Clicked item for page: ${pageNumber}`);
    if (onItemClick) {
      onItemClick(pageNumber);
    }
  };

  return (
    <div className={`reading-guide-pane ${isVisible ? 'visible' : ''}`}>
      <div className="reading-guide-header">
        <h3>Reading Guide</h3>
        {onClose && ( // Show close button only if onClose prop is provided (typically for mobile)
          <button onClick={onClose} className="close-guide-pane-btn" aria-label="Close Reading Guide">
            &times;
          </button>
        )}
      </div>
      <div className="reading-guide-content">
        {isLoading && <p>Loading guide...</p>}
        {error && <p className="error-message">Error: {error}</p>}
        {!isLoading && !error && (!guideContent || guideContent.length === 0) && (
          <p>No guide content available. Try generating it if you haven't.</p>
        )}
        {!isLoading && !error && guideContent && guideContent.length > 0 && (
          <ul>
            {guideContent.map((item, index) => (
              <li key={index} className="guide-item">
                <button
                  onClick={() => handleItemClick(item.estimated_page)}
                  className="guide-item-button"
                  aria-label={`Go to page ${item.estimated_page}, section: ${item.title}`}
                >
                  <strong className="guide-item-title">{item.title}</strong>
                  <span className="guide-item-page">(Page ~{item.estimated_page})</span>
                </button>
                <p className="guide-item-summary">{item.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default ReadingGuidePane;
