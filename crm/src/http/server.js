'use strict';

const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { createApiRouter } = require('./routes');

const STATIC_FILES = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', csp: true },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', csp: true },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' }
});

function createServer({ service, publicDir = resolve(__dirname, '../../public') }) {
  const root = resolve(publicDir);
  const routeApi = createApiRouter({ service });
  return http.createServer(async (request, response) => {
    try {
      if (await routeApi(request, response)) return;
      const url = new URL(request.url, 'http://same-origin.invalid');
      const asset = !url.search && STATIC_FILES[url.pathname];
      if (!asset || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404, { 'x-content-type-options': 'nosniff' }); response.end(); return; }
      const path = resolve(root, asset.file);
      if (!path.startsWith(`${root}\\`) && path !== root) { response.writeHead(404); response.end(); return; }
      const headers = { 'content-type': asset.type, 'x-content-type-options': 'nosniff' };
      if (asset.csp) headers['content-security-policy'] = "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";
      if (request.method === 'HEAD') { response.writeHead(200, headers); response.end(); return; }
      const body = await readFile(path);
      response.writeHead(200, headers);
      response.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(404, { 'x-content-type-options': 'nosniff' });
      response.end();
    }
  });
}

module.exports = { createServer };
