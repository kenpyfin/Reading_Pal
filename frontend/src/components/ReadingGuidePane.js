import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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

/** Stack of parent ids that must be expanded for `targetId` to appear (excludes target). */
function ancestorIdsToExpandForRoadmapItem(items, targetId) {
  const target = String(targetId);
  const walk = (nodes, stack) => {
    if (!nodes) return null;
    for (const n of nodes) {
      if (String(n.id) === target) return stack;
      if (n.children && n.children.length > 0) {
        const found = walk(n.children, [...stack, n.id]);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const path = walk(items, []);
  return path === null ? [] : path;
}

function RoadmapCard({
  item,
  completedIds,
  onToggleProgress,
  onGuideTextLink,
  onGenerateGraph,
  onGenerateAlternativeReading,
  onGenerateOutsiderGuide,
  isGeneratingAllAlternativeReadings = false,
  graphLoadingById,
  alternativeLoadingById,
  outsiderLoadingById,
  onOpenGraphImage,
  serverActionsDisabled = false,
  depth = 0,
  mustExpandIds,
}) {
  const {
    hub_score: hubScoreRaw,
    purpose,
    title,
  } = item;
  const idStr = String(item.id);
  const mustExpand = mustExpandIds && mustExpandIds.has(idStr);
  const [expanded, setExpanded] = useState(() => depth < 2 || !!mustExpand);
  const hasChildren = item.children && item.children.length > 0;
  const isCompleted = completedIds.includes(item.id);
  const isGraphLoading = !!graphLoadingById[item.id];
  const isAlternativeReadingLoading = !!alternativeLoadingById[item.id];
  const isOutsiderGuideLoading = !!outsiderLoadingById[item.id];
  const hubScore = Number(hubScoreRaw);
  const hasHubScore = Number.isFinite(hubScore) && hubScore > 0;
  const signpost = typeof purpose === 'string' ? purpose.trim() : '';
  const takeawayRaw = typeof item.takeaway === 'string' ? item.takeaway.trim() : item.takeaway;
  const takeawayText = takeawayRaw && String(takeawayRaw).trim();
  const showTakeaway = !!takeawayText;
  const hasReadingSummary = !!(item.reading_summary && String(item.reading_summary).trim());
  const hasReadingBullets = Array.isArray(item.reading_bullets) && item.reading_bullets.length > 0;
  const showThoughtProcess =
    Array.isArray(item.thought_process) &&
    item.thought_process.length > 0 &&
    !String(item.thought_process[0] || '').startsWith('reference::');

  useEffect(() => {
    if (mustExpand) setExpanded(true);
  }, [mustExpand]);

  const handleViewOriginal = () => {
    if (!onGuideTextLink) return;
    onGuideTextLink({
      start_offset: item.start_offset,
      end_offset: item.end_offset,
      preview_text: item.preview_text || item.key_quote || item.title,
      key_quote: item.key_quote || null,
      context_before: null,
      context_after: null,
      sourceItemId: item.id,
    });
  };

  return (
    <div
      className="guide-section roadmap-card"
      style={{ marginLeft: depth * 14 }}
      data-roadmap-item-id={idStr}
    >
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
          <h4 className="guide-section-title roadmap-title">
            <span>{title}</span>
            {hasHubScore && (
              <span className="roadmap-hub-badge">Knowledge Hub ({hubScore})</span>
            )}
          </h4>
        </div>
      </div>

      {signpost && (
        <div className="roadmap-signpost-block">
          <span className="roadmap-field-label">Signpost</span>
          <p className="roadmap-signpost">{signpost}</p>
        </div>
      )}

      {(hasReadingSummary || hasReadingBullets) && (
        <div className="roadmap-reading roadmap-reading-prominent">
          <h5 className="roadmap-subtitle roadmap-reading-heading">How to read this segment</h5>
          {hasReadingSummary && (
            <div className="roadmap-reading-summary-block">
              <span className="roadmap-field-label">Summary</span>
              <p className="roadmap-reading-summary">{item.reading_summary}</p>
            </div>
          )}
          {hasReadingBullets && (
            <div className="roadmap-reading-bullets-block">
              <span className="roadmap-field-label">Quick points</span>
              <ul className="roadmap-reading-bullets">
                {item.reading_bullets.map((bullet, idx) => (
                  <li key={`${item.id}-reading-${idx}`}>{bullet}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {showTakeaway && (
        <div className="roadmap-takeaway-block guide-section-content">
          <span className="roadmap-field-label">Takeaway</span>
          <div className="roadmap-takeaway-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.takeaway}</ReactMarkdown>
          </div>
        </div>
      )}
      {showThoughtProcess && (
        <div className="roadmap-thought-process">
          <span className="roadmap-field-label">Follow the thread</span>
          <ol className="roadmap-thought-steps">
            {item.thought_process.map((step, idx) => (
              <li key={`${item.id}-tp-${idx}`}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      {typeof item.alternative_reading === 'string' && item.alternative_reading.trim() && (
        <details className="roadmap-alternative-reading">
          <summary>Author Shortcut</summary>
          <div className="roadmap-alternative-reading-content">
            {Number.isFinite(item.alternative_source_word_count) && Number.isFinite(item.alternative_word_count) && (
              <p className="roadmap-alternative-reading-stats">
                Reference words: {item.alternative_source_word_count} | Shortcut words: {item.alternative_word_count}
              </p>
            )}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.alternative_reading}</ReactMarkdown>
          </div>
        </details>
      )}
      {typeof item.outsider_guide === 'string' && item.outsider_guide.trim() && (
        <details className="roadmap-outsider-guide">
          <summary>Outsider Guide</summary>
          <div className="roadmap-outsider-guide-content">
            {Number.isFinite(item.outsider_source_word_count) && Number.isFinite(item.outsider_word_count) && (
              <p className="roadmap-outsider-guide-stats">
                Reference words: {item.outsider_source_word_count} | Guide words: {item.outsider_word_count}
              </p>
            )}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.outsider_guide}</ReactMarkdown>
          </div>
        </details>
      )}
      {(item.preview_text || item.key_quote) && (
        <blockquote className="roadmap-quote">{item.preview_text || item.key_quote}</blockquote>
      )}

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
        <button
          className="guide-section-link secondary"
          type="button"
          disabled={
            isAlternativeReadingLoading ||
            isGeneratingAllAlternativeReadings ||
            serverActionsDisabled ||
            !onGenerateAlternativeReading
          }
          onClick={() => onGenerateAlternativeReading && onGenerateAlternativeReading(item.id)}
        >
          {isAlternativeReadingLoading ? 'Generating author shortcut...' : 'Author Shortcut'}
        </button>
        <button
          className="guide-section-link secondary"
          type="button"
          disabled={isOutsiderGuideLoading || serverActionsDisabled || !onGenerateOutsiderGuide}
          onClick={() => onGenerateOutsiderGuide && onGenerateOutsiderGuide(item.id)}
        >
          {isOutsiderGuideLoading ? 'Generating outsider guide...' : 'Outsider Guide'}
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
              onGenerateAlternativeReading={onGenerateAlternativeReading}
              onGenerateOutsiderGuide={onGenerateOutsiderGuide}
              graphLoadingById={graphLoadingById}
              alternativeLoadingById={alternativeLoadingById}
              outsiderLoadingById={outsiderLoadingById}
              onOpenGraphImage={onOpenGraphImage}
              serverActionsDisabled={serverActionsDisabled}
              depth={depth + 1}
              mustExpandIds={mustExpandIds}
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
  onGenerateAlternativeReading,
  onGenerateOutsiderGuide,
  onGenerateAllAlternativeReadings,
  graphLoadingById = {},
  alternativeLoadingById = {},
  outsiderLoadingById = {},
  isGeneratingAllAlternativeReadings = false,
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
  focusItemId = null,
  onRoadmapReturnFocusDone,
}) => {
  const paneRef = useRef(null);
  const [selectedGraphImage, setSelectedGraphImage] = useState(null);

  const mustExpandIds = useMemo(() => {
    if (!focusItemId || !roadmap?.items?.length) return null;
    const ids = ancestorIdsToExpandForRoadmapItem(roadmap.items, focusItemId);
    return new Set(ids.map(String));
  }, [focusItemId, roadmap]);

  useEffect(() => {
    if (!scrollContainerRef?.current || typeof scrollPositionToRestore !== 'number' || scrollPositionToRestore <= 0) {
      return undefined;
    }
    const el = scrollContainerRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = scrollPositionToRestore;
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollPositionToRestore, scrollContainerRef, roadmap]);

  useEffect(() => {
    if (!focusItemId || !scrollContainerRef?.current || !roadmap?.items?.length) {
      return undefined;
    }
    const container = scrollContainerRef.current;
    let cancelled = false;
    let escaped = String(focusItemId);
    try {
      if (typeof CSS !== 'undefined' && CSS.escape) {
        escaped = CSS.escape(escaped);
      }
    } catch (_e) {
      /* ignore */
    }
    const id = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (cancelled) return;
        const el = container.querySelector(`[data-roadmap-item-id="${escaped}"]`);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        if (onRoadmapReturnFocusDone) {
          window.setTimeout(() => {
            if (!cancelled) onRoadmapReturnFocusDone();
          }, 480);
        }
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(id);
    };
  }, [focusItemId, roadmap, scrollContainerRef, onRoadmapReturnFocusDone]);

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

  const handleOpenGraph = useCallback((url, title) => {
    setSelectedGraphImage({ url, title });
  }, []);

  if (!embedInMainArea && !isVisible) return null;

  const totalItems = roadmap?.items ? countItems(roadmap.items) : 0;
  const progressPct = totalItems > 0 ? Math.round((completedIds.length / totalItems) * 100) : 0;

  return (
    <div className={`reading-guide-pane ${isVisible ? 'visible' : ''} ${embedInMainArea ? 'reading-guide-pane-embed' : ''}`} ref={paneRef}>
      <div className="reading-guide-header">
        <h3>Reading Roadmap</h3>
        <div className="reading-guide-header-actions">
          {embedInMainArea && onSwitchToOriginal && (
            <button type="button" onClick={onSwitchToOriginal} className="switch-to-original-btn" aria-label="Switch to original text">
              Switch to Original Text
            </button>
          )}
          {!embedInMainArea && onClose && (
            <button type="button" onClick={onClose} className="close-guide-pane-btn" aria-label="Close Reading Guide">
              &times;
            </button>
          )}
        </div>
      </div>

      <div className="reading-guide-actions">
        <button
          type="button"
          onClick={onGenerateRoadmap}
          disabled={isLoading || isGenerating || isGeneratingAllAlternativeReadings || serverActionsDisabled}
          className="generate-guide-btn"
        >
          {isGenerating ? 'Generating...' : (roadmap ? 'Regenerate Roadmap' : 'Generate Roadmap')}
        </button>
        {roadmap?.items?.length > 0 && (
          <button
            type="button"
            onClick={onGenerateAllAlternativeReadings}
            disabled={isLoading || isGenerating || isGeneratingAllAlternativeReadings || serverActionsDisabled || !onGenerateAllAlternativeReadings}
            className="generate-guide-btn generate-shortcuts-btn"
          >
            {isGeneratingAllAlternativeReadings ? 'Generating all shortcuts...' : 'Generate All Shortcuts'}
          </button>
        )}
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
        {!isLoading && !error && !roadmap && <p>No roadmap generated yet. Click &quot;Generate Roadmap&quot;.</p>}
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
                onGenerateAlternativeReading={onGenerateAlternativeReading}
                onGenerateOutsiderGuide={onGenerateOutsiderGuide}
                isGeneratingAllAlternativeReadings={isGeneratingAllAlternativeReadings}
                graphLoadingById={graphLoadingById}
                alternativeLoadingById={alternativeLoadingById}
                outsiderLoadingById={outsiderLoadingById}
                onOpenGraphImage={handleOpenGraph}
                serverActionsDisabled={serverActionsDisabled}
                mustExpandIds={mustExpandIds}
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
