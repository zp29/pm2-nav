const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const NAV_PORT = toInteger(process.env.NAV_PORT, 80);
const NAV_HOST = process.env.NAV_HOST || '0.0.0.0';
const PM2_BIN = process.env.PM2_BIN || 'pm2';
const PM2_TIMEOUT_MS = toInteger(process.env.PM2_NAV_TIMEOUT_MS, 5000);
const DETECT_LISTEN_PORTS = process.env.PM2_NAV_DETECT_LISTEN !== '0';
const HIDE_SELF = process.env.PM2_NAV_HIDE_SELF !== '0';
const DATA_DIR = process.env.PM2_NAV_DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = process.env.PM2_NAV_CONFIG || path.join(DATA_DIR, 'config.json');
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const LOGIN_PATH = path.join(__dirname, 'public', 'login.html');
const SESSION_COOKIE = 'pm2_nav_session';
const SESSION_TTL_MS = toInteger(process.env.PM2_NAV_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
const BODY_LIMIT_BYTES = toInteger(process.env.PM2_NAV_BODY_LIMIT_BYTES, 64 * 1024);
const sessions = new Map();
let configWriteQueue = Promise.resolve();

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

  try {
    if (requestUrl.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        name: 'pm2-nav',
        port: NAV_PORT,
        configPath: CONFIG_PATH,
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (requestUrl.pathname === '/api/session' && req.method === 'GET') {
      handleSession(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/login' && req.method === 'POST') {
      await handleLogin(req, res);
      return;
    }

    if (requestUrl.pathname === '/api/logout' && req.method === 'POST') {
      handleLogout(res);
      return;
    }

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
      if (!isRequestAuthenticated(req, loadConfig())) {
        sendHtml(res, fs.readFileSync(LOGIN_PATH, 'utf8'));
        return;
      }

      sendHtml(res, fs.readFileSync(INDEX_PATH, 'utf8'));
      return;
    }

    if (requestUrl.pathname === '/login' || requestUrl.pathname === '/login.html') {
      const config = loadConfig();
      if (!isAuthEnabled(config) || isRequestAuthenticated(req, config)) {
        sendRedirect(res, '/');
        return;
      }

      sendHtml(res, fs.readFileSync(LOGIN_PATH, 'utf8'));
      return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      const guard = requireAuth(req, res);
      if (!guard.ok) return;

      await handleApi(req, res, requestUrl, guard.config);
      return;
    }

    sendJson(res, 404, { ok: false, message: 'Not Found' });
  } catch (error) {
    sendJson(res, error instanceof PublicError ? error.statusCode : 500, {
      ok: false,
      message: error.message || 'Server error',
      generatedAt: new Date().toISOString(),
    });
  }
});

