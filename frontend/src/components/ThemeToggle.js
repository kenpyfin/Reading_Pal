import React from 'react';
import './ThemeToggle.css';
import { getThemeLabel } from '../utils/theme';

function ThemeToggle({ themeOverride, effectiveTheme, onToggle, onUseSystem }) {
  const followingSystem = themeOverride === null;
  const themeLabel = getThemeLabel(effectiveTheme);

  let ariaLabel;
  if (followingSystem) {
    ariaLabel = `Appearance follows system (${themeLabel}). Click to set a fixed theme.`;
  } else {
    ariaLabel = `Appearance set to ${themeLabel}. Click to switch theme.`;
  }

  let icon;
  if (followingSystem) {
    icon = 'Auto';
  } else if (themeOverride === 'sepia') {
    icon = 'Sep';
  } else if (themeOverride === 'dark') {
    icon = '☀';
  } else {
    icon = '☾';
  }

  return (
    <div className="theme-toggle">
      <button
        type="button"
        className={`theme-toggle-btn${followingSystem ? ' theme-toggle-btn--system' : ''}${themeOverride === 'sepia' ? ' theme-toggle-btn--sepia' : ''}`}
        onClick={onToggle}
        aria-label={ariaLabel}
        aria-pressed={!followingSystem}
        title={ariaLabel}
      >
        <span className="theme-toggle-icon" aria-hidden="true">{icon}</span>
      </button>
      {!followingSystem && (
        <button
          type="button"
          className="theme-toggle-auto"
          onClick={onUseSystem}
          aria-label="Use system appearance"
          title="Use system appearance"
        >
          Auto
        </button>
      )}
    </div>
  );
}

export default ThemeToggle;
