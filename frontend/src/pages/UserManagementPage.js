import React, { useState, useEffect, useCallback } from 'react';
import './UserManagementPage.css'; // We'll create this CSS file

function UserManagementPage() {
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState({ total_users: 0, total_books: 0, total_notes: 0 });
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingStats, setLoadingStats] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    // setError(null); // Keep error state for overall page, or separate for users/stats
    const token = localStorage.getItem('authToken');
    if (!token) {
      setError("Authentication token not found. Please log in.");
      setLoadingUsers(false);
      return;
    }

    try {
      const response = await fetch('/api/auth/admin/users', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setUsers(data);
    } catch (err) {
      setError(prevError => prevError ? `${prevError}\nFailed to fetch users: ${err.message}` : `Failed to fetch users: ${err.message}`);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    setLoadingStats(true);
    const token = localStorage.getItem('authToken');
    if (!token) {
      // Error already handled by fetchUsers or will be shown globally
      setLoadingStats(false);
      return;
    }
    try {
      const response = await fetch('/api/auth/admin/stats', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setStats(data);
    } catch (err) {
      setError(prevError => prevError ? `${prevError}\nFailed to fetch stats: ${err.message}` : `Failed to fetch stats: ${err.message}`);
    } finally {
      setLoadingStats(false);
    }
  }, []);


  useEffect(() => {
    fetchUsers();
    fetchStats();
  }, [fetchUsers, fetchStats]);

  const handleDeleteUser = async (userId, userEmail) => {
    if (!window.confirm(`Are you sure you want to delete the user "${userEmail || userId}"? This action cannot be undone.`)) {
      return;
    }
    setDeletingId(userId);
    setError(null);
    const token = localStorage.getItem('authToken');
    if (!token) {
      setError("Authentication token not found. Please log in.");
      setDeletingId(null);
      return;
    }

    try {
      const response = await fetch(`/api/auth/admin/users/${googleIdToDelete}`, { // Use googleIdToDelete in URL
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        // For 204 No Content, response.json() will fail. Check status first.
        if (response.status === 204) {
          // Success
          setUsers(prevUsers => prevUsers.filter(user => user.google_id !== googleIdToDelete)); // Filter by google_id
          alert(`User "${userEmail || googleIdToDelete}" deleted successfully.`);
        } else {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
        }
      } else {
         // This case handles 204 No Content correctly as well if response.ok is true for it
        setUsers(prevUsers => prevUsers.filter(user => user.google_id !== googleIdToDelete)); // Filter by google_id
        alert(`User "${userEmail || googleIdToDelete}" deleted successfully.`);
      }
    } catch (err) {
      setError(err.message || "Failed to delete user.");
      alert(`Error deleting user: ${err.message}`);
    } finally {
      setDeletingId(null); // Clear deletingId (which was google_id)
    }
  };

  if (error) { // Display general error first
    return <div className="user-management-container"><p className="error-message">Error: {error}</p></div>;
  }
  
  if ((loadingUsers && users.length === 0) || loadingStats) {
    return <div className="user-management-container"><p>Loading dashboard data...</p></div>;
  }

  return (
    <div className="user-management-container">
      <h1>Admin Dashboard</h1>

      <div className="stats-container">
        <div className="stat-card">
          <h2>Total Users</h2>
          <p>{stats.total_users}</p>
        </div>
        <div className="stat-card">
          <h2>Total Books</h2>
          <p>{stats.total_books}</p>
        </div>
        <div className="stat-card">
          <h2>Total Notes</h2>
          <p>{stats.total_notes}</p>
        </div>
      </div>

      <h2>User Management</h2>
      {users.length === 0 && !loadingUsers ? (
        <p>No users found.</p>
      ) : (
        <table className="users-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Email</th>
              <th>Full Name</th>
              <th>Google ID</th>
              <th>Active</th>
              <th>Book Count</th>
              <th>Note Count</th>
              <th>Created At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.id}>
                <td>{user.id}</td>
                <td>{user.email || 'N/A'}</td>
                <td>{user.full_name || 'N/A'}</td>
                <td>{user.google_id || 'N/A'}</td>
                <td>{user.is_active ? 'Yes' : 'No'}</td>
                <td>{user.book_count !== undefined ? user.book_count : 'N/A'}</td>
                <td>{user.note_count !== undefined ? user.note_count : 'N/A'}</td>
                <td>{new Date(user.created_at).toLocaleString()}</td>
                <td>
                  <button
                    onClick={() => handleDeleteUser(user.google_id, user.email)} // Pass user.google_id
                    disabled={deletingId === user.google_id || !user.google_id} // Disable if deleting or no google_id
                    className="delete-button"
                  >
                    {deletingId === user.google_id ? 'Deleting...' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default UserManagementPage;
