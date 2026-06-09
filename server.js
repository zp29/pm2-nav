const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const NAV_PORT = toInteger(process.env.NAV_PORT, 80);
const NAV_HOST = process.env.NAV_HOST || '0.0.0.0';
const PM2_BIN = process.env.PM2_BIN || 'pm2';
const PM2_TIMEOUT_MS = toInteger(process.env.PM2_NAV_TIMEOUT_MS, 5000);
const DETECT_LISTEN_PORTS = process.env.PM2_NAV_DETECT_LISTEN !== '0';
const HIDE_SELF = process.env.PM2_NAV_HIDE_SELF !== '0';
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

const PORT_KEYS = [
  'PORT',
  'port',
  'APP_PORT',
  'SERVER_PORT',
  'HTTP_PORT',
  'HTTPS_PORT',
  'WEB_PORT',
  'UI_PORT',
  'API_PORT',
  'ADMIN_PORT',
  'CLIENT_PORT',
  'FRONTEND_PORT',
  'BACKEND_PORT',
  'DEV_PORT',
  'DEV_SERVER_PORT',
  'LISTEN_PORT',
  'HOST_PORT',
  'VITE_PORT',
  'VITE_APP_PORT',
  'VITE_SERVER_PORT',
  'NEXT_PORT',
  'NUXT_PORT',
  'REACT_APP_PORT',
];

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, getRequestOrigin(req));

  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, message: 'Method Not Allowed' });
    return;
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
    sendHtml(res, fs.readFileSync(INDEX_PATH, 'utf8'));
    return;
  }

  if (requestUrl.pathname === '/api/apps') {
    await handleApps(req, res);
    return;
  }

  if (requestUrl.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      name: 'pm2-nav',
      port: NAV_PORT,
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Not Found' });
});

server.listen(NAV_PORT, NAV_HOST, () => {
  console.log(`PM2 nav is listening on http://${NAV_HOST}:${NAV_PORT}`);
});

