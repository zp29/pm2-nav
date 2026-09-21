const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { HttpsProxyManager, normalizeHostname } = require('./https-proxy');

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
const STATIC_IMPORT_LIMIT_BYTES = toInteger(process.env.PM2_NAV_STATIC_IMPORT_LIMIT_BYTES, 25 * 1024 * 1024);
const STATIC_IMPORT_MAX_FILES = toInteger(process.env.PM2_NAV_STATIC_IMPORT_MAX_FILES, 1000);
const HTTPS_DATA_DIR = process.env.PM2_NAV_HTTPS_DIR || path.join(DATA_DIR, 'https');
const STATIC_SITES_DIR = process.env.PM2_NAV_STATIC_SITES_DIR || path.join(DATA_DIR, 'static-sites');
const OPENSSL_BIN = process.env.PM2_NAV_OPENSSL_BIN || 'openssl';
const sessions = new Map();
let configWriteQueue = Promise.resolve();
const httpsProxyManager = new HttpsProxyManager({
  dataDir: HTTPS_DATA_DIR,
  listenHost: NAV_HOST,
  opensslBin: OPENSSL_BIN,
});

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

    if (requestUrl.pathname.startsWith('/static-sites/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const guard = requireAuth(req, res);
      if (!guard.ok) return;

      handleStaticSite(req, res, requestUrl.pathname, guard.config);
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

server.listen(NAV_PORT, NAV_HOST, async () => {
  console.log(`PM2 nav is listening on http://${NAV_HOST}:${NAV_PORT}`);
  console.log(`PM2 nav config path: ${CONFIG_PATH}`);
  await httpsProxyManager.sync(loadConfig().httpsProxies);
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

  if (requestUrl.pathname === '/api/static-sites' && req.method === 'POST') {
    const imported = await handleImportStaticSite(req);
    sendJson(res, 201, { ok: true, customLink: imported });
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

  if (requestUrl.pathname === '/api/https-proxies' && req.method === 'POST') {
    await handleCreateHttpsProxy(req, res, config);
    return;
  }

  const httpsProxyMatch = requestUrl.pathname.match(/^\/api\/https-proxies\/([^/]+)$/);
  if (httpsProxyMatch && req.method === 'DELETE') {
    await handleDeleteHttpsProxy(res, decodeURIComponent(httpsProxyMatch[1]));
    return;
  }

  if (requestUrl.pathname === '/api/https-ca' && req.method === 'GET') {
    handleDownloadHttpsCa(res);
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
  const lanAddresses = getLanAddresses();
  const httpsProxies = httpsProxyManager.describe(config.httpsProxies);
  const httpsByConfigKey = new Map(httpsProxies.map((proxy) => [proxy.configKey, proxy]));
  const appsWithHttps = apps.map((app) => ({
    ...app,
    httpsProxy: httpsByConfigKey.get(app.configKey) || null,
  }));
  sendJson(res, 200, {
    ok: true,
    config: {
      authRequired: isAuthEnabled(config),
      configPath: CONFIG_PATH,
      suggestedHostname: lanAddresses[0] || null,
      lanAddresses,
    },
    generatedAt: new Date().toISOString(),
    apps: appsWithHttps,
    customLinks: config.customLinks,
    httpsProxies,
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
  const { result: removed } = await updateConfig((config) => {
    const removedLink = config.customLinks.find((item) => item.id === id);
    const nextLinks = config.customLinks.filter((item) => item.id !== id);
    if (nextLinks.length === config.customLinks.length) {
      throw new PublicError(404, '导航不存在');
    }

    config.customLinks = nextLinks;
    return removedLink;
  });

  if (removed && removed.kind === 'static' && isStaticSiteId(removed.id)) {
    fs.rmSync(path.join(STATIC_SITES_DIR, removed.id), { recursive: true, force: true });
  }

  sendJson(res, 200, { ok: true });
}

async function handleImportStaticSite(req) {
  const parts = await readMultipartBody(req);
  const name = cleanText(readMultipartText(parts, 'name'), 80);
  const mode = readMultipartText(parts, 'mode') === 'folder' ? 'folder' : 'file';
  const files = parts.filter((part) => part.name === 'files' && part.filename !== null);
  let relativePaths;

  if (!name) throw new PublicError(400, '请输入名称');
  if (!files.length) throw new PublicError(400, '请选择 HTML 文件或静态站点文件夹');
  if (files.length > STATIC_IMPORT_MAX_FILES) {
    throw new PublicError(413, `文件数量不能超过 ${STATIC_IMPORT_MAX_FILES} 个`);
  }

  try {
    relativePaths = JSON.parse(readMultipartText(parts, 'paths'));
  } catch {
    throw new PublicError(400, '文件路径清单无效');
  }

  if (!Array.isArray(relativePaths) || relativePaths.length !== files.length) {
    throw new PublicError(400, '文件路径清单与上传内容不一致');
  }

  const normalizedPaths = relativePaths.map(normalizeStaticRelativePath);
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new PublicError(400, '站点中包含重复文件路径');
  }

  let entry = 'index.html';
  if (mode === 'file') {
    if (files.length !== 1 || !/\.html?$/i.test(normalizedPaths[0])) {
      throw new PublicError(400, '单文件模式只能导入一个 HTML 文件');
    }
    normalizedPaths[0] = entry;
  } else {
    const indexPath = normalizedPaths.find((item) => item.toLowerCase() === 'index.html');
    if (!indexPath) throw new PublicError(400, '文件夹根目录需要包含 index.html');
    entry = indexPath;
  }

  const id = crypto.randomUUID();
  const stagingDir = path.join(STATIC_SITES_DIR, `.${id}.${process.pid}.tmp`);
  const finalDir = path.join(STATIC_SITES_DIR, id);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    normalizedPaths.forEach((relativePath, index) => {
      const targetPath = path.join(stagingDir, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, files[index].data);
    });
    fs.renameSync(stagingDir, finalDir);

    const totalBytes = files.reduce((sum, file) => sum + file.data.length, 0);
    const { result: link } = await updateConfig((config) => {
      const staticLink = buildStaticLink({
        id,
        name,
        entry,
        fileCount: files.length,
        sizeBytes: totalBytes,
      });
      config.customLinks.push(staticLink);
      return staticLink;
    });
    return link;
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(finalDir, { recursive: true, force: true });
    throw error;
  }
}

function handleStaticSite(req, res, pathname, config) {
  const match = pathname.match(/^\/static-sites\/([^/]+)(?:\/(.*))?$/);
  if (!match) throw new PublicError(404, '静态站点不存在');

  let id;
  let requestedPath;
  try {
    id = decodeURIComponent(match[1]);
    requestedPath = decodeURIComponent(match[2] || '');
  } catch {
    throw new PublicError(400, '静态站点路径无效');
  }

  const link = config.customLinks.find((item) => item.kind === 'static' && item.id === id);
  if (!link || !isStaticSiteId(id)) throw new PublicError(404, '静态站点不存在');

  if (!match[2] && !pathname.endsWith('/')) {
    sendRedirect(res, `${pathname}/`);
    return;
  }

  const siteDir = path.join(STATIC_SITES_DIR, id);
  let relativePath = requestedPath ? normalizeStaticRelativePath(requestedPath) : link.entry;
  let filePath = path.resolve(siteDir, relativePath);
  const siteRoot = `${path.resolve(siteDir)}${path.sep}`;
  if (!filePath.startsWith(siteRoot)) throw new PublicError(400, '静态站点路径无效');

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    relativePath = path.posix.join(relativePath, 'index.html');
    filePath = path.resolve(siteDir, relativePath);
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new PublicError(404, '静态资源不存在');
  }

  const realSiteDir = fs.realpathSync(siteDir);
  const realFilePath = fs.realpathSync(filePath);
  if (!realFilePath.startsWith(`${realSiteDir}${path.sep}`)) {
    throw new PublicError(400, '静态站点路径无效');
  }

  const stat = fs.statSync(realFilePath);
  res.writeHead(200, {
    'Content-Type': getStaticContentType(realFilePath),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(realFilePath).pipe(res);
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

async function handleCreateHttpsProxy(req, res, currentConfig) {
  const body = await readJsonBody(req);
  const configKey = cleanText(body.configKey, 160);
  const apps = await getPm2Apps(currentConfig);
  const app = apps.find((item) => item.configKey === configKey);

  if (!app) throw new PublicError(404, '找不到对应的 PM2 服务');
  if (currentConfig.httpsProxies.some((item) => item.configKey === configKey)) {
    throw new PublicError(409, '该服务已经配置 HTTPS，请先移除现有配置');
  }

  let proxy;
  try {
    proxy = buildHttpsProxy({
      ...body,
      configKey,
      name: app.name,
      sourcePort: body.sourcePort || app.port,
    });
  } catch (error) {
    throw new PublicError(400, error.message);
  }

  if (proxy.httpsPort === NAV_PORT) {
    throw new PublicError(409, `HTTPS 端口不能与 PM2 Nav 的 ${NAV_PORT} 端口相同`);
  }
  if (currentConfig.httpsProxies.some((item) => item.httpsPort === proxy.httpsPort)) {
    throw new PublicError(409, `HTTPS 端口 ${proxy.httpsPort} 已被其他网关使用`);
  }

  try {
    await httpsProxyManager.start(proxy);
    await updateConfig((config) => {
      if (config.httpsProxies.some((item) => item.configKey === proxy.configKey)) {
        throw new PublicError(409, '该服务已经配置 HTTPS');
      }
      config.httpsProxies.push(proxy);
      return proxy;
    });
  } catch (error) {
    await httpsProxyManager.stop(proxy.id);
    throw error instanceof PublicError ? error : new PublicError(500, error.message);
  }

  sendJson(res, 201, {
    ok: true,
    httpsProxy: httpsProxyManager.describeOne(proxy),
  });
}

async function handleDeleteHttpsProxy(res, id) {
  await updateConfig((config) => {
    const next = config.httpsProxies.filter((item) => item.id !== id);
    if (next.length === config.httpsProxies.length) {
      throw new PublicError(404, 'HTTPS 配置不存在');
    }
    config.httpsProxies = next;
    return null;
  });
  await httpsProxyManager.stop(id);
  sendJson(res, 200, { ok: true });
}

function handleDownloadHttpsCa(res) {
  const caPath = httpsProxyManager.getCaCertificatePath();
  if (!caPath) throw new PublicError(404, '尚未生成局域网 CA 证书');

  const certificate = fs.readFileSync(caPath);
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="pm2-nav-lan-ca.crt"',
    'Content-Length': certificate.length,
    'Cache-Control': 'no-store',
  });
  res.end(certificate);
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
  const httpsProxies = Array.isArray(config.httpsProxies)
    ? config.httpsProxies.map(normalizeHttpsProxy).filter(Boolean)
    : [];

  return { auth, aliases, customLinks, httpsProxies };
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

function buildStaticLink(input) {
  const id = cleanText(input.id, 80);
  const name = cleanText(input.name, 80);
  const entry = normalizeStaticRelativePath(input.entry || 'index.html');
  const fileCount = Math.max(1, toInteger(input.fileCount, 1));
  const sizeBytes = Math.max(0, toInteger(input.sizeBytes, 0));

  if (!isStaticSiteId(id)) throw new PublicError(400, '静态站点标识无效');
  if (!name) throw new PublicError(400, '请输入名称');
  if (!/\.html?$/i.test(entry)) throw new PublicError(400, '静态站点入口必须是 HTML 文件');

  const now = new Date().toISOString();
  return {
    id,
    kind: 'static',
    name,
    entry,
    fileCount,
    sizeBytes,
    url: null,
    port: null,
    createdAt: cleanText(input.createdAt, 40) || now,
    updatedAt: cleanText(input.updatedAt, 40) || now,
  };
}

function normalizeCustomLink(input) {
  if (!isPlainObject(input)) return null;

  try {
    if (input.kind === 'static') {
      return buildStaticLink(input);
    }
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

function buildHttpsProxy(input) {
  const id = cleanText(input.id, 80) || crypto.randomUUID();
  const configKey = cleanText(input.configKey, 160);
  const name = cleanText(input.name, 80) || configKey;
  const sourcePort = parsePort(input.sourcePort);
  const httpsPort = parsePort(input.httpsPort);
  const hostname = normalizeHostname(input.hostname);

  if (!configKey) throw new Error('缺少 PM2 服务标识');
  if (!sourcePort) throw new Error('未检测到有效的 HTTP 源端口');
  if (!httpsPort) throw new Error('请输入有效的 HTTPS 端口');
  if (sourcePort === httpsPort) throw new Error('HTTP 源端口与 HTTPS 端口不能相同');

  const now = new Date().toISOString();
  return {
    id,
    configKey,
    name,
    sourcePort,
    httpsPort,
    hostname,
    createdAt: cleanText(input.createdAt, 40) || now,
    updatedAt: cleanText(input.updatedAt, 40) || now,
  };
}

function normalizeHttpsProxy(input) {
  if (!isPlainObject(input)) return null;
  try {
    return buildHttpsProxy(input);
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

function normalizeStaticRelativePath(value) {
  const text = String(value || '').trim().replace(/\\/g, '/');
  if (!text || text.length > 500 || text.startsWith('/') || text.includes('\0')) {
    throw new PublicError(400, '静态站点包含无效文件路径');
  }

  const segments = text.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new PublicError(400, '静态站点不能包含隐藏文件或越级路径');
  }

  return segments.join('/');
}

function isStaticSiteId(value) {
  return /^[a-z0-9][a-z0-9-]{0,79}$/i.test(String(value || ''));
}

function getStaticContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  };
  return types[extension] || 'application/octet-stream';
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
  const text = (await readRequestBody(req, BODY_LIMIT_BYTES)).toString('utf8').trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new PublicError(400, '请求 JSON 无效');
  }
}

async function readRequestBody(req, limitBytes) {
  const declaredSize = Number(req.headers['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > limitBytes) {
    throw new PublicError(413, '请求内容过大');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new PublicError(413, '请求内容过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readMultipartBody(req) {
  const contentType = String(req.headers['content-type'] || '');
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch && (boundaryMatch[1] || boundaryMatch[2]);
  if (!boundary || boundary.length > 200) {
    throw new PublicError(400, '上传格式无效');
  }

  const body = await readRequestBody(req, STATIC_IMPORT_LIMIT_BYTES);
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const headerBreak = Buffer.from('\r\n\r\n');
  const parts = [];
  let cursor = 0;

  while (cursor < body.length) {
    const delimiterIndex = body.indexOf(delimiter, cursor);
    if (delimiterIndex === -1) break;
    const afterDelimiter = delimiterIndex + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString() === '--') break;

    const headersStart = afterDelimiter + 2;
    const headersEnd = body.indexOf(headerBreak, headersStart);
    if (headersEnd === -1) throw new PublicError(400, '上传内容头部无效');
    const dataStart = headersEnd + headerBreak.length;
    const dataEnd = body.indexOf(nextDelimiter, dataStart);
    if (dataEnd === -1) throw new PublicError(400, '上传内容不完整');

    const headers = body.subarray(headersStart, headersEnd).toString('utf8');
    const disposition = headers.split('\r\n').find((line) => /^content-disposition:/i.test(line)) || '';
    const nameMatch = disposition.match(/(?:^|;)\s*name="([^"]*)"/i);
    const filenameMatch = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i);
    if (nameMatch) {
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch ? filenameMatch[1] : null,
        data: body.subarray(dataStart, dataEnd),
      });
    }
    cursor = dataEnd + 2;
  }

  if (!parts.length) throw new PublicError(400, '上传内容为空');
  return parts;
}

function readMultipartText(parts, name) {
  const part = parts.find((item) => item.name === name && item.filename === null);
  return part ? part.data.toString('utf8') : '';
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

function getLanAddresses() {
  const seen = new Set();
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && !address.internal && isIpv4Family(address.family))
    .map((address) => address.address)
    .filter((address) => {
      if (!address || seen.has(address) || !isPrivateIpv4(address)) return false;
      seen.add(address);
      return true;
    })
    .sort(compareLanAddresses);
}

function isIpv4Family(family) {
  return family === 'IPv4' || family === 4;
}

function compareLanAddresses(left, right) {
  const rank = lanAddressRank(left) - lanAddressRank(right);
  if (rank) return rank;
  return left.localeCompare(right, 'en');
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const first = parts[0];
  const second = parts[1];
  return first === 10
    || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31);
}

function lanAddressRank(address) {
  const parts = String(address || '').split('.').map(Number);
  const first = parts[0];
  const second = parts[1];
  if (first === 192 && second === 168) return 0;
  if (first === 10) return 1;
  if (first === 172 && second >= 16 && second <= 31) return 2;
  return 3;
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
