import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './ReadingGuidePane.css';

function countItems(items) {
  let count = 0;
  const walk = (nodes) => {
    if (!nodes || !Array.isArray(nodes)) return;
    for (const n of nodes) {
      count += 1;
      walk(n.children);
    }
  };
  walk(items);
  return count;
}

function RoadmapCard({
  item,
  completedIds,
  onToggleProgress,
  onGuideTextLink,
  onGenerateGraph,
  graphLoadingById,
  onOpenGraphImage,
  serverActionsDisabled = false,
  depth = 0,
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = item.children && item.children.length > 0;
  const isCompleted = completedIds.includes(item.id);
  const isGraphLoading = !!graphLoadingById[item.id];

  const handleViewOriginal = () => {
    if (!onGuideTextLink) return;
    onGuideTextLink({
      start_offset: item.start_offset,
      end_offset: item.end_offset,
      preview_text: item.preview_text || item.key_quote || item.title,
      key_quote: item.key_quote || null,
      context_before: null,
      context_after: null,
    });
  };

  return (
    <div className="guide-section roadmap-card" style={{ marginLeft: depth * 14 }}>
      <div className="roadmap-card-header">
        <div className="roadmap-left">
          {hasChildren ? (
            <button className="roadmap-expand-btn" onClick={() => setExpanded((v) => !v)} type="button">
              {expanded ? '−' : '+'}
            </button>
          ) : (
            <span className="roadmap-expand-spacer" />
          )}
          <label className="roadmap-checkbox-label">
            <input
              type="checkbox"
              checked={isCompleted}
              onChange={(e) => onToggleProgress(item.id, e.target.checked)}
            />
          </label>
          <h4 className="guide-section-title roadmap-title">{item.title}</h4>
        </div>
      </div>

      {item.takeaway && (
        <div className="guide-section-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.takeaway}</ReactMarkdown>
        </div>
      )}
      {item.reading_summary && (
        <div className="roadmap-reading">
          <h5 className="roadmap-subtitle">Reading</h5>
          <p className="roadmap-reading-summary">{item.reading_summary}</p>
          {Array.isArray(item.reading_bullets) && item.reading_bullets.length > 0 && (
            <ul className="roadmap-reading-bullets">
              {item.reading_bullets.map((bullet, idx) => (
                <li key={`${item.id}-reading-${idx}`}>{bullet}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {Array.isArray(item.thought_process) && item.thought_process.length > 0 && (
        <details className="roadmap-thought-process">
          <summary>Thought process</summary>
          <ul>
            {item.thought_process.map((step, idx) => (
              <li key={`${item.id}-thought-${idx}`}>{step}</li>
            ))}
          </ul>
        </details>
      )}
      {item.key_quote && <blockquote className="roadmap-quote">"{item.key_quote}"</blockquote>}

      <div className="roadmap-card-actions">
        <button className="guide-section-link" type="button" onClick={handleViewOriginal}>
          View in original text
        </button>
        <button
          className="guide-section-link secondary"
          type="button"
          disabled={isGraphLoading || serverActionsDisabled}
          onClick={() => onGenerateGraph(item.id)}
        >
          {isGraphLoading ? 'Generating graph...' : 'Generate Graph'}
        </button>
      </div>

      {item.graph_image_url && (
        <div className="roadmap-graph-wrap">
          <button
            type="button"
            className="roadmap-graph-preview-btn"
            onClick={() => onOpenGraphImage(item.graph_image_url, item.title)}
            aria-label={`Open larger graph for ${item.title}`}
          >
            <img src={item.graph_image_url} alt={`Concept graph for ${item.title}`} className="roadmap-graph-image" />
          </button>
        </div>
      )}

      {hasChildren && expanded && (
        <div className="roadmap-children">
          {item.children.map((child) => (
            <RoadmapCard
              key={child.id}
              item={child}
              completedIds={completedIds}
              onToggleProgress={onToggleProgress}
              onGuideTextLink={onGuideTextLink}
              onGenerateGraph={onGenerateGraph}
              graphLoadingById={graphLoadingById}
              onOpenGraphImage={onOpenGraphImage}
              serverActionsDisabled={serverActionsDisabled}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const ReadingGuidePane = ({
  roadmap,
  completedIds = [],
  onGenerateRoadmap,
  onToggleProgress,
  onGuideTextLink,
  onGenerateGraph,
  graphLoadingById = {},
  isLoading,
  isGenerating,
  error,
  onClose,
  isVisible,
  onSwitchToOriginal,
  scrollContainerRef,
  scrollPositionToRestore = 0,
  embedInMainArea = false,
  serverActionsDisabled = false,
}) => {
  const paneRef = useRef(null);
  const [selectedGraphImage, setSelectedGraphImage] = useState(null);

  useEffect(() => {
    if (scrollPositionToRestore > 0 && scrollContainerRef?.current) {
      const el = scrollContainerRef.current;
      const raf = requestAnimationFrame(() => {
        el.scrollTop = scrollPositionToRestore;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [scrollPositionToRestore, scrollContainerRef, roadmap]);

  useEffect(() => {
    const onEsc = (event) => {
      if (event.key === 'Escape') {
        setSelectedGraphImage(null);
      }
    };
    if (selectedGraphImage) {
      document.addEventListener('keydown', onEsc);
    }
    return () => {
      document.removeEventListener('keydown', onEsc);
    };
  }, [selectedGraphImage]);

  if (!embedInMainArea && !isVisible) return null;

  const totalItems = roadmap?.items ? countItems(roadmap.items) : 0;
  const progressPct = totalItems > 0 ? Math.round((completedIds.length / totalItems) * 100) : 0;

  return (
    <div className={`reading-guide-pane ${isVisible ? 'visible' : ''} ${embedInMainArea ? 'reading-guide-pane-embed' : ''}`} ref={paneRef}>
      <div className="reading-guide-header">
        <h3>Reading Roadmap</h3>
        <div className="reading-guide-header-actions">
          {embedInMainArea && onSwitchToOriginal && (
            <button onClick={onSwitchToOriginal} className="switch-to-original-btn" aria-label="Switch to original text">
              Switch to Original Text
            </button>
          )}
          {!embedInMainArea && onClose && (
            <button onClick={onClose} className="close-guide-pane-btn" aria-label="Close Reading Guide">
              &times;
            </button>
          )}
        </div>
      </div>

      <div className="reading-guide-actions">
        <button
          onClick={onGenerateRoadmap}
          disabled={isLoading || isGenerating || serverActionsDisabled}
          className="generate-guide-btn"
        >
          {isGenerating ? 'Generating...' : (roadmap ? 'Regenerate Roadmap' : 'Generate Roadmap')}
        </button>
        {totalItems > 0 && (
          <div className="reading-guide-progress">
            <span className="progress-text">{completedIds.length} / {totalItems} completed ({progressPct}%)</span>
            <div className="progress-bar" role="progressbar" aria-valuenow={completedIds.length} aria-valuemin={0} aria-valuemax={totalItems}>
              <div className="progress-bar-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="reading-guide-content" ref={scrollContainerRef}>
        {isLoading && <p>Loading roadmap...</p>}
        {error && <p className="error-message">Error: {error}</p>}
        {!isLoading && !error && !roadmap && <p>No roadmap generated yet. Click "Generate Roadmap".</p>}
        {!isLoading && !error && roadmap?.items?.length > 0 && (
          <div className="structured-guide roadmap-tree">
            {roadmap.items.map((item) => (
              <RoadmapCard
                key={item.id}
                item={item}
                completedIds={completedIds}
                onToggleProgress={onToggleProgress}
                onGuideTextLink={onGuideTextLink}
                onGenerateGraph={onGenerateGraph}
                graphLoadingById={graphLoadingById}
                onOpenGraphImage={(url, title) => setSelectedGraphImage({ url, title })}
                serverActionsDisabled={serverActionsDisabled}
              />
            ))}
          </div>
        )}
      </div>

      {selectedGraphImage && (
        <div className="roadmap-modal-backdrop" role="presentation" onClick={() => setSelectedGraphImage(null)}>
          <div
            className="roadmap-image-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Large concept graph preview"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="roadmap-image-modal-header">
              <h4>{selectedGraphImage.title}</h4>
              <button
                type="button"
                className="roadmap-modal-close"
                onClick={() => setSelectedGraphImage(null)}
                aria-label="Close details"
              >
                &times;
              </button>
            </div>
            <div className="roadmap-image-modal-body">
              <img
                src={selectedGraphImage.url}
                alt={`Large concept graph for ${selectedGraphImage.title}`}
                className="roadmap-graph-image-large"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReadingGuidePane;
