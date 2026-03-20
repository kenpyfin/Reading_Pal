import { getStoredAuthToken } from './storage';

export function getAuthHeaders(additionalHeaders = {}) {
  const token = getStoredAuthToken();
  if (!token) {
    return null;
  }

  return {
    ...additionalHeaders,
    Authorization: `Bearer ${token}`,
  };
}
