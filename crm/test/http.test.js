'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const http = require('node:http');
const { createServer } = require('../src/http/server');

const publicDir = join(__dirname, '..', 'public');

function spyService() {
  const calls = [];
  const service = {};
  for (const method of ['dashboard', 'listCustomers', 'importCustomer', 'createOrder', 'appendPayment', 'triageConversation']) {
    service[method] = input => {
      calls.push({ method, input });
      if (input?.customer?.name === 'throw-forbidden') throw Object.assign(new Error('internal path /secret.db'), { code: 'FORBIDDEN' });
      if (input?.customer?.name === 'throw-conflict') throw Object.assign(new Error('internal path /secret.db'), { code: 'CUSTOMER_REVIEW_REQUIRED' });
      if (input?.customer?.name === 'throw-unexpected') throw new Error('SQLITE at C:\\hidden\\db.sqlite');
      return method === 'dashboard'
        ? { customerCount: 0, pendingHumanCount: 0, metrics: { agreed: { amountCents: 0 }, received: { amountCents: 0 }, outstanding: { amountCents: 0 } } }
        : method === 'listCustomers' ? { customers: [] } : { method, ok: true };
    };
  }
  return { service, calls };
}

async function withServer(run, service = spyService().service) {
  const server = createServer({ service, publicDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

function rawRequest(url, options, chunks) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(target, options, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function rawTargetRequest(base, target, options = {}) {
  return new Promise((resolve, reject) => {
    const origin = new URL(base);
    const request = http.request({ hostname: origin.hostname, port: origin.port, path: target, method: options.method || 'GET', headers: options.headers }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('health endpoint is public and returns a JSON ok envelope', async () => {
  await withServer(async base => {
    const { response, body } = await json(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(body, { ok: true });
  });
});

test('protected routes reject missing or unknown demo users with a stable 401 envelope', async () => {
  await withServer(async base => {
    for (const headers of [{}, { 'x-demo-user': 'made-up' }, { 'x-demo-user': 'admin-1,service-1' }]) {
      const { response, body } = await json(`${base}/api/dashboard`, { headers });
      assert.equal(response.status, 401);
      assert.deepEqual(body, { error: { code: 'UNAUTHENTICATED', message: '需要演示身份' } });
    }
  });
});

test('every route maps only route-owned fields and server-owned actor to the service', async () => {
  const { service, calls } = spyService();
  await withServer(async base => {
    const headers = { 'x-demo-user': 'admin-1', 'content-type': 'application/json' };
    const requests = [
      [`${base}/api/dashboard?campusId=campus-a`, { method: 'GET', headers }],
      [`${base}/api/customers?teamId=team-a`, { method: 'GET', headers }],
      [`${base}/api/customers`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'c1', customer: { name: '王小明', roles: ['finance'], campusIds: ['evil'] }, source: { channel: 'demo' }, actor: { id: 'evil' } }) }],
      [`${base}/api/orders`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'o1', customerId: 'customer-1', order: { listPriceCents: 100 }, actor: { id: 'evil' } }) }],
      [`${base}/api/ledger`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'l1', orderId: 'order-1', entry: { type: 'payment' }, actor: { id: 'evil' } }) }],
      [`${base}/api/conversations/triage`, { method: 'POST', headers, body: JSON.stringify({ requestId: 't1', customerId: 'customer-1', conversation: { message: '你好' }, actor: { id: 'evil' } }) }]
    ];
    for (const [url, options] of requests) assert.equal((await fetch(url, options)).status, 200);
  }, service);
  assert.deepEqual(calls.map(call => call.method), ['dashboard', 'listCustomers', 'importCustomer', 'createOrder', 'appendPayment', 'triageConversation']);
  for (const { input } of calls) {
    assert.equal(input.actor.id, 'admin-1');
    assert.deepEqual(input.actor.roles, ['admin']);
    assert.deepEqual(input.actor.campusIds, []);
    assert.equal(Object.hasOwn(input, 'roles'), false);
  }
  assert.deepEqual(calls[0].input.scope, { campusId: 'campus-a' });
  assert.deepEqual(calls[1].input.scope, { teamId: 'team-a' });
  assert.equal(calls[2].input.customer.roles, undefined);
  assert.equal(calls[2].input.customer.campusIds, undefined);
  assert.equal(calls[2].input.actor.id, 'admin-1');
});

