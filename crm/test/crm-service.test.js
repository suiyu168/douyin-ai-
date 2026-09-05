'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { createStore } = require('../src/storage/sqlite-store');
const { createCrmService } = require('../src/services/crm-service');

// Public service contract: synchronous JSON-safe object arguments/results.
// Writes: { actor, requestId, customer|order|entry|conversation, source?, customerId?, orderId? }.
// Reads: { actor, scope?: { campusId?, teamId?, ownerId? } }.
// Import -> { decision, reasons, customer, sourceId }; order/payment -> { order, summary };
// triage -> { conversation }; list -> { customers };
// dashboard -> { customerCount, metrics, pendingHumanCount, pendingConversationIds }.
// Review is a CUSTOMER_REVIEW_REQUIRED error with safe decision/reasons, no mutation.
// Actor objects are trusted server-resolved identities, never browser-supplied roles.
const admin = { id: 'admin-1', roles: ['admin'], campusIds: [] };
const serviceActor = { id: 'service-1', roles: ['service'], campusIds: ['campus-a'] };
const financeActor = { id: 'finance-1', roles: ['finance'], campusIds: ['campus-a'] };
const clock = () => new Date('2026-09-05T00:00:00.000Z');
const customerInput = (extra = {}) => ({ name: '演示学员一', phone: '13800000001', wechat: 'demo_one', ownerId: 'service-1', campusId: 'campus-a', teamId: 'team-a', ...extra });
const imported = (service, requestId = 'import-1', extra = {}, actor = admin) => service.importCustomer({ actor, requestId, customer: customerInput(extra), source: { channel: 'demo', batch: 'batch-a' } });
const quoted = (service, customerId, requestId = 'order-1', extra = {}, actor = admin) => service.createOrder({ actor, requestId, customerId, order: { listPriceCents: 1_000_000, discountCents: 50_000, discountApproved: true, dueAt: '2026-09-01', ...extra } });
const paid = (service, orderId, requestId = 'payment-1', extra = {}, actor = admin) => service.appendPayment({ actor, requestId, orderId, entry: { type: 'payment', idempotencyKey: requestId, amountCents: 300_000, status: 'confirmed', occurredAt: '2026-09-04', ...extra } });
const triaged = (service, customerId, requestId = 'triage-1', extra = {}, actor = admin) => service.triageConversation({ actor, requestId, customerId, conversation: { message: '报名需要哪些材料', confidence: 0.9, citations: [], ...extra } });
const activeCitation = (id = 'knowledge-v1') => ({ id, status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01', expiresAt: '2026-10-01', text: 'fictional knowledge' });
function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  return { store, service: createCrmService({ store, clock }) };
}
function counts(store) {
  return ['customers', 'customer_sources', 'customer_identities', 'orders', 'ledger_entries', 'conversations', 'audit_events', 'request_results'].map(table => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n));
}

test('file-backed customer and order survive repeat migrations and reopen', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-service-'));
  let store;
  t.after(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, 'crm.sqlite');
  store = createStore(path);
  let service = createCrmService({ store, clock });
  const customer = imported(service).customer;
  const result = quoted(service, customer.id);
  assert.equal(result.order.agreedPriceCents, 950_000);
  assert.equal(result.summary.outstanding, 950_000);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  store.close(); store = createStore(path); service = createCrmService({ store, clock });
  assert.equal(service.listCustomers({ actor: admin }).customers[0].id, customer.id);
  assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM orders').get().payload).agreedPriceCents, 950_000);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM metadata').get().n, 1);
});

