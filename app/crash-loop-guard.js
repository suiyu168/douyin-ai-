'use strict'

const fs = require('node:fs')
const path = require('node:path')

class CrashLoopGuard {
  constructor(options = {}) {
    this.windowMs = Math.max(1000, Number(options.windowMs) || 10 * 60 * 1000)
    this.maxRestarts = Math.max(1, Number(options.maxRestarts) || 3)
    this.baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 2000)
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(options.maxDelayMs) || 30000)
    this.history = []
  }

  next(nowMs = Date.now()) {
    const now = Number(nowMs) || Date.now()
    this.history = this.history.filter((value) => now - value < this.windowMs)
    if (this.history.length >= this.maxRestarts) {
      return { allowed: false, count: this.history.length, delayMs: 0 }
    }
    const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** this.history.length))
    this.history.push(now)
    return { allowed: true, count: this.history.length, delayMs }
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, JSON.stringify(value), 'utf8')
  try {
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    fs.copyFileSync(tempPath, filePath)
    fs.rmSync(tempPath, { force: true })
  }
}

function recordPersistentCrash(filePath, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now()
  const windowMs = Math.max(1000, Number(options.windowMs) || 10 * 60 * 1000)
  const maxRestarts = Math.max(1, Number(options.maxRestarts) || 3)
  let history = []
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (Array.isArray(parsed)) history = parsed.map(Number).filter(Number.isFinite)
  } catch (error) {}
  history = history.filter((value) => nowMs - value < windowMs)
  const allowed = history.length < maxRestarts
  history.push(nowMs)
  writeJsonAtomic(filePath, history)
  return { allowed, count: history.length, windowMs }
}

function clearPersistentCrashHistory(filePath) {
  try { fs.rmSync(filePath, { force: true }) } catch (error) {}
}

module.exports = { CrashLoopGuard, recordPersistentCrash, clearPersistentCrashHistory }
