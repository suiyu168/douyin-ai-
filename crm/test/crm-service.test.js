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
// Writes: { actor, requestId, customer|order|entry|conversation|enrollment|decision|task, source?, customerId?, orderId?, enrollmentId?, taskId?, status? }.
// Reads: { actor, scope?: { campusId?, teamId?, ownerId? } }.
// Import -> { decision, reasons, customer, sourceId }; order/payment -> { order, summary };
// triage -> { conversation }; enrollment decision -> { enrollment, student, task }; lists -> { customers|enrollments|students|tasks };
// dashboard preserves customer/conversation/money fields and adds traceable enrollment/student/task counts and IDs.
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
const enrollmentInput = (extra = {}) => ({ currentEducation: '高中', targetLevel: '本科', school: '虚构大学', major: '计算机', classType: '周末班', ...extra });
const submittedEnrollment = (service, customerId, requestId = 'submit-1', extra = {}, actor = admin) => service.submitEnrollment({ actor, requestId, customerId, enrollment: enrollmentInput(extra) });
const createdTask = (service, customerId, requestId = 'task-create-1', extra = {}, actor = admin) => service.createFollowUpTask({
  actor, requestId, customerId, task: { title: '联系客户', dueAt: '2026-09-04T23:59:59.999Z', ...extra },
});
const activeCitation = (id = 'knowledge-v1') => ({ id, status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01', expiresAt: '2026-10-01', text: 'fictional knowledge' });
function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  return { store, service: createCrmService({ store, clock }) };
}
function counts(store) {
  return ['customers', 'customer_sources', 'customer_identities', 'orders', 'ledger_entries', 'conversations', 'audit_events', 'request_results'].map(table => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n));
}

function workflowCounts(store) {
  return ['enrollment_applications', 'students', 'follow_up_tasks', 'audit_events', 'request_results']
    .map(table => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n));
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

test('phone merges enrich only blank master fields and audit only names those changes', (t) => {
  const { store, service } = fixture(t);
  const first = service.importCustomer({ actor: admin, requestId: 'phone-only', customer: customerInput({ wechat: '', notes: '', name: '原始姓名' }), source: { channel: 'demo', batch: 'batch-a' } });
  const merged = service.importCustomer({ actor: admin, requestId: 'phone-enrichment', customer: customerInput({
    wechat: 'new_wechat', notes: '新来源备注', name: '不应覆盖姓名', ownerId: 'service-2', campusId: 'campus-b', teamId: 'team-b',
  }), source: { channel: 'manual', batch: 'batch-b' } });
  const retried = service.importCustomer({ actor: admin, requestId: 'phone-enrichment', customer: customerInput({ wechat: 'different_wechat' }), source: { channel: 'changed', batch: 'changed' } });
  const stored = JSON.parse(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(first.customer.id).payload);
  const audit = store.db.prepare("SELECT after_summary FROM audit_events WHERE request_id = 'phone-enrichment'").get();

  assert.equal(merged.decision, 'merge');
  assert.equal(merged.customer.wechat, 'new_wechat');
  assert.equal(merged.customer.notes, '新来源备注');
  assert.equal(merged.customer.name, '原始姓名');
  assert.deepEqual([merged.customer.ownerId, merged.customer.campusId, merged.customer.teamId], ['service-1', 'campus-a', 'team-a']);
  assert.equal(stored.wechat, 'new_wechat');
  assert.equal(stored.notes, '新来源备注');
  assert.equal(stored.name, '原始姓名');
  assert.deepEqual([stored.ownerId, stored.campusId, stored.teamId], ['service-1', 'campus-a', 'team-a']);
  assert.deepEqual(JSON.parse(audit.after_summary).changedFields, ['notes', 'wechat']);
  assert.doesNotMatch(audit.after_summary, /new_wechat|新来源备注/);
  assert.equal(JSON.stringify(retried), JSON.stringify(merged));
  assert.deepEqual(counts(store), [1, 2, 2, 0, 0, 0, 2, 2]);
});

