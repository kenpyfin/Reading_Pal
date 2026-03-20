const STORAGE_KEYS = {
  AUTH_TOKEN: 'authToken',
};

const READING_POSITION_PREFIX = 'readingPalLastPosition_';
const READING_VIEW_MODE_PREFIX = 'readingPalViewMode_';

function sanitizeToken(rawToken) {
  if (typeof rawToken !== 'string') {
    return null;
  }

  const token = rawToken.trim().replace(/(\r\n|\n|\r)/gm, '');
  if (!token || token === 'null' || token === 'undefined') {
    return null;
  }

  return token;
}

function getReadingPositionKey(bookId) {
  return `${READING_POSITION_PREFIX}${bookId}`;
}

function getReadingViewModeKey(bookId) {
  return `${READING_VIEW_MODE_PREFIX}${bookId}`;
}

export function getStoredAuthToken() {
  return sanitizeToken(localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN));
}

export function setStoredAuthToken(token) {
  const sanitizedToken = sanitizeToken(token);
  if (!sanitizedToken) {
    localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
    return;
  }

  localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, sanitizedToken);
}

export function clearStoredAuthToken() {
  localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
}

export function getStoredReadingPosition(bookId) {
  if (!bookId) {
    return null;
  }

  const raw = localStorage.getItem(getReadingPositionKey(bookId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    return parsed;
  } catch (_error) {
    return null;
  }
}

export function setStoredReadingPosition(bookId, position) {
  if (!bookId || !position || typeof position !== 'object') {
    return;
  }

  localStorage.setItem(getReadingPositionKey(bookId), JSON.stringify(position));
}

export function getStoredReadingViewMode(bookId) {
  if (!bookId) {
    return 'original';
  }

  const saved = localStorage.getItem(getReadingViewModeKey(bookId));
  return saved === 'guide' ? 'guide' : 'original';
}

export function setStoredReadingViewMode(bookId, viewMode) {
  if (!bookId) {
    return;
  }

  const normalized = viewMode === 'guide' ? 'guide' : 'original';
  localStorage.setItem(getReadingViewModeKey(bookId), normalized);
}
