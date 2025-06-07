import React, { useState, useEffect } from 'react';
import './index.css'; // Assuming some global styles
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PdfUploadForm from './components/PdfUploadForm';
import BookView from './pages/BookView';
import BookList from './pages/BookList';
import NavBar from './components/NavBar';
import LoginPage from './pages/LoginPage'; // Import LoginPage
import AuthCallbackPage from './pages/AuthCallbackPage'; // Import AuthCallbackPage

function App() {
  const [authToken, setAuthToken] = useState(localStorage.getItem('authToken'));

  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (token) {
      setAuthToken(token);
    }
  }, []);

  const handleSetAuthToken = (token) => {
    if (token) {
      localStorage.setItem('authToken', token);
    } else {
      localStorage.removeItem('authToken');
    }
    setAuthToken(token);
  };

  const handleLogout = () => {
    handleSetAuthToken(null); // This will remove from localStorage and update state
    // No need to navigate here, the conditional rendering will take care of it.
  };

  return (
    <div className="App">
      <Router>
        {authToken && <NavBar onLogout={handleLogout} />} {/* Show NavBar only if authenticated */}
        <Routes>
          {!authToken ? (
            <>
              <Route path="/login" element={<LoginPage />} />
              <Route 
                path="/auth/callback" 
                element={<AuthCallbackPage setAuthToken={handleSetAuthToken} />} 
              />
              {/* Redirect any other path to /login if not authenticated */}
              <Route path="*" element={<Navigate to="/login" replace />} />
            </>
          ) : (
            <>
              {/* Authenticated routes */}
              <Route path="/" element={<BookList />} />
              <Route path="/upload" element={<PdfUploadForm />} />
              <Route path="/book/:bookId" element={<BookView />} />
              {/* Redirect /login to / if already authenticated */}
              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route path="/auth/callback" element={<Navigate to="/" replace />} /> 
              {/* Optional: Redirect any other unknown authenticated path to home */}
              {/* <Route path="*" element={<Navigate to="/" replace />} /> */}
            </>
          )}
        </Routes>
      </Router>
    </div>
  );
}

export default App;