test('cross-batch phone and WeChat matches retain one master and each source', (t) => {
  const { store, service } = fixture(t);
  const first = imported(service);
  const second = service.importCustomer({ actor: admin, requestId: 'import-2', customer: customerInput({ phone: '+86 138-0000-0001', wechat: 'demo_alias', name: '新来源姓名' }), source: { channel: 'manual', batch: 'batch-b' } });
  const third = imported(service, 'import-3', { phone: '13900000002', wechat: ' DEMO_ALIAS ' });
  assert.equal(second.decision, 'merge'); assert.deepEqual(second.reasons, ['PHONE_MATCH']);
  assert.equal(third.decision, 'merge'); assert.deepEqual(third.reasons, ['WECHAT_MATCH']);
  assert.equal(third.customer.id, first.customer.id);
  assert.equal(second.customer.name, '演示学员一');
  assert.notEqual(first.sourceId, second.sourceId);
  assert.equal(service.listCustomers({ actor: admin }).customers.length, 1);
  const sources = store.db.prepare('SELECT payload FROM customer_sources').all().map(row => JSON.parse(row.payload));
  assert.deepEqual(sources.map(source => source.batch).sort(), ['batch-a', 'batch-a', 'batch-b']);
  const identities = store.db.prepare('SELECT field, hash FROM customer_identities').all();
  assert.equal(identities.length, 4);
  for (const identity of identities) assert.match(identity.hash, /^[a-f0-9]{64}$/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit_events').get().n, 3);
});

test('same request returns original bytes, including concurrent queued calls and changed input', async (t) => {
  const { store, service } = fixture(t);
  const first = imported(service);
  first.customer.name = 'mutated response';
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => imported(service, 'import-1', { phone: '13900000002' }))));
  const original = store.db.prepare('SELECT result FROM request_results').get().result;
  for (const result of duplicates) assert.equal(JSON.stringify(result), original);
  assert.deepEqual(counts(store), [1, 1, 2, 0, 0, 0, 1, 1]);
});

test('strong identity conflict and weak last-four match demand review without partial writes', (t) => {
  const { store, service } = fixture(t);
  imported(service, 'a', { idLast4: '1234' });
  imported(service, 'b', { phone: '13900000002', wechat: 'demo_two' });
  const before = counts(store);
  assert.throws(() => imported(service, 'conflict', { phone: '13800000001', wechat: 'demo_two' }), { code: 'CUSTOMER_REVIEW_REQUIRED', details: { decision: 'review', reasons: ['STRONG_IDENTITY_CONFLICT'] } });
  assert.throws(() => imported(service, 'weak', { phone: '13700000003', wechat: 'demo_three', idLast4: '1234' }), { code: 'CUSTOMER_REVIEW_REQUIRED', details: { decision: 'review', reasons: ['ID_LAST4_MATCH'] } });
  assert.deepEqual(counts(store), before);
});

test('customer masking follows the requesting actor and strips unrecognized secrets', (t) => {
  const { store, service } = fixture(t);
  const result = imported(service, 'masked', { idNumber: 'FICTIONAL-ID-1234', token: 'fake-token', cookie: 'fake-cookie', nested: { password: 'fake-pass' } }, serviceActor);
  assert.equal(result.customer.phone, '138****0001');
  assert.equal(result.customer.idNumber, '**************1234');
  assert.equal(service.listCustomers({ actor: financeActor }).customers[0].phone, '13800000001');
  assert.equal(service.listCustomers({ actor: admin }).customers[0].idNumber, 'FICTIONAL-ID-1234');
  assert.doesNotMatch(JSON.stringify(result), /fake-token|fake-cookie|fake-pass/);
  assert.doesNotMatch(store.db.prepare('SELECT payload FROM customers').get().payload, /fake-token|fake-cookie|fake-pass/);
});

test('default reads filter scope while explicit cross-scope reads and imports are denied', (t) => {
  const { store, service } = fixture(t);
  imported(service);
  imported(service, 'other', { phone: '13900000002', wechat: 'other', campusId: 'campus-b', ownerId: 'service-2' });
  assert.equal(service.listCustomers({ actor: serviceActor }).customers.length, 1);
  const before = counts(store);
  for (const scope of [{ campusId: 'campus-b' }, { ownerId: 'service-2' }]) assert.throws(() => service.listCustomers({ actor: serviceActor, scope }), { code: 'FORBIDDEN' });
  assert.throws(() => imported(service, 'forbidden', { ownerId: 'service-2' }, serviceActor), { code: 'FORBIDDEN' });
  // A caller cannot claim ownership of a pre-existing master through its incoming data.
  assert.throws(() => imported(service, 'steal', { phone: '13900000002', wechat: 'new' }, serviceActor), { code: 'FORBIDDEN' });
  for (const actor of [null, {}, { id: 'x', roles: ['admin'] }, { ...admin, id: ' ' }, { ...admin, roles: [] }]) {
    assert.throws(() => service.listCustomers({ actor }), { code: 'FORBIDDEN' });
    assert.throws(() => imported(service, 'bad-actor', {}, actor), { code: 'FORBIDDEN' });
  }
  assert.deepEqual(counts(store), before);
});