test('failed audit rolls back an enrichment merge without partial customer changes', (t) => {
  const { store, service } = fixture(t);
  const first = service.importCustomer({ actor: admin, requestId: 'phone-only', customer: customerInput({ wechat: '', notes: '' }), source: { channel: 'demo', batch: 'batch-a' } });
  const before = { payload: store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(first.customer.id).payload, counts: counts(store) };
  store.db.exec("CREATE TRIGGER reject_enrichment_audit BEFORE INSERT ON audit_events WHEN NEW.request_id = 'failed-enrichment' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");

  assert.throws(() => service.importCustomer({ actor: admin, requestId: 'failed-enrichment', customer: customerInput({ wechat: 'new_wechat', notes: '新来源备注' }), source: { channel: 'manual', batch: 'batch-b' } }));
  assert.equal(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(first.customer.id).payload, before.payload);
  assert.deepEqual(counts(store), before.counts);
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

test('customer import derives canonical X ID suffixes and rejects conflicting explicit suffixes', (t) => {
  const { store, service } = fixture(t);
  const first = imported(service, 'id-x-first', {
    phone: '', wechat: '', idNumber: '11010119900101123X', idLast4: ''
  });
  const stored = JSON.parse(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(first.customer.id).payload);
  assert.equal(stored.idLast4, '123X');

  const beforeReview = counts(store);
  assert.throws(() => imported(service, 'id-x-review', {
    phone: '', wechat: '', idNumber: '', idLast4: '123x'
  }), (error) => error.code === 'CUSTOMER_REVIEW_REQUIRED' && error.details.reasons.includes('ID_LAST4_MATCH'));
  assert.deepEqual(counts(store), beforeReview);

  assert.throws(() => imported(service, 'id-x-conflict', {
    phone: '', wechat: '', idNumber: '11010119900101123X', idLast4: '9999'
  }), { code: 'INVALID_CUSTOMER' });
  assert.deepEqual(counts(store), beforeReview);
});

test('merge keeps the full ID and suffix as one coherent identity', (t) => {
  const { store, service } = fixture(t);
  const first = imported(service, 'suffix-only', { idNumber: '', idLast4: '1234' });
  const beforeConflict = {
    payload: store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(first.customer.id).payload,
    counts: counts(store),
  };

  assert.throws(() => imported(service, 'conflicting-full-id', {
    idNumber: '110101199001015678', idLast4: '5678'
  }), {
    code: 'CUSTOMER_REVIEW_REQUIRED',
    details: { decision: 'review', reasons: ['IDENTITY_FIELD_CONFLICT'] },
  });
  assert.equal(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(first.customer.id).payload, beforeConflict.payload);
  assert.deepEqual(counts(store), beforeConflict.counts);

  const compatible = imported(service, 'compatible-full-id', {
    idNumber: '110101199001011234', idLast4: '1234'
  });
  const stored = JSON.parse(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(first.customer.id).payload);
  assert.equal(compatible.decision, 'merge');
  assert.equal(stored.idNumber, '110101199001011234');
  assert.equal(stored.idLast4, '1234');
});

test('full ID comparison canonicalizes a terminal lowercase x', (t) => {
  const { store, service } = fixture(t);
  const first = imported(service, 'lowercase-full-id', { idNumber: '11010119900101123x', idLast4: '' });
  const second = imported(service, 'uppercase-full-id', { idNumber: '11010119900101123X', idLast4: '' });
  const stored = JSON.parse(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(first.customer.id).payload);

  assert.equal(first.customer.id, second.customer.id);
  assert.equal(second.decision, 'merge');
  assert.equal(stored.idNumber, '11010119900101123X');
  assert.equal(stored.idLast4, '123X');
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

test('order and ledger permissions use actual customer scope and ledger writes require admin', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service).customer.id;
  const orderId = quoted(service, customerId, 'owned', {}, serviceActor).order.id;
  paid(service, orderId, 'allowed', {}, admin);
  const orderOutsiders = [financeActor, { ...serviceActor, id: 'other' }, { ...serviceActor, campusIds: ['campus-b'] }, null];
  const ledgerOutsiders = [serviceActor, ...orderOutsiders];
  const before = counts(store);
  for (const actor of orderOutsiders) {
    assert.throws(() => quoted(service, customerId, 'forbidden-order', {}, actor), { code: 'FORBIDDEN' });
  }
  for (const actor of ledgerOutsiders) {
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

test('scoped approval atomically creates one student and first task', (t) => {
  const { store, service } = fixture(t);
  const consultant = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const supervisor = { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-a'] };
  const customerId = imported(service, 'enrollment-customer', { ownerId: 'consultant-1', assignedTeacherId: 'teacher-1' }).customer.id;
  const submitted = service.submitEnrollment({ actor: consultant, requestId: 'submit-1', customerId, enrollment: enrollmentInput() });
  const approved = service.decideEnrollment({ actor: supervisor, requestId: 'approve-1', enrollmentId: submitted.enrollment.id, decision: { status: 'approved' } });

  assert.equal(approved.enrollment.status, 'approved');
  assert.equal(approved.student.customerId, customerId);
  assert.deepEqual(approved.task, {
    id: approved.task.id, customerId, studentId: approved.student.id, originType: 'enrollment_approval', originId: submitted.enrollment.id,
    ownerId: 'consultant-1', title: '完成报名交接', dueAt: '2026-09-06T00:00:00.000Z', status: 'open', overdue: false,
  });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM students').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM follow_up_tasks').get().n, 1);
});

test('enrollment submission requires consultant ownership and campus scope', (t) => {
  const { store, service } = fixture(t);
  const consultant = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const own = imported(service, 'own-enrollment-customer', { ownerId: consultant.id }).customer.id;
  const other = imported(service, 'other-enrollment-customer', { phone: '13900000002', wechat: 'other', ownerId: 'consultant-2' }).customer.id;
  const otherCampus = imported(service, 'campus-enrollment-customer', { phone: '13900000003', wechat: 'campus', ownerId: consultant.id, campusId: 'campus-b' }).customer.id;
  assert.equal(submittedEnrollment(service, own, 'own-submit', {}, consultant).enrollment.submittedBy, consultant.id);
  const before = workflowCounts(store);
  for (const customerId of [other, otherCampus]) assert.throws(() => submittedEnrollment(service, customerId, `forbidden-${customerId}`, {}, consultant), { code: 'FORBIDDEN' });
  assert.deepEqual(workflowCounts(store), before);
});

test('enrollment approval requires supervisor campus and team scope', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'supervisor-scope-customer', { ownerId: 'consultant-1' }).customer.id;
  const enrollmentId = submittedEnrollment(service, customerId).enrollment.id;
  const before = workflowCounts(store);
  for (const actor of [
    { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-b'], teamIds: ['team-a'] },
    { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-b'] },
  ]) assert.throws(() => service.decideEnrollment({ actor, requestId: `scope-${actor.campusIds[0]}-${actor.teamIds[0]}`, enrollmentId, decision: { status: 'approved' } }), { code: 'FORBIDDEN' });
  assert.deepEqual(workflowCounts(store), before);
});

test('admin has global enrollment decision and read access', (t) => {
  const { service } = fixture(t);
  const customerId = imported(service, 'remote-enrollment-customer', { campusId: 'campus-z', teamId: 'team-z', ownerId: 'consultant-z' }).customer.id;
  const enrollmentId = submittedEnrollment(service, customerId, 'admin-submit').enrollment.id;
  const approved = service.decideEnrollment({ actor: admin, requestId: 'admin-approve', enrollmentId, decision: { status: 'approved' } });
  assert.equal(approved.enrollment.status, 'approved');
  assert.equal(service.listEnrollments({ actor: admin, scope: { campusId: 'campus-z' } }).enrollments.length, 1);
  assert.equal(service.listStudents({ actor: admin, scope: { teamId: 'team-z' } }).students.length, 1);
});

test('service teacher and finance actors cannot submit or decide enrollments', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'denied-enrollment-customer', { ownerId: 'service-1', assignedTeacherId: 'teacher-1' }).customer.id;
  const enrollmentId = submittedEnrollment(service, customerId, 'admin-enrollment').enrollment.id;
  const actors = [serviceActor, { id: 'teacher-1', roles: ['teacher'], campusIds: ['campus-a'], teamIds: [] }, financeActor];
  const before = workflowCounts(store);
  for (const actor of actors) {
    assert.throws(() => submittedEnrollment(service, customerId, `submit-${actor.id}`, {}, actor), { code: 'FORBIDDEN' });
    assert.throws(() => service.decideEnrollment({ actor, requestId: `decide-${actor.id}`, enrollmentId, decision: { status: 'approved' } }), { code: 'FORBIDDEN' });
  }
  assert.deepEqual(workflowCounts(store), before);
});

test('one pending enrollment is allowed per customer', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'pending-enrollment-customer').customer.id;
  submittedEnrollment(service, customerId, 'pending-first');
  const before = workflowCounts(store);
  assert.throws(() => submittedEnrollment(service, customerId, 'pending-second'), { code: 'ENROLLMENT_PENDING' });
  assert.deepEqual(workflowCounts(store), before);
});

