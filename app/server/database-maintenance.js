'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const DAY_MS = 24 * 60 * 60 * 1000

function safeKey(value) {
  return String(value || 'database').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'database'
}

function quickCheckDatabase(db) {
  const rows = db.prepare('PRAGMA quick_check').all()
  const messages = rows.map((row) => String(row.quick_check || Object.values(row)[0] || ''))
  const ok = messages.length === 1 && messages[0].toLowerCase() === 'ok'
  return { ok, messages }
}

function diskSpaceInfo(targetPath) {
  if (typeof fs.statfsSync !== 'function') return { available: null, total: null, ratio: null }
  const stats = fs.statfsSync(targetPath)
  const blockSize = Number(stats.bsize) || 0
  const available = blockSize * (Number(stats.bavail) || 0)
  const total = blockSize * (Number(stats.blocks) || 0)
  return { available, total, ratio: total > 0 ? available / total : null }
}

function latestBackup(backupDir, key) {
  if (!fs.existsSync(backupDir)) return null
  const prefix = safeKey(key) + '-'
  const rows = fs.readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.sqlite'))
    .map((entry) => {
      const filePath = path.resolve(backupDir, entry.name)
      return { path: filePath, name: entry.name, mtimeMs: fs.statSync(filePath).mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  return rows[0] || null
}

function rotateBackups(backupDir, key, keep = 7) {
  const resolvedDir = path.resolve(backupDir)
  if (!fs.existsSync(resolvedDir)) return 0
  const prefix = safeKey(key) + '-'
  const rows = fs.readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.sqlite'))
    .map((entry) => ({ path: path.resolve(resolvedDir, entry.name), mtimeMs: fs.statSync(path.resolve(resolvedDir, entry.name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  let removed = 0
  for (const row of rows.slice(Math.max(1, Number(keep) || 7))) {
    if (path.dirname(row.path) !== resolvedDir) continue
    fs.rmSync(row.path, { force: true })
    removed++
  }
  return removed
}

function backupDatabase(entry, backupDir, options = {}) {
  if (!entry || !entry.db || !entry.dbPath) throw new Error('数据库备份项不完整')
  const key = safeKey(entry.key || path.basename(entry.dbPath, path.extname(entry.dbPath)))
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  const minIntervalMs = options.minIntervalMs == null ? DAY_MS : Math.max(0, Number(options.minIntervalMs) || 0)
  fs.mkdirSync(backupDir, { recursive: true })
  const latest = latestBackup(backupDir, key)
  if (!options.force && latest && nowMs - latest.mtimeMs < minIntervalMs) {
    return { key, skipped: true, path: latest.path, reason: 'recent_backup' }
  }
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  let outputPath = path.resolve(backupDir, `${key}-${stamp}.sqlite`)
  let suffix = 1
  while (fs.existsSync(outputPath)) {
    outputPath = path.resolve(backupDir, `${key}-${stamp}-${suffix++}.sqlite`)
  }
  if (path.dirname(outputPath) !== path.resolve(backupDir)) throw new Error('备份路径越界')
  const escapedPath = outputPath.replace(/'/g, "''")
  try {
    entry.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    entry.db.exec(`VACUUM INTO '${escapedPath}'`)
    const backupDb = new DatabaseSync(outputPath, { readOnly: true })
    let check
    try {
      check = quickCheckDatabase(backupDb)
    } finally {
      backupDb.close()
    }
    if (!check.ok) throw new Error(`备份完整性检查失败：${check.messages.join('; ')}`)
    const backupSize = fs.statSync(outputPath).size
    rotateBackups(backupDir, key, options.keep || 7)
    return { key, skipped: false, path: outputPath, size: backupSize, integrity: check }
  } catch (error) {
    try {
      if (fs.existsSync(outputPath) && path.dirname(outputPath) === path.resolve(backupDir)) fs.rmSync(outputPath, { force: true })
    } catch (cleanupError) {}
    throw error
  }
}

class DatabaseMaintenance {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('DatabaseMaintenance 需要 dataDir')
    if (typeof options.getEntries !== 'function') throw new Error('DatabaseMaintenance 需要数据库读取器')
    this.dataDir = path.resolve(options.dataDir)
    this.backupDir = path.join(this.dataDir, '备份')
    this.getEntries = options.getEntries
    this.notify = typeof options.notify === 'function' ? options.notify : () => {}
    this.keep = Math.max(3, Math.min(30, Number(options.keep) || 7))
    this.timer = null
    this.startTimeout = null
    this.running = false
    this.lastRun = null
  }

  appendLog(message) {
    const logPath = path.join(this.dataDir, 'maintenance.log')
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
        const content = fs.readFileSync(logPath, 'utf8')
        fs.writeFileSync(logPath, content.slice(-256 * 1024), 'utf8')
      }
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${String(message).slice(0, 2000)}\n`, 'utf8')
    } catch (error) {}
  }

  runNow(options = {}) {
    if (this.running) return this.lastRun || { running: true }
    this.running = true
    const startedAt = new Date().toISOString()
    const results = []
    const errors = []
    try {
      const disk = diskSpaceInfo(this.dataDir)
      if (disk.available != null && (disk.available < 2 * 1024 ** 3 || disk.ratio < 0.05)) {
        const message = `数据目录可用空间不足：${(disk.available / 1024 ** 3).toFixed(1)} GB`
        errors.push({ key: 'disk_space', message })
        try { this.notify({ kind: 'disk_space', message }) } catch (error) {}
      }
      for (const entry of this.getEntries()) {
        try {
          const integrity = quickCheckDatabase(entry.db)
          if (!integrity.ok) throw new Error(`数据库完整性检查失败：${integrity.messages.join('; ')}`)
          results.push(backupDatabase(entry, this.backupDir, {
            force: !!options.force,
            minIntervalMs: options.minIntervalMs == null ? DAY_MS : Number(options.minIntervalMs),
            keep: this.keep,
          }))
        } catch (error) {
          const item = { key: String(entry && entry.key || 'database'), message: String(error && error.message || error) }
          errors.push(item)
          try { this.notify({ kind: 'database', message: `${item.key}：${item.message}` }) } catch (notifyError) {}
        }
      }
      this.lastRun = { running: false, startedAt, finishedAt: new Date().toISOString(), backupDir: this.backupDir, disk, results, errors }
      this.appendLog(JSON.stringify(this.lastRun))
      return this.lastRun
    } finally {
      this.running = false
    }
  }

  getStatus() {
    return { running: this.running, backupDir: this.backupDir, keep: this.keep, lastRun: this.lastRun }
  }

  start() {
    if (this.timer) return
    const tick = () => { try { this.runNow() } catch (error) { this.appendLog(String(error && error.message || error)) } }
    this.timer = setInterval(tick, 6 * 60 * 60 * 1000)
    if (this.timer.unref) this.timer.unref()
    this.startTimeout = setTimeout(() => {
      this.startTimeout = null
      tick()
    }, 60000)
    if (this.startTimeout.unref) this.startTimeout.unref()
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    if (this.startTimeout) clearTimeout(this.startTimeout)
    this.timer = null
    this.startTimeout = null
  }
}

module.exports = {
  DatabaseMaintenance,
  quickCheckDatabase,
  diskSpaceInfo,
  backupDatabase,
  rotateBackups,
}