server.on('error', (error) => {
  if (error.code === 'EACCES') {
    console.error(`Cannot bind port ${NAV_PORT}. Port 80 usually requires elevated permission or a reverse proxy.`);
    process.exit(1);
  }

  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${NAV_PORT} is already in use.`);
    process.exit(1);
  }

  throw error;
});

async function handleApps(req, res) {
  try {
    const apps = await getPm2Apps();
    sendJson(res, 200, {
      ok: true,
      host: getRequestHostname(req),
      generatedAt: new Date().toISOString(),
      apps,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: error.message || 'PM2 read failed',
      generatedAt: new Date().toISOString(),
      apps: [],
    });
  }
}

async function getPm2Apps() {
  const rawApps = await readPm2List();
  let apps = rawApps.map(normalizeApp).filter(Boolean);

  if (HIDE_SELF) {
    apps = apps.filter((app) => !app.isSelf);
  }

  if (DETECT_LISTEN_PORTS) {
    await enrichListeningPorts(apps);
  }

  return apps.sort(compareApps).map(({ isSelf, ...app }) => app);
}

async function readPm2List() {
  try {
    const { stdout } = await execFileAsync(PM2_BIN, ['jlist'], {
      timeout: PM2_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });

    const text = stdout.trim();
    return text ? JSON.parse(text) : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`找不到 PM2 命令：${PM2_BIN}`);
    }

    if (error.name === 'SyntaxError') {
      throw new Error('PM2 返回内容不是有效 JSON');
    }

    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`读取 PM2 失败：${detail}`);
  }
}

function normalizeApp(app) {
  const env = app.pm2_env || {};
  const detected = detectPort(app);
  const pid = toNullableNumber(app.pid);
  const selfPmId = process.env.pm_id;
  const selfName = process.env.name || process.env.PM2_NAV_NAME || 'pm2-nav';
  const name = app.name || env.name || `process-${app.pm_id}`;

  return {
    id: app.pm_id,
    name,
    namespace: env.namespace || 'default',
    status: env.status || 'unknown',
    pid,
    mode: env.exec_mode || 'fork',
    version: env.version || null,
    cpu: toNullableNumber(app.monit && app.monit.cpu) || 0,
    memory: toNullableNumber(app.monit && app.monit.memory) || 0,
    uptime: toNullableNumber(env.pm_uptime),
    restarts: toNullableNumber(env.restart_time) || 0,
    port: detected.port,
    ports: detected.port ? [detected.port] : [],
    portSource: detected.source,
    isSelf: String(app.pm_id) === String(selfPmId) || name === selfName,
  };
}

async function enrichListeningPorts(apps) {
  const processTree = await readProcessTree();

  await Promise.all(
    apps.map(async (app) => {
      if (app.port || !app.pid) return;

      const result = await getListeningPortsForProcess(app.pid, processTree);
      if (!result.ports.length) return;

      app.ports = result.ports;
      app.port = result.ports[0];
      app.portSource = result.source;
    }),
  );
}

async function readProcessTree() {
  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
      timeout: 1200,
      maxBuffer: 8 * 1024 * 1024,
    });
    const childrenByParent = new Map();

    stdout.split('\n').forEach((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return;

      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return;

      if (!childrenByParent.has(ppid)) {
        childrenByParent.set(ppid, []);
      }
      childrenByParent.get(ppid).push(pid);
    });

    return childrenByParent;
  } catch {
    return new Map();
  }
}

async function getListeningPortsForProcess(pid, processTree) {
  const pids = collectProcessFamily(pid, processTree);
  const found = [];

  for (const candidatePid of pids) {
    const ports = await getListeningPorts(candidatePid);
    ports.forEach((port) => found.push({ port, pid: candidatePid }));
  }

  const ports = [...new Set(found.map((item) => item.port))].sort((a, b) => a - b);
  const source = found.some((item) => item.pid !== pid) ? 'listen:child' : 'listen';

  return { ports, source };
}

function collectProcessFamily(rootPid, childrenByParent) {
  const family = [];
  const queue = [rootPid];
  const seen = new Set();

  while (queue.length && family.length < 64) {
    const pid = queue.shift();
    if (!pid || seen.has(pid)) continue;

    seen.add(pid);
    family.push(pid);

    const children = childrenByParent.get(pid) || [];
    children.forEach((childPid) => queue.push(childPid));
  }

  return family;
}

async function getListeningPorts(pid) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], {
      timeout: 1200,
      maxBuffer: 1024 * 1024,
    });

    return [...new Set(stdout
      .split('\n')
      .map((line) => {
        const match = line.match(/:(\d{1,5})\s+\(LISTEN\)$/);
        return match ? parsePort(match[1]) : null;
      })
      .filter(Boolean))]
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function detectPort(app) {
  const env = app.pm2_env || {};
  const nestedEnv = isPlainObject(env.env) ? env.env : null;
  const envSources = [
    { label: 'env', data: nestedEnv },
    { label: 'pm2_env', data: env },
  ].filter((source) => source.data);

  for (const source of envSources) {
    for (const key of PORT_KEYS) {
      const candidate = getCaseInsensitiveValue(source.data, key);
      const port = parsePort(candidate.value);
      if (port) return { port, source: candidate.key || key };
    }
  }

  const argPort = detectPortFromArgs([
    env.args,
    env.node_args,
    env.script_args,
    env.pm_exec_path,
  ]);

  if (argPort) return argPort;

  return { port: null, source: null };
}

function detectPortFromArgs(values) {
  const args = values.flatMap(splitArgs).filter(Boolean);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const inline = token.match(/^--?(?:port|listen|http-port|server\.port)=(\d{1,5})$/i)
      || token.match(/^-p(\d{1,5})$/i)
      || token.match(/^(?:PORT|APP_PORT|SERVER_PORT|HTTP_PORT)=(\d{1,5})$/i);

    if (inline) {
      const port = parsePort(inline[1]);
      if (port) return { port, source: 'args' };
    }

    if (/^--?(?:p|port|listen|http-port|server\.port)$/i.test(token)) {
      const port = parsePort(args[index + 1]);
      if (port) return { port, source: 'args' };
    }
  }

  return null;
}

function splitArgs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitArgs);
  return String(value).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((item) => item.replace(/^["']|["']$/g, '')) || [];
}

function getCaseInsensitiveValue(data, key) {
  if (!isPlainObject(data)) return { key: null, value: undefined };

  if (Object.prototype.hasOwnProperty.call(data, key)) {
    return { key, value: data[key] };
  }

  const lowerKey = key.toLowerCase();
  const foundKey = Object.keys(data).find((item) => item.toLowerCase() === lowerKey);
  return foundKey ? { key: foundKey, value: data[foundKey] } : { key: null, value: undefined };
}

function parsePort(value) {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const port = parsePort(item);
      if (port) return port;
    }
    return null;
  }

  if (typeof value === 'number') {
    return isValidPort(value) ? value : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  const direct = text.match(/^\d{1,5}$/);
  if (direct) return isValidPort(Number(direct[0])) ? Number(direct[0]) : null;

  try {
    const parsed = new URL(text);
    const urlPort = Number(parsed.port);
    if (isValidPort(urlPort)) return urlPort;
  } catch {
    // Continue with host:port style parsing.
  }

  const hostPort = text.match(/:(\d{1,5})(?:\/|$)/);
  if (hostPort) {
    const port = Number(hostPort[1]);
    return isValidPort(port) ? port : null;
  }

  return null;
}

function compareApps(a, b) {
  const onlineRank = Number(b.status === 'online') - Number(a.status === 'online');
  if (onlineRank) return onlineRank;

  const portRank = Number(Boolean(b.port)) - Number(Boolean(a.port));
  if (portRank) return portRank;

  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

function getRequestOrigin(req) {
  return `http://${req.headers.host || 'localhost'}`;
}

function getRequestHostname(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return String(host).replace(/:\d+$/, '');
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isValidPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function toInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function toNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
