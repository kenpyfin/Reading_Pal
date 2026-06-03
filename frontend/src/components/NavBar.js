import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';
import './NavBar.css';

const MOBILE_MAX_WIDTH = 768;
const SCROLL_DELTA_THRESHOLD = 6;

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

function NavBar({
  onLogout,
  isAdmin,
  hidden = false,
  disableMobileScrollHide = false,
  extra = null,
  mergeScrollContainerRef = null,
  mergeScrollEpoch = 0,
  themeOverride = null,
  effectiveTheme = 'light',
  onToggle,
  onUseSystem,
}) {
  const navigate = useNavigate();
  const [mobileNavHidden, setMobileNavHidden] = useState(false);
  const isMobileViewport = useCallback(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX_WIDTH,
    [],
  );

  const applyScrollDelta = useCallback((event, lastScrollTopByTarget, setHidden) => {
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
      setHidden(false);
      return;
    }
    if (delta > SCROLL_DELTA_THRESHOLD) {
      setHidden(true);
    } else if (delta < -SCROLL_DELTA_THRESHOLD) {
      setHidden(false);
    }
  }, []);

  useEffect(() => {
    if (hidden || disableMobileScrollHide) {
      setMobileNavHidden(false);
      return undefined;
    }

    const lastScrollTopByTarget = new Map();

    const onScroll = (event) => {
      if (!isMobileViewport()) {
        return;
      }
      applyScrollDelta(event, lastScrollTopByTarget, setMobileNavHidden);
    };

    const onResize = () => {
      if (!isMobileViewport()) {
        setMobileNavHidden(false);
      }
    };

    const scrollListenerOptions = { capture: true, passive: true };
    document.addEventListener('scroll', onScroll, scrollListenerOptions);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('scroll', onScroll, scrollListenerOptions);
      window.removeEventListener('resize', onResize);
    };
  }, [isMobileViewport, hidden, disableMobileScrollHide, applyScrollDelta]);

  useEffect(() => {
    if (hidden || disableMobileScrollHide || !isMobileViewport() || !extra || !mergeScrollContainerRef) {
      return undefined;
    }
    const lastScrollTopByTarget = new Map();
    const onMergedScroll = (event) => {
      applyScrollDelta(event, lastScrollTopByTarget, setMobileNavHidden);
    };
    const el = mergeScrollContainerRef.current;
    if (!el) {
      return undefined;
    }
    el.addEventListener('scroll', onMergedScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onMergedScroll);
    };
  }, [
    hidden,
    disableMobileScrollHide,
    isMobileViewport,
    extra,
    mergeScrollContainerRef,
    mergeScrollEpoch,
    applyScrollDelta,
  ]);

  useEffect(() => {
    if (hidden || !isMobileViewport()) {
      document.documentElement.removeAttribute('data-mobile-navbar-hidden');
      return undefined;
    }
    document.documentElement.setAttribute(
      'data-mobile-navbar-hidden',
      mobileNavHidden ? '1' : '0',
    );
    return () => {
      document.documentElement.removeAttribute('data-mobile-navbar-hidden');
    };
  }, [hidden, mobileNavHidden, isMobileViewport]);

  const handleLogoutClick = () => {
    if (onLogout) {
      onLogout();
    }
    navigate('/login');
  };

  if (hidden) {
    return null;
  }

  const showMobileExtra = !!extra;

  return (
    <nav
      className={`navbar${mobileNavHidden ? ' navbar-hidden' : ''}${extra ? ' navbar-has-extra' : ''}`}
    >
      <div className={`navbar-container${showMobileExtra ? ' navbar-container--mobile-extra' : ''}`}>
        {!showMobileExtra && (isAdmin ? (
          <Link to="/admin/user-management" className="navbar-brand">
            Admin Dashboard
          </Link>
        ) : (
          <Link to="/" className="navbar-brand">
            Reading Pal
          </Link>
        ))}
        {showMobileExtra && (
          <div className="navbar-extra" aria-label="Reading guide">
            {extra}
          </div>
        )}
        {!isAdmin && (
          <ul className="nav-links">
            <li>
              <Link to="/" className="nav-link">Book List</Link>
            </li>
            <li>
              <Link to="/upload" className="nav-link">Upload Book</Link>
            </li>
          </ul>
        )}
        {isAdmin && (
          <ul className="nav-links">
            <li>
              <Link to="/admin/user-management" className="nav-link">User Management</Link>
            </li>
          </ul>
        )}
        <ul className="nav-links nav-links-right">
          {onToggle && (
            <li className="nav-theme-toggle-item">
              <ThemeToggle
                themeOverride={themeOverride}
                effectiveTheme={effectiveTheme}
                onToggle={onToggle}
                onUseSystem={onUseSystem}
              />
            </li>
          )}
          <li>
            <button type="button" onClick={handleLogoutClick} className="nav-link logout-button">
              Logout
            </button>
          </li>
        </ul>
      </div>
    </nav>
  );
}

export default NavBar;
