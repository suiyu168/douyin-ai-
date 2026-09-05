'use strict';

function dataField(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { ok: false, present: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return { ok: false, present: true, value: undefined };
    return { ok: true, present: true, value: descriptor.value };
  } catch {
    return { ok: false, present: true, value: undefined };
  }
}

function dateValue(value) {
  try {
    if (value instanceof Date) return value.getTime();
  } catch {
    return NaN;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  return new Date(value).getTime();
}

function activeKnowledgeId(version, now) {
  if (!version || typeof version !== 'object') return null;
  const id = dataField(version, 'id');
  const status = dataField(version, 'status');
  const reviewStatus = dataField(version, 'reviewStatus');
  const effectiveAt = dataField(version, 'effectiveAt');
  if (!id.ok || typeof id.value !== 'string' || !id.value.trim()) return null;
  if (!status.ok || status.value !== 'published') return null;
  if (!reviewStatus.ok || reviewStatus.value !== 'approved') return null;
  if (!effectiveAt.ok) return null;
  const current = dateValue(now);
  const effective = dateValue(effectiveAt.value);
  if (!Number.isFinite(current) || !Number.isFinite(effective) || effective > current) return null;
  const expiresAt = dataField(version, 'expiresAt');
  if (!expiresAt.present) return id.value;
  if (!expiresAt.ok) return null;
  if (expiresAt.value === null || expiresAt.value === '' || expiresAt.value === undefined) return id.value;
  const expires = dateValue(expiresAt.value);
  return Number.isFinite(expires) && current < expires ? id.value : null;
}

function isKnowledgeActive(version, now) {
  return activeKnowledgeId(version, now) !== null;
}

const RISK_RULES = [
  [['投诉'], 'COMPLAINT_RISK'],
  [['退款', '退费'], 'REFUND_RISK'],
  [['合同'], 'CONTRACT_RISK'],
  [['付款异常', '支付失败', '重复扣款'], 'PAYMENT_EXCEPTION_RISK'],
  [['资格不确定', '不确定能不能报名', '报名资格不确定'], 'ELIGIBILITY_UNCERTAIN_RISK'],
  [['非标准优惠', '特殊优惠', '额外优惠', '私下优惠'], 'NON_STANDARD_DISCOUNT_RISK'],
  [['身份证'], 'IDENTITY_DOCUMENT_RISK'],
  [['保过'], 'GUARANTEED_PASS_RISK'],
  [['包毕业'], 'GUARANTEED_GRADUATION_RISK'],
];

function validCitationIds(citations, now) {
  try {
    if (!Array.isArray(citations)) return [];
  } catch {
    return [];
  }
  const lengthField = dataField(citations, 'length');
  if (!lengthField.ok || !Number.isSafeInteger(lengthField.value) || lengthField.value < 0) return [];
  const seen = new Set();
  const ids = [];
  for (let index = 0; index < lengthField.value; index += 1) {
    const item = dataField(citations, String(index));
    if (!item.ok) continue;
    const id = activeKnowledgeId(item.value, now);
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function triageMessage(input) {
  const source = input && typeof input === 'object' ? input : null;
  const messageField = dataField(source, 'message');
  const citationsField = dataField(source, 'citations');
  const nowField = dataField(source, 'now');
  const confidenceField = dataField(source, 'confidence');
  const citations = validCitationIds(citationsField.value, nowField.value);
  if (!messageField.ok || typeof messageField.value !== 'string' || !messageField.value.trim()) return { mode: 'human_required', reasons: ['INVALID_MESSAGE'], citations };
  const normalized = messageField.value.trim().toLowerCase();
  const reasons = [];
  for (const [phrases, reason] of RISK_RULES) if (phrases.some((phrase) => normalized.includes(phrase))) reasons.push(reason);
  if (reasons.length) return { mode: 'human_required', reasons, citations };
  const confident = confidenceField.ok && Number.isFinite(confidenceField.value) && confidenceField.value >= 0.75 && confidenceField.value <= 1;
  const normalReasons = [];
  if (!confident) normalReasons.push('LOW_CONFIDENCE');
  if (!citations.length) normalReasons.push('NO_VALID_CITATION');
  return { mode: confident && citations.length ? 'auto_reply' : 'suggestion', reasons: normalReasons, citations };
}

module.exports = { isKnowledgeActive, triageMessage };
