'use strict';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function money(value) { return Number.isSafeInteger(value) && value >= 0; }
function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function validDate(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return !Number.isNaN(new Date(value).getTime());
}
function isoDate(value) { if (!validDate(value)) fail('INVALID_LEDGER_ENTRY'); return new Date(value).toISOString(); }
function cloneValue(value, code, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') { if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') fail(code); return value; }
  if (seen.has(value)) fail(code); seen.add(value);
  let out;
  if (value instanceof Date) { if (!validDate(value)) fail(code); out = value.toISOString(); seen.delete(value); return out; }
  if (Array.isArray(value)) out = value.map(item => cloneValue(item, code, seen));
  else { out = {}; for (const key of Object.keys(value)) out[key] = cloneValue(value[key], code, seen); }
  seen.delete(value); return out;
}
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}
function safeAdd(a, b) { const result = a + b; if (!Number.isSafeInteger(result)) fail('INVALID_ORDER'); return result; }
function safeSub(a, b) { const result = a - b; if (!Number.isSafeInteger(result)) fail('INVALID_ORDER'); return result; }

function quoteOrder(input) {
  if (!input || typeof input !== 'object' || !own(input, 'listPriceCents')) fail('INVALID_ORDER');
  if (!money(input.listPriceCents)) fail('INVALID_MONEY');
  const discount = input.discountCents === undefined ? 0 : input.discountCents;
  if (!money(discount) || discount > input.listPriceCents) fail('INVALID_MONEY');
  if (discount > 0 && input.discountApproved !== true) fail('UNAPPROVED_DISCOUNT');
  const order = {};
  for (const key of Object.keys(input)) { if (key !== 'ledger' && key !== 'agreedPriceCents' && key !== 'dueAt') order[key] = cloneValue(input[key], 'INVALID_ORDER'); }
  if (input.dueAt !== undefined) order.dueAt = validDate(input.dueAt) ? new Date(input.dueAt).toISOString() : undefined;
  order.discountCents = discount;
  order.agreedPriceCents = input.listPriceCents - discount;
  order.ledger = Object.freeze([]);
  return order;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || !own(entry, 'type') || !own(entry, 'idempotencyKey') || !own(entry, 'amountCents') || !own(entry, 'status') || !own(entry, 'occurredAt')) fail('INVALID_LEDGER_ENTRY');
  if (!['payment', 'refund', 'reversal', 'adjustment'].includes(entry.type) || typeof entry.idempotencyKey !== 'string' || !entry.idempotencyKey.trim() || !money(entry.amountCents) || !['pending', 'confirmed', 'rejected'].includes(entry.status) || !validDate(entry.occurredAt)) fail('INVALID_LEDGER_ENTRY');
  if (entry.type === 'adjustment' && !['increase', 'decrease'].includes(entry.direction)) fail('INVALID_LEDGER_ENTRY');
}

function validateOrder(order) {
  if (!order || typeof order !== 'object' || !own(order, 'agreedPriceCents') || !money(order.agreedPriceCents) || !own(order, 'ledger') || !Array.isArray(order.ledger)) fail('INVALID_ORDER');
  const keys = new Set();
  for (const entry of order.ledger) { validateEntry(entry); if (keys.has(entry.idempotencyKey)) fail('DUPLICATE_LEDGER_ENTRY'); keys.add(entry.idempotencyKey); }
}

function appendLedgerEntry(order, entry) {
  validateOrder(order); validateEntry(entry);
  if (order.ledger.some(item => item.idempotencyKey === entry.idempotencyKey)) fail('DUPLICATE_LEDGER_ENTRY');
  const copy = cloneValue(entry, 'INVALID_LEDGER_ENTRY');
  copy.occurredAt = isoDate(entry.occurredAt);
  const ledger = order.ledger.map(item => freezeDeep(cloneValue(item, 'INVALID_LEDGER_ENTRY'))).concat(freezeDeep(copy));
  return { ...order, ledger: Object.freeze(ledger) };
}

function summarizeOrder(order, now) {
  validateOrder(order);
  let receivable = order.agreedPriceCents, received = 0, refunded = 0, reversed = 0;
  for (const entry of order.ledger) {
    if (entry.status !== 'confirmed') continue;
    if (entry.type === 'payment') received = safeAdd(received, entry.amountCents);
    if (entry.type === 'refund') refunded = safeAdd(refunded, entry.amountCents);
    if (entry.type === 'reversal') reversed = safeAdd(reversed, entry.amountCents);
    if (entry.type === 'adjustment') receivable = entry.direction === 'increase' ? safeAdd(receivable, entry.amountCents) : safeSub(receivable, entry.amountCents);
  }
  receivable = Math.max(0, receivable);
  const netReceived = safeSub(safeSub(received, refunded), reversed);
  const outstanding = Math.max(0, safeSub(receivable, netReceived));
  const due = validDate(order.dueAt) ? new Date(order.dueAt).getTime() : NaN;
  const current = validDate(now) ? new Date(now).getTime() : NaN;
  return { agreed: order.agreedPriceCents, receivable, received, refunded, reversed, outstanding, netReceived, overdue: outstanding > 0 && Number.isFinite(due) && Number.isFinite(current) && current > due };
}

module.exports = { quoteOrder, appendLedgerEntry, summarizeOrder };
