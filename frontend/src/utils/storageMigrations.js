import { STORAGE_KEYS } from './storage';

export const STORAGE_SCHEMA_VERSION = 1;
export const SW_RELOAD_GUARD_KEY = 'readingPalSwReloaded';

const VALID_THEME_OVERRIDES = new Set(['light', 'dark', 'sepia']);

const migrations = [
  {
    from: 0,
    to: 1,
    run() {
      const saved = localStorage.getItem(STORAGE_KEYS.THEME_OVERRIDE);
      if (saved && !VALID_THEME_OVERRIDES.has(saved)) {
        localStorage.removeItem(STORAGE_KEYS.THEME_OVERRIDE);
      }
    },
  },
];

function getStoredSchemaVersion() {
  const raw = localStorage.getItem(STORAGE_KEYS.STORAGE_SCHEMA);
  const version = parseInt(raw, 10);
  return Number.isFinite(version) ? version : 0;
}

function getStoredDeployId() {
  return localStorage.getItem(STORAGE_KEYS.DEPLOY_ID) || null;
}

export function runStorageMigrations() {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }

  let version = getStoredSchemaVersion();
  for (const migration of migrations) {
    if (version === migration.from) {
      migration.run();
      version = migration.to;
      localStorage.setItem(STORAGE_KEYS.STORAGE_SCHEMA, String(version));
    }
  }

  if (version < STORAGE_SCHEMA_VERSION) {
    localStorage.setItem(STORAGE_KEYS.STORAGE_SCHEMA, String(STORAGE_SCHEMA_VERSION));
  }

  const deployId = process.env.REACT_APP_BUILD_ID || 'dev';
  const storedDeployId = getStoredDeployId();
  if (storedDeployId !== deployId) {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(SW_RELOAD_GUARD_KEY);
    }
    localStorage.setItem(STORAGE_KEYS.DEPLOY_ID, deployId);
  }
}
