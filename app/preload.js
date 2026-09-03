const { contextBridge, ipcRenderer, webUtils } = require('electron')
// sandboxed preload 只能 require Electron/Node 的受限内建模块，不能加载本地文件。
// 将日志脱敏器保留在 preload 内，避免预加载脚本整体失败后 CatBridge 不存在、账号列表永远为空。
const SENSITIVE_KEY_RE = /cookie|token|session|password|passphrase|secret|api.?key|authorization|credential|phone|mobile|contact|raw.?text|evidence|source.?text/i
function sanitizeForLog(value, depth = 0) {
  if (depth > 3) return '[省略]'
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitizeForLog(item, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[已脱敏]' : sanitizeForLog(item, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') {
    return value
      .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已脱敏]')
      .replace(/(?<!\d)(?:0\d{2,3}[- ]?)?\d{7,8}(?!\d)/g, '[电话已脱敏]')
      .replace(/(sessionid|sid_guard|passport_auth_status|d_ticket)=([^;\s]+)/gi, '$1=[凭证已脱敏]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [凭证已脱敏]')
      .replace(/\b(?:sk|bsa|api)[-_][A-Za-z0-9_-]{12,}\b/gi, '[API密钥已脱敏]')
  }
  return value
}
const EventStore = {}
let isLocal = false

function blog(msg) {
  try { ipcRenderer.send('bridgeLog', `[${Date.now()}] ${msg}`) } catch (e) {}
}
function clamp(s, n) {
  s = String(s)
  return s.length > n ? s.slice(0, n) + '...' : s
}
const CatBridge = {
  getValue: async (d, options) => {
    blog(`getValue(${clamp(JSON.stringify(sanitizeForLog(d, 0)), 120)})`)
    try {
      const r = await ipcRenderer.invoke('getValue', { keys: d, options })
      blog(`getValue => ${clamp(JSON.stringify(sanitizeForLog(r, 0)), 200)}`)
      return r
    } catch (e) {
      blog(`getValue ERROR ${sanitizeForLog(e.message, 0)}`)
      throw e
    }
  },
  getCall: (name, ...args) => {
    blog(`getCall(${name} ${clamp(JSON.stringify(sanitizeForLog(args, 0)), 150)})`)
    return ipcRenderer.invoke('getCall', name, ...args).then(r => {
      blog(`getCall(${name}) => ${clamp(JSON.stringify(sanitizeForLog(r, 0)), 200)}`)
      return r
    }).catch(e => {
      blog(`getCall(${name}) ERROR ${sanitizeForLog(e.message, 0)}`)
      throw new Error(e.message.replace(`Error invoking remote method 'getCall':`, ''))
    })
  },
  addListenter: (target, name, callback) => {
    const id = `${target}:${name}:${Math.floor(Math.random() * 100000)}`
    const listener = (_ipcEvent, ...args) => callback(...args)
    EventStore[id] = listener
    ipcRenderer.addListener(id, listener)
    ipcRenderer.invoke('addListenter', { target, name, id }).catch((error) => {
      blog(`addListenter(${name}) ERROR ${error.message}`)
    })
    return id
  },
  removeListener: (id) => {
    ipcRenderer.removeListener(id, EventStore[id])
    delete EventStore[id]
    ipcRenderer.invoke('removeListener', id)
  },
  getReady: () => {
    return ipcRenderer.invoke('isReady')
  },
  showDevtools: () => {
    ipcRenderer.invoke('showDevtools')
  },
  openExternalUrl: (url) => ipcRenderer.invoke('openExternalUrl', url),
  setLoginPartition: (p) => {
    ipcRenderer.invoke('setLoginPartition', p)
  },
  handle: (channel, callable) => ipcRenderer.on(channel, callable),
  getPathForFile: (file) => {
    // return file.path
    return webUtils.getPathForFile(file)
  },
}

contextBridge.exposeInMainWorld('CatBridge', CatBridge)

window.addEventListener('DOMContentLoaded', () => {
    if (window.document.getElementById('Local_Script')) {
      isLocal = true
    }
})
