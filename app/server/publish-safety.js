'use strict'

const UNCERTAIN_PUBLISH_STAGES = new Set([
  'publish_intent',
  'publish_clicking',
  'publish_clicked',
  'waiting_result',
  'result_unknown',
])

function publishMayHaveSubmitted(task = {}) {
  return !!task.uncertain || UNCERTAIN_PUBLISH_STAGES.has(String(task.stage || ''))
}

function recoverInterruptedPublishing(tasks, now = Date.now()) {
  const changed = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || task.status !== 'publishing' || task.finishTime) continue
    const uncertain = publishMayHaveSubmitted(task)
    task.status = 'interrupted'
    task.uncertain = uncertain
    task.errorCode = uncertain ? 'RESULT_UNKNOWN' : 'PUBLISH_INTERRUPTED'
    task.stage = uncertain ? 'result_unknown' : 'interrupted_before_submit'
    task.error = uncertain
      ? '程序上次在提交发布后中断，结果未知；请先到抖音作品管理核对，禁止自动重发'
      : '程序上次发布过程中断，已停止自动重试，请核对后手动处理'
    task.finishTime = now
    task.recoveredAt = now
    changed.push(task)
  }
  return changed
}

function decidePublishAccountHealth(health = {}, previousUnknownChecks = 0) {
  if (health.ok !== false && health.verified === true && (health.login === true || health.state === 'online')) {
    return { ok: true, action: 'allow', unknownChecks: 0 }
  }
  if (health.ok === false && health.kind && health.kind !== 'account_unknown') {
    return { ok: false, action: 'reject', unknownChecks: 0, kind: health.kind,
      message: String(health.message || '账号状态不可用') }
  }
  const unknownChecks = Math.max(0, Number(previousUnknownChecks) || 0) + 1
  if (unknownChecks >= 3) {
    return {
      ok: false,
      action: 'pause',
      kind: 'account_unknown',
      errorCode: 'ACCOUNT_UNVERIFIED',
      unknownChecks,
      message: '连续三次无法确认抖音账号在线状态，发布任务已暂停；请打开账号页面确认后再恢复',
    }
  }
  return {
    ok: false,
    action: 'defer',
    kind: 'account_unknown',
    errorCode: 'ACCOUNT_STATUS_UNKNOWN',
    unknownChecks,
    delayMs: Math.min(30 * 60 * 1000, 5 * 60 * 1000 * (2 ** (unknownChecks - 1))),
    message: `暂时无法确认抖音账号在线状态，已延迟第 ${unknownChecks} 次复检，不会执行发布`,
  }
}

function settleUnexpectedPublishError(task, error, now = Date.now()) {
  const uncertain = publishMayHaveSubmitted(task)
  task.status = uncertain ? 'interrupted' : 'fail'
  task.uncertain = uncertain
  task.errorCode = uncertain ? 'RESULT_UNKNOWN' : 'TASK_EXCEPTION'
  task.stage = uncertain ? 'result_unknown' : 'failed'
  task.error = uncertain
    ? `发布过程异常中断且结果未知：${String(error && error.message || error).slice(0, 220)}`
    : `发布任务异常：${String(error && error.message || error).slice(0, 240)}`
  task.finishTime = now
  return task
}

module.exports = {
  UNCERTAIN_PUBLISH_STAGES,
  publishMayHaveSubmitted,
  recoverInterruptedPublishing,
  decidePublishAccountHealth,
  settleUnexpectedPublishError,
}
