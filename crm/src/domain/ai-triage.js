'use strict';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function dateValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  return new Date(value).getTime();
}

function isKnowledgeActive(version, now) {
  if (!version || typeof version !== 'object') return false;
  if (!own(version, 'id') || typeof version.id !== 'string' || !version.id.trim()) return false;
  if (!own(version, 'status') || version.status !== 'published') return false;
  if (!own(version, 'reviewStatus') || version.reviewStatus !== 'approved') return false;
  if (!own(version, 'effectiveAt')) return false;
  const current = dateValue(now);
  const effective = dateValue(version.effectiveAt);
  if (!Number.isFinite(current) || !Number.isFinite(effective) || effective > current) return false;
  if (!own(version, 'expiresAt') || version.expiresAt === null || version.expiresAt === '' || version.expiresAt === undefined) return true;
  const expires = dateValue(version.expiresAt);
  return Number.isFinite(expires) && current < expires;
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
  if (!Array.isArray(citations)) return [];
  const seen = new Set();
  const ids = [];
  for (const version of citations) {
    if (isKnowledgeActive(version, now) && !seen.has(version.id)) {
      seen.add(version.id);
      ids.push(version.id);
    }
  }
  return ids;
}

function triageMessage(input) {
  const source = input && typeof input === 'object' ? input : {};
  const citations = validCitationIds(source.citations, source.now);
  if (typeof source.message !== 'string' || !source.message.trim()) return { mode: 'human_required', reasons: ['INVALID_MESSAGE'], citations };
  const normalized = source.message.trim().toLowerCase();
  const reasons = [];
  for (const [phrases, reason] of RISK_RULES) if (phrases.some((phrase) => normalized.includes(phrase))) reasons.push(reason);
  if (reasons.length) return { mode: 'human_required', reasons, citations };
  const confident = Number.isFinite(source.confidence) && source.confidence >= 0.75 && source.confidence <= 1;
  const normalReasons = [];
  if (!confident) normalReasons.push('LOW_CONFIDENCE');
  if (!citations.length) normalReasons.push('NO_VALID_CITATION');
  return { mode: confident && citations.length ? 'auto_reply' : 'suggestion', reasons: normalReasons, citations };
}

module.exports = { isKnowledgeActive, triageMessage };