test('enrollment rejection requires a reason and permits resubmission', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'rejected-enrollment-customer').customer.id;
  const first = submittedEnrollment(service, customerId, 'rejected-first').enrollment;
  const beforeInvalid = workflowCounts(store);
  for (const decision of [{ status: 'rejected' }, { status: 'rejected', reason: ' ' }, { status: 'approved', reason: '不应存在' }]) {
    assert.throws(() => service.decideEnrollment({ actor: admin, requestId: `invalid-reject-${JSON.stringify(decision)}`, enrollmentId: first.id, decision }), { code: 'INVALID_ENROLLMENT_DECISION' });
  }
  assert.deepEqual(workflowCounts(store), beforeInvalid);
  const rejected = service.decideEnrollment({ actor: admin, requestId: 'reject-valid', enrollmentId: first.id, decision: { status: 'rejected', reason: ' 信息不完整 ' } });
  assert.equal(rejected.enrollment.rejectionReason, '信息不完整');
  assert.equal(rejected.student, null);
  assert.equal(rejected.task, null);
  const second = submittedEnrollment(service, customerId, 'resubmit-after-rejection').enrollment;
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'pending');
});

test('approved customers reject further enrollment and decided applications reject another decision', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'existing-student-customer').customer.id;
  const enrollmentId = submittedEnrollment(service, customerId).enrollment.id;
  service.decideEnrollment({ actor: admin, requestId: 'first-approval', enrollmentId, decision: { status: 'approved' } });
  const before = workflowCounts(store);
  assert.throws(() => submittedEnrollment(service, customerId, 'submit-with-student'), { code: 'STUDENT_EXISTS' });
  assert.throws(() => service.decideEnrollment({ actor: admin, requestId: 'second-approval', enrollmentId, decision: { status: 'approved' } }), { code: 'ENROLLMENT_ALREADY_DECIDED' });
  assert.deepEqual(workflowCounts(store), before);
});

test('enrollment workflow uses server IDs and timestamps and student copies no customer PII', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'server-enrollment-fields', { name: '不可复制姓名', phone: '13900000009', wechat: 'private-wechat', idNumber: 'FICTIONAL-ID-9009', notes: 'private-notes' }).customer.id;
  const submitted = submittedEnrollment(service, customerId, 'server-submit', { id: 'caller-enrollment', status: 'approved', submittedBy: 'caller', submittedAt: '1999-01-01T00:00:00.000Z' }).enrollment;
  assert.notEqual(submitted.id, 'caller-enrollment');
  assert.equal(submitted.status, 'pending');
  assert.equal(submitted.submittedBy, 'admin-1');
  assert.equal(submitted.submittedAt, '2026-09-05T00:00:00.000Z');
  const approved = service.decideEnrollment({ actor: admin, requestId: 'server-approve', enrollmentId: submitted.id, decision: { status: 'approved', id: 'caller-student', decidedBy: 'caller', decidedAt: '1999-01-01T00:00:00.000Z' } });
  assert.notEqual(approved.student.id, 'caller-student');
  assert.equal(approved.student.createdAt, '2026-09-05T00:00:00.000Z');
  assert.equal(approved.enrollment.decidedBy, 'admin-1');
  assert.equal(approved.enrollment.decidedAt, '2026-09-05T00:00:00.000Z');
  const studentPayload = store.db.prepare('SELECT payload FROM students WHERE id = ?').get(approved.student.id).payload;
  assert.deepEqual(Object.keys(JSON.parse(studentPayload)).sort(), ['createdAt', 'customerId', 'enrollmentId', 'id', 'status']);
  assert.doesNotMatch(studentPayload, /不可复制姓名|13900000009|private-wechat|FICTIONAL-ID-9009|private-notes/);
});

test('enrollment submission and approval replay their original byte-equivalent results', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'replayed-enrollment-customer').customer.id;
  const firstSubmit = submittedEnrollment(service, customerId, 'replayed-submit');
  const replayedSubmit = submittedEnrollment(service, customerId, 'replayed-submit', { school: '已更改' });
  assert.equal(JSON.stringify(replayedSubmit), JSON.stringify(firstSubmit));
  const firstApproval = service.decideEnrollment({ actor: admin, requestId: 'replayed-approval', enrollmentId: firstSubmit.enrollment.id, decision: { status: 'approved' } });
  const replayedApproval = service.decideEnrollment({ actor: admin, requestId: 'replayed-approval', enrollmentId: 'changed-id', decision: { status: 'rejected', reason: '已更改' } });
  assert.equal(JSON.stringify(replayedApproval), JSON.stringify(firstApproval));
  assert.deepEqual(workflowCounts(store), [1, 1, 1, 3, 3]);
});

test('enrollment request replay rejects cross-actor and downgraded identities', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'protected-replay-customer').customer.id;
  const enrollmentId = submittedEnrollment(service, customerId, 'protected-submit').enrollment.id;
  const before = workflowCounts(store);
  for (const actor of [
    { id: 'other-admin', roles: ['admin'], campusIds: [], teamIds: [] },
    { ...admin, roles: ['finance'], campusIds: ['campus-a'], teamIds: [] },
  ]) assert.throws(() => submittedEnrollment(service, customerId, 'protected-submit', {}, actor), { code: 'FORBIDDEN' });
  service.decideEnrollment({ actor: admin, requestId: 'protected-approval', enrollmentId, decision: { status: 'approved' } });
  const afterApproval = workflowCounts(store);
  for (const actor of [
    { id: 'other-admin', roles: ['admin'], campusIds: [], teamIds: [] },
    { ...admin, roles: ['finance'], campusIds: ['campus-a'], teamIds: [] },
  ]) assert.throws(() => service.decideEnrollment({ actor, requestId: 'protected-approval', enrollmentId, decision: { status: 'approved' } }), { code: 'FORBIDDEN' });
  assert.deepEqual(before.slice(0, 3), [1, 0, 0]);
  assert.deepEqual(workflowCounts(store), afterApproval);
});

