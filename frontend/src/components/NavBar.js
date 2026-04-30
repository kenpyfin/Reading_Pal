import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import './NavBar.css'; // Import the CSS file

function NavBar({ onLogout, isAdmin }) { // Accept onLogout and isAdmin props
  const navigate = useNavigate();

  const handleLogoutClick = () => {
    if (onLogout) {
      onLogout();
    }
    // App.js will handle redirecting to /login due to authToken becoming null
    // However, explicitly navigating can be a fallback or for immediate UI update feel.
    navigate('/login'); 
  };

  return (
    <nav className="navbar">
      <div className="navbar-container">
        {isAdmin ? (
          <Link to="/admin/user-management" className="navbar-brand">
            Admin Dashboard
          </Link>
        ) : (
          <Link to="/" className="navbar-brand">
            Reading Pal
          </Link>
        )}
        {!isAdmin && (
          <ul className="nav-links">
            <li>
              <Link to="/" className="nav-link">Book List</Link>
            </li>
            <li>
              <Link to="/upload" className="nav-link">Upload Book</Link>
            </li>
            {/* Add more navigation links here if needed for regular users */}
          </ul>
        )}
        {isAdmin && (
          <ul className="nav-links">
            <li>
              <Link to="/admin/user-management" className="nav-link">User Management</Link>
            </li>
            {/* Add other admin-specific links here if needed in the future */}
          </ul>
        )}
        <ul className="nav-links nav-links-right">
          <li>
            <button onClick={handleLogoutClick} className="nav-link logout-button">
              Logout
            </button>
          </li>
        </ul>
      </div>
    </nav>
  );
}

export default NavBar;
