const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('apps API exposes unique IPv4 LAN addresses for local jump links', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-nav-lan-test-'));
  const pm2Stub = path.join(dataDir, 'pm2-stub');
  fs.writeFileSync(pm2Stub, '#!/usr/bin/env node\nprocess.stdout.write("[]\\n");\n');
  fs.chmodSync(pm2Stub, 0o755);

  const port = await getFreePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NAV_HOST: '127.0.0.1',
      NAV_PORT: String(port),
      PM2_BIN: pm2Stub,
      PM2_NAV_DATA_DIR: dataDir,
      PM2_NAV_CONFIG: path.join(dataDir, 'config.json'),
      PM2_NAV_DETECT_LISTEN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForServer(port, child);

  const response = await fetch(`http://127.0.0.1:${port}/api/apps`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.config.lanAddresses), true);

  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  for (const address of payload.config.lanAddresses) {
    assert.match(address, ipv4);
    assert.notEqual(address, '127.0.0.1');
  }
  assert.equal(new Set(payload.config.lanAddresses).size, payload.config.lanAddresses.length);
  assert.equal(payload.config.suggestedHostname, payload.config.lanAddresses[0] || null);
  assert.equal(payload.config.lanAddresses.some((address) => address.startsWith('198.18.')), false);
  assert.deepEqual([...payload.config.lanAddresses].sort(), discoveredLanAddresses().sort());

  const privateLan = payload.config.lanAddresses.find((address) => address.startsWith('192.168.'));
  if (privateLan) {
    assert.equal(payload.config.lanAddresses[0], privateLan);
  }
});

function discoveredLanAddresses() {
  const seen = new Set();
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && !address.internal && (address.family === 'IPv4' || address.family === 4))
    .map((address) => address.address)
    .filter((address) => {
      if (!address || seen.has(address) || !isPrivateIpv4(address)) return false;
      seen.add(address);
      return true;
    });
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
