import React, { useState, useEffect, useRef, useCallback } from 'react';
import './index.css'; // Assuming some global styles
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PdfUploadForm from './components/PdfUploadForm';
import BookView from './pages/BookView';
import BookList from './pages/BookList';
import NavBar from './components/NavBar';
import LoginPage from './pages/LoginPage'; // Import LoginPage
import AuthCallbackPage from './pages/AuthCallbackPage'; // Import AuthCallbackPage
import AdminLoginPage from './pages/AdminLoginPage'; // Import AdminLoginPage
import UserManagementPage from './pages/UserManagementPage'; // Import UserManagementPage
import { clearStoredAuthToken, getStoredAuthToken, setStoredAuthToken } from './utils/storage';

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
  const navBarMergeScrollRef = useRef(null);
  const [navBarScrollEpoch, setNavBarScrollEpoch] = useState(0);
  const bumpNavBarScrollSync = useCallback(() => setNavBarScrollEpoch((n) => n + 1), []);

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
            mergeScrollContainerRef={navBarMergeScrollRef}
            mergeScrollEpoch={navBarScrollEpoch}
          />
        )}
        <div className="app-content-shell">
          <Routes>
            {!authToken ? (
              <>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/admin/login" element={<AdminLoginPage setAuthToken={handleSetAuthToken} />} />
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
                      navBarMergeScrollRef={navBarMergeScrollRef}
                      bumpNavBarScrollSync={bumpNavBarScrollSync}
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
                      navBarMergeScrollRef={navBarMergeScrollRef}
                      bumpNavBarScrollSync={bumpNavBarScrollSync}
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
