'use strict';
// Serves sim/images/src over http://127.0.0.1:8765/ so the sender app's "URL から読み込む" can be exercised locally.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', 'sim', 'images', 'src');
const port = Number(process.argv[2] || 8765);
http.createServer((req, res) => {
  const file = path.join(root, path.basename(decodeURIComponent(req.url.split('?')[0])));
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', file.endsWith('.png') ? 'image/png' : 'application/octet-stream');
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));
