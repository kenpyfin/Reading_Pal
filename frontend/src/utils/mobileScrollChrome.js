const OVERFLOW_SCROLL_VALUES = new Set(['auto', 'scroll', 'overlay']);

function isOverflowScrollY(el) {
  if (!el || el.nodeType !== 1) return false;
  const style = typeof window !== 'undefined' ? window.getComputedStyle(el) : null;
  if (!style) return false;
  return OVERFLOW_SCROLL_VALUES.has(style.overflowY);
}

/**
 * Returns true when the scroll event originated from the active container or a
 * non-scrollable descendant (ignores nested modals/menus with their own scroll).
 */
export function isScrollFromActiveContainer(eventTarget, activeContainer) {
  if (!activeContainer || !eventTarget) return false;
  if (eventTarget === activeContainer) return true;

  let node = eventTarget;
  while (node && node !== activeContainer) {
    if (node !== eventTarget && isOverflowScrollY(node)) {
      return false;
    }
    node = node.parentElement;
  }
  return node === activeContainer;
}

/**
 * Hysteresis-based mobile chrome hide/show controller.
 * Hide after cumulative scroll-down passes thresholdHide; show after scroll-up passes thresholdShow.
 */
export function createScrollChromeController({
  thresholdHide = 48,
  thresholdShow = 16,
  minScrollTop = 8,
  onHiddenChange,
} = {}) {
  let hidden = false;
  let lastScrollTop = null;
  let cumDown = 0;
  let cumUp = 0;

  const setHidden = (next) => {
    if (hidden === next) return;
    hidden = next;
    onHiddenChange?.(next);
  };

  const reset = () => {
    lastScrollTop = null;
    cumDown = 0;
    cumUp = 0;
    setHidden(false);
  };

  const onScroll = (event, activeContainer) => {
    if (!activeContainer) return;
    if (!isScrollFromActiveContainer(event.target, activeContainer)) return;

    const scrollTop = activeContainer.scrollTop;

    if (scrollTop <= minScrollTop) {
      setHidden(false);
      lastScrollTop = scrollTop;
      cumDown = 0;
      cumUp = 0;
      return;
    }

    if (lastScrollTop === null) {
      lastScrollTop = scrollTop;
      return;
    }

    const delta = scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;

    if (delta === 0) return;

    if (delta > 0) {
      cumDown += delta;
      cumUp = 0;
      if (!hidden && cumDown >= thresholdHide) {
        setHidden(true);
        cumDown = 0;
      }
    } else {
      cumUp += -delta;
      cumDown = 0;
      if (hidden && cumUp >= thresholdShow) {
        setHidden(false);
        cumUp = 0;
      }
    }
  };

  return {
    onScroll,
    reset,
    getHidden: () => hidden,
  };
}