test('request replay cannot disclose original results to another actor or downgraded actor', (t) => {
  const { store, service } = fixture(t);
  imported(service);
  const before = counts(store);
  assert.throws(() => imported(service, 'import-1', {}, serviceActor), { code: 'FORBIDDEN' });
  assert.throws(() => imported(service, 'import-1', {}, { ...admin, roles: ['service'], campusIds: ['campus-a'] }), { code: 'FORBIDDEN' });
  assert.deepEqual(counts(store), before);
});

test('caller IDs are ignored and generated customer/source/audit collisions roll back', (t) => {
  const { store, service } = fixture(t);
  const first = imported(service, 'one', { id: 'caller-customer' });
  assert.notEqual(first.customer.id, 'caller-customer');
  const before = counts(store);
  for (const target of [first.customer.id, first.sourceId, store.db.prepare('SELECT id FROM audit_events').get().id]) {
    const generated = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    generated[target === first.customer.id ? 0 : target === first.sourceId ? 1 : 2] = target;
    const mock = t.mock.method(crypto, 'randomUUID', () => generated.shift());
    try { assert.throws(() => imported(service, 'collision', { phone: '13900000002', wechat: 'different' }), { code: 'ID_CONFLICT' }); }
    finally { mock.mock.restore(); }
    assert.deepEqual(counts(store), before);
  }
  const second = imported(service, 'two', { id: first.customer.id, phone: '13900000002', wechat: 'different' });
  assert.notEqual(second.customer.id, first.customer.id);
});

test('audit failure rolls back customer identities sources and request-result atomically', (t) => {
  const { store, service } = fixture(t);
  store.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  assert.throws(() => imported(service));
  assert.deepEqual(counts(store), [0, 0, 0, 0, 0, 0, 0, 0]);
  store.db.exec('DROP TRIGGER reject_audit');
  assert.equal(imported(service).decision, 'create');
});

