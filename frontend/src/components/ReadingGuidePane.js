import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css'; // Import KaTeX CSS
import './ReadingGuidePane.css';
import logger from '../utils/logger';

// Component to handle authenticated image loading for app images
const AuthenticatedImage = ({ src, style, alt }) => {
  const [imageUrl, setImageUrl] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const loadImage = async () => {
      try {
        const token = localStorage.getItem('authToken');
        if (!token) {
          console.warn('[AuthenticatedImage] No authToken found');
          setError(true);
          return;
        }

        // Fetch image with Authorization header
        const response = await fetch(src, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (!response.ok) {
          console.error(`[AuthenticatedImage] Failed to load image: ${response.status}`);
          setError(true);
          return;
        }

        // Convert response to blob URL
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setImageUrl(url);

        // Cleanup function
        return () => {
          URL.revokeObjectURL(url);
        };
      } catch (err) {
        console.error('[AuthenticatedImage] Error loading image:', err);
        setError(true);
      }
    };

    loadImage();
  }, [src]);

  if (error) {
    return <div style={style}>Failed to load image</div>;
  }

  if (!imageUrl) {
    return <div style={style}>Loading image...</div>;
  }

  return <img src={imageUrl} alt={alt} style={style} />;
};

const MIN_STRUCTURE_HEIGHT = 50; // Minimum height for the structure section in pixels
const DEFAULT_STRUCTURE_HEIGHT = 150; // Default height