test('generated enrollment student task and audit ID collisions roll back atomically', (t) => {
  const { store, service } = fixture(t);
  const firstCustomerId = imported(service, 'collision-first-customer').customer.id;
  const firstEnrollment = submittedEnrollment(service, firstCustomerId, 'collision-first-submit').enrollment;
  const firstApproval = service.decideEnrollment({ actor: admin, requestId: 'collision-first-approval', enrollmentId: firstEnrollment.id, decision: { status: 'approved' } });
  const existingAuditId = store.db.prepare("SELECT id FROM audit_events WHERE request_id = 'collision-first-approval'").get().id;

  const submissionCustomerId = imported(service, 'collision-submit-customer', { phone: '13900000002', wechat: 'collision-submit' }).customer.id;
  let before = workflowCounts(store);
  let mock = t.mock.method(crypto, 'randomUUID', () => firstEnrollment.id);
  try { assert.throws(() => submittedEnrollment(service, submissionCustomerId, 'collision-submit'), { code: 'ID_CONFLICT' }); }
  finally { mock.mock.restore(); }
  assert.deepEqual(workflowCounts(store), before);

  const approvalCustomerId = imported(service, 'collision-approval-customer', { phone: '13900000003', wechat: 'collision-approval' }).customer.id;
  const pendingId = submittedEnrollment(service, approvalCustomerId, 'collision-approval-submit').enrollment.id;
  before = workflowCounts(store);
  for (const [position, collision] of [[0, firstApproval.student.id], [1, firstApproval.task.id], [2, existingAuditId]]) {
    const generated = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    generated[position] = collision;
    mock = t.mock.method(crypto, 'randomUUID', () => generated.shift());
    try { assert.throws(() => service.decideEnrollment({ actor: admin, requestId: `collision-approval-${position}`, enrollmentId: pendingId, decision: { status: 'approved' } }), { code: 'ID_CONFLICT' }); }
    finally { mock.mock.restore(); }
    assert.equal(store.db.prepare('SELECT status FROM enrollment_applications WHERE id = ?').get(pendingId).status, 'pending');
    assert.deepEqual(workflowCounts(store), before);
  }
});

test('approval audit and request-result failures roll back enrollment student and task', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'approval-trigger-customer').customer.id;
  const enrollmentId = submittedEnrollment(service, customerId, 'approval-trigger-submit').enrollment.id;
  for (const table of ['audit_events', 'request_results']) {
    const before = workflowCounts(store);
    store.db.exec(`CREATE TRIGGER reject_enrollment_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;`);
    assert.throws(() => service.decideEnrollment({ actor: admin, requestId: `approval-trigger-${table}`, enrollmentId, decision: { status: 'approved' } }));
    assert.equal(store.db.prepare('SELECT status FROM enrollment_applications WHERE id = ?').get(enrollmentId).status, 'pending');
    assert.deepEqual(workflowCounts(store), before);
    store.db.exec('DROP TRIGGER reject_enrollment_write');
  }
  assert.equal(service.decideEnrollment({ actor: admin, requestId: 'approval-after-trigger', enrollmentId, decision: { status: 'approved' } }).student.status, 'active');
});

test('enrollment audit summaries exclude application reasons and customer PII', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'safe-enrollment-audit-customer', { name: 'SECRET-CUSTOMER-NAME', phone: '13900000009', idNumber: 'SECRET-ID-9009' }).customer.id;
  const rejectedId = submittedEnrollment(service, customerId, 'safe-audit-submit-one', { school: 'SECRET-SCHOOL', major: 'SECRET-MAJOR' }).enrollment.id;
  service.decideEnrollment({ actor: admin, requestId: 'safe-audit-reject', enrollmentId: rejectedId, decision: { status: 'rejected', reason: 'SECRET-REASON' } });
  const approvedId = submittedEnrollment(service, customerId, 'safe-audit-submit-two', { school: 'SECRET-SCHOOL', major: 'SECRET-MAJOR' }).enrollment.id;
  service.decideEnrollment({ actor: admin, requestId: 'safe-audit-approve', enrollmentId: approvedId, decision: { status: 'approved' } });
  const audits = store.db.prepare("SELECT action, before_summary, after_summary FROM audit_events WHERE action LIKE 'enrollment.%' ORDER BY rowid").all();
  assert.deepEqual(audits.map(row => row.action), ['enrollment.submit', 'enrollment.decide', 'enrollment.submit', 'enrollment.decide']);
  assert.deepEqual(JSON.parse(audits[1].after_summary), { status: 'rejected', studentCreated: false, taskCreated: false });
  assert.deepEqual(JSON.parse(audits[3].after_summary), { status: 'approved', studentCreated: true, taskCreated: true });
  assert.doesNotMatch(JSON.stringify(audits), /SECRET-SCHOOL|SECRET-MAJOR|SECRET-REASON|SECRET-CUSTOMER-NAME|13900000009|SECRET-ID-9009/);
});

