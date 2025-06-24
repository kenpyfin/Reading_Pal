import React, { useState, useEffect, useCallback } from 'react';
import './UserManagementPage.css'; // We'll create this CSS file

function UserManagementPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    const token = localStorage.getItem('authToken');
    if (!token) {
      setError("Authentication token not found. Please log in.");
      setLoading(false);
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
      setError(err.message || "Failed to fetch users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

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
      const response = await fetch(`/api/auth/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        // For 204 No Content, response.json() will fail. Check status first.
        if (response.status === 204) {
          // Success
          setUsers(prevUsers => prevUsers.filter(user => user.id !== userId));
          alert(`User "${userEmail || userId}" deleted successfully.`);
        } else {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
        }
      } else {
         // This case handles 204 No Content correctly as well if response.ok is true for it
        setUsers(prevUsers => prevUsers.filter(user => user.id !== userId));
        alert(`User "${userEmail || userId}" deleted successfully.`);
      }
    } catch (err) {
      setError(err.message || "Failed to delete user.");
      alert(`Error deleting user: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  if (loading && users.length === 0) { // Show loading only on initial load
    return <div className="user-management-container"><p>Loading users...</p></div>;
  }

  if (error) {
    return <div className="user-management-container"><p className="error-message">Error: {error}</p></div>;
  }

  return (
    <div className="user-management-container">
      <h1>User Management</h1>
      {users.length === 0 && !loading ? (
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
                <td>{new Date(user.created_at).toLocaleString()}</td>
                <td>
                  <button
                    onClick={() => handleDeleteUser(user.id, user.email)}
                    disabled={deletingId === user.id}
                    className="delete-button"
                  >
                    {deletingId === user.id ? 'Deleting...' : 'Delete'}
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
