'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

class PublishTaskStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('PublishTaskStore 需要 dataDir')
    this.dataDir = path.resolve(options.dataDir)
    this.dbPath = path.join(this.dataDir, 'publish-tasks.sqlite')
    fs.mkdirSync(this.dataDir, { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS publish_tasks (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        create_time INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_publish_tasks_create_time
        ON publish_tasks(create_time DESC);
      CREATE TABLE IF NOT EXISTS publish_batches (
        request_id TEXT PRIMARY KEY,
        task_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publish_store_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `)
    this.upsertStatement = this.db.prepare(`INSERT INTO publish_tasks
      (id, payload_json, create_time, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json,
        create_time = excluded.create_time, updated_at = excluded.updated_at`)
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = callback()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
  }

  loadTasks() {
    const rows = this.db.prepare('SELECT id, payload_json FROM publish_tasks ORDER BY create_time ASC, id ASC').all()
    const tasks = []
    for (const row of rows) {
      try {
        const task = JSON.parse(row.payload_json)
        if (task && String(task.id || '') === String(row.id)) tasks.push(task)
      } catch (error) {
        // 单条损坏不能拖垮整个队列；原始行仍保留在数据库中供排查。
      }
    }
    return tasks
  }

  upsertTasks(tasks) {
    const rows = Array.isArray(tasks) ? tasks.filter((task) => task && task.id) : []
    if (!rows.length) return 0
    return this.transaction(() => {
      for (const task of rows) {
        const now = Date.now()
        this.upsertStatement.run(String(task.id), JSON.stringify(task), Number(task.createTime) || now, now)
      }
      return rows.length
    })
  }

  deleteTasks(ids) {
    const values = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean))]
    if (!values.length) return 0
    const remove = this.db.prepare('DELETE FROM publish_tasks WHERE id = ?')
    return this.transaction(() => {
      let deleted = 0
      for (const id of values) deleted += Number(remove.run(id).changes) || 0
      return deleted
    })
  }

  getBatchTaskIds(requestId) {
    if (!requestId) return []
    const row = this.db.prepare('SELECT task_ids_json FROM publish_batches WHERE request_id = ?').get(String(requestId))
    if (!row) return []
    try {
      const value = JSON.parse(row.task_ids_json)
      return Array.isArray(value) ? value.map(String).filter(Boolean) : []
    } catch (error) {
      return []
    }
  }

  saveBatch(requestId, taskIds) {
    const id = String(requestId || '')
    const values = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(String).filter(Boolean))]
    if (!id || !values.length) return false
    this.db.prepare(`INSERT INTO publish_batches (request_id, task_ids_json, created_at)
      VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING`)
      .run(id, JSON.stringify(values), Date.now())
    return true
  }

  createBatchWithTasks(requestId, tasks) {
    const id = String(requestId || '')
    const rows = Array.isArray(tasks) ? tasks.filter((task) => task && task.id) : []
    if (!id || !rows.length) return { created: false, taskIds: [] }
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT task_ids_json FROM publish_batches WHERE request_id = ?').get(id)
      if (existing) {
        try {
          const taskIds = JSON.parse(existing.task_ids_json)
          return { created: false, taskIds: Array.isArray(taskIds) ? taskIds.map(String).filter(Boolean) : [] }
        } catch (error) {
          return { created: false, taskIds: [] }
        }
      }
      for (const task of rows) {
        const now = Date.now()
        this.upsertStatement.run(String(task.id), JSON.stringify(task), Number(task.createTime) || now, now)
      }
      const taskIds = rows.map((task) => String(task.id))
      this.db.prepare('INSERT INTO publish_batches (request_id, task_ids_json, created_at) VALUES (?, ?, ?)')
        .run(id, JSON.stringify(taskIds), Date.now())
      return { created: true, taskIds }
    })
  }

  importLegacyJson(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return 0
    const migrationKey = 'legacy_publish_tasks_json_v1'
    if (this.db.prepare('SELECT 1 FROM publish_store_metadata WHERE key = ?').get(migrationKey)) return 0
    const existing = this.db.prepare('SELECT COUNT(*) AS count FROM publish_tasks').get()
    if (Number(existing && existing.count) > 0) {
      this.db.prepare('INSERT INTO publish_store_metadata (key, value, updated_at) VALUES (?, ?, ?)')
        .run(migrationKey, JSON.stringify({ file: path.basename(filePath), skipped: 'sqlite_not_empty' }), Date.now())
      return 0
    }
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!Array.isArray(payload)) return 0
    const rows = payload.filter((task) => task && task.id)
    return this.transaction(() => {
      for (const task of rows) {
        const now = Date.now()
        this.upsertStatement.run(String(task.id), JSON.stringify(task), Number(task.createTime) || now, now)
      }
      this.db.prepare(`INSERT INTO publish_store_metadata (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(migrationKey, JSON.stringify({ file: path.basename(filePath), imported: rows.length }), Date.now())
      return rows.length
    })
  }

  close() {
    try { this.db.close() } catch (error) {}
  }
}

module.exports = { PublishTaskStore }
