const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { colors } = require('./palette.js');
const { watchView } = require('./live.js');
const { WEB_IP, WEB_PORT } = require('./config.js');

function renderPage() {
  return fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
    .replace('/*PALETTE*/', Object.entries(colors).map(([name, color]) => `--${name}:${color};`).join(''));
}
function ssePacket(view) { return `data: ${JSON.stringify(view)}\n\n`; }
function listen(server, port = WEB_PORT, host = WEB_IP) {
  return new Promise((resolve, reject) => {
    const failed = error => {
      if (error.code === 'EADDRINUSE' && port !== 0) {
        port = 0;
        server.once('error', failed);
        server.listen(port, host);
      } else reject(error);
    };
    server.once('error', failed);
    server.once('listening', () => { server.removeListener('error', failed); resolve(server.address()); });
    server.listen(port, host);
  });
}
async function startWeb(options = {}) {
  const page = renderPage(), clients = new Set();
  let packet;
  const stopView = (options.watchView ?? watchView)(view => {
    packet = ssePacket(view);
    for (const client of clients) {
      // Bound buffering when a tab stops consuming updates.
      if (client.writableLength > 1024 * 1024) client.destroy();
      else client.write(packet);
    }
  }, options);
  const server = http.createServer((request, response) => {
    // Refuse foreign Host headers so a DNS-rebinding page cannot read the stream.
    const { address, port, family } = server.address();
    const hosts = [`${family === 'IPv6' ? `[${address}]` : address}:${port}`];
    if (address === '127.0.0.1' || address === '::1') hosts.push(`localhost:${port}`);
    if (!hosts.includes(request.headers.host)) {
      response.writeHead(403); response.end();
    } else if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page);
    } else if (request.method === 'GET' && request.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      response.write(packet);
      clients.add(response);
      response.on('close', () => clients.delete(response));
    } else if (request.method === 'GET' && request.url === '/graph.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(fs.readFileSync(path.join(__dirname, 'graph.js'), 'utf8'));
    } else { response.writeHead(404); response.end(); }
  });
  const close = () => {
    stopView();
    for (const client of clients) client.destroy();
    server.close();
  };
  try {
    const address = await listen(server, options.port ?? WEB_PORT, options.host ?? WEB_IP);
    return { server, close, url: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}` };
  } catch (error) { close(); throw error; }
}
module.exports = { renderPage, ssePacket, listen, startWeb };
