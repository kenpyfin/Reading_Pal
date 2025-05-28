import React from 'react';
import './LoginPage.css'; // We'll create this CSS file next

function LoginPage() {
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
      <div className="login-box">
        <h1>Welcome to Reading Pal</h1>
        <p>Please sign in to continue.</p>
        <button onClick={handleLogin} className="google-login-button">
          <img 
            src="https://developers.google.com/identity/images/g-logo.png" 
            alt="Google logo" 
            className="google-logo"
          />
          Sign in with Google
        </button>
      </div>
    </div>
  );
}

export default LoginPage;
