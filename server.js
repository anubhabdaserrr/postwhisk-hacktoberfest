// Tiny local server: serves this app and relays API-mode requests to ollama.com
// (the Ollama cloud API does not allow direct browser calls). Nothing is stored or logged.
// Run:  node server.js   then open http://localhost:8000
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = 8000;
const TYPES = {'.html':'text/html','.css':'text/css','.js':'text/javascript'};

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/cloud/api/chat') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const r = await fetch('https://ollama.com/api/chat', {
          method: 'POST',
          headers: {'Content-Type':'application/json', 'Authorization': req.headers.authorization || ''},
          body: Buffer.concat(chunks)
        });
        res.writeHead(r.status, {'Content-Type':'application/json'});
        res.end(await r.text());
      } catch (e) {
        res.writeHead(502, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Could not reach ollama.com'}));
      }
    });
    return;
  }
  const name = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(__dirname, path.normalize(name));
  if (!file.startsWith(__dirname) || !TYPES[path.extname(file)]) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)]});
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Open http://localhost:${PORT}`));
