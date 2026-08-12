const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HttpsProxyManager } = require('../https-proxy');

test('HTTPS proxy forwards HTTP and WebSocket traffic', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-nav-https-test-'));
  const source = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, forwardedProto: req.headers['x-forwarded-proto'] }));
  });

  source.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', (data) => socket.write(data));
  });

  await listen(source, 0, '127.0.0.1');
  const sourcePort = source.address().port;
  const httpsPort = await getFreePort();
  const manager = new HttpsProxyManager({
    dataDir,
    listenHost: '127.0.0.1',
    logger: { log() {}, error() {} },
  });
  const proxy = {
    id: 'test-proxy',
    configKey: 'default/test',
    name: 'test',
    hostname: '127.0.0.1',
    sourcePort,
    httpsPort,
  };

  t.after(async () => {
    await manager.closeAll();
    await close(source);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await manager.start(proxy);
  const ca = fs.readFileSync(manager.getCaCertificatePath());
  const response = await requestHttps({ ca, port: httpsPort, path: '/hello?from=test' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    path: '/hello?from=test',
    forwardedProto: 'https',
  });

  const websocketResult = await testWebSocketTunnel({ ca, port: httpsPort });
  assert.match(websocketResult, /101 Switching Protocols/);
  assert.match(websocketResult, /pm2-nav-ping/);
});

function requestHttps(options) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: '127.0.0.1',
      port: options.port,
      path: options.path,
      ca: options.ca,
      rejectUnauthorized: true,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

function testWebSocketTunnel(options) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: options.port,
      ca: options.ca,
      rejectUnauthorized: true,
    });
    let output = '';
    let sentPing = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('WebSocket proxy test timed out'));
    }, 5000);

    socket.on('secureConnect', () => {
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${options.port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (data) => {
      output += data.toString('utf8');
      if (!sentPing && output.includes('101 Switching Protocols')) {
        sentPing = true;
        socket.write('pm2-nav-ping');
      }
      if (sentPing && output.includes('pm2-nav-ping')) {
        clearTimeout(timer);
        socket.end();
        resolve(output);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function getFreePort() {
  const server = net.createServer();
  return listen(server, 0, '127.0.0.1').then(() => {
    const port = server.address().port;
    return close(server).then(() => port);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}
