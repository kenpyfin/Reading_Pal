import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';
import { createScrollChromeController } from '../utils/mobileScrollChrome';
import './NavBar.css';

const MOBILE_MAX_WIDTH = 768;

function NavBar({
  onLogout,
  isAdmin,
  hidden = false,
  disableMobileScrollHide = false,
  extra = null,
  activeScrollContainerRef = null,
  activeScrollEpoch = 0,
  onChromeHiddenChange = null,
  themeOverride = null,
  effectiveTheme = 'light',
  onToggle,
  onUseSystem,
}) {
  const navigate = useNavigate();
  const [mobileNavHidden, setMobileNavHidden] = useState(false);
  const onChromeHiddenChangeRef = useRef(onChromeHiddenChange);
  onChromeHiddenChangeRef.current = onChromeHiddenChange;

  const isMobileViewport = useCallback(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX_WIDTH,
    [],
  );

  const handleHiddenChange = useCallback((nextHidden) => {
    setMobileNavHidden(nextHidden);
    onChromeHiddenChangeRef.current?.(nextHidden);
  }, []);

  useEffect(() => {
    if (hidden || disableMobileScrollHide) {
      setMobileNavHidden(false);
      onChromeHiddenChangeRef.current?.(false);
      return undefined;
    }

    if (!isMobileViewport()) {
      setMobileNavHidden(false);
      onChromeHiddenChangeRef.current?.(false);
      return undefined;
    }

    const controller = createScrollChromeController({
      onHiddenChange: handleHiddenChange,
    });

    const attach = () => {
      const el = activeScrollContainerRef?.current;
      if (!el) {
        controller.reset();
        return undefined;
      }

      const onScroll = (event) => {
        if (!isMobileViewport()) return;
        controller.onScroll(event, el);
      };

      el.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        el.removeEventListener('scroll', onScroll);
      };
    };

    let detach = attach();

    const onResize = () => {
      if (!isMobileViewport()) {
        controller.reset();
      }
    };

    window.addEventListener('resize', onResize);
    return () => {
      if (detach) detach();
      window.removeEventListener('resize', onResize);
      controller.reset();
    };
  }, [
    hidden,
    disableMobileScrollHide,
    isMobileViewport,
    activeScrollContainerRef,
    activeScrollEpoch,
    handleHiddenChange,
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
