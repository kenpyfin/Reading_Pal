import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';
import './LoginPage.css';

function LoginPage({
  themeOverride = null,
  effectiveTheme = 'light',
  onToggle,
  onUseSystem,
}) {
  const [errorMessage, setErrorMessage] = useState('');
  const location = useLocation();

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
        <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px' }}>
          <a href="/admin/login">Admin Login</a>
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
