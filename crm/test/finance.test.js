const test = require('node:test');
const assert = require('node:assert/strict');

const { quoteOrder, appendLedgerEntry, summarizeOrder } = require('../src/domain/finance');

const payment = (key, amount, status = 'confirmed') => ({ type: 'payment', idempotencyKey: key, amountCents: amount, status, occurredAt: '2026-08-01T00:00:00.000Z' });

test('quotes an approved discounted order in integer cents', () => {
  const order = quoteOrder({ listPriceCents: 1_000_000, discountCents: 50_000, discountApproved: true, customerId: 'cust-001' });
  assert.equal(order.agreedPriceCents, 950_000);
  assert.equal(order.discountApproved, true);
  assert.deepEqual(summarizeOrder(order, new Date('2026-08-01T00:00:00.000Z')), { agreed: 950_000, receivable: 950_000, received: 0, refunded: 0, reversed: 0, outstanding: 950_000, netReceived: 0, overdue: false });
  assert.equal(order.customerId, 'cust-001');
});

test('appends confirmed payments and ignores pending or rejected entries', () => {
  let order = quoteOrder({ listPriceCents: 1_000_000, discountCents: 50_000, discountApproved: true });
  order = appendLedgerEntry(order, payment('p1', 300_000));
  order = appendLedgerEntry(order, payment('p2', 200_000));
  order = appendLedgerEntry(order, payment('p3', 100_000, 'pending'));
  order = appendLedgerEntry(order, payment('p4', 100_000, 'rejected'));
  assert.deepEqual(summarizeOrder(order), { agreed: 950_000, receivable: 950_000, received: 500_000, refunded: 0, reversed: 0, outstanding: 450_000, netReceived: 500_000, overdue: false });
});

test('rejects duplicate keys without changing the original order', () => {
  const order = appendLedgerEntry(quoteOrder({ listPriceCents: 1_000_000 }), payment('same', 10));
  const before = JSON.stringify(order);
  assert.throws(() => appendLedgerEntry(order, payment('same', 20)), { code: 'DUPLICATE_LEDGER_ENTRY' });
  assert.equal(JSON.stringify(order), before);
});

test('accounts for refunds reversals and clamped adjustments', () => {
  let order = quoteOrder({ listPriceCents: 1_000_000 });
  for (const entry of [payment('p', 500_000), { type: 'refund', idempotencyKey: 'r', amountCents: 50_000, status: 'confirmed', occurredAt: '2026-08-01' }, { type: 'reversal', idempotencyKey: 'v', amountCents: 20_000, status: 'confirmed', occurredAt: '2026-08-01' }, { type: 'adjustment', direction: 'increase', idempotencyKey: 'i', amountCents: 30_000, status: 'confirmed', occurredAt: '2026-08-01' }, { type: 'adjustment', direction: 'decrease', idempotencyKey: 'd', amountCents: 10_000, status: 'confirmed', occurredAt: '2026-08-01' }]) order = appendLedgerEntry(order, entry);
  assert.deepEqual(summarizeOrder(order), { agreed: 1_000_000, receivable: 1_020_000, received: 500_000, refunded: 50_000, reversed: 20_000, outstanding: 590_000, netReceived: 430_000, overdue: false });
  order = appendLedgerEntry(order, { type: 'adjustment', direction: 'decrease', idempotencyKey: 'all', amountCents: 2_000_000, status: 'confirmed', occurredAt: '2026-08-01' });
  assert.equal(summarizeOrder(order).receivable, 0);
});

test('marks outstanding orders overdue only after the due instant', () => {
  const order = quoteOrder({ listPriceCents: 100, dueAt: '2026-09-01T00:00:00.000Z' });
  assert.equal(summarizeOrder(order, new Date('2026-09-01T00:00:00.000Z')).overdue, false);
  assert.equal(summarizeOrder(order, new Date('2026-09-01T00:00:00.001Z')).overdue, true);
  assert.equal(summarizeOrder(appendLedgerEntry(order, payment('p', 100)), new Date('2026-09-02')).overdue, false);
});

