'use strict'

class ExclusiveActivityCoordinator {
  constructor() {
    this.holder = null
    this.sequence = 0
  }

  acquire(owner) {
    if (this.holder) return null
    const token = Object.freeze({ owner: String(owner || 'unknown'), id: ++this.sequence, acquiredAt: Date.now() })
    this.holder = token
    return token
  }

  release(token) {
    if (!token || this.holder !== token) return false
    this.holder = null
    return true
  }

  status() {
    return this.holder ? { ...this.holder } : null
  }
}

module.exports = { ExclusiveActivityCoordinator }
