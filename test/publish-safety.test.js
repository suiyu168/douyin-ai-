'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  publishMayHaveSubmitted,
  recoverInterruptedPublishing,
  decidePublishAccountHealth,
  settleUnexpectedPublishError,
} = require('../app/server/publish-safety')

test('发布意图落盘后发生中断必须按结果未知恢复', () => {
  const task = { id: 'one', status: 'publishing', stage: 'publish_intent', uncertain: true, finishTime: 0 }
  const changed = recoverInterruptedPublishing([task], 12345)
  assert.equal(changed.length, 1)
  assert.equal(task.status, 'interrupted')
  assert.equal(task.stage, 'result_unknown')
  assert.equal(task.errorCode, 'RESULT_UNKNOWN')
  assert.equal(task.uncertain, true)
  assert.equal(task.finishTime, 12345)
})

test('发布意图前异常立即失败且不会伪装成结果未知', () => {
  const task = { status: 'publishing', stage: 'uploading', uncertain: false }
  settleUnexpectedPublishError(task, new Error('上传窗口异常'), 200)
  assert.equal(task.status, 'fail')
  assert.equal(task.stage, 'failed')
  assert.equal(task.errorCode, 'TASK_EXCEPTION')
  assert.equal(task.uncertain, false)
  assert.equal(publishMayHaveSubmitted(task), false)
})

test('发布意图后异常立即收口为结果未知', () => {
  const task = { status: 'publishing', stage: 'waiting_result', uncertain: true }
  settleUnexpectedPublishError(task, new Error('窗口意外关闭'), 300)
  assert.equal(task.status, 'interrupted')
  assert.equal(task.stage, 'result_unknown')
  assert.equal(task.errorCode, 'RESULT_UNKNOWN')
  assert.equal(task.uncertain, true)
})

test('发布账号只有真实验证在线才放行，未知状态指数延迟后三次暂停', () => {
  assert.equal(decidePublishAccountHealth({ ok: true, verified: true, state: 'online', login: true }).action, 'allow')
  const first = decidePublishAccountHealth({ ok: true, verified: false, state: 'unknown' }, 0)
  assert.equal(first.action, 'defer')
  assert.equal(first.delayMs, 5 * 60 * 1000)
  const second = decidePublishAccountHealth({ ok: false, verified: false, state: 'busy', kind: 'account_unknown' }, 1)
  assert.equal(second.action, 'defer')
  assert.equal(second.delayMs, 10 * 60 * 1000)
  const third = decidePublishAccountHealth({ ok: true, verified: false, state: 'unknown' }, 2)
  assert.equal(third.action, 'pause')
  assert.equal(third.errorCode, 'ACCOUNT_UNVERIFIED')
  const offline = decidePublishAccountHealth({ ok: false, verified: false, kind: 'login_expired', message: '已掉线' }, 0)
  assert.equal(offline.action, 'reject')
  assert.equal(offline.kind, 'login_expired')
})
