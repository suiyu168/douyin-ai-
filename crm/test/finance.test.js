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