test('invalid request IDs dates and malformed customer/source inputs fail without writes', (t) => {
  const { store, service } = fixture(t);
  for (const requestId of [undefined, null, '', ' ', 42, {}, 'x'.repeat(201)]) assert.throws(() => imported(service, requestId === undefined ? null : requestId), { code: 'INVALID_REQUEST_ID' });
  for (const customer of [null, [], 2, { ...customerInput(), phone: {} }, { ...customerInput(), campusId: '' }, Object.create(customerInput())]) {
    assert.throws(() => service.importCustomer({ actor: admin, requestId: 'bad', customer }), { code: 'INVALID_CUSTOMER' });
  }
  assert.throws(() => service.importCustomer({ actor: admin, requestId: 'bad', customer: customerInput(), source: [] }), { code: 'INVALID_SOURCE' });
  for (const value of [new Date('bad'), null, {}, 'not-a-date']) {
    const badClock = createCrmService({ store, clock: () => value });
    assert.throws(() => imported(badClock), { code: 'INVALID_DATE' });
  }
  assert.deepEqual(counts(store), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('orders and ledger use server IDs, append-only cents, and original retry results', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const created = quoted(service, customerId, 'order', { id: 'caller-order', ledger: [{ amountCents: 999 }], agreedPriceCents: 1, token: 'fake-token' });
  assert.notEqual(created.order.id, 'caller-order'); assert.deepEqual(created.order.ledger, []);
  const first = paid(service, created.order.id, 'paid', { id: 'caller-entry' });
  assert.notEqual(first.order.ledger[0].id, 'caller-entry');
  assert.equal(first.summary.received, 300_000);
  assert.equal(first.summary.outstanding, 650_000);
  const second = paid(service, created.order.id, 'paid2', { amountCents: 200_000 });
  assert.equal(second.summary.received, 500_000);
  assert.deepEqual(second.order.ledger[0], first.order.ledger[0]);
  assert.equal(JSON.stringify(quoted(service, customerId, 'order', { listPriceCents: 123 })), JSON.stringify(created));
  assert.equal(JSON.stringify(paid(service, created.order.id, 'paid', { amountCents: 555 })), JSON.stringify(first));
  assert.doesNotMatch(JSON.stringify(created), /fake-token/);
  assert.deepEqual(counts(store), [1, 1, 2, 1, 2, 0, 4, 4]);
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT payload FROM orders').get().payload).ledger, []);
});

test('refund reversal adjustments and unconfirmed entries preserve accounting', (t) => {
  const { service } = fixture(t);
  const orderId = quoted(service, imported(service).customer.id).order.id;
  paid(service, orderId, 'pay', { amountCents: 500_000 });
  paid(service, orderId, 'refund', { type: 'refund', amountCents: 50_000 });
  paid(service, orderId, 'reversal', { type: 'reversal', amountCents: 20_000 });
  paid(service, orderId, 'increase', { type: 'adjustment', direction: 'increase', amountCents: 30_000 });
  paid(service, orderId, 'decrease', { type: 'adjustment', direction: 'decrease', amountCents: 10_000 });
  paid(service, orderId, 'pending', { amountCents: 400_000, status: 'pending' });
  const final = paid(service, orderId, 'rejected', { amountCents: 900_000, status: 'rejected' });
  assert.deepEqual(final.summary, { agreed: 950_000, receivable: 970_000, received: 500_000, refunded: 50_000, reversed: 20_000, outstanding: 540_000, netReceived: 430_000, overdue: true });
  assert.equal(final.order.ledger.length, 7);
});

test('duplicate ledger keys across requests and orders never overwrite earlier entries', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const first = quoted(service, customerId, 'o1').order.id;
  const second = quoted(service, customerId, 'o2').order.id;
  paid(service, first, 'p1', { idempotencyKey: 'global-key', status: 'pending' });
  const before = counts(store);
  for (const orderId of [first, second]) assert.throws(() => paid(service, orderId, 'p2', { idempotencyKey: 'global-key', amountCents: 123 }), { code: 'DUPLICATE_LEDGER_ENTRY' });
  assert.deepEqual(counts(store), before);
  const row = JSON.parse(store.db.prepare('SELECT payload FROM ledger_entries').get().payload);
  assert.equal(row.amountCents, 300_000); assert.equal(row.status, 'pending');
});

test('order and ledger permissions use actual customer scope and finance remains read-only', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const orderId = quoted(service, customerId, 'owned', {}, serviceActor).order.id;
  paid(service, orderId, 'allowed', {}, serviceActor);
  const outsiders = [financeActor, { ...serviceActor, id: 'other' }, { ...serviceActor, campusIds: ['campus-b'] }, null];
  const before = counts(store);
  for (const actor of outsiders) {
    assert.throws(() => quoted(service, customerId, 'forbidden-order', {}, actor), { code: 'FORBIDDEN' });
    assert.throws(() => paid(service, orderId, 'forbidden-payment', { ownerId: actor?.id }, actor), { code: 'FORBIDDEN' });
  }
  assert.deepEqual(counts(store), before);
});

test('generated order and ledger ID collisions fail atomically', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const orderId = quoted(service, customerId).order.id;
  const ledgerId = paid(service, orderId).order.ledger[0].id;
  const before = counts(store);
  for (const [collision, work] of [[orderId, () => quoted(service, customerId, 'new-order')], [ledgerId, () => paid(service, orderId, 'new-payment')]]) {
    const mock = t.mock.method(crypto, 'randomUUID', () => collision);
    try { assert.throws(work, { code: 'ID_CONFLICT' }); } finally { mock.mock.restore(); }
    assert.deepEqual(counts(store), before);
  }
});

