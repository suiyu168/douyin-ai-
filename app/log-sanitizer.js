'use strict'

const SENSITIVE_KEY_RE = /cookie|token|session|password|passphrase|secret|api.?key|authorization|credential|phone|mobile|contact|raw.?text|evidence|source.?text/i

function sanitizeForLog(value, depth = 0) {
  if (depth > 3) return '[省略]'
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitizeForLog(item, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) out[key] = '[已脱敏]'
      else out[key] = sanitizeForLog(item, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') {
    return value
      .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已脱敏]')
      .replace(/(?<!\d)(?:0\d{2,3}[- ]?)?\d{7,8}(?!\d)/g, '[电话已脱敏]')
      .replace(/(sessionid|sid_guard|passport_auth_status|d_ticket)=([^;\s]+)/gi, '$1=[凭证已脱敏]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [凭证已脱敏]')
      .replace(/\b(?:sk|bsa|api)[-_][A-Za-z0-9_-]{12,}\b/gi, '[API密钥已脱敏]')
  }
  return value
}

module.exports = { SENSITIVE_KEY_RE, sanitizeForLog }
