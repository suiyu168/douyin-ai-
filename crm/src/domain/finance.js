'use strict';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function money(value) { return Number.isSafeInteger(value) && value >= 0; }
function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function validDate(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return !Number.isNaN(new Date(value).getTime());
}

function quoteOrder(input) {
  if (!input || typeof input !== 'object' || !own(input, 'listPriceCents')) fail('INVALID_ORDER');
  if (!money(input.listPriceCents)) fail('INVALID_MONEY');
  const discount = input.discountCents === undefined ? 0 : input.discountCents;
  if (!money(discount) || discount > input.listPriceCents) fail('INVALID_MONEY');
  if (discount > 0 && input.discountApproved !== true) fail('UNAPPROVED_DISCOUNT');
  const order = { ...input, discountCents: discount, agreedPriceCents: input.listPriceCents - discount, ledger: Object.freeze([]) };
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
  const copy = { ...entry };
  const ledger = order.ledger.map(item => Object.freeze({ ...item })).concat(Object.freeze(copy));
  return { ...order, ledger: Object.freeze(ledger) };
}

function summarizeOrder(order, now) {
  validateOrder(order);
  let receivable = order.agreedPriceCents, received = 0, refunded = 0, reversed = 0;
  for (const entry of order.ledger) {
    if (entry.status !== 'confirmed') continue;
    if (entry.type === 'payment') received += entry.amountCents;
    if (entry.type === 'refund') refunded += entry.amountCents;
    if (entry.type === 'reversal') reversed += entry.amountCents;
    if (entry.type === 'adjustment') receivable += entry.direction === 'increase' ? entry.amountCents : -entry.amountCents;
  }
  receivable = Math.max(0, receivable);
  const netReceived = received - refunded - reversed;
  const outstanding = Math.max(0, receivable - netReceived);
  const due = validDate(order.dueAt) ? new Date(order.dueAt).getTime() : NaN;
  const current = validDate(now) ? new Date(now).getTime() : NaN;
  return { agreed: order.agreedPriceCents, receivable, received, refunded, reversed, outstanding, netReceived, overdue: outstanding > 0 && Number.isFinite(due) && Number.isFinite(current) && current > due };
}

module.exports = { quoteOrder, appendLedgerEntry, summarizeOrder };
