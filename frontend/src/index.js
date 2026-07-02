import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { runStorageMigrations, SW_RELOAD_GUARD_KEY } from './utils/storageMigrations';

runStorageMigrations();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

function registerServiceWorker() {
  const base = process.env.PUBLIC_URL || '';
  const path = `${base.endsWith('/') ? base.slice(0, -1) : base}/sw.js`;

  const notifyWaiting = (registration) => {
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (sessionStorage.getItem(SW_RELOAD_GUARD_KEY)) {
      return;
    }
    sessionStorage.setItem(SW_RELOAD_GUARD_KEY, '1');
    window.location.reload();
  });

  navigator.serviceWorker
    .register(path)
    .then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        notifyWaiting(registration);
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) {
          return;
        }
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            notifyWaiting(registration);
          }
        });
      });

      const checkForUpdates = () => {
        registration.update().catch(() => {});
      };

      checkForUpdates();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          checkForUpdates();
        }
      });
    })
    .catch(() => {});
}

if (process.env.NODE_ENV === 'production' && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', registerServiceWorker);
}
