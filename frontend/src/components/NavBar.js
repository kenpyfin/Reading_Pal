import React from 'react';
import { Link } from 'react-router-dom';
import './NavBar.css'; // Import the CSS file

function NavBar() {
  return (
    <nav className="navbar">
      <div className="navbar-container">
        <Link to="/" className="navbar-brand">
          Reading Pal
        </Link>
        <ul className="nav-links">
          <li>
            <Link to="/" className="nav-link">Book List</Link>
          </li>
          <li>
            <Link to="/upload" className="nav-link">Upload PDF</Link>
          </li>
          {/* Add more navigation links here if needed */}
        </ul>
      </div>
    </nav>
  );
}

export default NavBar;