test('enrollment and student lists apply module authorization masking scope and stable ordering', (t) => {
  const { service } = fixture(t);
  const consultant = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const supervisor = { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-a'] };
  const teacher = { id: 'teacher-1', roles: ['teacher'], campusIds: ['campus-a'], teamIds: [] };
  const firstCustomer = imported(service, 'list-first-customer', { name: '列表客户一', ownerId: consultant.id, assignedTeacherId: teacher.id }).customer;
  const secondCustomer = imported(service, 'list-second-customer', { name: '列表客户二', phone: '13900000002', wechat: 'list-two', ownerId: consultant.id, assignedTeacherId: teacher.id }).customer;
  const hiddenCustomer = imported(service, 'list-hidden-customer', { name: '隐藏客户', phone: '13900000003', wechat: 'list-hidden', campusId: 'campus-b', teamId: 'team-b', ownerId: 'consultant-b', assignedTeacherId: 'teacher-b' }).customer;
  const secondEnrollment = submittedEnrollment(service, secondCustomer.id, 'list-submit-second', {}, consultant).enrollment;
  const firstEnrollment = submittedEnrollment(service, firstCustomer.id, 'list-submit-first', {}, consultant).enrollment;
  const hiddenEnrollment = submittedEnrollment(service, hiddenCustomer.id, 'list-submit-hidden').enrollment;
  const firstStudent = service.decideEnrollment({ actor: supervisor, requestId: 'list-approve-first', enrollmentId: firstEnrollment.id, decision: { status: 'approved' } }).student;
  const secondStudent = service.decideEnrollment({ actor: supervisor, requestId: 'list-approve-second', enrollmentId: secondEnrollment.id, decision: { status: 'approved' } }).student;
  service.decideEnrollment({ actor: admin, requestId: 'list-approve-hidden', enrollmentId: hiddenEnrollment.id, decision: { status: 'approved' } });

  const enrollments = service.listEnrollments({ actor: supervisor }).enrollments;
  assert.deepEqual(enrollments.map(item => item.id), [firstEnrollment.id, secondEnrollment.id].sort());
  assert.deepEqual(enrollments[0].customer, {
    id: enrollments[0].customerId, name: enrollments[0].customerId === firstCustomer.id ? '列表客户一' : '列表客户二',
    maskedPhone: enrollments[0].customerId === firstCustomer.id ? '138****0001' : '139****0002', campusId: 'campus-a', teamId: 'team-a', assignedTeacherId: 'teacher-1',
  });
  assert.equal(service.listEnrollments({ actor: consultant, scope: { ownerId: consultant.id } }).enrollments.length, 2);
  assert.throws(() => service.listEnrollments({ actor: consultant, scope: { campusId: 'campus-b' } }), { code: 'FORBIDDEN' });
  assert.throws(() => service.listEnrollments({ actor: teacher }), { code: 'FORBIDDEN' });

  const students = service.listStudents({ actor: teacher }).students;
  assert.deepEqual(students.map(item => item.id), [firstStudent.id, secondStudent.id].sort());
  assert.ok(students.every(item => item.customer.maskedPhone.includes('****')));
  assert.ok(students.every(item => !Object.hasOwn(item.customer, 'idNumber') && !Object.hasOwn(item.customer, 'wechat') && !Object.hasOwn(item.customer, 'notes')));
  assert.throws(() => service.listStudents({ actor: financeActor }), { code: 'FORBIDDEN' });
  assert.equal(service.listStudents({ actor: admin, scope: { campusId: 'campus-b' } }).students.length, 1);
  assert.throws(() => service.listStudents({ actor: supervisor, scope: { teamId: 'team-b' } }), { code: 'FORBIDDEN' });
});

test('file-backed rejected resubmitted and approved enrollment survives reopen byte-equivalently', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-enrollment-reopen-'));
  const path = join(dir, 'crm.sqlite');
  let store = createStore(path);
  t.after(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });
  let service = createCrmService({ store, clock });
  const customerId = imported(service, 'restart-enrollment-customer').customer.id;
  const rejectedId = submittedEnrollment(service, customerId, 'restart-submit-one').enrollment.id;
  service.decideEnrollment({ actor: admin, requestId: 'restart-reject', enrollmentId: rejectedId, decision: { status: 'rejected', reason: '信息不完整' } });
  const approvedId = submittedEnrollment(service, customerId, 'restart-submit-two').enrollment.id;
  const approved = service.decideEnrollment({ actor: admin, requestId: 'restart-approve', enrollmentId: approvedId, decision: { status: 'approved' } });
  const before = {
    enrollments: JSON.stringify(service.listEnrollments({ actor: admin })),
    students: JSON.stringify(service.listStudents({ actor: admin })),
    rows: store.db.prepare('SELECT id, status, payload FROM enrollment_applications ORDER BY submitted_at, id').all(),
    student: store.db.prepare('SELECT id, payload FROM students').get(),
    task: store.db.prepare('SELECT id, status, payload FROM follow_up_tasks').get(),
  };
  assert.equal(before.student.id, approved.student.id);
  assert.equal(before.task.id, approved.task.id);
  store.close();
  store = createStore(path);
  service = createCrmService({ store, clock });
  assert.equal(JSON.stringify(service.listEnrollments({ actor: admin })), before.enrollments);
  assert.equal(JSON.stringify(service.listStudents({ actor: admin })), before.students);
  assert.deepEqual(store.db.prepare('SELECT id, status, payload FROM enrollment_applications ORDER BY submitted_at, id').all(), before.rows);
  assert.deepEqual(store.db.prepare('SELECT id, payload FROM students').get(), before.student);
  assert.deepEqual(store.db.prepare('SELECT id, status, payload FROM follow_up_tasks').get(), before.task);
});

test('customer owner creates and advances a task while overdue is derived from the server clock', (t) => {
  const { store, service } = fixture(t);
  const consultant = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const customerId = imported(service, 'task-owner-customer', { ownerId: consultant.id }).customer.id;
  const created = createdTask(service, customerId, 'task-create', {
    id: 'browser-id', ownerId: 'browser-owner', status: 'completed', studentId: 'browser-student',
    originType: 'enrollment_approval', originId: 'browser-origin', title: ' 联系客户 ',
  }, consultant).task;
  assert.notEqual(created.id, 'browser-id');
  assert.deepEqual(created, {
    id: created.id, customerId, studentId: '', originType: 'manual', originId: '', ownerId: consultant.id,
    title: '联系客户', dueAt: '2026-09-04T23:59:59.999Z', status: 'open', overdue: true,
  });
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT payload FROM follow_up_tasks WHERE id = ?').get(created.id).payload), {
    id: created.id, customerId, studentId: '', originType: 'manual', originId: '', ownerId: consultant.id,
    title: '联系客户', dueAt: '2026-09-04T23:59:59.999Z', status: 'open',
  });
  const started = service.updateFollowUpTaskStatus({ actor: consultant, requestId: 'task-start', taskId: created.id, status: 'in_progress' }).task;
  assert.equal(started.status, 'in_progress');
  assert.equal(started.overdue, true);
  const completed = service.updateFollowUpTaskStatus({ actor: consultant, requestId: 'task-complete', taskId: created.id, status: 'completed' }).task;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.overdue, false);
  const row = store.db.prepare('SELECT status, payload FROM follow_up_tasks WHERE id = ?').get(created.id);
  assert.equal(row.status, 'completed');
  assert.equal(JSON.parse(row.payload).status, 'completed');
});

test('task status service allows every forward edge and rejects repeats backward edges and terminal changes', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'task-transition-customer').customer.id;
  const make = name => createdTask(service, customerId, `task-transition-create-${name}`).task;
  const advance = (task, status, suffix) => service.updateFollowUpTaskStatus({ actor: admin, requestId: `task-transition-${suffix}`, taskId: task.id, status }).task;

  const directComplete = make('direct-complete');
  assert.equal(advance(directComplete, 'completed', 'direct-complete').status, 'completed');
  const directCancel = make('direct-cancel');
  assert.equal(advance(directCancel, 'cancelled', 'direct-cancel').status, 'cancelled');
  const progressCancel = make('progress-cancel');
  assert.equal(advance(advance(progressCancel, 'in_progress', 'progress-cancel-start'), 'cancelled', 'progress-cancel-end').status, 'cancelled');

  const cases = [
    ['open-repeat', 'open', ['open', 'unknown']],
    ['in-progress', 'in_progress', ['open', 'in_progress', 'unknown']],
    ['completed', 'completed', ['open', 'in_progress', 'completed', 'cancelled', 'unknown']],
    ['cancelled', 'cancelled', ['open', 'in_progress', 'completed', 'cancelled', 'unknown']],
  ];
  for (const [name, initial, forbidden] of cases) {
    let task = make(name);
    if (initial !== 'open') task = advance(task, initial, `${name}-setup`);
    for (const status of forbidden) {
      const before = workflowCounts(store);
      assert.throws(() => advance(task, status, `${name}-${status}`), { code: 'INVALID_TASK_TRANSITION' });
      assert.deepEqual(workflowCounts(store), before);
      assert.equal(store.db.prepare('SELECT status FROM follow_up_tasks WHERE id = ?').get(task.id).status, initial);
    }
  }
});

