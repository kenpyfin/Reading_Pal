import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './theme.css';
import './index.css';
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PdfUploadForm from './components/PdfUploadForm';
import BookView from './pages/BookView';
import BookList from './pages/BookList';
import NavBar from './components/NavBar';
import LoginPage from './pages/LoginPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import AdminLoginPage from './pages/AdminLoginPage';
import UserManagementPage from './pages/UserManagementPage';
import {
  clearStoredAuthToken,
  clearStoredThemeOverride,
  getStoredAuthToken,
  getStoredThemeOverride,
  setStoredAuthToken,
  setStoredThemeOverride,
} from './utils/storage';
import {
  applyThemeToDocument,
  getEffectiveTheme,
  getNextThemeOverride,
  getThemeMetaColor,
  subscribeToSystemTheme,
} from './utils/theme';

// Helper to decode JWT (simplified, use a library like jwt-decode in a real app for production)
const decodeJwt = (token) => {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    console.error("Failed to decode JWT:", e);
    return null;
  }
};

function App() {
  const [authToken, setAuthToken] = useState(() => getStoredAuthToken());
  const [isAdmin, setIsAdmin] = useState(false);

  const [navBarExtra, setNavBarExtra] = useState(null);
  const navBarActiveScrollRef = useRef(null);
  const [navBarScrollEpoch, setNavBarScrollEpoch] = useState(0);
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const bumpNavBarScrollSync = useCallback(() => setNavBarScrollEpoch((n) => n + 1), []);

  const [themeOverride, setThemeOverride] = useState(() => getStoredThemeOverride());
  const [systemThemeEpoch, setSystemThemeEpoch] = useState(0);
  const effectiveTheme = useMemo(
    () => getEffectiveTheme(themeOverride),
    [themeOverride, systemThemeEpoch],
  );

  useEffect(() => {
    applyThemeToDocument(effectiveTheme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', getThemeMetaColor(effectiveTheme));
    }
  }, [effectiveTheme]);

  useEffect(() => {
    if (themeOverride !== null) {
      return undefined;
    }
    return subscribeToSystemTheme(() => setSystemThemeEpoch((n) => n + 1));
  }, [themeOverride]);

  const handleThemeToggle = useCallback(() => {
    const next = getNextThemeOverride(themeOverride);
    setStoredThemeOverride(next);
    setThemeOverride(next);
  }, [themeOverride]);

  const handleUseSystemTheme = useCallback(() => {
    clearStoredThemeOverride();
    setThemeOverride(null);
    setSystemThemeEpoch((n) => n + 1);
  }, []);

  const themeToggleProps = {
    themeOverride,
    effectiveTheme,
    onToggle: handleThemeToggle,
    onUseSystem: handleUseSystemTheme,
  };

  useEffect(() => {
    const token = getStoredAuthToken();
    if (token) {
      setAuthToken(token); // Set the token state
      const decoded = decodeJwt(token); // Decode it
      if (decoded && decoded.is_admin) { // Check for admin claim
        setIsAdmin(true);
      } else {
        setIsAdmin(false);
      }
    }
    // If no token, isAdmin remains false (its initial state), which is correct.
  }, []);

  const handleSetAuthToken = (token) => {
    if (token) {
      setStoredAuthToken(token);
      const normalizedToken = getStoredAuthToken();
      if (!normalizedToken) {
        setIsAdmin(false);
        setAuthToken(null);
        return;
      }
      const decoded = decodeJwt(normalizedToken);
      if (decoded && decoded.is_admin) {
        setIsAdmin(true);
      } else {
        setIsAdmin(false);
      }
      setAuthToken(normalizedToken);
    } else {
      clearStoredAuthToken();
      setIsAdmin(false);
      setAuthToken(null);
    }
  };

  const handleLogout = () => {
    handleSetAuthToken(null); // This will remove from localStorage and update state
    // No need to navigate here, the conditional rendering will take care of it.
  };

  return (
    <div className="App">
      <Router>
        {authToken && (
          <NavBar
            onLogout={handleLogout}
            isAdmin={isAdmin}
            extra={navBarExtra}
            activeScrollContainerRef={navBarActiveScrollRef}
            activeScrollEpoch={navBarScrollEpoch}
            onChromeHiddenChange={setMobileChromeHidden}
            {...themeToggleProps}
          />
        )}
        <div className="app-content-shell">
          <Routes>
            {!authToken ? (
              <>
                <Route path="/login" element={<LoginPage {...themeToggleProps} />} />
                <Route
                  path="/admin/login"
                  element={<AdminLoginPage setAuthToken={handleSetAuthToken} {...themeToggleProps} />}
                />
                <Route
                  path="/auth/callback"
                  element={<AuthCallbackPage setAuthToken={handleSetAuthToken} />}
                />
                <Route path="*" element={<Navigate to="/login" replace />} />
              </>
            ) : isAdmin ? ( // Logged in and IS ADMIN
              <>
                <Route path="/admin/user-management" element={<UserManagementPage />} />
                {/* Decide if admins should access these or be redirected */}
                <Route path="/upload" element={<PdfUploadForm />} />
                <Route path="/book/:bookId" element={(
                    <BookView
                      setNavBarExtra={setNavBarExtra}
                      navBarActiveScrollRef={navBarActiveScrollRef}
                      bumpNavBarScrollSync={bumpNavBarScrollSync}
                      mobileChromeHidden={mobileChromeHidden}
                    />
                  )}
                  /> />
                <Route path="/" element={<Navigate to="/admin/user-management" replace />} />

                {/* Redirect login routes if admin is already logged in */}
                <Route path="/login" element={<Navigate to="/admin/user-management" replace />} />
                <Route path="/admin/login" element={<Navigate to="/admin/user-management" replace />} />
                <Route path="/auth/callback" element={<Navigate to="/admin/user-management" replace />} />
                {/* Catch-all for admin, redirect to their main page */}
                <Route path="*" element={<Navigate to="/admin/user-management" replace />} />
              </>
            ) : ( // Logged in and IS NOT ADMIN (regular user)
              <>
                <Route path="/" element={<BookList />} />
                <Route path="/upload" element={<PdfUploadForm />} />
                <Route path="/book/:bookId" element={(
                    <BookView
                      setNavBarExtra={setNavBarExtra}
                      navBarActiveScrollRef={navBarActiveScrollRef}
                      bumpNavBarScrollSync={bumpNavBarScrollSync}
                      mobileChromeHidden={mobileChromeHidden}
                    />
                  )}
                  /> />

                {/* Redirect login routes if regular user is already logged in */}
                <Route path="/login" element={<Navigate to="/" replace />} />
                <Route path="/admin/login" element={<Navigate to="/" replace />} /> {/* Prevent access */}
                <Route path="/auth/callback" element={<Navigate to="/" replace />} />
                {/* Prevent access to admin pages */}
                <Route path="/admin/user-management" element={<Navigate to="/" replace />} />
                {/* Catch-all for regular user, redirect to their main page */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </>
            )}
          </Routes>
        </div>
      </Router>
    </div>
  );
}

export default App;
