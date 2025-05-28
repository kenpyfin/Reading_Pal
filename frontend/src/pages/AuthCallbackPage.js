import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

// Helper function to parse query parameters
function useQuery() {
  return new URLSearchParams(useLocation().search);
}

function AuthCallbackPage({ setAuthToken }) {
  const navigate = useNavigate();
  const query = useQuery();

  useEffect(() => {
    const token = query.get('token');
    if (token) {
      console.log("Token received from callback:", token);
      localStorage.setItem('authToken', token);
      setAuthToken(token); // Update auth state in App.js
      navigate('/'); // Redirect to homepage (BookList)
    } else {
      console.error("Auth callback: No token found in URL.");
      // Handle error, e.g., redirect to login page with an error message
      navigate('/login?error=auth_failed');
    }
  }, [navigate, query, setAuthToken]);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', flexDirection: 'column' }}>
      <h2>Processing authentication...</h2>
      <p>Please wait while we redirect you.</p>
      {/* You can add a spinner or loading animation here */}
    </div>
  );
}

export default AuthCallbackPage;
