'use strict';

const { mkdirSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { createStore } = require('./storage/sqlite-store');
const { createCrmService } = require('./services/crm-service');
const { createServer } = require('./http/server');
const { seedDemoData } = require('./demo/seed');

function configError(message) {
  const error = new Error(message);
  error.code = 'INVALID_CONFIG';
  throw error;
}

function resolveConfig(env = process.env) {
  const hostInput = env.CRM_HOST === undefined ? '127.0.0.1' : env.CRM_HOST;
  if (typeof hostInput !== 'string' || /[\x00-\x1F\x7F]/.test(hostInput) || !hostInput.trim()) configError('CRM_HOST must be a nonblank host without control characters');
  const portInput = env.CRM_PORT === undefined ? '4310' : env.CRM_PORT;
  if (typeof portInput !== 'string' || !/^\d+$/.test(portInput)) configError('CRM_PORT must be an integer between 1 and 65535');
  const port = Number(portInput);
  if (!Number.isInteger(port) || port < 1 || port > 65535) configError('CRM_PORT must be an integer between 1 and 65535');
  const dataInput = env.CRM_DATA_DIR === undefined ? join(homedir(), '.chengqiyun-crm-data') : env.CRM_DATA_DIR;
  if (typeof dataInput !== 'string' || !dataInput.trim() || /\x00/.test(dataInput)) configError('CRM_DATA_DIR must name a directory');
  return { host: hostInput.trim(), port, dataDir: resolve(dataInput.trim()) };
}

function ensureDataDirectory(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  if (!statSync(dataDir).isDirectory()) configError('CRM_DATA_DIR must resolve to a directory');
}

function listen(server, { host, port }) {
  return new Promise((resolveListen, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolveListen(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

async function startCrm({ env = process.env } = {}) {
  const config = resolveConfig(env);
  ensureDataDirectory(config.dataDir);
  const store = createStore(join(config.dataDir, 'chengqiyun-crm.sqlite'));
  let server;
  let closing;
  try {
    const service = createCrmService({ store });
    const seed = seedDemoData({ service });
    server = createServer({ service });
    await listen(server, config);
    const address = server.address();
    const actualHost = typeof address === 'object' && address.family === 'IPv6' ? `[${address.address}]` : address.address;
    const readiness = `CRM_READY http://${actualHost}:${address.port}`;
    const shutdown = () => {
      if (!closing) closing = closeServer(server).catch(() => undefined).then(() => store.close());
      return closing;
    };
    return { config, store, service, server, seed, readiness, shutdown };
  } catch (error) {
    if (server) await closeServer(server).catch(() => undefined);
    store.close();
    throw error;
  }
}

async function runMain() {
  try {
    const app = await startCrm();
    process.stdout.write(`${app.readiness}\n`);
    let shuttingDown = false;
    const stop = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.shutdown().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`CRM_STARTUP_FAILED ${error.code || 'ERROR'}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runMain();

module.exports = { resolveConfig, startCrm };
