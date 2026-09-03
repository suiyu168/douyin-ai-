'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { RuntimeSupervisor, shouldKeepAwake } = require('../app/runtime-supervisor')

function fakeBlocker() {
  const active = new Set()
  let nextId = 1
  return {
    starts: 0,
    stops: 0,
    start() { this.starts++; const id = nextId++; active.add(id); return id },
    stop(id) { this.stops++; active.delete(id) },
    isStarted(id) { return active.has(id) },
  }
}

test('守护策略仅在自动任务启用或正在工作时阻止挂起', () => {
  assert.equal(shouldKeepAwake(null), false)
  assert.equal(shouldKeepAwake({ keepAwake: false, active: true }), false)
  assert.equal(shouldKeepAwake({ keepAwake: true, active: true }), true)
  assert.equal(shouldKeepAwake({ keepAwake: true, automationEnabled: true }), true)
  assert.equal(shouldKeepAwake({ keepAwake: true, active: false, automationEnabled: false }), false)
})

test('运行状态变化时守护锁只启停一次', async (t) => {
  const blocker = fakeBlocker()
  let state = { keepAwake: true, automationEnabled: true }
  const supervisor = new RuntimeSupervisor({ powerSaveBlocker: blocker, getState: async () => state, intervalMs: 5000 })
  t.after(() => supervisor.close())
  await supervisor.tick()
  await supervisor.tick()
  assert.equal(blocker.starts, 1)
  assert.equal(supervisor.getStatus().blocking, true)
  state = { keepAwake: true, automationEnabled: false, active: false }
  await supervisor.tick()
  await supervisor.tick()
  assert.equal(blocker.stops, 1)
  assert.equal(supervisor.getStatus().blocking, false)
})

test('短暂状态读取失败不会中途释放已有守护锁', async (t) => {
  const blocker = fakeBlocker()
  let fail = false
  const supervisor = new RuntimeSupervisor({
    powerSaveBlocker: blocker,
    getState: async () => {
      if (fail) throw new Error('temporary failure')
      return { keepAwake: true, active: true }
    },
  })
  t.after(() => supervisor.close())
  await supervisor.tick()
  fail = true
  await supervisor.tick()
  assert.equal(supervisor.getStatus().blocking, true)
  assert.match(supervisor.getStatus().lastError, /temporary failure/)
})
