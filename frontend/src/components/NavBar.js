import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';
import { createScrollChromeController } from '../utils/mobileScrollChrome';
import { matchesMobileLayout } from '../utils/mobileLayout';
import './NavBar.css';

function NavLinks({ isAdmin, onNavigate }) {
  if (isAdmin) {
    return (
      <ul className="nav-links">
        <li>
          <Link to="/admin/user-management" className="nav-link" onClick={onNavigate}>User Management</Link>
        </li>
        <li>
          <Link to="/settings/prompts" className="nav-link" onClick={onNavigate}>Guide prompts</Link>
        </li>
      </ul>
    );
  }
  return (
    <ul className="nav-links">
      <li>
        <Link to="/" className="nav-link" onClick={onNavigate}>Book List</Link>
      </li>
      <li>
        <Link to="/upload" className="nav-link" onClick={onNavigate}>Upload Book</Link>
      </li>
      <li>
        <Link to="/settings/prompts" className="nav-link" onClick={onNavigate}>Guide prompts</Link>
      </li>
    </ul>
  );
}

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
  const location = useLocation();
  const navRef = useRef(null);
  const [mobileNavHidden, setMobileNavHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const onChromeHiddenChangeRef = useRef(onChromeHiddenChange);
  onChromeHiddenChangeRef.current = onChromeHiddenChange;

  const isMobileViewport = useCallback(() => matchesMobileLayout(), []);

  const handleHiddenChange = useCallback((nextHidden) => {
    setMobileNavHidden(nextHidden);
    onChromeHiddenChangeRef.current?.(nextHidden);
  }, []);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (hidden || disableMobileScrollHide || menuOpen) {
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
        setMenuOpen(false);
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
    menuOpen,
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

  useEffect(() => {
    const el = navRef.current;
    if (!el || hidden) {
      document.documentElement.style.removeProperty('--app-nav-offset');
      return undefined;
    }
    const apply = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--app-nav-offset', `${height}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--app-nav-offset');
    };
  }, [hidden, menuOpen, extra, mobileNavHidden]);

  const handleLogoutClick = () => {
    closeMenu();
    if (onLogout) {
      onLogout();
    }
    navigate('/login');
  };

  if (hidden) {
    return null;
  }

  const themeToggle = onToggle ? (
    <ThemeToggle
      themeOverride={themeOverride}
      effectiveTheme={effectiveTheme}
      onToggle={onToggle}
      onUseSystem={onUseSystem}
    />
  ) : null;

  return (
    <nav
      ref={navRef}
      className={`navbar${mobileNavHidden ? ' navbar-hidden' : ''}${extra ? ' navbar-has-extra' : ''}${menuOpen ? ' navbar-menu-open' : ''}`}
    >
      <div className="navbar-container">
        {extra ? (
          <div className="navbar-extra" aria-label="Reading guide">
            {extra}
          </div>
        ) : (isAdmin ? (
          <Link to="/admin/user-management" className="navbar-brand">
            Admin Dashboard
          </Link>
        ) : (
          <Link to="/" className="navbar-brand">
            Reading Pal
          </Link>
        ))}
        <div className="navbar-desktop">
          <NavLinks isAdmin={isAdmin} />
          <ul className="nav-links nav-links-right">
            {themeToggle && (
              <li className="nav-theme-toggle-item">
                {themeToggle}
              </li>
            )}
            <li>
              <button type="button" onClick={handleLogoutClick} className="nav-link logout-button">
                Logout
              </button>
            </li>
          </ul>
        </div>
        <button
          type="button"
          className="navbar-menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="navbar-menu-panel"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </div>
      {menuOpen && (
        <div id="navbar-menu-panel" className="navbar-menu-panel">
          <NavLinks isAdmin={isAdmin} onNavigate={closeMenu} />
          <div className="navbar-menu-footer">
            {themeToggle}
            <button type="button" onClick={handleLogoutClick} className="nav-link logout-button">
              Logout
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}

export default NavBar;
