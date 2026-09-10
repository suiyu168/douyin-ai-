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
    if (hasTerminated(process.child)) throw new Error(`CRM exited before readiness: ${process.output()}`);
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
    if (hasTerminated(child)) return resolveStop({ code: child.exitCode, signal: child.signalCode });
    const timeout = setTimeout(() => reject(new Error(`child did not stop within 5 seconds: ${process.output()}`)), 5_000);
    child.once('exit', (code, exitSignal) => { clearTimeout(timeout); resolveStop({ code, signal: exitSignal }); });
    if (!child.kill(signal)) { clearTimeout(timeout); resolveStop({ code: child.exitCode, signal: child.signalCode, missing: true }); }
  });
}

function hasTerminated(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function naturalExit(result) {
  if (!result.missing && result.code === 0 && result.signal === null) return { code: result.code, signal: result.signal };
  throw new Error(`CRM did not exit cleanly: ${JSON.stringify(result)}`);
}

async function forceStop(processInfo) {
  const { child } = processInfo;
  if (hasTerminated(child)) return { code: child.exitCode, signal: child.signalCode };
  let result;
  try {
    result = await stopped(processInfo, 'SIGKILL');
  } catch (error) {
    throw new Error('Emergency child recovery failed', { cause: error });
  }
  if (result.missing || !hasTerminated(child)) {
    throw new Error('Emergency child recovery could not confirm termination', { cause: new Error(JSON.stringify(result)) });
  }
  return { code: child.exitCode, signal: child.signalCode };
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    if (hasTerminated(child)) return resolveExit({ code: child.exitCode, signal: child.signalCode });
    const timeout = setTimeout(() => reject(new Error('child did not reject invalid configuration within 5 seconds')), 5_000);
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }); });
  });
}

