'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir, homedir } = require('node:os');
const { spawn, fork } = require('node:child_process');
const http = require('node:http');
const { resolveConfig, startCrm } = require('../src/index');

const root = resolve(__dirname, '..', '..');
const entry = join(root, 'crm', 'src', 'index.js');

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function start({ port, dataDir, extraEnv = {}, ipc = false }) {
  const options = {
    cwd: root,
    env: { ...process.env, CRM_HOST: '127.0.0.1', CRM_PORT: String(port), CRM_DATA_DIR: dataDir, ...extraEnv },
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']
  };
  const child = ipc ? fork(entry, [], options) : spawn(process.execPath, [entry], options);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}

function request(url, headers = {}) {
  return new Promise((resolveRequest, reject) => {
    const request = http.get(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
  });
}

async function waitForHealth(process, port) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) throw new Error(`CRM exited before readiness: ${process.output()}`);
    try {
      const response = await request(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200 && JSON.parse(response.body).ok === true) return;
    } catch (error) { lastError = error; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`CRM did not become healthy: ${lastError || process.output()}`);
}

function stopped(process, signal = 'SIGTERM') {
  const { child } = process;
  return new Promise((resolveStop, reject) => {
    if (child.exitCode !== null) return resolveStop({ code: child.exitCode, signal: child.signalCode });
    const timeout = setTimeout(() => reject(new Error(`child did not stop within 5 seconds: ${process.output()}`)), 5_000);
    child.once('exit', (code, exitSignal) => { clearTimeout(timeout); resolveStop({ code, signal: exitSignal }); });
    if (!child.kill(signal)) { clearTimeout(timeout); resolveStop({ code: child.exitCode, signal: child.signalCode, missing: true }); }
  });
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    if (child.exitCode !== null) return resolveExit({ code: child.exitCode, signal: child.signalCode });
    const timeout = setTimeout(() => reject(new Error('child did not reject invalid configuration within 5 seconds')), 5_000);
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }); });
  });
}

async function dashboard(port) {
  const response = await request(`http://127.0.0.1:${port}/api/dashboard`, { 'x-demo-user': 'admin-1' });
  assert.equal(response.status, 200);
  return JSON.parse(response.body);
}

async function customers(port) {
  const response = await request(`http://127.0.0.1:${port}/api/customers`, { 'x-demo-user': 'admin-1' });
  assert.equal(response.status, 200);
  return JSON.parse(response.body).customers;
}

async function stopProcess(processInfo) {
  if (globalThis.process.platform !== 'win32') return stopped(processInfo);
  return new Promise((resolveStop, reject) => {
    const { child } = processInfo;
    const timeout = setTimeout(() => reject(new Error(`IPC shutdown did not exit within 5 seconds: ${processInfo.output()}`)), 5_000);
    child.send({ type: 'crm:shutdown', ignored: true }, error => {
      if (error) { clearTimeout(timeout); reject(error); return; }
      setTimeout(() => {
        if (child.exitCode !== null) { clearTimeout(timeout); reject(new Error('non-fixed IPC message stopped CRM')); return; }
        child.once('exit', (code, signal) => { clearTimeout(timeout); resolveStop({ code, signal }); });
        child.send({ type: 'crm:shutdown' }, sendError => { if (sendError) { clearTimeout(timeout); reject(sendError); } });
      }, 50);
    });
  });
}

