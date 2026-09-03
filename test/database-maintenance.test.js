'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const {
  DatabaseMaintenance,
  quickCheckDatabase,
  backupDatabase,
} = require('../app/server/database-maintenance')

function tempDatabase(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-maintenance-'))
  const dbPath = path.join(dataDir, 'source.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);')
  db.prepare('INSERT INTO records (value) VALUES (?)').run('可恢复数据')
  t.after(() => {
    try { db.close() } catch (error) {}
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  return { dataDir, dbPath, db }
}

test('数据库快速检查和 VACUUM INTO 备份均可恢复', (t) => {
  const { dataDir, dbPath, db } = tempDatabase(t)
  assert.deepEqual(quickCheckDatabase(db), { ok: true, messages: ['ok'] })

  const backupDir = path.join(dataDir, '备份')
  const result = backupDatabase({ key: 'business', db, dbPath }, backupDir, {
    force: true,
    nowMs: Date.UTC(2026, 7, 29, 12, 0, 0),
  })
  assert.equal(result.skipped, false)
  assert.equal(result.integrity.ok, true)
  assert.equal(fs.existsSync(result.path), true)

  const restored = new DatabaseSync(result.path, { readOnly: true })
  try {
    assert.deepEqual({ ...restored.prepare('SELECT value FROM records').get() }, { value: '可恢复数据' })
  } finally {
    restored.close()
  }
})

test('备份自动轮换且同一时刻强制备份不会覆盖旧文件', (t) => {
  const { dataDir, dbPath, db } = tempDatabase(t)
  const backupDir = path.join(dataDir, '备份')
  const nowMs = Date.UTC(2026, 7, 29, 12, 0, 0)
  const first = backupDatabase({ key: 'business', db, dbPath }, backupDir, { force: true, nowMs, keep: 3 })
  const second = backupDatabase({ key: 'business', db, dbPath }, backupDir, { force: true, nowMs, keep: 3 })
  assert.notEqual(first.path, second.path)
  for (let index = 1; index <= 6; index++) {
    backupDatabase({ key: 'business', db, dbPath }, backupDir, { force: true, nowMs: nowMs + index, keep: 3 })
  }
  const files = fs.readdirSync(backupDir).filter((name) => name.startsWith('business-') && name.endsWith('.sqlite'))
  assert.equal(files.length, 3)
})

test('维护器汇总备份状态并阻止并发维护', (t) => {
  const { dataDir, dbPath, db } = tempDatabase(t)
  const maintenance = new DatabaseMaintenance({
    dataDir,
    getEntries: () => [{ key: 'source', db, dbPath }],
  })
  t.after(() => maintenance.close())
  const result = maintenance.runNow({ force: true })
  assert.equal(result.errors.length, 0)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].integrity.ok, true)
  assert.equal(maintenance.getStatus().lastRun.finishedAt, result.finishedAt)

  maintenance.running = true
  assert.equal(maintenance.runNow().finishedAt, result.finishedAt)
  maintenance.running = false
})