function registerInvalidStartupCleanup(t, parent) {
  const processes = [];
  t.after(async () => {
    const errors = [];
    try {
      for (const processInfo of processes) {
        try {
          // A startup timeout remains a test failure; recovery only prevents an orphan.
          await forceStop(processInfo);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Invalid startup child recovery failed');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
  return processes;
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
  if (globalThis.process.platform !== 'win32') return naturalExit(await stopped(processInfo));
  const result = await new Promise((resolveStop, reject) => {
    const { child } = processInfo;
    if (typeof child.send !== 'function') { reject(new Error('IPC shutdown is unavailable')); return; }
    const timeout = setTimeout(() => reject(new Error(`IPC shutdown did not exit within 5 seconds: ${processInfo.output()}`)), 5_000);
    child.send({ type: 'crm:shutdown', ignored: true }, error => {
      if (error) { clearTimeout(timeout); reject(error); return; }
      setTimeout(() => {
        if (hasTerminated(child)) { clearTimeout(timeout); reject(new Error('non-fixed IPC message stopped CRM')); return; }
        child.once('exit', (code, signal) => { clearTimeout(timeout); resolveStop({ code, signal }); });
        child.send({ type: 'crm:shutdown' }, sendError => { if (sendError) { clearTimeout(timeout); reject(sendError); } });
      }, 50);
    });
  });
  return naturalExit(result);
}

async function cleanupProcess(processInfo) {
  if (hasTerminated(processInfo.child)) return { code: processInfo.child.exitCode, signal: processInfo.child.signalCode };
  try {
    const result = await stopProcess(processInfo);
    if (!hasTerminated(processInfo.child)) throw new Error('Graceful shutdown did not reach a child terminal state');
    return result;
  } catch (gracefulError) {
    try {
      await forceStop(processInfo);
    } catch (emergencyError) {
      throw new AggregateError([gracefulError, emergencyError], 'Graceful shutdown failed and emergency child recovery could not be confirmed');
    }
    throw gracefulError;
  }
}

test('exit helpers immediately recognize an already signalled child', { timeout: 15_000 }, async t => {
  const processInfo = {
    child: spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }),
    output: () => 'already signalled child'
  };
  t.after(() => forceStop(processInfo));
  await forceStop(processInfo);
  assert.equal(processInfo.child.exitCode, null);
  assert.equal(processInfo.child.signalCode, 'SIGKILL');
  const port = await freePort();
  const started = performance.now();
  const results = await Promise.allSettled([
    stopped(processInfo),
    waitForExit(processInfo.child),
    waitForHealth(processInfo, port)
  ]);
  assert.deepEqual(results[0], { status: 'fulfilled', value: { code: null, signal: 'SIGKILL' } });
  assert.deepEqual(results[1], { status: 'fulfilled', value: { code: null, signal: 'SIGKILL' } });
  assert.equal(results[2].status, 'rejected');
  assert.match(results[2].reason.message, /CRM exited before readiness/);
  assert.ok(performance.now() - started < 1_000, 'terminal children must not wait for helper timeouts');
});

test('IPC shutdown detects a signal exit after the non-fixed message', { skip: process.platform !== 'win32', timeout: 5_000 }, async t => {
  const child = spawn(process.execPath, ['-e',
    "process.on('message', () => {}); console.log('ready')"
  ], { stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
  const processInfo = { child, output: () => '' };
  t.after(() => forceStop(processInfo));
  await new Promise(resolveReady => child.stdout.once('data', resolveReady));
  const send = child.send.bind(child);
  child.send = (message, callback) => {
    return send(message, async error => {
      if (error) return callback(error);
      // Delay successful delivery notification until the real exit event has occurred.
      await forceStop(processInfo);
      callback(null);
    });
  };
  await assert.rejects(stopProcess(processInfo), /non-fixed IPC message stopped CRM/);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('entrypoint becomes healthy only after fictional seed and reopens without duplication', { timeout: 30_000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chengqiyun-smoke-'));
  const processes = [];
  t.after(async () => {
    try {
      await Promise.all(processes.map(process => !hasTerminated(process.child) ? cleanupProcess(process) : undefined));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  const firstPort = await freePort();
  const first = start({ port: firstPort, dataDir, ipc: process.platform === 'win32' });
  processes.push(first);
  await waitForHealth(first, firstPort);
  assert.match(first.output(), new RegExp(`CRM_READY http://127\\.0\\.0\\.1:${firstPort}`));
  const firstDashboard = await dashboard(firstPort);
  assert.equal(firstDashboard.customerCount, 4);
  assert.equal(firstDashboard.pendingEnrollmentCount, 1);
  assert.equal(firstDashboard.studentCount, 0);
  assert.equal(firstDashboard.openTaskCount, 0);
  assert.equal(firstDashboard.overdueTaskCount, 0);
  assert.ok(firstDashboard.pendingHumanCount >= 1);
  assert.ok(firstDashboard.metrics.agreed.amountCents > 0);
  assert.ok(firstDashboard.metrics.received.amountCents > 0);
  assert.ok(firstDashboard.metrics.outstanding.amountCents > 0);
  assert.equal(firstDashboard.metrics.agreed.amountCents, 2_860_000);
  assert.equal(firstDashboard.metrics.received.amountCents, 420_000);
  assert.equal(firstDashboard.metrics.outstanding.amountCents, 2_440_000);
  assert.equal(firstDashboard.pendingHumanCount, 1);
  assert.deepEqual((await customers(firstPort)).map(customer => [customer.name, customer.phone]).sort(), [
    ['演示学员一', '13800000001'], ['演示学员三', '13800000003'], ['演示学员二', '13800000002'], ['虚构报名客户', '13800000004']
  ]);
  const firstCustomers = await customers(firstPort);
  const enrollmentCustomer = firstCustomers.find(customer => customer.name === '虚构报名客户');
  assert.equal(enrollmentCustomer.ownerId, 'consultant-1');
  const firstEnrollments = JSON.parse((await request(`http://127.0.0.1:${firstPort}/api/enrollments`, { 'x-demo-user': 'admin-1' })).body).enrollments;
  assert.equal(firstEnrollments.length, 1);
  assert.deepEqual([firstEnrollments[0].customerId, firstEnrollments[0].status, firstEnrollments[0].submittedBy, firstEnrollments[0].school, firstEnrollments[0].major],
    [enrollmentCustomer.id, 'pending', 'consultant-1', '虚构大学', '数字媒体']);
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
  assert.deepEqual(await customers(secondPort), firstCustomers);
  assert.deepEqual(JSON.parse((await request(`http://127.0.0.1:${secondPort}/api/enrollments`, { 'x-demo-user': 'admin-1' })).body).enrollments, firstEnrollments);
  const secondExit = await stopProcess(second);
  if (process.platform === 'win32') assert.deepEqual(secondExit, { code: 0, signal: null });
  else assert.deepEqual(secondExit, { code: 0, signal: null });
});

test('cleanup accepts only a natural graceful exit and rethrows after emergency child recovery', { timeout: 20_000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chengqiyun-cleanup-'));
  const port = await freePort();
  const crm = start({ port, dataDir, ipc: process.platform === 'win32' });
  const stubborn = {
    child: spawn(process.execPath, ['-e', process.platform === 'win32'
      ? "process.on('message', () => {}); setInterval(() => {}, 1000)"
      : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: process.platform === 'win32' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] }),
    output: () => ''
  };
  t.after(async () => {
    try {
      await Promise.all([crm, stubborn].map(processInfo => !hasTerminated(processInfo.child) ? forceStop(processInfo) : undefined));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await waitForHealth(crm, port);
  assert.deepEqual(await cleanupProcess(crm), { code: 0, signal: null });
  await assert.rejects(cleanupProcess(stubborn), /child did not stop|IPC shutdown/);
  assert.notEqual(stubborn.child.signalCode, null);
  const unconfirmable = {
    child: { exitCode: null, signalCode: null, kill: () => false, once: () => {} },
    output: () => 'unconfirmable controlled child'
  };
  await assert.rejects(cleanupProcess(unconfirmable), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /did not exit cleanly|IPC shutdown/);
    assert.match(error.errors[1].message, /Emergency child recovery/);
    return true;
  });
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

test('invalid startup timeout cleanup terminates every registered child', { timeout: 20_000 }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'chengqiyun-invalid-timeout-'));
  let cleanup;
  const processes = registerInvalidStartupCleanup({ after: callback => { cleanup = callback; } }, parent);
  t.after(async () => {
    try {
      for (const processInfo of processes) await forceStop(processInfo);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
  for (let index = 0; index < 2; index++) {
    processes.push({
      child: spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }),
      output: () => ''
    });
  }
  await assert.rejects(waitForExit(processes[0].child), /child did not reject invalid configuration/);
  await cleanup();
  for (const processInfo of processes) assert.equal(hasTerminated(processInfo.child), true);
});

test('invalid startup configuration fails closed and never deletes an existing target', { timeout: 20_000 }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'chengqiyun-invalid-'));
  const processes = registerInvalidStartupCleanup(t, parent);
  const fileTarget = join(parent, 'keep-me.txt');
  writeFileSync(fileTarget, 'do not overwrite');
  for (const extraEnv of [{ CRM_PORT: '0' }, { CRM_HOST: 'bad\nhost' }, { CRM_DATA_DIR: fileTarget }]) {
    const process = start({ port: await freePort(), dataDir: join(parent, 'unused'), extraEnv });
    processes.push(process);
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
  assert.match(rootReadme, /知程云 CRM/);
  assert.match(rootReadme, /legacy/i);
  assert.match(crmReadme, /虚构数据/);
  assert.match(crmReadme, /不得.*真实/);
  assert.match(crmReadme, /只读/);
});
