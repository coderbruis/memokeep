const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'web');
const modulesRoot = path.join(__dirname, '..', 'modules');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const isModule = relative.startsWith('modules/');
  const base = isModule ? modulesRoot : root;
  const file = path.resolve(base, isModule ? relative.slice('modules/'.length) : relative);
  if (!file.startsWith(base + path.sep) || (isModule && !['.js', '.css'].includes(path.extname(file)))) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(4173, '127.0.0.1', () => console.log('Memory Pet web: http://127.0.0.1:4173'));