test('malformed order money dates entries and arithmetic overflow roll back', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const orderId = quoted(service, customerId).order.id;
  const before = counts(store);
  for (const listPriceCents of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '100']) assert.throws(() => quoted(service, customerId, 'bad', { listPriceCents }), { code: 'INVALID_MONEY' });
  assert.throws(() => quoted(service, customerId, 'bad', { discountApproved: false }), { code: 'UNAPPROVED_DISCOUNT' });
  for (const dueAt of ['invalid', null, {}, new Date('bad')]) assert.throws(() => quoted(service, customerId, 'bad', { dueAt }), { code: 'INVALID_DATE' });
  for (const order of [null, [], Object.create({ listPriceCents: 100 })]) assert.throws(() => service.createOrder({ actor: admin, requestId: 'bad', customerId, order }), { code: 'INVALID_ORDER' });
  for (const extra of [{ amountCents: 0.5 }, { amountCents: -1 }, { status: 'settled' }, { type: 'unknown' }, { occurredAt: 'bad' }, { idempotencyKey: '' }, { type: 'adjustment', direction: 'sideways' }]) assert.throws(() => paid(service, orderId, 'bad', extra));
  assert.throws(() => service.appendPayment({ actor: admin, requestId: 'bad', orderId, entry: [] }), { code: 'INVALID_LEDGER_ENTRY' });
  assert.deepEqual(counts(store), before);
  paid(service, orderId, 'max', { amountCents: Number.MAX_SAFE_INTEGER });
  const beforeOverflow = counts(store);
  assert.throws(() => paid(service, orderId, 'overflow', { amountCents: 1 }), { code: 'INVALID_ORDER' });
  assert.deepEqual(counts(store), beforeOverflow);
});

test('order payment audit and request-result failures leave no partial writes', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const orderId = quoted(service, customerId).order.id;
  const before = counts(store);
  for (const table of ['audit_events', 'request_results']) {
    store.db.exec(`CREATE TRIGGER reject_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;`);
    assert.throws(() => quoted(service, customerId, 'new-order'));
    assert.throws(() => paid(service, orderId, 'new-payment'));
    assert.deepEqual(counts(store), before);
    store.db.exec('DROP TRIGGER reject_write');
  }
  assert.equal(paid(service, orderId, 'new-payment').summary.received, 300_000);
});

test('cross-operation request IDs conflict without mutation', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const before = counts(store);
  assert.throws(() => quoted(service, customerId, 'import-1'), { code: 'REQUEST_ID_CONFLICT' });
  assert.deepEqual(counts(store), before);
});

test('store transaction rollback enforces foreign keys and rejects asynchronous callbacks', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.transaction(() => {
    store.db.prepare('INSERT INTO customers (id, payload) VALUES (?, ?)').run('temp', '{}');
    store.db.prepare('INSERT INTO orders (id, customer_id, payload) VALUES (?, ?, ?)').run('order', 'missing', '{}');
  }));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM customers').get().n, 0);
  assert.throws(() => store.transaction(async () => 1), { code: 'ASYNC_TRANSACTION' });
  assert.throws(() => store.transaction(() => Promise.resolve(1)), { code: 'ASYNC_TRANSACTION' });
});

test('triage persists filtered citation IDs and overrides high confidence on every mandatory risk', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const suggestion = triaged(service, customerId);
  assert.equal(suggestion.conversation.mode, 'suggestion');
  assert.deepEqual(suggestion.conversation.citations, []);
  const citations = [activeCitation(), activeCitation(), { ...activeCitation('expired'), expiresAt: '2026-09-05' }, { ...activeCitation('draft'), status: 'draft' }];
  const automatic = triaged(service, customerId, 'automatic', { citations });
  assert.equal(automatic.conversation.mode, 'auto_reply');
  assert.deepEqual(automatic.conversation.citations, ['knowledge-v1']);
  const risks = ['投诉', '退款', '合同', '付款异常', '资格不确定', '非标准优惠', '身份证', '保过', '包毕业'];
  for (const [index, message] of risks.entries()) assert.equal(triaged(service, customerId, `risk-${index}`, { message, confidence: 0.99, citations }).conversation.mode, 'human_required');
  const rows = store.db.prepare('SELECT payload FROM conversations').all();
  assert.equal(rows.length, 11);
  assert.doesNotMatch(JSON.stringify(rows), /fictional knowledge|expired|draft/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit_events').get().n, 12);
});

