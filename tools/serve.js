'use strict';
/* Optional static file server: node tools/serve.js [port]. The app also works by opening index.html directly. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.env.NETMAP_ROOT || path.join(__dirname, '..'));
const port = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const versionTool = require('./version.js');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/version.json') { // always the version of the files on disk right now, so edits show up without regenerating
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: versionTool.computeVersion(root) }) + '\n');
    return;
  }
  const file = path.join(root, p);
  if (!file.startsWith(root + path.sep) || /(^|[\\/])(\.git|tests|node_modules)([\\/]|$)/.test(path.relative(root, file))) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log('NetMap on http://127.0.0.1:' + port + '/'));
