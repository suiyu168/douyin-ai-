const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePhone,
  normalizeWechat,
} = require('../src/domain/customer');

test('normalizes a mainland mobile phone number', () => {
  assert.equal(normalizePhone('+86 138-0013-8000'), '13800138000');
});

test('normalizes a WeChat identifier', () => {
  assert.equal(normalizeWechat(' wx_Alice '), 'wx_alice');
});

test('rejects an invalid phone number as empty', () => {
  assert.equal(normalizePhone('12345'), '');
});

test('merges customers with the same phone', () => {
  const { decideDuplicate } = require('../src/domain/customer');
  const existing = [{ customerId: 'cust-1', phone: '13800138000', nickname: '旧名' }];
  assert.deepEqual(decideDuplicate({ phone: '13800138000', nickname: '新名' }, existing), {
    decision: 'merge', customerId: 'cust-1', reasons: ['PHONE_MATCH'],
  });
});

test('merges customers with the same WeChat identifier', () => {
  const { decideDuplicate } = require('../src/domain/customer');
  const existing = [{ customerId: 'cust-2', wechat: 'wx_alice', nickname: '旧名' }];
  assert.deepEqual(decideDuplicate({ wechat: ' WX_Alice ', nickname: '新名' }, existing), {
    decision: 'merge', customerId: 'cust-2', reasons: ['WECHAT_MATCH'],
  });
});

test('requests review when only ID last four digits match', () => {
  const { decideDuplicate } = require('../src/domain/customer');
  const existing = [{ customerId: 'cust-3', idLast4: '1234', nickname: '旧名' }];
  assert.deepEqual(decideDuplicate({ idLast4: '1234', nickname: '新名' }, existing), {
    decision: 'review', customerId: 'cust-3', reasons: ['ID_LAST4_MATCH'],
  });
});

test('creates a customer when nickname matches but strong identifiers differ', () => {
  const { decideDuplicate } = require('../src/domain/customer');
  const existing = [{ customerId: 'cust-4', phone: '13800138000', wechat: 'wx_alice', nickname: '小明' }];
  assert.deepEqual(decideDuplicate({ phone: '13900139000', wechat: 'wx_bob', nickname: '小明' }, existing), {
    decision: 'create', customerId: null, reasons: [],
  });
});

test('produces field-prefixed stable hashes and blanks for missing fields', () => {
  const { customerFingerprint } = require('../src/domain/customer');
  const first = customerFingerprint({ phone: '+86 138-0013-8000', wechat: ' wx_Alice ', idLast4: '1234' });
  assert.deepEqual(Object.keys(first).sort(), ['idLast4Hash', 'phoneHash', 'wechatHash']);
  assert.match(first.phoneHash, /^[0-9a-f]{64}$/);
  assert.match(first.wechatHash, /^[0-9a-f]{64}$/);
  assert.match(first.idLast4Hash, /^[0-9a-f]{64}$/);
  assert.notEqual(first.phoneHash, first.wechatHash);
  assert.deepEqual(customerFingerprint({}), { phoneHash: '', wechatHash: '', idLast4Hash: '' });
});
