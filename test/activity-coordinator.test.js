'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ExclusiveActivityCoordinator } = require('../app/server/activity-coordinator')
const { DouyinPublicCollector } = require('../app/server/douyin-public-collector')

test('抖音采集与发布使用同一个原子活动锁', () => {
  const activity = new ExclusiveActivityCoordinator()
  const publishing = activity.acquire('publisher')
  assert.equal(publishing.owner, 'publisher')
  assert.equal(activity.acquire('collector'), null)
  assert.equal(activity.release({ owner: 'publisher' }), false)
  assert.equal(activity.release(publishing), true)
  const collecting = activity.acquire('collector')
  assert.equal(collecting.owner, 'collector')
  assert.equal(activity.status().id, collecting.id)
})

test('采集在第一次异步账号检查前占位，异常时必定释放', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-activity-'))
  const activity = new ExclusiveActivityCoordinator()
  let rejectCheck
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir },
    BrowserWindow: function BrowserWindow() { throw new Error('不应创建窗口') },
    getAccounts: () => [{ uid: 'account-1', platform: 'Douyin', partition: 'persist:test', isLogin: true, status: 1 }],
    checkAccount: () => new Promise((resolve, reject) => { rejectCheck = reject }),
    acquireActivity: () => activity.acquire('collector'),
    releaseActivity: (token) => activity.release(token),
    now: () => new Date(2026, 7, 29, 12, 0),
  })
  t.after(() => {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const run = collector.runNow({ mode: 'profiles' })
  assert.equal(collector.running, true)
  assert.equal(activity.status().owner, 'collector')
  assert.equal(activity.acquire('publisher'), null)
  rejectCheck(new Error('停止测试'))
  await assert.rejects(run, /停止测试/)
  assert.equal(collector.running, false)
  const publishing = activity.acquire('publisher')
  assert.equal(publishing.owner, 'publisher')
})
