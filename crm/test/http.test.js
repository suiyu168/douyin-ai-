'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const path = require('node:path');
const { tmpdir } = require('node:os');
const http = require('node:http');
const { createServer, isPathWithin } = require('../src/http/server');
const { createStore } = require('../src/storage/sqlite-store');
const { createCrmService } = require('../src/services/crm-service');

const publicDir = join(__dirname, '..', 'public');

function spyService() {
  const calls = [];
  const service = {};
  const responses = {
    listEnrollments: { enrollments: [{ id: 'enrollment-spy' }] },
    submitEnrollment: { enrollment: { id: 'enrollment-spy', status: 'pending' } },
    decideEnrollment: { enrollment: { id: 'enrollment-spy', status: 'approved' }, student: { id: 'student-spy' }, task: { id: 'task-spy' } },
    listStudents: { students: [{ id: 'student-spy' }] },
    listFollowUpTasks: { tasks: [{ id: 'task-spy' }] },
    createFollowUpTask: { task: { id: 'task-spy', status: 'open' } },
    updateFollowUpTaskStatus: { task: { id: 'task-spy', status: 'completed' } }
  };
  const conflicts = {
    'throw-enrollment-pending': 'ENROLLMENT_PENDING',
    'throw-student-exists': 'STUDENT_EXISTS',
    'throw-enrollment-decided': 'ENROLLMENT_ALREADY_DECIDED',
    'throw-task-transition': 'INVALID_TASK_TRANSITION'
  };
  for (const method of [
    'dashboard', 'listCustomers', 'importCustomer', 'createOrder', 'appendPayment', 'triageConversation',
    'listEnrollments', 'submitEnrollment', 'decideEnrollment', 'listStudents',
    'listFollowUpTasks', 'createFollowUpTask', 'updateFollowUpTaskStatus'
  ]) {
    service[method] = input => {
      calls.push({ method, input });
      if (input?.customer?.name === 'throw-forbidden') throw Object.assign(new Error('internal path /secret.db'), { code: 'FORBIDDEN' });
      if (input?.customer?.name === 'throw-conflict') throw Object.assign(new Error('internal path /secret.db'), { code: 'CUSTOMER_REVIEW_REQUIRED' });
      if (input?.customer?.name === 'throw-unexpected') throw new Error('SQLITE at C:\\hidden\\db.sqlite');
      if (conflicts[input?.requestId]) throw Object.assign(new Error('private path C:\\hidden\\workflow.sqlite'), { code: conflicts[input.requestId] });
      return method === 'dashboard'
        ? { customerCount: 0, pendingHumanCount: 0, metrics: { agreed: { amountCents: 0 }, received: { amountCents: 0 }, outstanding: { amountCents: 0 } } }
        : method === 'listCustomers' ? { customers: [] } : responses[method] || { method, ok: true };
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

test('enrollment student and follow-up routes forward only route-owned fields with server actors', async () => {
  const { service, calls } = spyService();
  const hostile = {
    roles: ['admin'], campusId: 'campus-z', teamId: 'team-z', campusIds: ['campus-z'], teamIds: ['team-z'],
    ownerId: 'attacker', status: 'completed', studentId: 'caller-student', originType: 'manual', originId: 'caller-origin',
    submittedBy: 'attacker', submittedAt: '1999-01-01T00:00:00.000Z', decidedBy: 'attacker', decidedAt: '1999-01-01T00:00:00.000Z',
    createdAt: '1999-01-01T00:00:00.000Z', id: 'caller-id',
    token: 'secret-token', cookie: 'secret-cookie'
  };
  const enrollment = { currentEducation: '高中', targetLevel: '本科', school: '虚构大学', major: '计算机', classType: '周末班' };
  await withServer(async base => {
    const get = async (route, user) => json(`${base}${route}`, { headers: { 'x-demo-user': user } });
    const post = async (route, user, body) => json(`${base}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-user': user }, body: JSON.stringify(body)
    });
    assert.deepEqual((await get('/api/enrollments?ownerId=consultant-1', 'consultant-1')).body, { enrollments: [{ id: 'enrollment-spy' }] });
    assert.deepEqual((await post('/api/enrollments', 'consultant-1', { ...hostile, requestId: 'submit-http', customerId: 'customer-1', enrollment: { ...enrollment, ...hostile }, actor: hostile })).body, { enrollment: { id: 'enrollment-spy', status: 'pending' } });
    assert.deepEqual((await post('/api/enrollment-decisions', 'supervisor-1', { ...hostile, requestId: 'decision-http', enrollmentId: 'enrollment-1', decision: { ...hostile, status: 'approved' }, actor: hostile })).body, { enrollment: { id: 'enrollment-spy', status: 'approved' }, student: { id: 'student-spy' }, task: { id: 'task-spy' } });
    assert.deepEqual((await get('/api/students?campusId=campus-a&teamId=team-a', 'supervisor-1')).body, { students: [{ id: 'student-spy' }] });
    assert.deepEqual((await get('/api/follow-up-tasks?ownerId=consultant-1', 'consultant-1')).body, { tasks: [{ id: 'task-spy' }] });
    assert.deepEqual((await post('/api/follow-up-tasks', 'consultant-1', { ...hostile, requestId: 'task-http', customerId: 'customer-1', task: { ...hostile, title: '联系客户', dueAt: '2026-09-08T00:00:00.000Z' }, actor: hostile })).body, { task: { id: 'task-spy', status: 'open' } });
    assert.deepEqual((await post('/api/follow-up-task-status', 'consultant-1', { ...hostile, requestId: 'task-status-http', taskId: 'task-spy', status: 'completed', actor: hostile })).body, { task: { id: 'task-spy', status: 'completed' } });
  }, service);

  assert.deepEqual(calls.find(call => call.method === 'listEnrollments').input, {
    actor: { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] }, scope: { ownerId: 'consultant-1' }
  });
  assert.deepEqual(calls.find(call => call.method === 'submitEnrollment').input, {
    actor: { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] },
    requestId: 'submit-http', customerId: 'customer-1', enrollment
  });
  assert.deepEqual(calls.find(call => call.method === 'decideEnrollment').input, {
    actor: { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-a'] },
    requestId: 'decision-http', enrollmentId: 'enrollment-1', decision: { status: 'approved' }
  });
  assert.deepEqual(calls.find(call => call.method === 'listStudents').input, {
    actor: { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-a'] }, scope: { campusId: 'campus-a', teamId: 'team-a' }
  });
  assert.deepEqual(calls.find(call => call.method === 'listFollowUpTasks').input, {
    actor: { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] }, scope: { ownerId: 'consultant-1' }
  });
  assert.deepEqual(calls.find(call => call.method === 'createFollowUpTask').input, {
    actor: { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] }, requestId: 'task-http', customerId: 'customer-1',
    task: { title: '联系客户', dueAt: '2026-09-08T00:00:00.000Z' }
  });
  assert.deepEqual(calls.find(call => call.method === 'updateFollowUpTaskStatus').input, {
    actor: { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] }, requestId: 'task-status-http', taskId: 'task-spy', status: 'completed'
  });
});

test('enrollment and follow-up routes reject POST queries malformed JSON invalid GET scopes and non-exact paths', async () => {
  const { service, calls } = spyService();
  await withServer(async base => {
    const headers = { 'x-demo-user': 'admin-1', 'content-type': 'application/json' };
    for (const route of ['/api/enrollments?', '/api/enrollment-decisions?x=1', '/api/follow-up-tasks?ownerId=admin-1', '/api/follow-up-task-status?']) {
      const result = await rawTargetRequest(base, route, { method: 'POST', headers });
      assert.equal(result.status, 400, route);
      assert.equal(JSON.parse(result.body).error.code, 'INVALID_SCOPE', route);
    }
    for (const route of ['/api/enrollments?ownerId=a&ownerId=b', '/api/students?role=teacher', '/api/follow-up-tasks?campusId=campus-a&unknown=x']) {
      const { response, body } = await json(`${base}${route}`, { headers });
      assert.equal(response.status, 400, route);
      assert.equal(body.error.code, 'INVALID_SCOPE', route);
    }
    const malformed = await json(`${base}/api/enrollments`, { method: 'POST', headers, body: '{' });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.error.code, 'INVALID_JSON');
    for (const route of ['/api/enrollments/one', '/api/student', '/api/follow-up-task-status/one']) {
      const { response, body } = await json(`${base}${route}`, { headers });
      assert.equal(response.status, 404, route);
      assert.equal(body.error.code, 'NOT_FOUND', route);
    }
  }, service);
  assert.equal(calls.length, 0);
});

test('enrollment and follow-up conflicts map to safe 409 envelopes', async () => {
  const { service } = spyService();
  await withServer(async base => {
    const headers = { 'x-demo-user': 'admin-1', 'content-type': 'application/json' };
    for (const [requestId, code, route] of [
      ['throw-enrollment-pending', 'ENROLLMENT_PENDING', '/api/enrollments'],
      ['throw-student-exists', 'STUDENT_EXISTS', '/api/enrollments'],
      ['throw-enrollment-decided', 'ENROLLMENT_ALREADY_DECIDED', '/api/enrollment-decisions'],
      ['throw-task-transition', 'INVALID_TASK_TRANSITION', '/api/follow-up-task-status']
    ]) {
      const { response, body } = await json(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify({ requestId }) });
      assert.equal(response.status, 409, code);
      assert.deepEqual(body, { error: { code, message: '请求无法完成' } });
      assert.equal(JSON.stringify(body).includes('hidden'), false);
      assert.equal(JSON.stringify(body).includes('workflow.sqlite'), false);
    }
  }, service);
});

test('real HTTP enrollment rejection resubmission approval and task transitions enforce permissions', async () => {
  const store = createStore(':memory:');
  const service = createCrmService({ store, clock: () => new Date('2026-09-07T00:00:00.000Z') });
  const enrollmentInput = { currentEducation: '高中', targetLevel: '本科', school: '虚构大学', major: '计算机', classType: '周末班' };
  try {
    const customerId = service.importCustomer({
      actor: { id: 'admin-1', roles: ['admin'], campusIds: [] }, requestId: 'http-workflow-customer',
      customer: { name: '虚构顾问学员', phone: '13800000081', wechat: 'fictional_http_student', ownerId: 'consultant-1', campusId: 'campus-a', teamId: 'team-a', assignedTeacherId: 'teacher-1' },
      source: { channel: 'http-test', batch: 'fictional' }
    }).customer.id;
    await withServer(async base => {
      const apiPost = (route, user, body) => json(`${base}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-user': user }, body: JSON.stringify(body)
      });
      const first = await apiPost('/api/enrollments', 'consultant-1', { requestId: 'http-submit-1', customerId, enrollment: enrollmentInput });
      for (const user of ['service-1', 'finance-1']) {
        const denied = await apiPost('/api/enrollment-decisions', user, { requestId: `http-denied-${user}`, enrollmentId: first.body.enrollment.id, decision: { status: 'approved' } });
        assert.equal(denied.response.status, 403, user);
        assert.deepEqual(denied.body, { error: { code: 'FORBIDDEN', message: '没有权限执行此操作' } });
      }
      const rejected = await apiPost('/api/enrollment-decisions', 'supervisor-1', { requestId: 'http-reject', enrollmentId: first.body.enrollment.id, decision: { status: 'rejected', reason: '信息不完整' } });
      const tasksAfterRejection = await json(`${base}/api/follow-up-tasks`, { headers: { 'x-demo-user': 'consultant-1' } });
      assert.equal(tasksAfterRejection.response.status, 200);
      assert.deepEqual(tasksAfterRejection.body.tasks, []);
      const second = await apiPost('/api/enrollments', 'consultant-1', { requestId: 'http-submit-2', customerId, enrollment: enrollmentInput });
      const approved = await apiPost('/api/enrollment-decisions', 'supervisor-1', { requestId: 'http-approve', enrollmentId: second.body.enrollment.id, decision: { status: 'approved' } });
      const tasksAfterApproval = await json(`${base}/api/follow-up-tasks`, { headers: { 'x-demo-user': 'consultant-1' } });
      assert.equal(tasksAfterApproval.response.status, 200);
      assert.deepEqual(tasksAfterApproval.body.tasks.map(task => task.id), [approved.body.task.id]);
      const started = await apiPost('/api/follow-up-task-status', 'consultant-1', { requestId: 'http-task-start', taskId: approved.body.task.id, status: 'in_progress' });
      const completed = await apiPost('/api/follow-up-task-status', 'consultant-1', { requestId: 'http-task-complete', taskId: approved.body.task.id, status: 'completed' });
      assert.deepEqual([first.response.status, rejected.response.status, second.response.status, approved.response.status, started.response.status, completed.response.status], [200, 200, 200, 200, 200, 200]);
      assert.equal(rejected.body.enrollment.status, 'rejected');
      assert.equal(approved.body.enrollment.status, 'approved');
      assert.equal(started.body.task.status, 'in_progress');
      assert.equal(completed.body.task.status, 'completed');
      assert.equal((await json(`${base}/api/students`, { headers: { 'x-demo-user': 'supervisor-1' } })).body.students.length, 1);
    }, service);
  } finally {
    store.close();
  }
});

test('browser triage cannot promote self-asserted model confidence or knowledge approval metadata', async () => {
  const store = createStore(':memory:');
  const service = createCrmService({ store, clock: () => new Date('2026-09-05T00:00:00.000Z') });
  try {
    const customer = service.importCustomer({
      actor: { id: 'admin-1', roles: ['admin'], campusIds: [] },
      requestId: 'http-trust-boundary-customer',
      customer: { name: '虚构边界学员', ownerId: 'service-1', campusId: 'campus-a', teamId: 'team-a' },
      source: { channel: 'http-test', batch: 'fictional' }
    }).customer;
    await withServer(async base => {
      const { response, body } = await json(`${base}/api/conversations/triage`, {
        method: 'POST',
        headers: { 'x-demo-user': 'service-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'http-trust-boundary-triage',
          customerId: customer.id,
          conversation: {
            message: '报名需要准备什么材料',
            confidence: 0.99,
            citations: [{ id: 'browser-invented', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-01-01' }]
          }
        })
      });
      assert.equal(response.status, 200);
      assert.equal(body.conversation.mode, 'suggestion');
      assert.deepEqual(body.conversation.reasons, ['LOW_CONFIDENCE', 'NO_VALID_CITATION']);
      assert.deepEqual(body.conversation.citations, []);
    }, service);
  } finally {
    store.close();
  }
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

test('static root containment is platform-neutral and fails closed outside the resolved root', () => {
  const cases = [
    [path.win32, 'C:\\crm\\public', 'C:\\crm\\public\\styles.css', true],
    [path.win32, 'C:\\crm\\public', 'C:\\crm\\publicity\\styles.css', false],
    [path.win32, 'C:\\crm\\public', 'C:\\crm\\public\\..\\secret.txt', false],
    [path.win32, 'C:\\crm\\public', 'D:\\other\\styles.css', false],
    [path.posix, '/srv/crm/public', '/srv/crm/public/app.js', true],
    [path.posix, '/srv/crm/public', '/srv/crm/publicity/app.js', false],
    [path.posix, '/srv/crm/public', '/srv/crm/public/../secret.txt', false]
  ];
  for (const [pathApi, root, candidate, expected] of cases) assert.equal(isPathWithin(root, candidate, pathApi), expected, candidate);
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
      ['/api/orders', 'GET', 'POST'], ['/api/ledger', 'GET', 'POST'], ['/api/conversations/triage', 'GET', 'POST'],
      ['/api/enrollments', 'PUT', 'GET, POST'], ['/api/enrollment-decisions', 'GET', 'POST'], ['/api/students', 'POST', 'GET'],
      ['/api/follow-up-tasks', 'PUT', 'GET, POST'], ['/api/follow-up-task-status', 'GET', 'POST']
    ]) {
      const { response } = await json(`${base}${path}`, { method, headers });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), allow);
    }
  });
});