test('task dates titles IDs and request objects are validated without partial writes', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'task-invalid-customer').customer.id;
  const before = workflowCounts(store);
  for (const [name, task] of [
    ['blank-title', { title: ' ', dueAt: '2026-09-06' }],
    ['long-title', { title: 'x'.repeat(201), dueAt: '2026-09-06' }],
    ['bad-date', { title: '联系客户', dueAt: 'not-a-date' }],
    ['missing-date', { title: '联系客户' }],
  ]) assert.throws(() => service.createFollowUpTask({ actor: admin, requestId: `invalid-task-${name}`, customerId, task }), { code: 'INVALID_FOLLOW_UP_TASK' });
  const accessorTask = {};
  Object.defineProperty(accessorTask, 'title', { get() { return '秘密'; }, enumerable: true });
  assert.throws(() => service.createFollowUpTask({ actor: admin, requestId: 'invalid-task-accessor', customerId, task: accessorTask }), { code: 'INVALID_FOLLOW_UP_TASK' });
  assert.throws(() => service.createFollowUpTask({ actor: admin, requestId: 'invalid-task-object', customerId, task: null }), { code: 'INVALID_FOLLOW_UP_TASK' });
  assert.throws(() => service.updateFollowUpTaskStatus({ actor: admin, requestId: 'invalid-task-id', taskId: 'missing-task', status: 'completed' }), { code: 'NOT_FOUND' });
  assert.deepEqual(workflowCounts(store), before);
});

test('task reads use persisted owner scope exact due boundary and stable due-at then ID ordering', (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  let now = '2026-09-05T00:00:00.000Z';
  const service = createCrmService({ store, clock: () => new Date(now) });
  const consultant = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const other = { id: 'consultant-2', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const customerId = imported(service, 'task-list-customer', { ownerId: consultant.id }).customer.id;
  const hiddenCustomerId = imported(service, 'task-list-hidden', { phone: '13900000002', wechat: 'task-hidden', ownerId: other.id }).customer.id;
  const later = createdTask(service, customerId, 'task-list-later', { dueAt: '2026-09-06' }, consultant).task;
  const boundary = createdTask(service, customerId, 'task-list-boundary', { dueAt: now }, consultant).task;
  const sameDue = createdTask(service, customerId, 'task-list-same-due', { dueAt: now }, consultant).task;
  createdTask(service, hiddenCustomerId, 'task-list-hidden-create', { dueAt: '2026-09-01' }, other);

  let tasks = service.listFollowUpTasks({ actor: consultant }).tasks;
  assert.deepEqual(tasks.map(task => task.id), [boundary.id, sameDue.id].sort().concat(later.id));
  assert.equal(tasks.find(task => task.id === boundary.id).overdue, false);
  assert.ok(tasks.every(task => !Object.hasOwn(task, 'customer')));
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['customerId', 'dueAt', 'id', 'originId', 'originType', 'overdue', 'ownerId', 'status', 'studentId', 'title']);
  assert.deepEqual(service.listFollowUpTasks({ actor: consultant, scope: { ownerId: consultant.id } }).tasks.map(task => task.id), tasks.map(task => task.id));
  assert.throws(() => service.listFollowUpTasks({ actor: consultant, scope: { ownerId: other.id } }), { code: 'FORBIDDEN' });
  now = '2026-09-05T00:00:00.001Z';
  tasks = service.listFollowUpTasks({ actor: consultant }).tasks;
  assert.equal(tasks.find(task => task.id === boundary.id).overdue, true);
});