test('query scopes are strictly allowlisted and malformed API requests use the correct envelopes', async () => {
  await withServer(async base => {
    const user = { 'x-demo-user': 'admin-1' };
    const cases = [
      [`${base}/api/customers?role=admin`, { headers: user }, 400, 'INVALID_SCOPE'],
      [`${base}/api/customers`, { method: 'POST', headers: user, body: '{}' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [`${base}/api/customers`, { method: 'POST', headers: { ...user, 'content-type': 'application/json' }, body: '{' }, 400, 'INVALID_JSON'],
      [`${base}/api/customers`, { method: 'POST', headers: { ...user, 'content-type': 'application/json' }, body: '[]' }, 400, 'INVALID_JSON'],
      [`${base}/api/nope`, { headers: user }, 404, 'NOT_FOUND'],
      [`${base}/api/customers`, { method: 'PUT', headers: user }, 405, 'METHOD_NOT_ALLOWED']
    ];
    for (const [url, options, status, code] of cases) {
      const { response, body } = await json(url, options);
      assert.equal(response.status, status);
      assert.equal(body.error.code, code);
      assert.equal(typeof body.error.message, 'string');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  });
});

test('service errors preserve safe HTTP semantics without leaking paths or stacks', async () => {
  await withServer(async base => {
    const headers = { 'x-demo-user': 'admin-1', 'content-type': 'application/json' };
    for (const [name, status, code] of [['throw-forbidden', 403, 'FORBIDDEN'], ['throw-conflict', 409, 'CUSTOMER_REVIEW_REQUIRED'], ['throw-unexpected', 500, 'INTERNAL_ERROR']]) {
      const { response, body } = await json(`${base}/api/customers`, { method: 'POST', headers, body: JSON.stringify({ requestId: name, customer: { name } }) });
      assert.equal(response.status, status);
      assert.equal(body.error.code, code);
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes('hidden'), false);
      assert.equal(serialized.includes('sqlite'), false);
      assert.equal(serialized.includes('Error'), false);
    }
  });
});

test('JSON body limit permits exactly 1 MiB and rejects declared and streamed excess', async () => {
  await withServer(async base => {
    const headers = { 'x-demo-user': 'admin-1', 'content-type': 'application/json' };
    const exact = `{"requestId":"${'a'.repeat(1024 * 1024 - 16)}"}`;
    const accepted = await rawRequest(`${base}/api/customers`, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(exact) } }, [exact]);
    assert.equal(accepted.status, 200);
    const tooLarge = Buffer.alloc(1024 * 1024 + 1, 97);
    const declared = await rawRequest(`${base}/api/customers`, { method: 'POST', headers: { ...headers, 'content-length': tooLarge.length } }, [tooLarge]);
    assert.equal(declared.status, 413);
    assert.equal(JSON.parse(declared.body).error.code, 'PAYLOAD_TOO_LARGE');
    const streamed = await rawRequest(`${base}/api/customers`, { method: 'POST', headers }, [Buffer.alloc(700000, 97), Buffer.alloc(400000, 98)]);
    assert.equal(streamed.status, 413);
    assert.equal(JSON.parse(streamed.body).error.code, 'PAYLOAD_TOO_LARGE');
  });
});

test('static workbench uses explicit allowlisted paths, types, CSP, and no body for HEAD', async () => {
  await withServer(async base => {
    const expected = [['/', 'text/html; charset=utf-8'], ['/index.html', 'text/html; charset=utf-8'], ['/styles.css', 'text/css; charset=utf-8'], ['/app.js', 'text/javascript; charset=utf-8']];
    for (const [path, contentType] of expected) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), contentType);
    }
    const root = await fetch(`${base}/`);
    assert.match(root.headers.get('content-security-policy'), /default-src 'self'/);
    const head = await fetch(`${base}/styles.css`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const path of ['/missing.png', '/..%2f..%2fpackage.json', '/%2e%2e%5cpackage.json', '/styles.css/']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404);
    }
  });
});

test('static files require an exact raw request target and reject normalized traversal or empty queries', async () => {
  await withServer(async base => {
    for (const target of ['/%2e%2e/styles.css', '/x/%2e%2e/styles.css', '/styles.css?', '/?']) {
      assert.equal((await rawTargetRequest(base, target)).status, 404, target);
    }
    for (const target of ['/', '/index.html', '/styles.css', '/app.js']) assert.equal((await rawTargetRequest(base, target)).status, 200, target);
  });
});

test('API routing matches only the exact raw pathname while retaining allowed query scopes', async () => {
  await withServer(async base => {
    const headers = { 'x-demo-user': 'admin-1' };
    assert.equal((await rawTargetRequest(base, '/api/x/%2e%2e/dashboard', { headers })).status, 404);
    const { response } = await json(`${base}/api/customers?campusId=campus-a`, { headers });
    assert.equal(response.status, 200);
  });
});

test('405 Allow advertises only the methods implemented by each API route', async () => {
  await withServer(async base => {
    const headers = { 'x-demo-user': 'admin-1' };
    for (const [path, method, allow] of [
      ['/api/health', 'POST', 'GET'], ['/api/dashboard', 'POST', 'GET'], ['/api/customers', 'PUT', 'GET, POST'],
      ['/api/orders', 'GET', 'POST'], ['/api/ledger', 'GET', 'POST'], ['/api/conversations/triage', 'GET', 'POST']
    ]) {
      const { response } = await json(`${base}${path}`, { method, headers });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), allow);
    }
  });
});

test('a missing allowlisted public file fails closed with 404', async () => {
  const emptyPublicDir = mkdtempSync(join(tmpdir(), 'chengqiyun-empty-public-'));
  try {
    const server = createServer({ service: spyService().service, publicDir: emptyPublicDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
      assert.equal(response.status, 404);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { rmSync(emptyPublicDir, { recursive: true, force: true }); }
});

test('workbench source declares honest, accessible same-origin states without business constants or external assets', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const app = readFileSync(join(publicDir, 'app.js'), 'utf8');
  const css = readFileSync(join(publicDir, 'styles.css'), 'utf8');
  for (const label of ['工作台', '客户', 'AI 会话', '报名学员', '订单收款', '报表', '组织权限', '知识库', '成蹊云', '客户总数', '待人工', '成交额', '实收', '待收', 'AI 已回复', '待人工确认', '人工接管', '模块建设中']) assert.match(html, new RegExp(label));
  assert.match(html, /aria-live/);
  assert.match(app, /['"]\/api\/dashboard['"]/);
  assert.match(app, /['"]\/api\/customers['"]/);
  assert.match(app, /Intl\.NumberFormat\('zh-CN', \{ style: 'currency', currency: 'CNY' \}\)/);
  assert.match(app, /重新加载/);
  assert.match(app, /let loadGeneration = 0/);
  assert.match(app, /const generation = \+\+loadGeneration/);
  assert.match(app, /if \(generation !== loadGeneration\) return;/);
  assert.doesNotMatch(`${html}\n${app}\n${css}`, /https?:\/\//);
  assert.doesNotMatch(html, /成交额[^<]*[￥¥]\s*\d/);
  assert.doesNotMatch(html, /客户总数[^<]*\d/);
});
