'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PublishTaskStore } = require('../app/server/publish-task-store')

function tempStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-publish-store-'))
  const store = new PublishTaskStore({ dataDir })
  t.after(() => {
    store.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { store, dataDir }
}

test('发布任务以 SQLite 持久化并能更新单条状态', (t) => {
  const { store } = tempStore(t)
  const task = { id: 'task-1', title: '冷库案例', status: 'pending', createTime: 100 }
  assert.equal(store.upsertTasks([task]), 1)
  assert.deepEqual(store.loadTasks(), [task])

  task.status = 'success'
  task.finishTime = 200
  store.upsertTasks([task])
  assert.equal(store.loadTasks()[0].status, 'success')
  assert.equal(store.loadTasks()[0].finishTime, 200)
})

test('批次请求 ID 可用于重复提交幂等恢复', (t) => {
  const { store } = tempStore(t)
  store.upsertTasks([
    { id: 'a', clientBatchId: 'request-1', status: 'pending', createTime: 1 },
    { id: 'b', clientBatchId: 'request-1', status: 'pending', createTime: 2 },
  ])
  assert.equal(store.saveBatch('request-1', ['a', 'b']), true)
  assert.deepEqual(store.getBatchTaskIds('request-1'), ['a', 'b'])
  store.saveBatch('request-1', ['other'])
  assert.deepEqual(store.getBatchTaskIds('request-1'), ['a', 'b'])
})

test('任务和批次幂等标记在同一事务写入，重复创建不会覆盖原任务', (t) => {
  const { store } = tempStore(t)
  const original = { id: 'atomic-task', title: '原始内容', createTime: 1, status: 'pending' }
  assert.deepEqual(store.createBatchWithTasks('atomic-request', [original]), {
    created: true,
    taskIds: ['atomic-task'],
  })

  assert.deepEqual(store.createBatchWithTasks('atomic-request', [
    { id: 'different-task', title: '不应写入', createTime: 2, status: 'pending' },
  ]), {
    created: false,
    taskIds: ['atomic-task'],
  })
  assert.deepEqual(store.loadTasks().map((task) => task.id), ['atomic-task'])
  assert.equal(store.loadTasks()[0].title, '原始内容')
})

test('旧 JSON 队列只在新库为空时迁移且不会重复覆盖', (t) => {
  const { store, dataDir } = tempStore(t)
  const legacy = path.join(dataDir, 'publish-tasks.json')
  fs.writeFileSync(legacy, JSON.stringify([{ id: 'legacy-1', status: 'pending', createTime: 1 }]))
  assert.equal(store.importLegacyJson(legacy), 1)
  fs.writeFileSync(legacy, JSON.stringify([{ id: 'legacy-2', status: 'pending', createTime: 2 }]))
  assert.equal(store.importLegacyJson(legacy), 0)
  assert.deepEqual(store.loadTasks().map((task) => task.id), ['legacy-1'])
  store.deleteTasks(['legacy-1'])
  assert.equal(store.importLegacyJson(legacy), 0)
  assert.deepEqual(store.loadTasks(), [])
})

test('删除任务只影响指定 ID', (t) => {
  const { store } = tempStore(t)
  store.upsertTasks([
    { id: 'keep', status: 'pending', createTime: 1 },
    { id: 'remove', status: 'fail', createTime: 2 },
  ])
  assert.equal(store.deleteTasks(['remove']), 1)
  assert.deepEqual(store.loadTasks().map((task) => task.id), ['keep'])
})
