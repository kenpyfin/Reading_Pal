/**
 * Serves the production React build and proxies /api and /images to the backend.
 * The frontend container has no Nginx, so without this proxy the browser receives
 * index.html for /api/* and Google (or any) login never reaches FastAPI.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.FRONTEND_PORT || 3100);
const BACKEND_PORT = process.env.BACKEND_PORT || '8501';
const BACKEND_TARGET = process.env.BACKEND_PROXY_TARGET
  || `http://host.docker.internal:${BACKEND_PORT}`;
const BUILD_DIR = path.join(__dirname, 'build');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function isProxied(urlPath) {
  return urlPath === '/api'
    || urlPath.startsWith('/api/')
    || urlPath === '/images'
    || urlPath.startsWith('/images/');
}

function safeBuildPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded.replace(/^[/\\]+/, '');
  if (!rel || rel === '.') {
    return path.join(BUILD_DIR, 'index.html');
  }
  if (rel.split(/[/\\]/).includes('..')) {
    return null;
  }
  const filePath = path.resolve(BUILD_DIR, rel);
  if (filePath !== BUILD_DIR && !filePath.startsWith(`${BUILD_DIR}${path.sep}`)) {
    return null;
  }
  return filePath;
}

function proxy(req, res) {
  let target;
  try {
    target = new URL(BACKEND_TARGET);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Invalid BACKEND_PROXY_TARGET');
    return;
  }

  const headers = { ...req.headers };
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    method: req.method,
    headers,
  };
  const preq = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`Backend proxy error: ${err.message}`);
  });
  req.pipe(preq);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (readErr, data) => {
    if (readErr) {
      const indexPath = path.join(BUILD_DIR, 'index.html');
      fs.readFile(indexPath, (indexErr, indexData) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveStatic(req, res) {
  const filePath = safeBuildPath(req.url || '/');
  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad path');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      sendFile(res, path.join(filePath, 'index.html'));
      return;
    }
    sendFile(res, filePath);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (isProxied(urlPath)) {
    proxy(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }
  serveStatic(req, res);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`frontend listening on ${PORT}, proxying /api and /images to ${BACKEND_TARGET}`);
});