test('task authorization follows persisted task owner plus customer campus and team scope', (t) => {
  const { store, service } = fixture(t);
  const owner = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const newOwner = { id: 'consultant-2', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const supervisor = { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-a'] };
  const wrongTeam = { id: 'supervisor-2', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-b'] };
  const customerId = imported(service, 'task-auth-customer', { ownerId: owner.id }).customer.id;
  const task = createdTask(service, customerId, 'task-auth-create', {}, owner).task;
  assert.throws(() => createdTask(service, customerId, 'task-auth-other-create', {}, newOwner), { code: 'FORBIDDEN' });
  assert.throws(() => service.updateFollowUpTaskStatus({ actor: wrongTeam, requestId: 'task-auth-wrong-team', taskId: task.id, status: 'completed' }), { code: 'FORBIDDEN' });

  const serviceCustomerId = imported(service, 'task-auth-service-customer', { phone: '13900000002', wechat: 'task-auth-service' }).customer.id;
  const serviceTask = createdTask(service, serviceCustomerId, 'task-auth-service-create', {}, serviceActor).task;
  assert.deepEqual(service.listFollowUpTasks({ actor: serviceActor }).tasks.map(item => item.id), [serviceTask.id]);
  assert.equal(service.updateFollowUpTaskStatus({ actor: serviceActor, requestId: 'task-auth-service-update', taskId: serviceTask.id, status: 'completed' }).task.status, 'completed');
  for (const actor of [
    { id: 'teacher-1', roles: ['teacher'], campusIds: ['campus-a'], teamIds: [] }, financeActor,
  ]) assert.throws(() => service.listFollowUpTasks({ actor }), { code: 'FORBIDDEN' });

  const customer = JSON.parse(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get(customerId).payload);
  customer.ownerId = newOwner.id;
  store.db.prepare('UPDATE customers SET payload = ? WHERE id = ?').run(JSON.stringify(customer), customerId);
  assert.equal(JSON.stringify(createdTask(service, 'changed-customer', 'task-auth-create', { title: '已更改' }, owner)), JSON.stringify({ task }));
  assert.equal(service.listFollowUpTasks({ actor: owner }).tasks.length, 1);
  assert.equal(service.listFollowUpTasks({ actor: newOwner }).tasks.length, 0);
  assert.throws(() => service.updateFollowUpTaskStatus({ actor: newOwner, requestId: 'task-auth-new-owner', taskId: task.id, status: 'completed' }), { code: 'FORBIDDEN' });
  assert.equal(service.updateFollowUpTaskStatus({ actor: owner, requestId: 'task-auth-old-owner', taskId: task.id, status: 'completed' }).task.status, 'completed');
  assert.equal(service.listFollowUpTasks({ actor: supervisor }).tasks.length, 2);
  assert.equal(service.listFollowUpTasks({ actor: admin }).tasks.length, 2);
});

test('task writes replay original bytes and reject cross-actor or permission-downgraded replays', (t) => {
  const { store, service } = fixture(t);
  const owner = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const customerId = imported(service, 'task-replay-customer', { ownerId: owner.id }).customer.id;
  const firstCreate = createdTask(service, customerId, 'task-replay-create', {}, owner);
  const replayCreate = createdTask(service, 'changed-customer', 'task-replay-create', { title: '已更改', dueAt: '2099-01-01' }, owner);
  assert.equal(JSON.stringify(replayCreate), JSON.stringify(firstCreate));
  const firstUpdate = service.updateFollowUpTaskStatus({ actor: owner, requestId: 'task-replay-update', taskId: firstCreate.task.id, status: 'in_progress' });
  const replayUpdate = service.updateFollowUpTaskStatus({ actor: owner, requestId: 'task-replay-update', taskId: 'changed-task', status: 'cancelled' });
  assert.equal(JSON.stringify(replayUpdate), JSON.stringify(firstUpdate));
  const before = workflowCounts(store);
  for (const actor of [
    { id: 'other-consultant', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] },
    { ...owner, roles: ['finance'] },
  ]) {
    assert.throws(() => createdTask(service, customerId, 'task-replay-create', {}, actor), { code: 'FORBIDDEN' });
    assert.throws(() => service.updateFollowUpTaskStatus({ actor, requestId: 'task-replay-update', taskId: firstCreate.task.id, status: 'in_progress' }), { code: 'FORBIDDEN' });
  }
  assert.deepEqual(workflowCounts(store), before);
});

test('task ID audit and request-result failures roll back status and payload atomically', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'task-rollback-customer').customer.id;
  const existing = createdTask(service, customerId, 'task-existing').task;
  let before = workflowCounts(store);
  let mock = t.mock.method(crypto, 'randomUUID', () => existing.id);
  try { assert.throws(() => createdTask(service, customerId, 'task-id-collision'), { code: 'ID_CONFLICT' }); }
  finally { mock.mock.restore(); }
  assert.deepEqual(workflowCounts(store), before);

  for (const table of ['audit_events', 'request_results']) {
    before = workflowCounts(store);
    store.db.exec(`CREATE TRIGGER reject_task_create BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;`);
    assert.throws(() => createdTask(service, customerId, `task-rollback-create-${table}`));
    assert.deepEqual(workflowCounts(store), before);
    store.db.exec('DROP TRIGGER reject_task_create');

    const task = createdTask(service, customerId, `task-rollback-${table}`).task;
    before = workflowCounts(store);
    store.db.exec(`CREATE TRIGGER reject_task_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END;`);
    assert.throws(() => service.updateFollowUpTaskStatus({ actor: admin, requestId: `task-rollback-update-${table}`, taskId: task.id, status: 'completed' }));
    assert.equal(store.db.prepare('SELECT status FROM follow_up_tasks WHERE id = ?').get(task.id).status, 'open');
    assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM follow_up_tasks WHERE id = ?').get(task.id).payload).status, 'open');
    assert.deepEqual(workflowCounts(store), before);
    store.db.exec('DROP TRIGGER reject_task_write');
  }
});

test('task audit summaries contain lifecycle facts but no title or customer payload', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'task-audit-customer', { name: 'SECRET-CUSTOMER', phone: '13900000009', notes: 'SECRET-NOTES' }).customer.id;
  const task = createdTask(service, customerId, 'task-audit-create', { title: 'SECRET-TITLE' }).task;
  service.updateFollowUpTaskStatus({ actor: admin, requestId: 'task-audit-update', taskId: task.id, status: 'completed' });
  const audits = store.db.prepare("SELECT action, entity_type, before_summary, after_summary FROM audit_events WHERE action LIKE 'task.%' ORDER BY rowid").all();
  assert.deepEqual(audits.map(row => row.action), ['task.create', 'task.status.update']);
  assert.ok(audits.every(row => row.entity_type === 'task'));
  assert.deepEqual(JSON.parse(audits[1].before_summary), { status: 'open' });
  assert.deepEqual(JSON.parse(audits[1].after_summary), { status: 'completed' });
  assert.doesNotMatch(JSON.stringify(audits), /SECRET-TITLE|SECRET-CUSTOMER|13900000009|SECRET-NOTES/);
});

