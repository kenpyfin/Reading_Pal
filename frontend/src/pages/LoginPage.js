import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';
import './LoginPage.css';

function isDevLoginHost(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return true;
  }
  const parts = String(hostname || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const nums = parts.map(Number);
  if (nums.some((n) => n > 255)) {
    return false;
  }
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function LoginPage({
  setAuthToken,
  themeOverride = null,
  effectiveTheme = 'light',
  onToggle,
  onUseSystem,
}) {
  const [errorMessage, setErrorMessage] = useState('');
  const [devLoginPending, setDevLoginPending] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const showLocalDevLogin = isDevLoginHost(window.location.hostname);

  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    if (queryParams.get('error') === 'inactive_user') {
      setErrorMessage('Your account is inactive. Please contact an administrator.');
    }
  }, [location]);

  const handleLogin = () => {
    // Redirect to the backend Google login endpoint
    // Ensure this matches the BACKEND_URL if your frontend and backend are on different ports/domains during development
    // For a same-origin setup (proxied via Nginx), /api/auth/login/google should work.
    // If your backend is on, for example, http://localhost:8000, use that full URL.
    // Assuming backend is on the same origin or proxied.
    window.location.href = '/api/auth/login/google';
  };

  const handleLocalDevLogin = async () => {
    setErrorMessage('');
    setDevLoginPending(true);
    try {
      const response = await fetch('/api/auth/dev/login', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof data.detail === 'string' ? data.detail : 'Local login failed';
        throw new Error(detail);
      }
      if (!data.access_token) {
        throw new Error('Local login failed: no token received.');
      }
      setAuthToken(data.access_token);
      navigate('/');
    } catch (err) {
      setErrorMessage(err.message || 'Local login failed');
    } finally {
      setDevLoginPending(false);
    }
  };

  return (
    <div className="login-page-container">
      {onToggle && (
        <ThemeToggle
          themeOverride={themeOverride}
          effectiveTheme={effectiveTheme}
          onToggle={onToggle}
          onUseSystem={onUseSystem}
        />
      )}
      <div className="login-box">
        <h1>Welcome to Reading Pal</h1>
        <p>Please sign in to continue.</p>
        {errorMessage && <p className="login-error-message">{errorMessage}</p>}
        <button onClick={handleLogin} className="google-login-button">
          <img 
            src="https://developers.google.com/identity/images/g-logo.png" 
            alt="Google logo" 
            className="google-logo"
          />
          Sign in with Google
        </button>
        {showLocalDevLogin && (
          <>
            <button
              type="button"
              onClick={handleLocalDevLogin}
              className="local-dev-login-button"
              disabled={devLoginPending}
            >
              {devLoginPending ? 'Signing in…' : 'Continue as lgyhz1234@gmail'}
            </button>
            <p className="local-dev-login-note">
              Local and private-LAN only. Opens the existing lgyhz1234@gmail.com library.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default LoginPage;
