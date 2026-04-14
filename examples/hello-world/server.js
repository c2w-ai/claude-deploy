// Tiny hello-world HTTP server — used to prove the claude-deploy plugin works
// end-to-end. Zero dependencies so it builds on Railway in ~seconds.

const http = require('node:http');

const PORT = Number(process.env.PORT || 3000);
const GREETING = process.env.GREETING || 'Hello from claude-deploy!';

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>claude-deploy hello world</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 2rem; }
    code { background: #f4f4f4; padding: 0.15rem 0.35rem; border-radius: 4px; }
    .stamp { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(GREETING)}</h1>
  <p>This page was deployed by running <code>/deploy</code> inside Claude Code.</p>
  <p class="stamp">Served at ${new Date().toISOString()} • PID ${process.pid}</p>
</body>
</html>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => {
  console.log(`hello-world listening on :${PORT}`);
});