test('triage IDs retries permissions validation and audit rollback are enforced', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const first = triaged(service, customerId, 'triage', { id: 'caller-id', cookie: 'fake-cookie' }, serviceActor);
  assert.notEqual(first.conversation.id, 'caller-id');
  assert.doesNotMatch(JSON.stringify(first), /fake-cookie/);
  assert.equal(JSON.stringify(triaged(service, customerId, 'triage', { message: 'changed' }, serviceActor)), JSON.stringify(first));
  const before = counts(store);
  for (const actor of [financeActor, { ...serviceActor, id: 'other' }, null]) assert.throws(() => triaged(service, customerId, 'forbidden', {}, actor), { code: 'FORBIDDEN' });
  for (const conversation of [null, [], { message: {} }]) assert.throws(() => service.triageConversation({ actor: admin, requestId: 'bad', customerId, conversation }), { code: 'INVALID_CONVERSATION' });
  const mock = t.mock.method(crypto, 'randomUUID', () => first.conversation.id);
  try { assert.throws(() => triaged(service, customerId, 'collision'), { code: 'ID_CONFLICT' }); } finally { mock.mock.restore(); }
  assert.deepEqual(counts(store), before);
  store.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  assert.throws(() => triaged(service, customerId, 'failed'));
  assert.deepEqual(counts(store), before);
});

test('each successful operation has one complete audit with only safe summaries', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'import', { idNumber: 'FICTIONAL-ID-1234', notes: 'token=fake-secret; cookie=fake-session' }).customer.id;
  const orderId = quoted(service, customerId, 'order').order.id;
  const ledgerId = paid(service, orderId, 'ledger').order.ledger[0].id;
  const conversationId = triaged(service, customerId, 'triage', { message: '身份证 FICTIONAL-ID-1234 token=fake-secret cookie=fake-session' }).conversation.id;
  const audits = store.db.prepare('SELECT * FROM audit_events ORDER BY rowid').all();
  assert.deepEqual(audits.map(audit => [audit.actor_id, audit.action, audit.entity_type, audit.entity_id, audit.request_id, audit.timestamp]), [
    ['admin-1', 'customer.import', 'customer', customerId, 'import', '2026-09-05T00:00:00.000Z'],
    ['admin-1', 'order.create', 'order', orderId, 'order', '2026-09-05T00:00:00.000Z'],
    ['admin-1', 'ledger.append', 'ledger_entry', ledgerId, 'ledger', '2026-09-05T00:00:00.000Z'],
    ['admin-1', 'conversation.triage', 'conversation', conversationId, 'triage', '2026-09-05T00:00:00.000Z'],
  ]);
  for (const audit of audits) { assert.ok(audit.id); assert.doesNotThrow(() => JSON.parse(audit.before_summary)); assert.ok(JSON.parse(audit.after_summary)); }
  assert.doesNotMatch(JSON.stringify(audits), /FICTIONAL-ID-1234|fake-secret|fake-session|13800000001/);
  assert.equal(JSON.parse(audits[2].before_summary).received, 0);
  assert.equal(JSON.parse(audits[2].after_summary).received, 300_000);
});

test('dashboard monetary metrics use confirmed ledger and deterministic order drill-down', (t) => {
  const { service } = fixture(t);
  const customerId = imported(service, 'c1', { notes: '收入999999999元' }).customer.id;
  imported(service, 'c2', { phone: '13900000002', wechat: 'two' });
  const first = quoted(service, customerId, 'o1').order.id;
  const second = quoted(service, customerId, 'o2', { listPriceCents: 100_000, discountCents: 0 }).order.id;
  paid(service, first, 'p1', { amountCents: 500_000 });
  paid(service, first, 'r', { type: 'refund', amountCents: 50_000 });
  paid(service, first, 'v', { type: 'reversal', amountCents: 20_000 });
  paid(service, first, 'a', { type: 'adjustment', direction: 'increase', amountCents: 30_000 });
  paid(service, first, 'd', { type: 'adjustment', direction: 'decrease', amountCents: 10_000 });
  paid(service, second, 'p2', { amountCents: 10_000 });
  paid(service, second, 'pending', { amountCents: 99_999, status: 'pending' });
  paid(service, second, 'rejected', { type: 'refund', amountCents: 88_888, status: 'rejected' });
  const report = service.dashboard({ actor: admin });
  assert.equal(report.customerCount, 2);
  const both = [first, second].sort();
  assert.deepEqual(report.metrics, {
    agreed: { amountCents: 1_050_000, orderIds: both },
    receivable: { amountCents: 1_070_000, orderIds: both },
    received: { amountCents: 510_000, orderIds: both },
    outstanding: { amountCents: 630_000, orderIds: both },
    refunded: { amountCents: 50_000, orderIds: [first] },
    reversed: { amountCents: 20_000, orderIds: [first] },
    netReceived: { amountCents: 440_000, orderIds: both },
  });
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(report))), JSON.stringify(report));
});