test('returns frozen copies and rejects malformed entries and inherited fields', () => {
  let order = quoteOrder({ listPriceCents: 100 });
  const input = payment('p', 10); order = appendLedgerEntry(order, input);
  assert.ok(Object.isFrozen(order.ledger)); assert.ok(Object.isFrozen(order.ledger[0]));
  input.amountCents = 99; assert.equal(summarizeOrder(order).received, 10);
  for (const bad of [{ type: 'unknown' }, { type: 'payment', idempotencyKey: ' ', amountCents: 1, status: 'confirmed', occurredAt: 'x' }, { type: 'adjustment', direction: 'sideways', idempotencyKey: 'x', amountCents: 1, status: 'confirmed', occurredAt: '2026-08-01' }]) assert.throws(() => appendLedgerEntry(order, bad), { code: 'INVALID_LEDGER_ENTRY' });
  const inherited = Object.create({ listPriceCents: 100 }); assert.throws(() => quoteOrder(inherited), { code: 'INVALID_ORDER' });
  const malformed = { agreedPriceCents: 100, ledger: [payment('bad', 1, 'confirmed')] }; malformed.ledger[0].amountCents = 1.5;
  assert.throws(() => summarizeOrder(malformed), { code: 'INVALID_LEDGER_ENTRY' });
});

test('requires approval for positive discounts and rejects invalid money', () => {
  assert.throws(() => quoteOrder({ listPriceCents: 1_000_000, discountCents: 50_000 }), { code: 'UNAPPROVED_DISCOUNT' });
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) assert.throws(() => quoteOrder({ listPriceCents: value }), { code: 'INVALID_MONEY' });
  assert.throws(() => quoteOrder({ listPriceCents: 10, discountCents: 11, discountApproved: true }), { code: 'INVALID_MONEY' });
});

