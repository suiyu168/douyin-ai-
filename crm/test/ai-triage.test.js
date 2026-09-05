'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { isKnowledgeActive, triageMessage } = require('../src/domain/ai-triage');

const now = new Date('2026-09-05T00:00:00.000Z');

test('recognizes only the current published approved knowledge version', () => {
  const states = [
    { id: 'draft', status: 'draft', reviewStatus: 'approved', effectiveAt: '2026-08-01', expiresAt: null },
    { id: 'unreviewed', status: 'published', reviewStatus: 'pending', effectiveAt: '2026-08-01', expiresAt: null },
    { id: 'future', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-09-06', expiresAt: null },
    { id: 'expired', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01', expiresAt: '2026-09-05' },
    { id: 'current', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01', expiresAt: null },
  ];
  assert.deepEqual(states.map((version) => isKnowledgeActive(version, now)), [false, false, false, false, true]);
});

test('enforces knowledge date and own-field boundaries', () => {
  assert.equal(isKnowledgeActive({ id: 'at-effective', status: 'published', reviewStatus: 'approved', effectiveAt: now, expiresAt: '2026-09-06' }, now), true);
  assert.equal(isKnowledgeActive({ id: 'at-expiry', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01', expiresAt: now }, now), false);
  for (const version of [
    { id: 'bad-effective', status: 'published', reviewStatus: 'approved', effectiveAt: 'nope' },
    { id: 'bad-expiry', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01', expiresAt: 'nope' },
    { id: 'bad-now', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01' },
    { id: ' ', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01' },
  ]) {
    assert.equal(isKnowledgeActive(version, version.id === 'bad-now' ? 'nope' : now), false);
  }
  const inherited = Object.create({ id: 'inherited', status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01' });
  assert.equal(isKnowledgeActive(inherited, now), false);
});

const active = (id = 'v-current') => ({ id, status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01', expiresAt: '2026-10-01' });

test('auto replies only for high confidence with an active citation', () => {
  assert.deepEqual(triageMessage({ message: '如何准备材料？', confidence: 0.9, citations: [active()], now }), { mode: 'auto_reply', reasons: [], citations: ['v-current'] });
  assert.deepEqual(triageMessage({ message: '如何准备材料？', confidence: 0.9, citations: [], now }), { mode: 'suggestion', reasons: ['NO_VALID_CITATION'], citations: [] });
  assert.deepEqual(triageMessage({ message: '如何准备材料？', confidence: 0.74, citations: [active()], now }), { mode: 'suggestion', reasons: ['LOW_CONFIDENCE'], citations: ['v-current'] });
  assert.deepEqual(triageMessage({ message: '如何准备材料？', confidence: 0.74, citations: [], now }), { mode: 'suggestion', reasons: ['LOW_CONFIDENCE', 'NO_VALID_CITATION'], citations: [] });
  assert.equal(triageMessage({ message: '如何准备材料？', confidence: 0.75, citations: [active()], now }).mode, 'auto_reply');
});

test('filters malformed, inactive, duplicate, and inherited citation versions', () => {
  const inherited = Object.create(active('inherited'));
  const input = { message: '资料问题', confidence: 0.9, citations: [active('first'), active('first'), { ...active('expired'), expiresAt: '2026-09-05' }, { ...active('draft'), status: 'draft' }, inherited, { status: 'published', reviewStatus: 'approved', effectiveAt: '2026-08-01' }], now };
  assert.deepEqual(triageMessage(input).citations, ['first']);
  assert.deepEqual(triageMessage({ ...input, citations: 'not-array' }).citations, []);
});

test('requires human handling for blank or non-string messages', () => {
  for (const message of ['', '  ', null, 123]) assert.deepEqual(triageMessage({ message, confidence: 0.99, citations: [active()], now }), { mode: 'human_required', reasons: ['INVALID_MESSAGE'], citations: ['v-current'] });
});

test('routes every mandatory risk phrase to its exact human reason', () => {
  const risks = [
    ['我要投诉', 'COMPLAINT_RISK'], ['申请退款', 'REFUND_RISK'], ['请看合同', 'CONTRACT_RISK'],
    ['付款异常了', 'PAYMENT_EXCEPTION_RISK'], ['支付失败', 'PAYMENT_EXCEPTION_RISK'], ['重复扣款', 'PAYMENT_EXCEPTION_RISK'],
    ['资格不确定', 'ELIGIBILITY_UNCERTAIN_RISK'], ['不确定能不能报名', 'ELIGIBILITY_UNCERTAIN_RISK'], ['报名资格不确定', 'ELIGIBILITY_UNCERTAIN_RISK'],
    ['非标准优惠', 'NON_STANDARD_DISCOUNT_RISK'], ['特殊优惠', 'NON_STANDARD_DISCOUNT_RISK'], ['额外优惠', 'NON_STANDARD_DISCOUNT_RISK'], ['私下优惠', 'NON_STANDARD_DISCOUNT_RISK'],
    ['需要身份证吗', 'IDENTITY_DOCUMENT_RISK'], ['承诺保过吗', 'GUARANTEED_PASS_RISK'], ['能包毕业吗', 'GUARANTEED_GRADUATION_RISK'],
  ];
  for (const [message, reason] of risks) assert.deepEqual(triageMessage({ message, confidence: 0.99, citations: [active()], now }), { mode: 'human_required', reasons: [reason], citations: ['v-current'] });
});

test('returns all matching risks in fixed rule order and suppresses other reasons', () => {
  const message = '包毕业，合同有问题，投诉后申请退款，付款异常，资格不确定，特殊优惠，需要身份证，保过';
  assert.deepEqual(triageMessage({ message, confidence: 0.1, citations: [], now }), {
    mode: 'human_required',
    reasons: ['COMPLAINT_RISK', 'REFUND_RISK', 'CONTRACT_RISK', 'PAYMENT_EXCEPTION_RISK', 'ELIGIBILITY_UNCERTAIN_RISK', 'NON_STANDARD_DISCOUNT_RISK', 'IDENTITY_DOCUMENT_RISK', 'GUARANTEED_PASS_RISK', 'GUARANTEED_GRADUATION_RISK'],
    citations: [],
  });
});

test('handles invalid confidence safely and does not mutate inputs', () => {
  const citation = active();
  const input = { message: '普通问题', confidence: 0.9, citations: [citation], now };
  const before = JSON.stringify(input);
  for (const confidence of [undefined, NaN, -1, 2, '0.9']) assert.equal(triageMessage({ ...input, confidence }).mode, 'suggestion');
  const output = triageMessage(input);
  output.citations.push('tampered');
  assert.equal(JSON.stringify(input), before);
  assert.equal(citation.id, 'v-current');
});

test('safely rejects throwing source and citation accessors', () => {
  const source = {};
  for (const key of ['message', 'citations', 'now', 'confidence']) Object.defineProperty(source, key, { get() { throw new Error(`read ${key}`); } });
  assert.deepEqual(triageMessage(source), { mode: 'human_required', reasons: ['INVALID_MESSAGE'], citations: [] });

  const citation = active();
  for (const key of ['id', 'effectiveAt']) Object.defineProperty(citation, key, { get() { throw new Error(`read ${key}`); } });
  assert.deepEqual(triageMessage({ message: '普通问题', confidence: 0.9, citations: [citation], now }), { mode: 'suggestion', reasons: ['NO_VALID_CITATION'], citations: [] });
});

test('snapshots a citation id once after validation', () => {
  let reads = 0;
  const citation = active();
  const proxied = new Proxy(citation, { getOwnPropertyDescriptor(target, key) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (key === 'id' && reads++ === 0) target.id = 'tampered';
    return descriptor;
  } });
  assert.deepEqual(triageMessage({ message: '普通问题', confidence: 0.9, citations: [proxied], now }), { mode: 'auto_reply', reasons: [], citations: ['v-current'] });
  assert.equal(reads, 1);
});

test('scans only own numeric citation slots and ignores custom iteration', () => {
  const prototype = Array.prototype;
  const inherited = active('inherited-slot');
  Object.defineProperty(prototype, '0', { configurable: true, writable: true, value: inherited });
  try {
    const citations = [];
    citations.length = 2;
    citations[1] = active('own-slot');
    citations[Symbol.iterator] = function* () { yield active('iterator-slot'); };
    assert.deepEqual(triageMessage({ message: '普通问题', confidence: 0.9, citations, now }).citations, ['own-slot']);
  } finally {
    delete prototype[0];
  }
});

test('safely ignores revoked proxies and throwing descriptor traps', () => {
  const revoked = Proxy.revocable(active(), {});
  revoked.revoke();
  const throwingCitation = new Proxy(active('throwing'), { getOwnPropertyDescriptor() { throw new Error('descriptor'); } });
  const citations = [revoked.proxy, throwingCitation, active('valid')];
  assert.deepEqual(triageMessage({ message: '普通问题', confidence: 0.9, citations, now }).citations, ['valid']);
  const sourceRevoked = Proxy.revocable({ message: '普通问题' }, {});
  sourceRevoked.revoke();
  assert.deepEqual(triageMessage(sourceRevoked.proxy), { mode: 'human_required', reasons: ['INVALID_MESSAGE'], citations: [] });
});

test('does not trust an overridden getTime on an invalid Date used as now', () => {
  const invalidNow = new Date('invalid');
  invalidNow.getTime = () => new Date('2026-09-05T00:00:00Z').getTime();
  assert.equal(isKnowledgeActive(active(), invalidNow), false);
});

test('does not trust an overridden getTime on an invalid effective date', () => {
  const invalidEffective = new Date('invalid');
  invalidEffective.getTime = () => new Date('2026-08-01T00:00:00Z').getTime();
  const citation = { ...active(), effectiveAt: invalidEffective };
  assert.equal(isKnowledgeActive(citation, now), false);
  assert.deepEqual(triageMessage({ message: '普通问题', confidence: 0.9, citations: [citation], now }), { mode: 'suggestion', reasons: ['NO_VALID_CITATION'], citations: [] });
});

test('accepts cross-realm and re-prototyped real Dates but rejects fakes and Date proxies', () => {
  const crossRealm = vm.runInNewContext("new Date('2026-08-01T00:00:00Z')");
  const rePrototyped = new Date('2026-08-01T00:00:00Z');
  Object.setPrototypeOf(rePrototyped, {});
  assert.equal(isKnowledgeActive({ ...active(), effectiveAt: crossRealm }, now), true);
  assert.equal(isKnowledgeActive({ ...active(), effectiveAt: rePrototyped }, now), true);
  assert.equal(isKnowledgeActive({ ...active(), effectiveAt: Object.create(Date.prototype) }, now), false);
  assert.equal(isKnowledgeActive({ ...active(), effectiveAt: new Proxy(new Date('2026-08-01T00:00:00Z'), {}) }, now), false);
});

test('enumerates only own numeric citation keys in ascending index order', () => {
  const citations = [];
  citations.length = 4;
  citations[3] = active('three');
  citations[1] = active('one');
  Object.defineProperty(citations, '2', { configurable: true, enumerable: false, writable: true, value: active('two') });
  citations.note = active('note');
  assert.deepEqual(triageMessage({ message: '普通问题', confidence: 0.9, citations, now }).citations, ['one', 'two', 'three']);
});

test('does not scan a maximum-length empty array or non-index keys', () => {
  const citations = [];
  citations.length = 0xffffffff;
  Object.defineProperty(citations, '01', { configurable: true, value: active('non-index') });
  Object.defineProperty(citations, '4294967295', { configurable: true, value: active('too-large') });
  assert.deepEqual(triageMessage({ message: '普通问题', confidence: 0.9, citations, now }).citations, []);
});
