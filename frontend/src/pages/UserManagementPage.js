import React, { useState, useEffect, useCallback } from 'react';
import './UserManagementPage.css'; // We'll create this CSS file

function UserManagementPage() {
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState({ total_users: 0, total_books: 0, total_notes: 0 });
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingStats, setLoadingStats] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null); // Tracks google_id for deletion
  const [togglingStatusId, setTogglingStatusId] = useState(null); // Tracks google_id for status toggle

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

  const handleDeleteUser = async (googleIdToDelete, userEmail) => { // Parameter renamed for clarity
    if (!googleIdToDelete) {
      alert("Error: User Google ID is missing. Cannot proceed with deletion.");
      console.error("handleDeleteUser was called with an undefined or invalid Google ID:", googleIdToDelete);
      return;
    }
    if (!window.confirm(`Are you sure you want to delete the user "${userEmail || googleIdToDelete}"? This action cannot be undone.`)) {
      return;
    }
    setDeletingId(googleIdToDelete); // Track deletion by google_id
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

  const handleToggleUserStatus = async (googleIdToToggle, currentStatus) => {
    if (!googleIdToToggle) {
      alert("Error: User Google ID is missing. Cannot proceed with status toggle.");
      console.error("handleToggleUserStatus was called with an undefined or invalid Google ID:", googleIdToToggle);
      return;
    }
    const newStatus = !currentStatus;
    const action = newStatus ? "activate" : "deactivate";
    if (!window.confirm(`Are you sure you want to ${action} this user?`)) {
      return;
    }

    setTogglingStatusId(googleIdToToggle);
    setError(null); // Clear previous errors
    const token = localStorage.getItem('authToken');
    if (!token) {
      setError("Authentication token not found. Please log in.");
      setTogglingStatusId(null);
      return;
    }

    try {
      const response = await fetch(`/api/auth/admin/users/${googleIdToToggle}/status`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ is_active: newStatus }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
      }
      
      const updatedUser = await response.json();
      // Update the user in the local state
      setUsers(prevUsers => prevUsers.map(user => 
        user.google_id === googleIdToToggle ? { ...user, ...updatedUser } : user
      ));
      alert(`User successfully ${action}d.`);

    } catch (err) {
      setError(err.message || `Failed to ${action} user.`);
      alert(`Error ${action}ing user: ${err.message}`);
    } finally {
      setTogglingStatusId(null);
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
                    onClick={() => handleDeleteUser(user.google_id, user.email)}
                    disabled={deletingId === user.google_id || togglingStatusId === user.google_id || !user.google_id}
                    className="delete-button"
                  >
                    {deletingId === user.google_id ? 'Deleting...' : 'Delete'}
                  </button>
                  <button
                    onClick={() => handleToggleUserStatus(user.google_id, user.is_active)}
                    disabled={deletingId === user.google_id || togglingStatusId === user.google_id || !user.google_id}
                    className={user.is_active ? "deactivate-button" : "activate-button"}
                  >
                    {togglingStatusId === user.google_id ? 'Updating...' : (user.is_active ? 'Deactivate' : 'Activate')}
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