test('entrypoint becomes healthy only after fictional seed and reopens without duplication', { timeout: 30_000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chengqiyun-smoke-'));
  const processes = [];
  t.after(async () => {
    await Promise.all(processes.map(process => process.child.exitCode === null ? stopped(process, 'SIGKILL') : undefined));
    rmSync(dataDir, { recursive: true, force: true });
  });

  const firstPort = await freePort();
  const first = start({ port: firstPort, dataDir, ipc: process.platform === 'win32' });
  processes.push(first);
  await waitForHealth(first, firstPort);
  assert.match(first.output(), new RegExp(`CRM_READY http://127\\.0\\.0\\.1:${firstPort}`));
  const firstDashboard = await dashboard(firstPort);
  assert.equal(firstDashboard.customerCount, 3);
  assert.ok(firstDashboard.pendingHumanCount >= 1);
  assert.ok(firstDashboard.metrics.agreed.amountCents > 0);
  assert.ok(firstDashboard.metrics.received.amountCents > 0);
  assert.ok(firstDashboard.metrics.outstanding.amountCents > 0);
  assert.equal(firstDashboard.metrics.agreed.amountCents, 2_860_000);
  assert.equal(firstDashboard.metrics.received.amountCents, 420_000);
  assert.equal(firstDashboard.metrics.outstanding.amountCents, 2_440_000);
  assert.equal(firstDashboard.pendingHumanCount, 1);
  assert.deepEqual((await customers(firstPort)).map(customer => [customer.name, customer.phone]).sort(), [
    ['演示学员一', '13800000001'], ['演示学员三', '13800000003'], ['演示学员二', '13800000002']
  ]);
  assert.equal((await request(`http://127.0.0.1:${firstPort}/`)).status, 200);
  const firstExit = await stopProcess(first);
  if (process.platform === 'win32') assert.deepEqual(firstExit, { code: 0, signal: null });
  else assert.deepEqual(firstExit, { code: 0, signal: null });

  const secondPort = await freePort();
  const second = start({ port: secondPort, dataDir, ipc: process.platform === 'win32' });
  processes.push(second);
  await waitForHealth(second, secondPort);
  const secondDashboard = await dashboard(secondPort);
  assert.deepEqual(secondDashboard, firstDashboard);
  const secondExit = await stopProcess(second);
  if (process.platform === 'win32') assert.deepEqual(secondExit, { code: 0, signal: null });
  else assert.deepEqual(secondExit, { code: 0, signal: null });
});

test('composition helper stops HTTP before closing the seeded SQLite store', { timeout: 20_000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chengqiyun-graceful-'));
  const port = await freePort();
  const app = await startCrm({ env: { ...process.env, CRM_HOST: '127.0.0.1', CRM_PORT: String(port), CRM_DATA_DIR: dataDir } });
  t.after(async () => { await app.shutdown(); rmSync(dataDir, { recursive: true, force: true }); });
  assert.match(app.readiness, new RegExp(`CRM_READY http://127\\.0\\.0\\.1:${port}`));
  assert.equal((await request(`http://127.0.0.1:${port}/api/health`)).status, 200);
  await app.shutdown();
  await assert.rejects(request(`http://127.0.0.1:${port}/api/health`));
});

test('configuration defaults to a local loopback database and accepts explicit safe overrides', () => {
  assert.deepEqual(resolveConfig({}), { host: '127.0.0.1', port: 4310, dataDir: resolve(homedir(), '.chengqiyun-crm-data') });
  assert.deepEqual(resolveConfig({ CRM_HOST: ' localhost ', CRM_PORT: '4311', CRM_DATA_DIR: 'crm-demo-data' }), {
    host: 'localhost', port: 4311, dataDir: resolve('crm-demo-data')
  });
});

test('invalid startup configuration fails closed and never deletes an existing target', { timeout: 20_000 }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'chengqiyun-invalid-'));
  const fileTarget = join(parent, 'keep-me.txt');
  writeFileSync(fileTarget, 'do not overwrite');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const extraEnv of [{ CRM_PORT: '0' }, { CRM_HOST: 'bad\nhost' }, { CRM_DATA_DIR: fileTarget }]) {
    const process = start({ port: await freePort(), dataDir: join(parent, 'unused'), extraEnv });
    const result = await waitForExit(process.child);
    assert.notEqual(result.code, 0, process.output());
    assert.equal(readFileSync(fileTarget, 'utf8'), 'do not overwrite');
  }
});

test('root CRM commands retain legacy commands and the published boundaries', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'electron .');
  assert.equal(packageJson.scripts.app, 'electron app/');
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
  assert.equal(packageJson.scripts['crm:start'], 'node crm/src/index.js');
  assert.equal(packageJson.scripts['crm:test'], 'node --test crm/test/*.test.js');
  const rootReadme = readFileSync(join(root, 'README.md'), 'utf8');
  const crmReadme = readFileSync(join(root, 'crm', 'README.md'), 'utf8');
  assert.match(rootReadme, /成蹊云 CRM/);
  assert.match(rootReadme, /legacy/i);
  assert.match(crmReadme, /虚构数据/);
  assert.match(crmReadme, /不得.*真实/);
  assert.match(crmReadme, /只读/);
});
