'use strict';

const MAX_JSON_BYTES = 1024 * 1024;

const DEMO_ACTORS = Object.freeze({
  'admin-1': Object.freeze({ id: 'admin-1', roles: Object.freeze(['admin']), campusIds: Object.freeze([]), teamIds: Object.freeze([]) }),
  'supervisor-1': Object.freeze({ id: 'supervisor-1', roles: Object.freeze(['supervisor']), campusIds: Object.freeze(['campus-a']), teamIds: Object.freeze(['team-a']) }),
  'service-1': Object.freeze({ id: 'service-1', roles: Object.freeze(['service']), campusIds: Object.freeze(['campus-a']), teamIds: Object.freeze([]) }),
  'teacher-1': Object.freeze({ id: 'teacher-1', roles: Object.freeze(['teacher']), campusIds: Object.freeze(['campus-a']), teamIds: Object.freeze([]) }),
  'finance-1': Object.freeze({ id: 'finance-1', roles: Object.freeze(['finance']), campusIds: Object.freeze(['campus-a']), teamIds: Object.freeze([]) })
});

function makeError(code) { const error = new Error(code); error.code = code; return error; }
function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function pick(value, fields) {
  if (!object(value)) return value;
  const result = {};
  for (const field of fields) if (own(value, field)) result[field] = value[field];
  return result;
}
function actorFor(headers) {
  const id = headers['x-demo-user'];
  if (typeof id !== 'string' || id.includes(',') || !own(DEMO_ACTORS, id)) throw makeError('UNAUTHENTICATED');
  const actor = DEMO_ACTORS[id];
  return { id: actor.id, roles: [...actor.roles], campusIds: [...actor.campusIds], teamIds: [...actor.teamIds] };
}
function statusFor(code) {
  if (code === 'UNAUTHENTICATED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'METHOD_NOT_ALLOWED') return 405;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'UNSUPPORTED_MEDIA_TYPE') return 415;
  if (['CUSTOMER_REVIEW_REQUIRED', 'DUPLICATE_LEDGER_ENTRY', 'REQUEST_ID_CONFLICT', 'ID_CONFLICT'].includes(code)) return 409;
  if (code === 'INVALID_JSON' || code === 'INVALID_SCOPE' || code.startsWith('INVALID_') || code === 'UNAPPROVED_DISCOUNT') return 400;
  return 500;
}
function messageFor(code) {
  const messages = {
    UNAUTHENTICATED: '需要演示身份', FORBIDDEN: '没有权限执行此操作', NOT_FOUND: '资源不存在', METHOD_NOT_ALLOWED: '不支持的请求方法',
    PAYLOAD_TOO_LARGE: '请求内容过大', UNSUPPORTED_MEDIA_TYPE: '请求必须使用 JSON', INVALID_JSON: 'JSON 请求格式无效', INVALID_SCOPE: '查询范围无效'
  };
  return messages[code] || (statusFor(code) === 500 ? '服务器内部错误' : '请求无法完成');
}
function sendJson(response, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end(data);
}
function sendError(response, error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const status = statusFor(code);
  sendJson(response, status, { error: { code: status === 500 ? 'INTERNAL_ERROR' : code, message: messageFor(code) } }, status === 405 ? { allow: 'GET, POST, HEAD' } : {});
}
function readJson(request) {
  const type = request.headers['content-type'];
  if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) return Promise.reject(makeError('UNSUPPORTED_MEDIA_TYPE'));
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
    request.resume();
    return Promise.reject(makeError('PAYLOAD_TOO_LARGE'));
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let done = false;
    const chunks = [];
    const fail = code => {
      if (done) return;
      done = true;
      request.resume();
      reject(makeError(code));
    };
    request.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) return fail('PAYLOAD_TOO_LARGE');
      chunks.push(chunk);
    });
    request.on('error', () => fail('INVALID_JSON'));
    request.on('aborted', () => fail('INVALID_JSON'));
    request.on('end', () => {
      if (done) return;
      done = true;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(parsed)) throw makeError('INVALID_JSON');
        resolve(parsed);
      } catch (error) { reject(error?.code === 'INVALID_JSON' ? error : makeError('INVALID_JSON')); }
    });
  });
}
function scopeFor(url) {
  const scope = {};
  for (const [key, value] of url.searchParams) {
    if (!['campusId', 'teamId', 'ownerId'].includes(key) || own(scope, key)) throw makeError('INVALID_SCOPE');
    scope[key] = value;
  }
  return scope;
}
function noQuery(url) { if (url.search) throw makeError('INVALID_SCOPE'); }

function createApiRouter({ service }) {
  return async function route(request, response) {
    const url = new URL(request.url, 'http://same-origin.invalid');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      if (url.pathname === '/api/health') {
        if (request.method !== 'GET') throw makeError('METHOD_NOT_ALLOWED');
        noQuery(url);
        sendJson(response, 200, { ok: true });
        return true;
      }
      const actor = actorFor(request.headers);
      if (url.pathname === '/api/dashboard' && request.method === 'GET') {
        sendJson(response, 200, service.dashboard({ actor, scope: scopeFor(url) }));
      } else if (url.pathname === '/api/customers' && request.method === 'GET') {
        sendJson(response, 200, service.listCustomers({ actor, scope: scopeFor(url) }));
      } else if (url.pathname === '/api/customers' && request.method === 'POST') {
        noQuery(url); const body = await readJson(request);
        sendJson(response, 200, service.importCustomer({ actor, requestId: body.requestId, customer: pick(body.customer, ['name', 'phone', 'wechat', 'idNumber', 'idLast4', 'ownerId', 'campusId', 'teamId', 'assignedTeacherId', 'stage', 'nextFollowUpAt', 'notes']), source: pick(body.source, ['channel', 'batch']) }));
      } else if (url.pathname === '/api/orders' && request.method === 'POST') {
        noQuery(url); const body = await readJson(request);
        sendJson(response, 200, service.createOrder({ actor, requestId: body.requestId, customerId: body.customerId, order: pick(body.order, ['listPriceCents', 'discountCents', 'discountApproved', 'dueAt', 'title']) }));
      } else if (url.pathname === '/api/ledger' && request.method === 'POST') {
        noQuery(url); const body = await readJson(request);
        sendJson(response, 200, service.appendPayment({ actor, requestId: body.requestId, orderId: body.orderId, entry: pick(body.entry, ['type', 'idempotencyKey', 'amountCents', 'status', 'direction', 'occurredAt']) }));
      } else if (url.pathname === '/api/conversations/triage' && request.method === 'POST') {
        noQuery(url); const body = await readJson(request);
        sendJson(response, 200, service.triageConversation({ actor, requestId: body.requestId, customerId: body.customerId, conversation: pick(body.conversation, ['message', 'confidence', 'citations']) }));
      } else if (['/api/dashboard', '/api/customers', '/api/orders', '/api/ledger', '/api/conversations/triage'].includes(url.pathname)) {
        throw makeError('METHOD_NOT_ALLOWED');
      } else {
        throw makeError('NOT_FOUND');
      }
    } catch (error) { sendError(response, error); }
    return true;
  };
}

module.exports = { createApiRouter, DEMO_ACTORS, MAX_JSON_BYTES };