test('dashboard filters actual permissions rejects explicit scope escapes and starts empty', (t) => {
  const { service } = fixture(t);
  const empty = service.dashboard({ actor: admin });
  assert.equal(empty.customerCount, 0);
  for (const metric of Object.values(empty.metrics)) assert.deepEqual(metric, { amountCents: 0, orderIds: [] });
  const customerId = imported(service).customer.id;
  const orderId = quoted(service, customerId).order.id;
  const otherId = imported(service, 'other-c', { phone: '13900000002', wechat: 'other', campusId: 'campus-b', ownerId: 'other' }).customer.id;
  quoted(service, otherId, 'other-o');
  assert.equal(service.dashboard({ actor: financeActor }).customerCount, 1);
  assert.deepEqual(service.dashboard({ actor: financeActor }).metrics.agreed, { amountCents: 950_000, orderIds: [orderId] });
  assert.equal(service.dashboard({ actor: serviceActor }).customerCount, 1);
  assert.deepEqual(service.dashboard({ actor: serviceActor }).metrics.agreed, { amountCents: 0, orderIds: [] });
  for (const actor of [serviceActor, financeActor]) assert.throws(() => service.dashboard({ actor, scope: { campusId: 'campus-b' } }), { code: 'FORBIDDEN' });
  assert.throws(() => service.dashboard({ actor: null }), { code: 'FORBIDDEN' });
});

test('dashboard counts only persisted human-required conversations visible to the actor', (t) => {
  const { service } = fixture(t);
  assert.equal(service.dashboard({ actor: admin }).pendingHumanCount, 0);
  assert.deepEqual(service.dashboard({ actor: admin }).pendingConversationIds, []);
  const ownId = imported(service, 'own-c', { notes: 'human_required，待人工999' }).customer.id;
  const otherId = imported(service, 'other-c', { phone: '13900000002', wechat: 'other', campusId: 'campus-b', ownerId: 'other' }).customer.id;
  const first = triaged(service, ownId, 'risk-one', { message: '我要退款' }).conversation.id;
  const second = triaged(service, ownId, 'risk-two', { message: '合同问题' }).conversation.id;
  const other = triaged(service, otherId, 'risk-other', { message: '我要投诉' }).conversation.id;
  triaged(service, ownId, 'suggestion', { mode: 'human_required' });
  triaged(service, ownId, 'auto', { citations: [activeCitation()] });
  triaged(service, ownId, 'risk-one', { message: '重复请求不能多算' });
  const all = service.dashboard({ actor: admin });
  assert.equal(all.pendingHumanCount, 3);
  assert.deepEqual(all.pendingConversationIds, [first, second, other].sort());
  for (const input of [{ actor: serviceActor }, { actor: admin, scope: { campusId: 'campus-a' } }]) {
    const scoped = service.dashboard(input);
    assert.equal(scoped.pendingHumanCount, 2);
    assert.deepEqual(scoped.pendingConversationIds, [first, second].sort());
  }
  const finance = service.dashboard({ actor: financeActor });
  assert.equal(finance.pendingHumanCount, 0);
  assert.deepEqual(finance.pendingConversationIds, []);
  assert.throws(() => service.dashboard({ actor: serviceActor, scope: { campusId: 'campus-b' } }), { code: 'FORBIDDEN' });
});

test('dashboard refuses aggregate overflow instead of silently rounding cents', (t) => {
  const { service } = fixture(t);
  const customerId = imported(service).customer.id;
  quoted(service, customerId, 'huge', { listPriceCents: Number.MAX_SAFE_INTEGER, discountCents: 0 });
  quoted(service, customerId, 'one', { listPriceCents: 1, discountCents: 0 });
  assert.throws(() => service.dashboard({ actor: admin }), { code: 'INVALID_TOTAL' });
});

