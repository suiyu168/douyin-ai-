'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CrashLoopGuard, recordPersistentCrash, clearPersistentCrashHistory } = require('../app/crash-loop-guard')

test('渲染器连续崩溃采用指数退避并在上限后停止重建', () => {
  const guard = new CrashLoopGuard({ windowMs: 60000, maxRestarts: 3, baseDelayMs: 1000, maxDelayMs: 10000 })
  assert.deepEqual(guard.next(100000), { allowed: true, count: 1, delayMs: 1000 })
  assert.deepEqual(guard.next(100001), { allowed: true, count: 2, delayMs: 2000 })
  assert.deepEqual(guard.next(100002), { allowed: true, count: 3, delayMs: 4000 })
  assert.deepEqual(guard.next(100003), { allowed: false, count: 3, delayMs: 0 })
  assert.deepEqual(guard.next(200000), { allowed: true, count: 1, delayMs: 1000 })
})

test('主进程崩溃次数跨重启持久化并可在稳定后清除', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-crash-guard-'))
  const filePath = path.join(dir, 'fatal.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(recordPersistentCrash(filePath, { nowMs: 100000, windowMs: 60000, maxRestarts: 2 }).allowed, true)
  assert.equal(recordPersistentCrash(filePath, { nowMs: 100001, windowMs: 60000, maxRestarts: 2 }).allowed, true)
  assert.equal(recordPersistentCrash(filePath, { nowMs: 100002, windowMs: 60000, maxRestarts: 2 }).allowed, false)
  clearPersistentCrashHistory(filePath)
  assert.equal(fs.existsSync(filePath), false)
})
