import React from 'react';
import { useNavigate } from 'react-router-dom';
import './AdminLoginPage.css'; // We'll create this CSS file

function AdminLoginPage({ setAuthToken }) {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const navigate = useNavigate();

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    try {
      const response = await fetch('/api/auth/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || 'Admin login failed');
      }

      if (data.access_token) {
        setAuthToken(data.access_token);
        navigate('/admin/user-management'); // Redirect to admin page
      } else {
        setError('Admin login failed: No token received.');
      }
    } catch (err) {
      setError(err.message || 'An error occurred during admin login.');
    }
  };

  return (
    <div className="admin-login-page-container">
      <div className="admin-login-box">
        <h1>Admin Login</h1>
        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label htmlFor="username">Username</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="input-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="error-message">{error}</p>}
          <button type="submit" className="admin-login-button">Login</button>
        </form>
        <p style={{ textAlign: 'center', marginTop: '20px' }}>
          <a href="/login">Back to User Login</a>
        </p>
      </div>
    </div>
  );
}

export default AdminLoginPage;