// Simple tooltip component for link previews
const LinkPreviewTooltip = ({ textLink, children }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const linkRef = useRef(null);

  const handleMouseEnter = (e) => {
    if (textLink && textLink.preview_text) {
      const rect = e.currentTarget.getBoundingClientRect();
      setTooltipPosition({
        x: rect.left + rect.width / 2,
        y: rect.top - 10
      });
      setShowTooltip(true);
    }
  };

  const handleMouseLeave = () => {
    setShowTooltip(false);
  };

  return (
    <span
      ref={linkRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      {children}
      {showTooltip && textLink && textLink.preview_text && (
        <div
          className="link-preview-tooltip"
          style={{
            position: 'fixed',
            left: `${tooltipPosition.x}px`,
            top: `${tooltipPosition.y}px`,
            transform: 'translate(-50%, -100%)',
            zIndex: 10000,
          }}
        >
          <div className="tooltip-content">
            {textLink.context_before && (
              <div className="tooltip-context-before">{textLink.context_before}...</div>
            )}
            <div className="tooltip-preview">{textLink.preview_text}</div>
            {textLink.context_after && (
              <div className="tooltip-context-after">...{textLink.context_after}</div>
            )}
          </div>
          <div className="tooltip-arrow"></div>
        </div>
      )}
    </span>
  );
};

const ReadingGuidePane = ({
  guideContent, // This can be a string (simple guide), an object (structured guide with sections), or null
  onGenerateGuide, // New prop: function to call when "Generate" is clicked
  isLoading, // Loading state for fetching or generating guide
  error, // Error message if fetching/generating fails
  onClose,
  isVisible,
  hasGuideForCurrentPage, // New prop: boolean to indicate if a guide exists for the current page
  isGenerating, // New prop: boolean to indicate if generation is in progress (for button text/state)
  documentStructure, // New prop: array of {text, level, offset}
  onStructureItemClick, // New prop: function to handle structure item click (for guide section navigation)
  onGuideTextSearch, // New prop: function to search and highlight text from guide section (legacy)
  onGuideTextLink, // New prop: function to handle TextLink navigation (enhanced)
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

  // Function to transform image URIs from Markdown into accessible paths with authentication
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
    // prepend /images to make it web-accessible
    else if (uri.startsWith('/')) {
      transformedUri = `/images${uri}`;
    }
    // For relative paths, prepend /images/
    else {
      transformedUri = `/images/${uri}`;
    }

    // For app images, transform to API endpoint with secret key
    if (transformedUri.startsWith('/images/app/')) {
      // Transform to API endpoint and add secret
      const apiPath = transformedUri.replace('/images/app/', '/api/books/images/app/');
      // Get secret from environment (REACT_APP_IMAGE_SECRET must be set)
      const secret = process.env.REACT_APP_IMAGE_SECRET || '';
      if (secret) {
        const separator = apiPath.includes('?') ? '&' : '?';
        transformedUri = `${apiPath}${separator}secret=${encodeURIComponent(secret)}`;
      } else {
        transformedUri = apiPath;
      }
    }

    return transformedUri;
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
            {/* Check if guideContent is structured (has sections) or simple text */}
            {guideContent.sections && Array.isArray(guideContent.sections) && guideContent.sections.length > 0 ? (
              // Structured guide with sections
              <div className="structured-guide">
                {guideContent.sections.map((section, index) => (
                  <div key={index} className="guide-section">
                    <h4 className="guide-section-title">{section.section_title || `Section ${index + 1}`}</h4>
                    <div className="guide-section-content">
                      <ReactMarkdown
                        children={section.rewritten_content}
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeRaw, rehypeKatex]}
                        transformImageUri={transformUri}
                        transformLinkUri={transformUri}
                      />
                    </div>
                    {/* Enhanced linking: Use primary_link if available, fallback to legacy offsets */}
                    {(section.primary_link || (section.original_start_offset !== undefined && section.original_start_offset !== null)) && (
                      <LinkPreviewTooltip textLink={section.primary_link}>
                        <button
                          className="guide-section-link"
                          onClick={() => {
                            // Prefer new TextLink structure
                            if (section.primary_link && onGuideTextLink) {
                              onGuideTextLink(section.primary_link);
                            } else if (onGuideTextSearch) {
                              // Fallback to legacy search function
                              const searchText = section.original_text_preview || section.rewritten_content;
                              const offset = typeof section.original_start_offset === 'number' 
                                ? section.original_start_offset 
                                : parseInt(section.original_start_offset, 10);
                              if (searchText && !isNaN(offset)) {
                                onGuideTextSearch(searchText, offset);
                              } else if (!isNaN(offset)) {
                                // Fallback to offset-only navigation if no preview text
                                if (onStructureItemClick) {
                                  onStructureItemClick(offset);
                                }
                              } else {
                                console.warn(`[ReadingGuidePane] Invalid offset for section: ${section.original_start_offset}`);
                              }
                            } else if (onStructureItemClick) {
                              // Fallback to offset-only navigation
                              const offset = typeof section.original_start_offset === 'number' 
                                ? section.original_start_offset 
                                : parseInt(section.original_start_offset, 10);
                              if (!isNaN(offset)) {
                                onStructureItemClick(offset);
                              }
                            }
                          }}
                          onKeyDown={(e) => {
                            // Keyboard navigation: Enter or Space to activate
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              // Prefer new TextLink structure
                              if (section.primary_link && onGuideTextLink) {
                                onGuideTextLink(section.primary_link);
                              } else if (onGuideTextSearch) {
                                const searchText = section.original_text_preview || section.rewritten_content;
                                const offset = typeof section.original_start_offset === 'number' 
                                  ? section.original_start_offset 
                                  : parseInt(section.original_start_offset, 10);
                                if (searchText && !isNaN(offset)) {
                                  onGuideTextSearch(searchText, offset);
                                } else if (!isNaN(offset) && onStructureItemClick) {
                                  onStructureItemClick(offset);
                                }
                              } else if (onStructureItemClick) {
                                const offset = typeof section.original_start_offset === 'number' 
                                  ? section.original_start_offset 
                                  : parseInt(section.original_start_offset, 10);
                                if (!isNaN(offset)) {
                                  onStructureItemClick(offset);
                                }
                              }
                            }
                          }}
                          title={section.primary_link 
                            ? `View in original text: "${section.primary_link.preview_text.substring(0, 100)}..."`
                            : `Search and highlight in original text: "${(section.original_text_preview || section.rewritten_content || '').substring(0, 50)}..."`
                          }
                          aria-label="Link to original text. Press Enter or Space to activate."
                          tabIndex={0}
                        >
                          <span className="link-icon" aria-hidden="true">🔗</span> View in original text
                        </button>
                      </LinkPreviewTooltip>
                    )}
                    {section.original_text_preview && (
                      <div className="guide-section-preview">
                        <small>Original preview: {section.original_text_preview}</small>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              // Simple text guide (backward compatibility)
              <ReactMarkdown
                children={typeof guideContent === 'string' ? guideContent : guideContent.content || ''}
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeRaw, rehypeKatex]}
                transformImageUri={transformUri}
                transformLinkUri={transformUri}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReadingGuidePane;
