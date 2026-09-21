const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('static site import persists files, serves assets, and removes its copy', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-nav-static-test-'));
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NAV_HOST: '127.0.0.1',
      NAV_PORT: String(port),
      PM2_NAV_DATA_DIR: dataDir,
      PM2_NAV_CONFIG: path.join(dataDir, 'config.json'),
      PM2_NAV_STATIC_SITES_DIR: path.join(dataDir, 'static-sites'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(port, child);

  const form = new FormData();
  form.append('name', '静态测试站点');
  form.append('mode', 'folder');
  form.append('paths', JSON.stringify(['index.html', 'assets/site.css']));
  form.append('files', new Blob(['<!doctype html><link rel="stylesheet" href="assets/site.css"><h1>Imported</h1>'], { type: 'text/html' }), 'index.html');
  form.append('files', new Blob(['h1 { color: seagreen; }'], { type: 'text/css' }), 'site.css');

  const importResponse = await fetch(`http://127.0.0.1:${port}/api/static-sites`, {
    method: 'POST',
    body: form,
  });
  assert.equal(importResponse.status, 201);
  const imported = await importResponse.json();
  assert.equal(imported.customLink.kind, 'static');
  assert.equal(imported.customLink.fileCount, 2);

  const siteId = imported.customLink.id;
  const importedDir = path.join(dataDir, 'static-sites', siteId);
  const persistedConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(persistedConfig.customLinks.some((link) => link.id === siteId && link.kind === 'static'), true);
  assert.equal(fs.existsSync(path.join(importedDir, 'index.html')), true);
  assert.equal(fs.existsSync(path.join(importedDir, 'assets', 'site.css')), true);

  const pageResponse = await fetch(`http://127.0.0.1:${port}/static-sites/${siteId}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Imported/);

  const cssResponse = await fetch(`http://127.0.0.1:${port}/static-sites/${siteId}/assets/site.css`);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get('content-type'), /^text\/css/);
  assert.match(await cssResponse.text(), /seagreen/);

  const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/custom-links/${siteId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal(fs.existsSync(importedDir), false);
});

async function waitForServer(port, child) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('server did not become ready');
}

function getFreePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
