import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './ReadingGuidePane.css';

const MOBILE_MAX_WIDTH = 768;
const SCROLL_DELTA_THRESHOLD = 30;

function scrollEventTargetKey(target) {
  if (target === document || target === document.documentElement || target === document.body) {
    return document.documentElement;
  }
  return target;
}

function getScrollTopFromScrollEvent(event) {
  const { target } = event;
  if (target === document || target === document.documentElement || target === document.body) {
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }
  if (target && typeof target.scrollTop === 'number') {
    return target.scrollTop;
  }
  return null;
}

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

function RoadmapCardChat({
  cardId,
  cardTitle,
  onSendCardChat,
  onLoadCardChat,
  onClearCardChat,
  serverActionsDisabled = false,
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState(null);
  const loadedRef = useRef(false);

  const loadHistory = useCallback(async () => {
    if (!onLoadCardChat) return;
    setLoadingHistory(true);
    setError(null);
    try {
      const hist = await onLoadCardChat(cardId);
      setMessages(Array.isArray(hist) ? hist : []);
      loadedRef.current = true;
    } catch (err) {
      setError(err.message || 'Failed to load chat');
    } finally {
      setLoadingHistory(false);
    }
  }, [cardId, onLoadCardChat]);

  const openModal = useCallback(() => {
    setModalOpen(true);
    loadHistory();
  }, [loadHistory]);

  const closeModal = useCallback(() => {
    setModalOpen(false);
  }, []);

  useEffect(() => {
    if (!modalOpen) return undefined;
    const onEsc = (event) => {
      if (event.key === 'Escape') setModalOpen(false);
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [modalOpen]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !onSendCardChat || loading) return;
    setLoading(true);
    setError(null);
    try {
      const updated = await onSendCardChat(cardId, text);
      setMessages(Array.isArray(updated) ? updated : []);
      setInput('');
      loadedRef.current = true;
    } catch (err) {
      setError(err.message || 'Failed to send message');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    if (!onClearCardChat) return;
    if (!window.confirm('Clear all chat history for this section?')) return;
    setLoading(true);
    setError(null);
    try {
      await onClearCardChat(cardId);
      setMessages([]);
      loadedRef.current = true;
    } catch (err) {
      setError(err.message || 'Failed to clear chat');
    } finally {
      setLoading(false);
    }
  };

  if (!onSendCardChat) return null;

  const chatModal =
    modalOpen &&
    typeof document !== 'undefined' &&
    createPortal(
      <div
        className="roadmap-modal-backdrop"
        role="presentation"
        onClick={closeModal}
      >
        <div
          className="roadmap-card-chat-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`roadmap-chat-title-${cardId}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="roadmap-card-chat-modal-header">
            <h4 id={`roadmap-chat-title-${cardId}`}>
              Chat: {cardTitle || 'This section'}
            </h4>
            <button
              type="button"
              className="roadmap-modal-close"
              onClick={closeModal}
              aria-label="Close chat"
            >
              &times;
            </button>
          </div>
          <div className="roadmap-card-chat-modal-body">
            {serverActionsDisabled && (
              <p className="roadmap-card-chat-hint">Chat requires an internet connection.</p>
            )}
            {loadingHistory && <p className="roadmap-card-chat-hint">Loading conversation…</p>}
            <div className="roadmap-card-chat-messages" role="log" aria-live="polite">
              {messages.length === 0 && !loadingHistory && (
                <p className="roadmap-card-chat-empty">Ask a question about this section.</p>
              )}
              {messages.map((msg, idx) => (
                <div
                  key={`${cardId}-msg-${idx}`}
                  className={`roadmap-card-chat-message roadmap-card-chat-message--${msg.role}`}
                >
                  <span className="roadmap-card-chat-role">{msg.role === 'user' ? 'You' : 'Guide'}</span>
                  <div className="roadmap-card-chat-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  </div>
                </div>
              ))}
            </div>
            {error && <p className="error-message roadmap-card-chat-error">{error}</p>}
            <div className="roadmap-card-chat-compose">
              <textarea
                className="roadmap-card-chat-input"
                rows={3}
                value={input}
                disabled={serverActionsDisabled || loading}
                placeholder="Ask about this section…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div className="roadmap-card-chat-compose-actions">
                <button
                  type="button"
                  className="guide-section-link"
                  disabled={serverActionsDisabled || loading || !input.trim()}
                  onClick={handleSend}
                >
                  {loading ? 'Sending…' : 'Send'}
                </button>
                {messages.length > 0 && (
                  <button
                    type="button"
                    className="guide-section-link secondary"
                    disabled={serverActionsDisabled || loading}
                    onClick={handleClear}
                  >
                    Clear history
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );

  return (
    <>
      <button
        type="button"
        className="guide-section-link secondary"
        disabled={serverActionsDisabled}
        onClick={openModal}
        aria-haspopup="dialog"
      >
        Chat
      </button>
      {chatModal}
    </>
  );
}

function RoadmapCard({
  item,
  completedIds,
  onToggleProgress,
  onGuideTextLink,
  onGenerateGraph,
  onGenerateAlternativeReading,
  onGenerateOutsiderGuide,
  onSendCardChat,
  onLoadCardChat,
  onClearCardChat,
  roadmapBulkJob = null,
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

  useEffect(() => {
    if (isCompleted) setExpanded(false);
  }, [isCompleted]);

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

  const showDetails = !isCompleted;

  return (
    <div
      className={`guide-section roadmap-card${isCompleted ? ' roadmap-card--completed' : ''}`}
      style={{ marginLeft: depth * 8 }}
      data-roadmap-item-id={idStr}
    >
      <div className="roadmap-card-header">
        <div className="roadmap-left">
          {hasChildren && showDetails ? (
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

      {showDetails && signpost && (
        <div className="roadmap-signpost-block">
          <span className="roadmap-field-label">Signpost</span>
          <p className="roadmap-signpost">{signpost}</p>
        </div>
      )}

      {showDetails && (hasReadingSummary || hasReadingBullets) && (
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

      {showDetails && showTakeaway && (
        <div className="roadmap-takeaway-block guide-section-content">
          <span className="roadmap-field-label">Takeaway</span>
          <div className="roadmap-takeaway-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.takeaway}</ReactMarkdown>
          </div>
        </div>
      )}
      {showDetails && showThoughtProcess && (
        <div className="roadmap-thought-process">
          <span className="roadmap-field-label">Follow the thread</span>
          <ol className="roadmap-thought-steps">
            {item.thought_process.map((step, idx) => (
              <li key={`${item.id}-tp-${idx}`}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      {showDetails && typeof item.alternative_reading === 'string' && item.alternative_reading.trim() && (
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
      {showDetails && typeof item.outsider_guide === 'string' && item.outsider_guide.trim() && (
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
      {showDetails && (item.preview_text || item.key_quote) && (
        <blockquote className="roadmap-quote">{item.preview_text || item.key_quote}</blockquote>
      )}

      {showDetails && (
      <div className="roadmap-card-actions">
        <button className="guide-section-link" type="button" onClick={handleViewOriginal}>
          View in original text
        </button>
        <button
          className="guide-section-link secondary"
          type="button"
          disabled={isGraphLoading || roadmapBulkJob === 'graphs' || serverActionsDisabled}
          onClick={() => onGenerateGraph(item.id)}
        >
          {isGraphLoading ? 'Generating graph...' : 'Generate Graph'}
        </button>
        <button
          className="guide-section-link secondary"
          type="button"
          disabled={
            isAlternativeReadingLoading ||
            roadmapBulkJob === 'shortcuts' ||
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
          disabled={
            isOutsiderGuideLoading ||
            roadmapBulkJob === 'outsiders' ||
            serverActionsDisabled ||
            !onGenerateOutsiderGuide
          }
          onClick={() => onGenerateOutsiderGuide && onGenerateOutsiderGuide(item.id)}
        >
          {isOutsiderGuideLoading ? 'Generating outsider guide...' : 'Outsider Guide'}
        </button>
        <RoadmapCardChat
          cardId={idStr}
          cardTitle={title}
          onSendCardChat={onSendCardChat}
          onLoadCardChat={onLoadCardChat}
          onClearCardChat={onClearCardChat}
          serverActionsDisabled={serverActionsDisabled}
        />
      </div>
      )}

      {showDetails && item.graph_image_url && (
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

      {hasChildren && expanded && showDetails && (
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
              onSendCardChat={onSendCardChat}
              onLoadCardChat={onLoadCardChat}
              onClearCardChat={onClearCardChat}
              roadmapBulkJob={roadmapBulkJob}
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
  guidesList = [],
  activeGuideId = null,
  maxGuides = 5,
  onSwitchGuide,
  onCreateGuide,
  onDeleteGuide,
  completedIds = [],
  onGenerateRoadmap,
  onToggleProgress,
  onGuideTextLink,
  onGenerateGraph,
  onGenerateAlternativeReading,
  onGenerateOutsiderGuide,
  onBulkGenerateRoadmap,
  onSendCardChat,
  onLoadCardChat,
  onClearCardChat,
  graphLoadingById = {},
  alternativeLoadingById = {},
  outsiderLoadingById = {},
  roadmapBulkJob = null,
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
  hideHeader = false,
}) => {
  const paneRef = useRef(null);
  const [selectedGraphImage, setSelectedGraphImage] = useState(null);
  const [showBulkGenerateModal, setShowBulkGenerateModal] = useState(false);
  const [showNewGuideModal, setShowNewGuideModal] = useState(false);
  const [newGuideName, setNewGuideName] = useState('');
  const [newGuideRequirements, setNewGuideRequirements] = useState('');
  const [mobileHeaderHidden, setMobileHeaderHidden] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef(null);

  const canAddGuide = guidesList.length < maxGuides;
  const activeGuideSummary = guidesList.find((g) => g.guide_id === activeGuideId);
  const isBulkRoadmapRunning = !!roadmapBulkJob;
  const actionsBusy = isLoading || isGenerating || isBulkRoadmapRunning;

  const isMobileViewport = useCallback(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX_WIDTH,
    [],
  );

  useEffect(() => {
    if ((!embedInMainArea && !isVisible) || hideHeader) {
      setMobileHeaderHidden(false);
    }
  }, [embedInMainArea, isVisible, hideHeader]);

  useEffect(() => {
    if (hideHeader) {
      return undefined;
    }
    const lastScrollTopByTarget = new Map();

    const onScroll = (event) => {
      if (!isMobileViewport()) {
        return;
      }
      if (!embedInMainArea && !isVisible) {
        return;
      }
      const container = scrollContainerRef?.current;
      if (!container || event.target !== container) {
        return;
      }
      const scrollTop = getScrollTopFromScrollEvent(event);
      if (scrollTop === null) {
        return;
      }
      const key = scrollEventTargetKey(event.target);
      const prevTop = lastScrollTopByTarget.has(key)
        ? lastScrollTopByTarget.get(key)
        : scrollTop;
      lastScrollTopByTarget.set(key, scrollTop);
      const delta = scrollTop - prevTop;
      if (scrollTop <= 0) {
        setMobileHeaderHidden(false);
        return;
      }
      if (delta > SCROLL_DELTA_THRESHOLD) {
        setMobileHeaderHidden(true);
      } else if (delta < -SCROLL_DELTA_THRESHOLD) {
        setMobileHeaderHidden(false);
      }
    };

    const onResize = () => {
      if (!isMobileViewport()) {
        setMobileHeaderHidden(false);
      }
    };

    const scrollListenerOptions = { capture: true, passive: true };
    document.addEventListener('scroll', onScroll, scrollListenerOptions);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('scroll', onScroll, scrollListenerOptions);
      window.removeEventListener('resize', onResize);
    };
  }, [isMobileViewport, embedInMainArea, isVisible, scrollContainerRef, hideHeader]);

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
        setShowBulkGenerateModal(false);
        setShowNewGuideModal(false);
        setOverflowOpen(false);
      }
    };
    if (selectedGraphImage || showBulkGenerateModal || showNewGuideModal || overflowOpen) {
      document.addEventListener('keydown', onEsc);
    }
    return () => {
      document.removeEventListener('keydown', onEsc);
    };
  }, [selectedGraphImage, showBulkGenerateModal, showNewGuideModal, overflowOpen]);

  useEffect(() => {
    if (!overflowOpen) return undefined;
    const onPointerDown = (event) => {
      if (overflowRef.current && !overflowRef.current.contains(event.target)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [overflowOpen]);

  const handleOpenGraph = useCallback((url, title) => {
    setSelectedGraphImage({ url, title });
  }, []);

  if (!embedInMainArea && !isVisible) return null;

  const totalItems = roadmap?.items ? countItems(roadmap.items) : 0;
  const progressPct = totalItems > 0 ? Math.round((completedIds.length / totalItems) * 100) : 0;
  const progressBarWidthPct = totalItems > 0 ? Math.min(100, Math.round((completedIds.length / totalItems) * 100)) : 0;
  const bulkRunningLabel =
    roadmapBulkJob === 'graphs'
      ? 'Generating all graphs...'
      : roadmapBulkJob === 'shortcuts'
        ? 'Generating all shortcuts...'
        : roadmapBulkJob === 'outsiders'
          ? 'Generating all outsider guides...'
          : '';

  const handleSubmitNewGuide = () => {
    if (!onCreateGuide) return;
    onCreateGuide({
      name: newGuideName.trim() || undefined,
      custom_requirements: newGuideRequirements.trim() || undefined,
    });
    setShowNewGuideModal(false);
    setNewGuideName('');
    setNewGuideRequirements('');
  };

  const showGenerateRoadmap = onGenerateRoadmap && !roadmap?.items?.length;
  const generateRoadmapLabel = isGenerating ? 'Generating…' : 'Generate roadmap';

  const roadmapActionsInner = (
    <div className="reading-guide-toolbar">
      <div className="reading-guide-toolbar-row">
        {guidesList.length > 0 && (
          <div className="reading-guide-switcher">
            <select
              id="reading-guide-select"
              className="reading-guide-select"
              aria-label="Reading guide"
              title={
                activeGuideSummary?.custom_requirements
                  ? `Reading angle: ${activeGuideSummary.custom_requirements}`
                  : undefined
              }
              value={activeGuideId || ''}
              onChange={(e) => onSwitchGuide && onSwitchGuide(e.target.value)}
              disabled={actionsBusy}
            >
              {guidesList.map((g) => (
                <option
                  key={g.guide_id}
                  value={g.guide_id}
                  title={g.custom_requirements || g.name}
                >
                  {g.name}
                  {g.custom_requirements ? ` — ${String(g.custom_requirements).slice(0, 40)}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="reading-guide-overflow" ref={overflowRef}>
          <button
            type="button"
            className="reading-guide-overflow-trigger"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            aria-label="Guide actions"
            onClick={() => setOverflowOpen((v) => !v)}
          >
            ⋯
          </button>
          {overflowOpen && (
            <div className="reading-guide-overflow-menu" role="menu">
              {onCreateGuide && (
                <button
                  type="button"
                  role="menuitem"
                  className="reading-guide-overflow-item"
                  disabled={!canAddGuide || actionsBusy || serverActionsDisabled}
                  onClick={() => {
                    setOverflowOpen(false);
                    setShowNewGuideModal(true);
                  }}
                >
                  New guide…
                </button>
              )}
              {onDeleteGuide && guidesList.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="reading-guide-overflow-item"
                  disabled={actionsBusy || serverActionsDisabled}
                  onClick={() => {
                    setOverflowOpen(false);
                    if (activeGuideId && window.confirm('Delete this reading guide?')) {
                      onDeleteGuide(activeGuideId);
                    }
                  }}
                >
                  Delete guide
                </button>
              )}
              {showGenerateRoadmap && (
                <button
                  type="button"
                  role="menuitem"
                  className="reading-guide-overflow-item"
                  disabled={actionsBusy || serverActionsDisabled}
                  onClick={() => {
                    setOverflowOpen(false);
                    onGenerateRoadmap();
                  }}
                >
                  {generateRoadmapLabel}
                </button>
              )}
              {roadmap?.items?.length > 0 && onBulkGenerateRoadmap && (
                <button
                  type="button"
                  role="menuitem"
                  className="reading-guide-overflow-item"
                  disabled={actionsBusy || serverActionsDisabled}
                  onClick={() => {
                    setOverflowOpen(false);
                    setShowBulkGenerateModal(true);
                  }}
                >
                  {isBulkRoadmapRunning ? bulkRunningLabel : 'Generate all…'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {totalItems > 0 && (
        <div
          className="reading-guide-toolbar-progress reading-guide-progress"
          role="progressbar"
          aria-valuenow={completedIds.length}
          aria-valuemin={0}
          aria-valuemax={totalItems}
          aria-label={`${completedIds.length} of ${totalItems} sections completed`}
        >
          <span className="progress-text">
            {completedIds.length} / {totalItems} ({progressPct}%)
          </span>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${progressBarWidthPct}%` }} />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className={`reading-guide-pane ${isVisible ? 'visible' : ''} ${embedInMainArea ? 'reading-guide-pane-embed' : ''}`} ref={paneRef}>
      <div className="reading-guide-content" ref={scrollContainerRef}>
        {hideHeader ? (
          <div className="reading-guide-actions reading-guide-actions--below-merged-nav">
            {roadmapActionsInner}
          </div>
        ) : (
          <div className={`reading-guide-top-container ${mobileHeaderHidden ? 'top-hidden' : ''}`}>
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
            <div className="reading-guide-actions">{roadmapActionsInner}</div>
          </div>
        )}

        <div className="reading-guide-inner-content">
          {isLoading && <p>Loading roadmap...</p>}
          {error && <p className="error-message">Error: {error}</p>}
          {!isLoading && !error && !roadmap?.items?.length && (
            <p>No roadmap yet. Open ⋯ and choose Generate roadmap, or create a new guide.</p>
          )}
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
                  onSendCardChat={onSendCardChat}
                  onLoadCardChat={onLoadCardChat}
                  onClearCardChat={onClearCardChat}
                  roadmapBulkJob={roadmapBulkJob}
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

      {showNewGuideModal && (
        <div
          className="roadmap-modal-backdrop"
          role="presentation"
          onClick={() => setShowNewGuideModal(false)}
        >
          <div
            className="roadmap-bulk-choice-modal reading-guide-new-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reading-guide-new-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="roadmap-bulk-choice-modal-header">
              <h4 id="reading-guide-new-modal-title">New reading guide</h4>
              <button
                type="button"
                className="roadmap-modal-close"
                onClick={() => setShowNewGuideModal(false)}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <p className="roadmap-bulk-choice-hint">
              Optional custom angle shapes how pillars and cards are generated (e.g. focus on leadership lessons).
            </p>
            <label className="reading-guide-new-field">
              <span>Name (optional)</span>
              <input
                type="text"
                value={newGuideName}
                maxLength={120}
                onChange={(e) => setNewGuideName(e.target.value)}
                placeholder="Guide 2"
              />
            </label>
            <label className="reading-guide-new-field">
              <span>Custom reading angle (optional)</span>
              <textarea
                rows={4}
                value={newGuideRequirements}
                maxLength={2000}
                onChange={(e) => setNewGuideRequirements(e.target.value)}
                placeholder="e.g. Read as a product manager looking for actionable frameworks"
              />
            </label>
            <div className="roadmap-bulk-choice-footer">
              <button type="button" className="roadmap-bulk-cancel-btn" onClick={() => setShowNewGuideModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="roadmap-bulk-choice-btn roadmap-bulk-choice-btn--shortcut"
                disabled={serverActionsDisabled || isGenerating}
                onClick={handleSubmitNewGuide}
              >
                Create &amp; generate
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkGenerateModal && (
        <div
          className="roadmap-modal-backdrop"
          role="presentation"
          onClick={() => setShowBulkGenerateModal(false)}
        >
          <div
            className="roadmap-bulk-choice-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="roadmap-bulk-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="roadmap-bulk-choice-modal-header">
              <h4 id="roadmap-bulk-modal-title">Generate for all cards</h4>
              <button
                type="button"
                className="roadmap-modal-close"
                onClick={() => setShowBulkGenerateModal(false)}
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <p className="roadmap-bulk-choice-hint">
              Runs sequentially for every roadmap card (including nested sections).
            </p>
            <div className="roadmap-bulk-choice-actions">
              <button
                type="button"
                className="roadmap-bulk-choice-btn roadmap-bulk-choice-btn--graph"
                onClick={() => {
                  setShowBulkGenerateModal(false);
                  onBulkGenerateRoadmap('graph');
                }}
              >
                All graphs
              </button>
              <button
                type="button"
                className="roadmap-bulk-choice-btn roadmap-bulk-choice-btn--shortcut"
                onClick={() => {
                  setShowBulkGenerateModal(false);
                  onBulkGenerateRoadmap('shortcut');
                }}
              >
                All author shortcuts
              </button>
              <button
                type="button"
                className="roadmap-bulk-choice-btn roadmap-bulk-choice-btn--outsider"
                onClick={() => {
                  setShowBulkGenerateModal(false);
                  onBulkGenerateRoadmap('outsider');
                }}
              >
                All outsider guides
              </button>
            </div>
            <div className="roadmap-bulk-choice-footer">
              <button type="button" className="roadmap-bulk-cancel-btn" onClick={() => setShowBulkGenerateModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReadingGuidePane;
