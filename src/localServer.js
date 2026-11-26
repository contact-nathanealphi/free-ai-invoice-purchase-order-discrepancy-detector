'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const dashboardHandler = require('../api/dashboard');
const auditHandler = require('../api/audit');
const resolveHandler = require('../api/resolve');
const resetHandler = require('../api/reset');
const posHandler = require('../api/pos');
const vendorsHandler = require('../api/vendors');
const auditEventsHandler = require('../api/audit-events');
const extractPoHandler = require('../api/extract-po');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const API_ROUTES = {
  '/api/dashboard': dashboardHandler,
  '/api/audit': auditHandler,
  '/api/resolve': resolveHandler,
  '/api/reset': resetHandler,
  '/api/pos': posHandler,
  '/api/vendors': vendorsHandler,
  '/api/audit-events': auditEventsHandler,
  '/api/extract-po': extractPoHandler,
};

const LIVE_RELOAD_SNIPPET = `
<script>
(function () {
  if (typeof EventSource === 'undefined') return;
  var es = new EventSource('/__dev_reload');
  es.addEventListener('reload', function () { window.location.reload(); });
})();
</script>
</body>`;

function createLocalServer() {
  const sseClients = new Set();
  let watcher = null;
  let debounceTimer = null;

  try {
    watcher = fs.watch(PUBLIC_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        for (const client of sseClients) {
          client.write(`event: reload\ndata: ${Date.now()}\n\n`);
        }
      }, 120);
    });
  } catch {
    // Ignore watch errors on restricted filesystems
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (urlPath === '/__dev_reload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (API_ROUTES[urlPath]) {
      return API_ROUTES[urlPath](req, res);
    }

    const safeRelPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.resolve(PUBLIC_DIR, safeRelPath);

    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (ext === '.html') {
      const html = fs.readFileSync(filePath, 'utf8');
      res.end(html.includes('</body>') ? html.replace('</body>', LIVE_RELOAD_SNIPPET) : html);
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });

  server.on('close', () => {
    clearTimeout(debounceTimer);
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    for (const client of sseClients) {
      client.end();
    }
    sseClients.clear();
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createLocalServer();
  server.listen(port, () => {
    console.log(`AP Command Center running at http://localhost:${port}`);
  });
}

module.exports = { createLocalServer };
