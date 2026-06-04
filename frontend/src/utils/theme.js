export const THEME_OVERRIDE_CYCLE = ['light', 'dark', 'sepia'];

export function getSystemPrefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function getEffectiveTheme(override) {
  if (override === 'light' || override === 'dark' || override === 'sepia') {
    return override;
  }
  return getSystemPrefersDark() ? 'dark' : 'light';
}

export function getNextThemeOverride(currentOverride) {
  if (currentOverride === null) {
    return THEME_OVERRIDE_CYCLE[0];
  }
  const index = THEME_OVERRIDE_CYCLE.indexOf(currentOverride);
  if (index === -1) {
    return THEME_OVERRIDE_CYCLE[0];
  }
  return THEME_OVERRIDE_CYCLE[(index + 1) % THEME_OVERRIDE_CYCLE.length];
}

export function applyThemeToDocument(theme) {
  if (typeof document === 'undefined') {
    return;
  }
  const resolved = theme === 'dark' || theme === 'sepia' || theme === 'light' ? theme : 'light';
  document.documentElement.setAttribute('data-theme', resolved);
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
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
  if (theme === 'dark') {
    return '#111113';
  }
  if (theme === 'sepia') {
    return '#FBF0D9';
  }
  return '#fcfcfd';
}

export function getThemeLabel(theme) {
  if (theme === 'dark') {
    return 'dark';
  }
  if (theme === 'sepia') {
    return 'sepia';
  }
  return 'light';
}