test('snapshots dates and recursively freezes metadata', () => {
  const due = new Date('2026-09-01T00:00:00Z');
  const meta = { nested: { tags: ['a'] } };
  const order = quoteOrder({ listPriceCents: 100, dueAt: due, meta });
  due.setTime(0); meta.nested.tags.push('b');
  assert.equal(order.dueAt, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(order.meta, { nested: { tags: ['a'] } });
  const entryMeta = { nested: { tags: ['x'] } };
  const returned = appendLedgerEntry(order, { ...payment('snap', 10), meta: entryMeta });
  entryMeta.nested.tags.push('y');
  assert.deepEqual(returned.ledger[0].meta, { nested: { tags: ['x'] } });
  assert.equal(returned.ledger[0].occurredAt, '2026-08-01T00:00:00.000Z');
  assert.ok(Object.isFrozen(returned.ledger[0].meta.nested.tags));
});

test('rejects arithmetic overflow in confirmed aggregates', () => {
  const max = Number.MAX_SAFE_INTEGER;
  let order = quoteOrder({ listPriceCents: max });
  assert.throws(() => summarizeOrder(appendLedgerEntry(order, { type: 'adjustment', direction: 'increase', idempotencyKey: 'inc', amountCents: 1, status: 'confirmed', occurredAt: '2026-08-01' })), { code: 'INVALID_ORDER' });
  order = quoteOrder({ listPriceCents: 1 });
  assert.throws(() => summarizeOrder(appendLedgerEntry(appendLedgerEntry(order, payment('a', max)), payment('b', 1))), { code: 'INVALID_ORDER' });
  order = quoteOrder({ listPriceCents: 1 });
  assert.throws(() => summarizeOrder(appendLedgerEntry(appendLedgerEntry(order, { type: 'refund', idempotencyKey: 'r1', amountCents: max, status: 'confirmed', occurredAt: '2026-08-01' }), { type: 'refund', idempotencyKey: 'r2', amountCents: 1, status: 'confirmed', occurredAt: '2026-08-01' })), { code: 'INVALID_ORDER' });
});

test('duplicate keys include pending and rejected entries and payment direction is ignored', () => {
  for (const status of ['pending', 'rejected']) {
    const order = appendLedgerEntry(quoteOrder({ listPriceCents: 100 }), payment('dup', 10, status));
    assert.throws(() => appendLedgerEntry(order, payment('dup', 20)), { code: 'DUPLICATE_LEDGER_ENTRY' });
  }
  assert.throws(() => appendLedgerEntry(quoteOrder({ listPriceCents: 100 }), payment('bad-status', 1, 'settled')), { code: 'INVALID_LEDGER_ENTRY' });
  const entry = { ...payment('direction', 10), direction: 'decrease' };
  assert.equal(summarizeOrder(appendLedgerEntry(quoteOrder({ listPriceCents: 100 }), entry)).received, 10);
});

test('uses the agreed 950000 literal for refund and adjustment summaries', () => {
  let order = quoteOrder({ listPriceCents: 1_000_000, discountCents: 50_000, discountApproved: true });
  for (const entry of [payment('paid', 500_000), { type: 'refund', idempotencyKey: 'refund', amountCents: 50_000, status: 'confirmed', occurredAt: '2026-08-01' }, { type: 'reversal', idempotencyKey: 'reverse', amountCents: 20_000, status: 'confirmed', occurredAt: '2026-08-01' }]) order = appendLedgerEntry(order, entry);
  assert.equal(summarizeOrder(order).received, 500_000); assert.equal(summarizeOrder(order).refunded, 50_000); assert.equal(summarizeOrder(order).reversed, 20_000); assert.equal(summarizeOrder(order).netReceived, 430_000); assert.equal(summarizeOrder(order).outstanding, 520_000);
  order = quoteOrder({ listPriceCents: 1_000_000, discountCents: 50_000, discountApproved: true });
  order = appendLedgerEntry(order, { type: 'adjustment', direction: 'increase', idempotencyKey: 'up', amountCents: 30_000, status: 'confirmed', occurredAt: '2026-08-01' });
  order = appendLedgerEntry(order, { type: 'adjustment', direction: 'decrease', idempotencyKey: 'down', amountCents: 10_000, status: 'confirmed', occurredAt: '2026-08-01' });
  assert.equal(summarizeOrder(order).receivable, 970_000);
});

test('rejects inherited required fields on entries and prebuilt orders', () => {
  const proto = payment('inherited', 1); const inheritedEntry = Object.create(proto);
  assert.throws(() => appendLedgerEntry(quoteOrder({ listPriceCents: 100 }), inheritedEntry), { code: 'INVALID_LEDGER_ENTRY' });
  const inheritedOrder = Object.create({ agreedPriceCents: 100, ledger: [] });
  assert.throws(() => summarizeOrder(inheritedOrder), { code: 'INVALID_ORDER' });
});

test('append snapshots a prebuilt order and truly Date occurredAt', () => {
  const sourceDate = new Date('2026-08-02T00:00:00Z');
  const source = { agreedPriceCents: 100, dueAt: sourceDate, meta: { nested: { ok: true } }, ledger: [{ ...payment('old', 10), occurredAt: sourceDate, meta: { tags: ['old'] } }] };
  const result = appendLedgerEntry(source, { ...payment('new', 10), occurredAt: sourceDate });
  sourceDate.setTime(0); source.meta.nested.ok = false; source.ledger[0].meta.tags.push('mutated');
  assert.equal(result.dueAt, '2026-08-02T00:00:00.000Z');
  assert.equal(result.ledger[0].occurredAt, '2026-08-02T00:00:00.000Z');
  assert.deepEqual(result.meta, { nested: { ok: true } }); assert.deepEqual(result.ledger[0].meta, { tags: ['old'] });
  assert.ok(Object.isFrozen(result.meta.nested)); assert.ok(Object.isFrozen(result.ledger[0].meta.tags));
});

test('permits safe adjustment clamping despite negative intermediate values', () => {
  let order = quoteOrder({ listPriceCents: 0 });
  order = appendLedgerEntry(order, { type: 'adjustment', direction: 'decrease', idempotencyKey: 'down', amountCents: Number.MAX_SAFE_INTEGER, status: 'confirmed', occurredAt: '2026-08-01' });
  assert.equal(summarizeOrder(order).receivable, 0);
  order = appendLedgerEntry(order, { type: 'adjustment', direction: 'increase', idempotencyKey: 'up', amountCents: Number.MAX_SAFE_INTEGER, status: 'confirmed', occurredAt: '2026-08-01' });
  assert.equal(summarizeOrder(order).receivable, 0);
});
