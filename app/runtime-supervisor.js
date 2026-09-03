'use strict'

function shouldKeepAwake(state) {
  if (!state || state.keepAwake === false) return false
  return !!(state.active || state.automationEnabled)
}

class RuntimeSupervisor {
  constructor(options = {}) {
    if (!options.powerSaveBlocker) throw new Error('RuntimeSupervisor 需要 powerSaveBlocker')
    if (typeof options.getState !== 'function') throw new Error('RuntimeSupervisor 需要运行状态读取器')
    this.powerSaveBlocker = options.powerSaveBlocker
    this.getState = options.getState
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.intervalMs = Math.max(5000, Number(options.intervalMs) || 30000)
    this.timer = null
    this.blockerId = null
    this.ticking = false
    this.lastState = null
    this.lastError = ''
    this.lastCheckedAt = ''
  }

  isBlocking() {
    return this.blockerId != null && this.powerSaveBlocker.isStarted(this.blockerId)
  }

  setBlocking(enabled) {
    if (enabled && !this.isBlocking()) {
      this.blockerId = this.powerSaveBlocker.start('prevent-app-suspension')
      this.log('24小时守护已启用：自动任务运行期间阻止系统挂起')
      return
    }
    if (!enabled && this.blockerId != null) {
      try {
        if (this.powerSaveBlocker.isStarted(this.blockerId)) this.powerSaveBlocker.stop(this.blockerId)
      } finally {
        this.blockerId = null
      }
      this.log('24小时守护已释放系统挂起锁')
    }
  }

  async tick() {
    if (this.ticking) return this.getStatus()
    this.ticking = true
    try {
      const state = await this.getState()
      this.lastState = state || {}
      this.lastError = ''
      this.lastCheckedAt = new Date().toISOString()
      this.setBlocking(shouldKeepAwake(this.lastState))
    } catch (error) {
      // 短暂的 IPC/状态读取异常不应立刻释放已有守护锁，以免任务运行中电脑休眠。
      this.lastError = String(error && error.message || error)
      this.lastCheckedAt = new Date().toISOString()
      this.log('24小时守护状态读取失败：' + this.lastError)
    } finally {
      this.ticking = false
    }
    return this.getStatus()
  }

  getStatus() {
    return {
      blocking: this.isBlocking(),
      lastState: this.lastState,
      lastError: this.lastError,
      lastCheckedAt: this.lastCheckedAt,
    }
  }

  start() {
    if (this.timer) return
    this.tick().catch(() => {})
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs)
    if (this.timer.unref) this.timer.unref()
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.setBlocking(false)
  }
}

module.exports = { RuntimeSupervisor, shouldKeepAwake }
