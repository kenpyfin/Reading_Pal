import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

function readBottomReserve() {
  const shell = document.querySelector('.book-floating-toolbar-shell.is-phone-shell');
  const barHeight = shell ? shell.getBoundingClientRect().height : 0;
  const keyboardRaw = getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset');
  const keyboard = Number.parseFloat(keyboardRaw) || 0;
  if (barHeight > 0) {
    return barHeight + keyboard + 8;
  }
  return keyboard;
}

export default function ReaderSelectionBar({ anchor, scrollerRef, onNote, onAsk, onDismiss }) {
  const [bottomReserve, setBottomReserve] = useState(0);

  useLayoutEffect(() => {
    const measure = () => setBottomReserve(readBottomReserve());
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchor]);

  useEffect(() => {
    const el = scrollerRef?.current;
    if (!el || !anchor) return undefined;
    const start = el.scrollTop;
    const onScroll = () => {
      if (Math.abs(el.scrollTop - start) > 8) onDismiss();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [anchor, scrollerRef, onDismiss]);

  if (!anchor || typeof document === 'undefined') return null;

  const margin = 8;
  const barHeight = 52;
  const maxTop = window.innerHeight - bottomReserve - barHeight - margin;
  let top = anchor.top < 88 ? anchor.bottom + margin : Math.max(margin, anchor.top - barHeight);
  if (top > maxTop) top = Math.max(margin, maxTop);
  const left = Math.min(
    Math.max(margin, anchor.left),
    Math.max(margin, window.innerWidth - 168),
  );

  return createPortal(
    <div className="selection-action-bar" style={{ top, left }}>
      <button
        type="button"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onNote}
      >
        Note
      </button>
      <button
        type="button"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onAsk}
      >
        Ask
      </button>
    </div>,
    document.body,
  );
}