test('dashboard exposes only traceable visible workflow counts and preserves existing metrics', (t) => {
  const { service } = fixture(t);
  const supervisor = { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-a'] };
  const localApprovedCustomer = imported(service, 'dashboard-workflow-approved', { ownerId: 'consultant-1' }).customer.id;
  const localPendingCustomer = imported(service, 'dashboard-workflow-pending', { phone: '13900000002', wechat: 'dashboard-pending', ownerId: 'consultant-1' }).customer.id;
  const hiddenCustomer = imported(service, 'dashboard-workflow-hidden', { phone: '13900000003', wechat: 'dashboard-hidden', campusId: 'campus-b', teamId: 'team-b', ownerId: 'consultant-b' }).customer.id;
  const localEnrollment = submittedEnrollment(service, localApprovedCustomer, 'dashboard-local-submit').enrollment;
  const localApproved = service.decideEnrollment({ actor: supervisor, requestId: 'dashboard-local-approve', enrollmentId: localEnrollment.id, decision: { status: 'approved' } });
  const localPending = submittedEnrollment(service, localPendingCustomer, 'dashboard-local-pending').enrollment;
  const localOverdue = createdTask(service, localPendingCustomer, 'dashboard-local-overdue').task;
  const hiddenEnrollment = submittedEnrollment(service, hiddenCustomer, 'dashboard-hidden-submit').enrollment;
  const hiddenApproved = service.decideEnrollment({ actor: admin, requestId: 'dashboard-hidden-approve', enrollmentId: hiddenEnrollment.id, decision: { status: 'approved' } });
  const hiddenOverdue = createdTask(service, hiddenCustomer, 'dashboard-hidden-overdue').task;
  const order = quoted(service, localApprovedCustomer, 'dashboard-workflow-order').order;
  paid(service, order.id, 'dashboard-workflow-payment');
  triaged(service, localApprovedCustomer, 'dashboard-workflow-triage', { message: '我要投诉' });

  const report = service.dashboard({ actor: supervisor });
  assert.deepEqual(report.pendingEnrollmentIds, [localPending.id]);
  assert.equal(report.pendingEnrollmentCount, 1);
  assert.deepEqual(report.studentIds, [localApproved.student.id]);
  assert.equal(report.studentCount, 1);
  assert.deepEqual(report.openTaskIds, [localApproved.task.id, localOverdue.id].sort());
  assert.equal(report.openTaskCount, 2);
  assert.deepEqual(report.overdueTaskIds, [localOverdue.id]);
  assert.equal(report.overdueTaskCount, 1);
  assert.equal(report.customerCount, 2);
  assert.equal(report.pendingHumanCount, 1);
  assert.equal(report.metrics.agreed.amountCents, 0);
  assert.deepEqual(report.metrics.agreed.orderIds, []);
  for (const [ids, count] of [
    [report.pendingEnrollmentIds, report.pendingEnrollmentCount], [report.studentIds, report.studentCount],
    [report.openTaskIds, report.openTaskCount], [report.overdueTaskIds, report.overdueTaskCount],
  ]) assert.equal(ids.length, count);

  const global = service.dashboard({ actor: admin });
  assert.deepEqual(global.studentIds.sort(), [localApproved.student.id, hiddenApproved.student.id].sort());
  assert.ok(global.openTaskIds.includes(hiddenOverdue.id));
  assert.ok(global.overdueTaskIds.includes(hiddenOverdue.id));
  assert.equal(global.metrics.agreed.amountCents, 950_000);
  assert.deepEqual(global.metrics.agreed.orderIds, [order.id]);
});

test('service actor normalization blocks caller map promotion on cross-campus student reads without invoking hooks', (t) => {
  const { service } = fixture(t);
  const customerId = imported(service, 'hostile-actor-list-customer', {
    phone: '13900000031', wechat: 'hostile_actor_list', campusId: 'campus-b', teamId: 'team-b',
    ownerId: 'consultant-b', assignedTeacherId: 'teacher-b',
  }).customer.id;
  const enrollmentId = submittedEnrollment(service, customerId, 'hostile-actor-list-submit').enrollment.id;
  service.decideEnrollment({ actor: admin, requestId: 'hostile-actor-list-approve', enrollmentId, decision: { status: 'approved' } });

  const calls = { map: 0, iterator: 0, species: 0 };
  const roles = ['finance'];
  Object.defineProperty(roles, 'map', { value() { calls.map += 1; return ['admin']; } });
  Object.defineProperty(roles, Symbol.iterator, { value() { calls.iterator += 1; throw new Error('caller iterator invoked'); } });
  const campusIds = ['campus-a'];
  const constructor = {};
  Object.defineProperty(constructor, Symbol.species, { get() { calls.species += 1; return Array; } });
  Object.defineProperty(campusIds, 'constructor', { value: constructor });
  const hostile = { id: 'finance-1', roles, campusIds, teamIds: [] };

  assert.throws(() => service.listStudents({ actor: hostile, scope: { campusId: 'campus-b' } }), { code: 'FORBIDDEN' });
  assert.deepEqual(calls, { map: 0, iterator: 0, species: 0 });
});

test('service actor normalization blocks caller map promotion on enrollment writes', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'hostile-actor-write-customer', { ownerId: 'consultant-1' }).customer.id;
  const enrollmentId = submittedEnrollment(service, customerId, 'hostile-actor-write-submit').enrollment.id;
  let mapCalls = 0;
  const roles = ['finance'];
  Object.defineProperty(roles, 'map', { value() { mapCalls += 1; return ['admin']; } });
  const hostile = { id: 'finance-1', roles, campusIds: ['campus-a'], teamIds: [] };
  const before = workflowCounts(store);

  assert.throws(() => service.decideEnrollment({ actor: hostile, requestId: 'hostile-actor-write-approve', enrollmentId, decision: { status: 'approved' } }), { code: 'FORBIDDEN' });
  assert.equal(mapCalls, 0);
  assert.equal(store.db.prepare('SELECT status FROM enrollment_applications WHERE id = ?').get(enrollmentId).status, 'pending');
  assert.deepEqual(workflowCounts(store), before);
});

test('service actor normalization prevents downgraded map promotion from replaying an admin result', (t) => {
  const { store, service } = fixture(t);
  const customerId = imported(service, 'hostile-actor-replay-customer').customer.id;
  const original = submittedEnrollment(service, customerId, 'hostile-actor-replay-submit');
  let mapCalls = 0;
  const roles = ['finance'];
  Object.defineProperty(roles, 'map', { value() { mapCalls += 1; return ['admin']; } });
  const downgraded = { id: admin.id, roles, campusIds: [], teamIds: [] };
  const before = workflowCounts(store);

  assert.throws(() => service.submitEnrollment({ actor: downgraded, requestId: 'hostile-actor-replay-submit', customerId, enrollment: enrollmentInput({ school: '已篡改' }) }), { code: 'FORBIDDEN' });
  assert.equal(mapCalls, 0);
  assert.deepEqual(workflowCounts(store), before);
  assert.equal(service.submitEnrollment({ actor: admin, requestId: 'hostile-actor-replay-submit', customerId, enrollment: enrollmentInput({ school: '正常重放' }) }).enrollment.id, original.enrollment.id);
});

test('service actor normalization rejects accessor sparse and non-string array entries without reading accessors', (t) => {
  const { service } = fixture(t);
  const base = { id: 'admin-1', campusIds: [], teamIds: [] };
  assert.throws(() => service.listCustomers({ actor: { ...base, roles: Array(1) } }), { code: 'FORBIDDEN' });
  assert.throws(() => service.listCustomers({ actor: { ...base, roles: [{}] } }), { code: 'FORBIDDEN' });

  let accessorReads = 0;
  const accessorRoles = [];
  Object.defineProperty(accessorRoles, '0', { enumerable: true, get() { accessorReads += 1; return 'admin'; } });
  assert.throws(() => service.listCustomers({ actor: { ...base, roles: accessorRoles } }), { code: 'FORBIDDEN' });
  assert.equal(accessorReads, 0);
});