test('reopened stores share request idempotency results for the whole workflow', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-reopen-'));
  const path = join(dir, 'crm.sqlite');
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  stores.push(createStore(path));
  let service = createCrmService({ store: stores[0], clock });
  const customer = imported(service);
  const order = quoted(service, customer.customer.id);
  const payment = paid(service, order.order.id);
  const conversation = triaged(service, customer.customer.id, 'triage-1', { message: '合同问题' });
  const report = service.dashboard({ actor: admin });
  assert.equal(report.pendingHumanCount, 1);
  assert.deepEqual(report.pendingConversationIds, [conversation.conversation.id]);
  const before = counts(stores[0]);
  stores[0].close();
  stores.push(createStore(path)); stores.push(createStore(path));
  for (const store of stores.slice(1)) {
    service = createCrmService({ store, clock });
    assert.equal(JSON.stringify(imported(service)), JSON.stringify(customer));
    assert.equal(JSON.stringify(quoted(service, customer.customer.id)), JSON.stringify(order));
    assert.equal(JSON.stringify(paid(service, order.order.id)), JSON.stringify(payment));
    assert.equal(JSON.stringify(triaged(service, customer.customer.id)), JSON.stringify(conversation));
    assert.deepEqual(service.dashboard({ actor: admin }), report);
    assert.deepEqual(counts(store), before);
  }
});

test('ledger idempotency keys have one canonical stored value including whitespace', (t) => {
  const { store, service } = fixture(t);
  const orderId = quoted(service, imported(service).customer.id).order.id;
  const first = paid(service, orderId, 'one', { idempotencyKey: '  settlement-key  ' });
  assert.equal(first.order.ledger[0].idempotencyKey, 'settlement-key');
  const before = counts(store);
  assert.throws(() => paid(service, orderId, 'two', { idempotencyKey: ' settlement-key ' }), { code: 'DUPLICATE_LEDGER_ENTRY' });
  assert.deepEqual(counts(store), before);
});

test('order ID normalization cannot hide existing ledger entries from an append', (t) => {
  const { service } = fixture(t);
  const orderId = quoted(service, imported(service).customer.id).order.id;
  paid(service, orderId, 'first');
  const second = paid(service, ` ${orderId} `, 'second', { amountCents: 200_000 });
  assert.equal(second.order.ledger.length, 2);
  assert.equal(second.summary.received, 500_000);
  assert.equal(second.summary.outstanding, 450_000);
});

test('order approval rejects nonprimitive credential-bearing payloads', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const before = counts(store);
  assert.throws(() => quoted(service, customerId, 'bad-order', { discountCents: 0, discountApproved: { token: 'fictional-token' } }), { code: 'INVALID_ORDER' });
  assert.deepEqual(counts(store), before);
});

test('ledger direction rejects nonprimitive credential-bearing payloads', (t) => {
  const { store, service } = fixture(t);
  const orderId = quoted(service, imported(service).customer.id).order.id;
  const before = counts(store);
  assert.throws(() => paid(service, orderId, 'bad-entry', { direction: { cookie: 'fictional-cookie' } }), { code: 'INVALID_LEDGER_ENTRY' });
  assert.deepEqual(counts(store), before);
});

test('parallel independent SQLite connections commit one copy of a shared request', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-parallel-'));
  const path = join(dir, 'crm.sqlite');
  const store = createStore(path);
  const workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const ready = [];
  const results = [];
  for (let i = 0; i < 3; i++) {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { createStore } = require(workerData.storeModule);
      const { createCrmService } = require(workerData.serviceModule);
      const store = createStore(workerData.path);
      const service = createCrmService({ store, clock: () => new Date('2026-09-05T00:00:00.000Z') });
      parentPort.once('message', () => {
        try { parentPort.postMessage({ result: service.importCustomer(workerData.input) }); }
        finally { store.close(); }
      });
      parentPort.postMessage({ ready: true });
    `, { eval: true, workerData: { path, storeModule: require.resolve('../src/storage/sqlite-store'), serviceModule: require.resolve('../src/services/crm-service'), input: { actor: admin, requestId: 'parallel-import', customer: customerInput(), source: { channel: 'demo', batch: 'parallel' } } } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); }));
    results.push(new Promise((resolve, reject) => { worker.once('error', reject); worker.on('message', message => { if (message.result) resolve(message.result); }); }));
  }
  await Promise.all(ready);
  for (const worker of workers) worker.postMessage('go');
  const responses = await Promise.all(results);
  assert.equal(new Set(responses.map(result => JSON.stringify(result))).size, 1);
  assert.deepEqual(counts(store), [1, 1, 2, 0, 0, 0, 1, 1]);
});
