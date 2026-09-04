const crypto = require('node:crypto');

function normalizePhone(value) {
  if (value === null || value === undefined) return '';
  let text = String(value).trim();
  text = text.replace(/^\+86\s*/, '').replace(/[\s-]/g, '');
  return /^1[3-9]\d{9}$/.test(text) ? text : '';
}

function normalizeWechat(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function normalizeIdLast4(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return /^\d{4}$/.test(text) ? text : '';
}

function digest(field, value) {
  return value ? crypto.createHash('sha256').update(`${field}:${value}`, 'utf8').digest('hex') : '';
}

function customerFingerprint(input = {}) {
  const phone = normalizePhone(input.phone);
  const wechat = normalizeWechat(input.wechat);
  const idLast4 = normalizeIdLast4(input.idLast4);
  return {
    phoneHash: digest('phone', phone),
    wechatHash: digest('wechat', wechat),
    idLast4Hash: digest('idLast4', idLast4),
  };
}

function decideDuplicate(candidate = {}, existing = []) {
  const candidatePhone = normalizePhone(candidate.phone);
  const candidateWechat = normalizeWechat(candidate.wechat);
  const candidateIdLast4 = normalizeIdLast4(candidate.idLast4);

  for (const customer of existing) {
    const reasons = [];
    if (candidatePhone && candidatePhone === normalizePhone(customer.phone)) reasons.push('PHONE_MATCH');
    if (candidateWechat && candidateWechat === normalizeWechat(customer.wechat)) reasons.push('WECHAT_MATCH');
    if (reasons.length > 0) {
      return { decision: 'merge', customerId: customer.customerId ?? customer.id ?? null, reasons };
    }
  }

  for (const customer of existing) {
    if (candidateIdLast4 && candidateIdLast4 === normalizeIdLast4(customer.idLast4)) {
      return {
        decision: 'review',
        customerId: customer.customerId ?? customer.id ?? null,
        reasons: ['ID_LAST4_MATCH'],
      };
    }
  }

  return { decision: 'create', customerId: null, reasons: [] };
}

module.exports = {
  normalizePhone,
  normalizeWechat,
  customerFingerprint,
  decideDuplicate,
};
