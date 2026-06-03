export function getSystemPrefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function getEffectiveTheme(override) {
  if (override === 'light') {
    return 'light';
  }
  if (override === 'dark') {
    return 'dark';
  }
  return getSystemPrefersDark() ? 'dark' : 'light';
}

export function applyThemeToDocument(theme) {
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}

export function subscribeToSystemTheme(callback) {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {};
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => callback();
  if (media.addEventListener) {
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }
  media.addListener(handler);
  return () => media.removeListener(handler);
}

export function getThemeMetaColor(theme) {
  return theme === 'dark' ? '#121212' : '#ffffff';
}