server.listen(NAV_PORT, NAV_HOST, () => {
  console.log(`PM2 nav is listening on http://${NAV_HOST}:${NAV_PORT}`);
  console.log(`PM2 nav config path: ${CONFIG_PATH}`);
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

async function handleApi(req, res, requestUrl, config) {
  if (requestUrl.pathname === '/api/apps' && req.method === 'GET') {
    await handleApps(res, config);
    return;
  }

  if (requestUrl.pathname === '/api/custom-links' && req.method === 'POST') {
    await handleCreateCustomLink(req, res);
    return;
  }

  const customLinkMatch = requestUrl.pathname.match(/^\/api\/custom-links\/([^/]+)$/);
  if (customLinkMatch && req.method === 'PATCH') {
    await handleUpdateCustomLink(req, res, decodeURIComponent(customLinkMatch[1]));
    return;
  }

  if (customLinkMatch && req.method === 'DELETE') {
    await handleDeleteCustomLink(res, decodeURIComponent(customLinkMatch[1]));
    return;
  }

  if (requestUrl.pathname === '/api/aliases' && req.method === 'POST') {
    await handleAlias(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, message: 'Not Found' });
}

function handleSession(req, res) {
  const config = loadConfig();
  const session = getSession(req);
  const authRequired = isAuthEnabled(config);

  sendJson(res, 200, {
    ok: true,
    authRequired,
    authenticated: !authRequired || Boolean(session),
    username: session ? session.username : null,
  });
}

async function handleLogin(req, res) {
  const config = loadConfig();
  if (!isAuthEnabled(config)) {
    sendJson(res, 200, { ok: true, authRequired: false });
    return;
  }

  const body = await readJsonBody(req);
  const username = String(body.username || '');
  const password = String(body.password || '');

  if (!verifyCredentials(config, username, password)) {
    sendJson(res, 401, { ok: false, message: '账号或密码不正确' });
    return;
  }

  const token = createSession(username);
  sendJson(res, 200, { ok: true, authRequired: true, username }, {
    'Set-Cookie': buildSessionCookie(token),
  });
}

function handleLogout(res) {
  sendJson(res, 200, { ok: true }, {
    'Set-Cookie': buildExpiredSessionCookie(),
  });
}

async function handleApps(res, config) {
  const apps = await getPm2Apps(config);
  sendJson(res, 200, {
    ok: true,
    config: {
      authRequired: isAuthEnabled(config),
      configPath: CONFIG_PATH,
    },
    generatedAt: new Date().toISOString(),
    apps,
    customLinks: config.customLinks,
  });
}

async function handleCreateCustomLink(req, res) {
  const body = await readJsonBody(req);
  const { result: link } = await updateConfig((config) => {
    const customLink = buildCustomLink(body);
    config.customLinks.push(customLink);
    return customLink;
  });

  sendJson(res, 201, { ok: true, customLink: link });
}

async function handleUpdateCustomLink(req, res, id) {
  const body = await readJsonBody(req);
  const { result: link } = await updateConfig((config) => {
    const index = config.customLinks.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new PublicError(404, '导航不存在');
    }

    const previous = config.customLinks[index];
    const next = buildCustomLink({
      ...previous,
      ...body,
      id: previous.id,
      createdAt: previous.createdAt,
    });

    config.customLinks[index] = next;
    return next;
  });

  sendJson(res, 200, { ok: true, customLink: link });
}

async function handleDeleteCustomLink(res, id) {
  await updateConfig((config) => {
    const nextLinks = config.customLinks.filter((item) => item.id !== id);
    if (nextLinks.length === config.customLinks.length) {
      throw new PublicError(404, '导航不存在');
    }

    config.customLinks = nextLinks;
    return null;
  });

  sendJson(res, 200, { ok: true });
}

async function handleAlias(req, res) {
  const body = await readJsonBody(req);
  const configKey = cleanText(body.configKey, 160);
  const alias = cleanText(body.alias, 80);

  if (!configKey) {
    sendJson(res, 400, { ok: false, message: '缺少 PM2 标识' });
    return;
  }

  await updateConfig((config) => {
    if (alias) {
      config.aliases[configKey] = alias;
    } else {
      delete config.aliases[configKey];
    }
    return null;
  });

  sendJson(res, 200, { ok: true, configKey, alias: alias || null });
}

async function getPm2Apps(config) {
  const rawApps = await readPm2List();
  let apps = rawApps.map((app) => normalizeApp(app, config)).filter(Boolean);

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

function normalizeApp(app, config) {
  const env = app.pm2_env || {};
  const detected = detectPort(app);
  const pid = toNullableNumber(app.pid);
  const selfPmId = process.env.pm_id;
  const selfName = process.env.name || process.env.PM2_NAV_NAME || 'pm2-nav';
  const originalName = app.name || env.name || `process-${app.pm_id}`;
  const namespace = env.namespace || 'default';
  const configKey = createAppConfigKey(namespace, originalName);
  const alias = cleanText(config.aliases[configKey] || config.aliases[originalName], 80);
  const displayName = alias || originalName;

  return {
    id: app.pm_id,
    type: 'pm2',
    name: displayName,
    displayName,
    originalName,
    configKey,
    alias: alias || null,
    namespace,
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
    isSelf: String(app.pm_id) === String(selfPmId) || originalName === selfName,
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

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return normalizeConfig({});
    }

    if (error instanceof SyntaxError) {
      throw new Error(`配置文件不是有效 JSON：${CONFIG_PATH}`);
    }

    throw error;
  }
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tempPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(tempPath, CONFIG_PATH);
}

async function updateConfig(mutator) {
  const run = async () => {
    const config = loadConfig();
    const result = await mutator(config);
    saveConfig(config);
    return { config, result };
  };

  const next = configWriteQueue.then(run, run);
  configWriteQueue = next.catch(() => {});
  return next;
}

function normalizeConfig(input) {
  const config = isPlainObject(input) ? input : {};
  const authInput = isPlainObject(config.auth) ? config.auth : {};
  const auth = {
    username: cleanText(authInput.username || config.username, 120),
    password: String(authInput.password || config.password || ''),
    passwordSha256: cleanText(authInput.passwordSha256 || config.passwordSha256, 128),
  };

  const aliases = {};
  if (isPlainObject(config.aliases)) {
    Object.entries(config.aliases).forEach(([key, value]) => {
      const cleanKey = cleanText(key, 160);
      const cleanValue = cleanText(value, 80);
      if (cleanKey && cleanValue) aliases[cleanKey] = cleanValue;
    });
  }

  const customLinks = Array.isArray(config.customLinks)
    ? config.customLinks.map(normalizeCustomLink).filter(Boolean)
    : [];

  return { auth, aliases, customLinks };
}

function buildCustomLink(input) {
  const id = cleanText(input.id, 80) || crypto.randomUUID();
  const name = cleanText(input.name, 80);
  const target = input.target !== undefined
    ? input.target
    : (input.url !== undefined && input.url !== null && input.url !== '' ? input.url : input.port);

  if (!name) {
    throw new PublicError(400, '请输入名称');
  }

  const port = parsePort(target);
  let url = null;
  let finalPort = null;

  if (port && String(target).trim().match(/^\d{1,5}$/)) {
    finalPort = port;
  } else {
    url = normalizeUrl(target);
  }

  if (!url && !finalPort) {
    throw new PublicError(400, '请输入完整链接或端口');
  }

  const now = new Date().toISOString();
  return {
    id,
    name,
    url,
    port: finalPort,
    createdAt: cleanText(input.createdAt, 40) || now,
    updatedAt: now,
  };
}

function normalizeCustomLink(input) {
  if (!isPlainObject(input)) return null;

  try {
    const link = buildCustomLink(input);
    return {
      ...link,
      createdAt: cleanText(input.createdAt, 40) || link.createdAt,
      updatedAt: cleanText(input.updatedAt, 40) || link.updatedAt,
    };
  } catch {
    return null;
  }
}

function normalizeUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return null;

  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isAuthEnabled(config) {
  return Boolean(config.auth.username && (config.auth.password || config.auth.passwordSha256));
}

function requireAuth(req, res) {
  const config = loadConfig();
  if (isRequestAuthenticated(req, config)) {
    return { ok: true, config };
  }

  sendJson(res, 401, { ok: false, message: '需要登录' });
  return { ok: false, config };
}

function isRequestAuthenticated(req, config) {
  if (!isAuthEnabled(config)) return true;
  return Boolean(getSession(req));
}

function verifyCredentials(config, username, password) {
  if (!safeEqual(username, config.auth.username)) return false;

  if (config.auth.password) {
    return safeEqual(password, config.auth.password);
  }

  const digest = crypto.createHash('sha256').update(password).digest('hex');
  return safeEqual(digest, config.auth.passwordSha256);
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

function buildSessionCookie(token) {
  const maxAge = Math.max(1, Math.floor(SESSION_TTL_MS / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function buildExpiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return;

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  });
  return cookies;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      throw new PublicError(413, '请求内容过大');
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new PublicError(400, '请求 JSON 无效');
  }
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

function createAppConfigKey(namespace, name) {
  return `${namespace || 'default'}/${name}`;
}

function getRequestOrigin(req) {
  return `http://${req.headers.host || 'localhost'}`;
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const normalizedStatus = payload instanceof PublicError ? payload.statusCode : statusCode;
  const normalizedPayload = payload instanceof PublicError
    ? { ok: false, message: payload.message }
    : payload;

  res.writeHead(normalizedStatus, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(normalizedPayload));
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

function cleanText(value, limit) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, limit);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

class PublicError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
