// frontend/src/utils/logger.js

const LOG_LEVEL = process.env.REACT_APP_LOG_LEVEL || 'debug'; // Default to debug

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLogLevel = levels[LOG_LEVEL.toLowerCase()] !== undefined ? levels[LOG_LEVEL.toLowerCase()] : levels.debug;

const logger = {
  error: (...args) => {
    if (currentLogLevel >= levels.error) {
      console.error('[ERROR]', ...args);
    }
  },
  warn: (...args) => {
    if (currentLogLevel >= levels.warn) {
      console.warn('[WARN]', ...args);
    }
  },
  info: (...args) => {
    if (currentLogLevel >= levels.info) {
      console.info('[INFO]', ...args);
    }
  },
  debug: (...args) => {
    if (currentLogLevel >= levels.debug) {
      console.debug('[DEBUG]', ...args);
    }
  },
};

export default logger;