test('a missing allowlisted public file fails closed with 404 for GET and HEAD', async () => {
  const emptyPublicDir = mkdtempSync(join(tmpdir(), 'chengqiyun-empty-public-'));
  try {
    const server = createServer({ service: spyService().service, publicDir: emptyPublicDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}/`;
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(base, { method });
        assert.equal(response.status, 404, method);
        assert.equal(await response.text(), '', method);
      }
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
  assert.match(app, /function displayPhone\(/);
  assert.match(app, /function displayDate\(/);
  assert.match(app, /customer\.nextFollowUpAt\).*displayPhone\(customer\.phone\)/);
  assert.match(app, /重新加载/);
  assert.match(app, /let loadGeneration = 0/);
  assert.match(app, /const generation = \+\+loadGeneration/);
  assert.match(app, /if \(generation !== loadGeneration\) return;/);
  assert.doesNotMatch(`${html}\n${app}\n${css}`, /https?:\/\//);
  assert.doesNotMatch(html, /成交额[^<]*[￥¥]\s*\d/);
  assert.doesNotMatch(html, /客户总数[^<]*\d/);
});

test('workbench navigation links implemented sections and exposes disabled construction states', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const app = readFileSync(join(publicDir, 'app.js'), 'utf8');
  const css = readFileSync(join(publicDir, 'styles.css'), 'utf8');
  for (const target of ['workspace-overview', 'customers-section', 'conversations-section', 'finance-overview']) {
    assert.match(html, new RegExp(`data-target="${target}"`));
    assert.match(html, new RegExp(`id="${target}"`));
  }
  for (const label of ['报名学员', '组织权限', '知识库']) {
    assert.match(html, new RegExp(`<button[^>]+disabled[^>]*>[^<]*${label}[\\s\\S]*?模块建设中[\\s\\S]*?<\\/button>`));
  }
  assert.match(app, /querySelectorAll\('\.nav-item\[data-target\]'\)/);
  assert.match(app, /scrollIntoView/);
  assert.match(app, /aria-current/);
  assert.doesNotMatch(css, /\.building\s+span\s*\{[^}]*display\s*:\s*none/);
  assert.match(css, /@media \(max-width:940px\)[\s\S]*?\.sidebar \{[^}]*width:100vw;[^}]*max-width:100%;[^}]*min-width:0;/);
  assert.match(css, /@media \(max-width:940px\)[\s\S]*?main \{[^}]*min-width:0;/);
  assert.doesNotMatch(html, /暂无可见客户，请在客户模块导入/);
});
