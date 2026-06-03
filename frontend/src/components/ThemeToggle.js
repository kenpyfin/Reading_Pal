import React from 'react';
import './ThemeToggle.css';

function ThemeToggle({ themeOverride, effectiveTheme, onToggle, onUseSystem }) {
  const followingSystem = themeOverride === null;
  const isDark = effectiveTheme === 'dark';

  let ariaLabel;
  if (followingSystem) {
    ariaLabel = `Appearance follows system (${isDark ? 'dark' : 'light'}). Click to set a fixed theme.`;
  } else {
    ariaLabel = `Appearance set to ${isDark ? 'dark' : 'light'}. Click to switch.`;
  }

  return (
    <div className="theme-toggle">
      <button
        type="button"
        className={`theme-toggle-btn${followingSystem ? ' theme-toggle-btn--system' : ''}`}
        onClick={onToggle}
        aria-label={ariaLabel}
        aria-pressed={!followingSystem}
        title={ariaLabel}
      >
        {followingSystem ? (
          <span className="theme-toggle-icon" aria-hidden="true">Auto</span>
        ) : isDark ? (
          <span className="theme-toggle-icon" aria-hidden="true">☀</span>
        ) : (
          <span className="theme-toggle-icon" aria-hidden="true">☾</span>
        )}
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
