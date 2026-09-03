'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitizeForLog } = require('../app/log-sanitizer')

test('桥接日志按字段名脱敏搜索密钥、令牌和凭证', () => {
  const input = {
    webSearchApiKey: 'bsa_example_search_secret_123456789',
    api_key: 'api_example_secret_123456789',
    clientSecret: 'client-secret-value',
    authorization: 'Bearer token-value',
    nested: { accessToken: 'token-value', query: '地坪 招标' },
  }
  const output = sanitizeForLog(input)
  assert.equal(output.webSearchApiKey, '[已脱敏]')
  assert.equal(output.api_key, '[已脱敏]')
  assert.equal(output.clientSecret, '[已脱敏]')
  assert.equal(output.authorization, '[已脱敏]')
  assert.equal(output.nested.accessToken, '[已脱敏]')
  assert.equal(output.nested.query, '地坪 招标')
})

test('桥接日志也会脱敏无字段包裹的 Bearer 和常见 API 密钥字符串', () => {
  const output = sanitizeForLog('请求失败 Bearer abcdefghijklmnop；key=bsa_abcdefghijklmnop')
  assert.doesNotMatch(output, /abcdefghijklmnop/)
  assert.match(output, /已脱敏/)
})
