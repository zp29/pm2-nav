const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const CERTIFICATE_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

class HttpsProxyManager {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.listenHost = options.listenHost || '0.0.0.0';
    this.opensslBin = options.opensslBin || 'openssl';
    this.logger = options.logger || console;
    this.runtimes = new Map();
    this.errors = new Map();
    this.certificateQueue = Promise.resolve();
  }

  async sync(proxies) {
    const desired = new Map(proxies.map((proxy) => [proxy.id, proxy]));

    for (const [id, runtime] of this.runtimes) {
      const proxy = desired.get(id);
      if (!proxy || runtime.signature !== proxySignature(proxy)) {
        await this.stop(id);
      }
    }

    for (const proxy of proxies) {
      if (this.runtimes.has(proxy.id)) continue;

      try {
        await this.start(proxy);
      } catch (error) {
        this.errors.set(proxy.id, publicErrorMessage(error));
        this.logger.error(`HTTPS proxy ${proxy.name || proxy.id} failed: ${publicErrorMessage(error)}`);
      }
    }

    return this.describe(proxies);
  }

  async start(proxy) {
    validateProxy(proxy);
    await this.stop(proxy.id);

    const certificate = await this.ensureCertificate(proxy.hostname);
    const sockets = new Set();
    const server = https.createServer({
      key: fs.readFileSync(certificate.keyPath),
      cert: fs.readFileSync(certificate.certPath),
      minVersion: 'TLSv1.2',
    }, (req, res) => {
      proxyHttpRequest(proxy, req, res);
    });

    server.on('upgrade', (req, socket, head) => {
      proxyWebSocket(proxy, req, socket, head);
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    await listen(server, proxy.httpsPort, this.listenHost);

    server.on('error', (error) => {
      this.errors.set(proxy.id, publicErrorMessage(error));
      this.logger.error(`HTTPS proxy ${proxy.name || proxy.id} error: ${publicErrorMessage(error)}`);
    });

    this.runtimes.set(proxy.id, {
      server,
      sockets,
      signature: proxySignature(proxy),
    });
    this.errors.delete(proxy.id);
    this.logger.log(`HTTPS proxy ${proxy.name || proxy.id}: https://${proxy.hostname}:${proxy.httpsPort} -> http://127.0.0.1:${proxy.sourcePort}`);
    return this.describeOne(proxy);
  }

  async stop(id) {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      this.errors.delete(id);
      return;
    }

    this.runtimes.delete(id);
    runtime.sockets.forEach((socket) => socket.destroy());
    await closeServer(runtime.server);
    this.errors.delete(id);
  }

  async closeAll() {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }

  describe(proxies) {
    return proxies.map((proxy) => this.describeOne(proxy));
  }

  describeOne(proxy) {
    const error = this.errors.get(proxy.id) || null;
    return {
      ...proxy,
      status: this.runtimes.has(proxy.id) ? 'online' : (error ? 'error' : 'starting'),
      error,
      url: `https://${formatHostname(proxy.hostname)}:${proxy.httpsPort}`,
    };
  }

  getCaCertificatePath() {
    const caPath = path.join(this.dataDir, 'lan-ca-cert.pem');
    return fs.existsSync(caPath) ? caPath : null;
  }

  async ensureCertificate(hostname) {
    const task = async () => {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      const ca = await this.ensureCertificateAuthority();
      const basename = `server-${crypto.createHash('sha256').update(hostname).digest('hex').slice(0, 16)}`;
      const keyPath = path.join(this.dataDir, `${basename}-key.pem`);
      const certPath = path.join(this.dataDir, `${basename}-cert.pem`);

      if (isCertificateFresh(certPath) && fs.existsSync(keyPath)) {
        return { keyPath, certPath };
      }

      const csrPath = path.join(this.dataDir, `${basename}.csr`);
      const extPath = path.join(this.dataDir, `${basename}.ext`);
      const subjectAltNames = buildSubjectAltNames(hostname);

      fs.writeFileSync(extPath, [
        'authorityKeyIdentifier=keyid,issuer',
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${subjectAltNames.join(',')}`,
        '',
      ].join('\n'));

      await runOpenSsl(this.opensslBin, [
        'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
        '-keyout', keyPath,
        '-out', csrPath,
        '-subj', `/CN=${hostname}`,
      ]);
      await runOpenSsl(this.opensslBin, [
        'x509', '-req',
        '-in', csrPath,
        '-CA', ca.certPath,
        '-CAkey', ca.keyPath,
        '-CAcreateserial',
        '-out', certPath,
        '-days', '825',
        '-sha256',
        '-extfile', extPath,
      ]);

      fs.chmodSync(keyPath, 0o600);
      safeUnlink(csrPath);
      safeUnlink(extPath);
      return { keyPath, certPath };
    };

    const next = this.certificateQueue.then(task, task);
    this.certificateQueue = next.catch(() => {});
    return next;
  }

  async ensureCertificateAuthority() {
    const keyPath = path.join(this.dataDir, 'lan-ca-key.pem');
    const certPath = path.join(this.dataDir, 'lan-ca-cert.pem');

    if (isCertificateFresh(certPath) && fs.existsSync(keyPath)) {
      return { keyPath, certPath };
    }

    await runOpenSsl(this.opensslBin, [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-subj', '/CN=pm2-nav-local-LAN-CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    fs.chmodSync(keyPath, 0o600);
    return { keyPath, certPath };
  }
}

function proxyHttpRequest(proxy, req, res) {
  const headers = {
    ...req.headers,
    'x-forwarded-for': appendForwardedFor(req.headers['x-forwarded-for'], req.socket.remoteAddress),
    'x-forwarded-host': req.headers.host || '',
    'x-forwarded-proto': 'https',
  };

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: proxy.sourcePort,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: `上游服务不可用：${publicErrorMessage(error)}` }));
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function proxyWebSocket(proxy, req, clientSocket, head) {
  const upstreamSocket = net.connect(proxy.sourcePort, '127.0.0.1');

  upstreamSocket.on('connect', () => {
    const headers = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      headers.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
    }
    headers.push(`X-Forwarded-For: ${req.socket.remoteAddress || ''}`);
    headers.push('X-Forwarded-Proto: https');

    upstreamSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket).pipe(clientSocket);
  });

  upstreamSocket.on('error', () => {
    if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  clientSocket.on('error', () => upstreamSocket.destroy());
  clientSocket.on('close', () => upstreamSocket.destroy());
  upstreamSocket.on('close', () => clientSocket.destroy());
}

function validateProxy(proxy) {
  if (!proxy || !proxy.id) throw new Error('HTTPS proxy is missing an id');
  if (!isValidPort(proxy.sourcePort)) throw new Error('HTTP source port is invalid');
  if (!isValidPort(proxy.httpsPort)) throw new Error('HTTPS listen port is invalid');
  if (proxy.sourcePort === proxy.httpsPort) throw new Error('HTTP 和 HTTPS 不能使用同一个端口');
  normalizeHostname(proxy.hostname);
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new Error('请输入证书使用的局域网 IP 或主机名');
  if (net.isIP(hostname)) return hostname;
  if (hostname === 'localhost') return hostname;
  if (hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error('主机名格式无效');
  }
  if (hostname.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error('主机名格式无效');
  }
  return hostname;
}

function buildSubjectAltNames(hostname) {
  const names = new Set(['IP:127.0.0.1', 'DNS:localhost']);
  names.add(net.isIP(hostname) ? `IP:${hostname}` : `DNS:${hostname}`);
  return [...names];
}

function isCertificateFresh(certPath) {
  if (!fs.existsSync(certPath)) return false;
  try {
    const certificate = new crypto.X509Certificate(fs.readFileSync(certPath));
    return Date.parse(certificate.validTo) - Date.now() > CERTIFICATE_RENEW_BEFORE_MS;
  } catch {
    return false;
  }
}

async function runOpenSsl(binary, args) {
  try {
    await execFileAsync(binary, args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`找不到 OpenSSL 命令：${binary}`);
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(`生成 HTTPS 证书失败：${detail}`);
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function appendForwardedFor(previous, remoteAddress) {
  return [previous, remoteAddress].filter(Boolean).join(', ');
}

function proxySignature(proxy) {
  return [proxy.sourcePort, proxy.httpsPort, proxy.hostname].join(':');
}

function formatHostname(hostname) {
  return net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
}

function publicErrorMessage(error) {
  if (error && error.code === 'EADDRINUSE') return `端口 ${error.port || ''} 已被占用`.trim();
  if (error && error.code === 'EACCES') return '没有权限监听 HTTPS 端口';
  return String((error && error.message) || error || '未知错误');
}

function isValidPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = {
  HttpsProxyManager,
  normalizeHostname,
};
