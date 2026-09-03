const { app, BrowserWindow, ipcMain, Menu, shell, powerSaveBlocker, Notification } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { isAllowedNavigation, getNavigationUrl, getProtocol, isAllowedDouyinWebUrl } = require('./protocol-guard')
const { RuntimeSupervisor } = require('./runtime-supervisor')
const { CrashLoopGuard, recordPersistentCrash, clearPersistentCrashHistory } = require('./crash-loop-guard')

// 把 Electron 分区、浏览器资料和缓存统一放到 D 盘。隔离测试可用环境变量覆盖。
function defaultUserDataDir() {
  if (process.env.VCAT_USER_DATA_DIR) return path.resolve(process.env.VCAT_USER_DATA_DIR)
  if (process.platform === 'win32' && fs.existsSync('D:\\')) return 'D:\\小V猫数据\\抖音自动化\\用户数据'
  return path.join(app.getPath('documents'), '小V猫数据', '抖音自动化', '用户数据')
}

const originalUserDataDir = app.getPath('userData')
const userDataDir = defaultUserDataDir()
fs.mkdirSync(userDataDir, { recursive: true })

// 正式环境第一次切换到 D 盘时复制旧登录分区，避免用户重新扫码。旧目录暂不删除，便于回退。
if (!process.env.VCAT_USER_DATA_DIR) {
  const marker = path.join(userDataDir, '.migration-v1.json')
  if (!fs.existsSync(marker)) {
    const legacyRoots = [
      originalUserDataDir,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'vcat-neo') : '',
      process.env.APPDATA ? path.join(process.env.APPDATA, '小V猫') : '',
    ].filter(Boolean)
    const copied = []
    const failed = []
    for (const legacyRoot of [...new Set(legacyRoots.map((item) => path.resolve(item)))]) {
      if (legacyRoot.toLowerCase() === path.resolve(userDataDir).toLowerCase()) continue
      for (const name of ['Partitions', 'camoufox-profiles']) {
        const source = path.join(legacyRoot, name)
        const target = path.join(userDataDir, name)
        if (!fs.existsSync(source)) continue
        try {
          fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false })
          copied.push(source)
        } catch (error) { failed.push({ source, message: String(error && error.message || error).slice(0, 300) }) }
      }
    }
    // 有复制失败时不写完成标记，下次启动会合并缺失文件后重试。
    if (!failed.length) {
      try { fs.writeFileSync(marker, JSON.stringify({ migratedAt: new Date().toISOString(), copied }, null, 2)) } catch (error) {}
    }
  }
}

app.setPath('userData', userDataDir)
process.env.VCAT_APP_DATA_DIR = userDataDir
const logDir = path.join(userDataDir, 'logs')
fs.mkdirSync(logDir, { recursive: true })

function redactLogText(value) {
  return String(value == null ? '' : value)
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已脱敏]')
    .replace(/(?<!\d)(?:0\d{2,3}[- ]?)?\d{7,8}(?!\d)/g, '[电话已脱敏]')
    .replace(/(sessionid|sid_guard|passport_auth_status|d_ticket)=([^;\s]+)/gi, '$1=[凭证已脱敏]')
}

function appendRotatingLog(fileName, value, maxBytes = 2 * 1024 * 1024) {
  try {
    const filePath = path.join(logDir, fileName)
    if (fs.existsSync(filePath) && fs.statSync(filePath).size >= maxBytes) {
      const backup = filePath + '.1'
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true })
      fs.renameSync(filePath, backup)
    }
    fs.appendFileSync(filePath, redactLogText(value) + '\n')
  } catch (error) {}
}

app.commandLine.appendSwitch('enable-features', 'Geolocation')
app.commandLine.appendSwitch('max-pool-connections', '100')

// 默认不开放远程调试端口。仅本地验收时通过环境变量显式启用。
const remoteDebugPort = String(process.env.VCAT_REMOTE_DEBUG_PORT || '')
if (/^\d{4,5}$/.test(remoteDebugPort)) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebugPort)
}

let win = null
let runtimeSupervisor = null
let appQuitting = false
const rendererCrashGuard = new CrashLoopGuard({ windowMs: 10 * 60 * 1000, maxRestarts: 3, baseDelayMs: 2000, maxDelayMs: 30000 })
const fatalCrashHistoryFile = path.join(logDir, 'fatal-restarts.json')
const gotTheLock = app.requestSingleInstanceLock({})

if (!gotTheLock) {
  app.quit()
  return
}

function createWindow() {
  const createdWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0d1117',
    title: '发布助手',
    autoHideMenuBar: true,
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  win = createdWindow
  createdWindow.loadFile(path.join(__dirname, 'index.html'))

  createdWindow.webContents.on('console-message', (event) => {
    try {
      const level = event && typeof event === 'object' ? event.level : 0
      const message = event && typeof event === 'object' ? event.message : ''
      if (level >= 2) {
        appendRotatingLog('console.log', `[${new Date().toISOString()}] L${level} ${String(message).slice(0, 300)}`)
      }
    } catch (e) {}
  })

  createdWindow.webContents.on('render-process-gone', (_event, details) => {
    appendRotatingLog('runtime.log', `[${new Date().toISOString()}] renderer gone ${JSON.stringify(details || {})}`)
    if (appQuitting) return
    const recovery = rendererCrashGuard.next()
    if (!recovery.allowed) {
      appendRotatingLog('runtime.log', `[${new Date().toISOString()}] renderer recovery stopped after ${recovery.count} crashes`)
      try {
        if (Notification.isSupported()) new Notification({ title: '发布助手界面已暂停恢复', body: '界面连续异常，后台任务已保留。请稍后从桌面快捷方式重新打开。' }).show()
      } catch (error) {}
      return
    }
    setTimeout(() => {
      if (appQuitting || win !== createdWindow) return
      // 先建立替代窗口再销毁崩溃窗口，避免触发 window-all-closed 使后台采集器退出。
      createWindow()
      try { if (!createdWindow.isDestroyed()) createdWindow.destroy() } catch (error) {}
    }, recovery.delayMs)
  })
  createdWindow.on('unresponsive', () => appendRotatingLog('runtime.log', `[${new Date().toISOString()}] renderer unresponsive`))
  createdWindow.on('responsive', () => appendRotatingLog('runtime.log', `[${new Date().toISOString()}] renderer responsive`))
  createdWindow.on('closed', () => {
    if (win !== createdWindow) return
    win = null
    // 主窗口是用户可见的生命周期；即使采集器恰有隐藏窗口，也必须正常触发 before-quit 收口数据库。
    if (!appQuitting) setImmediate(() => app.quit())
  })
  return createdWindow
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// 全局拦截 window.open / target=_blank：deny 弹窗并通知前端在内置浏览器开标签页
let loginPartition = ''
function assertTrustedIpc(event) {
  if (!event || !event.sender || !win || win.isDestroyed() || event.sender.id !== win.webContents.id) {
    throw new Error('已拒绝非主界面的 IPC 调用')
  }
  const senderUrl = String(event.sender.getURL() || '')
  if (!isAllowedNavigation(senderUrl, { allowWeb: false, fileRoot: __dirname })) throw new Error('已拒绝非本地页面的 IPC 调用')
}
ipcMain.handle('setLoginPartition', (e, p) => { assertTrustedIpc(e); loginPartition = String(p || '') })

app.on('web-contents-created', (e, contents) => {
  try {
    const log = (msg) => {
      appendRotatingLog('open-window.log', `[${new Date().toISOString()}] ${msg}`)
    }
    log('WC created: ' + contents.getType())
    const guardNavigation = (event, details) => {
      const url = getNavigationUrl(details)
      const isLocalShell = !!(win && !win.isDestroyed() && contents === win.webContents)
      if (isAllowedNavigation(url, {
        allowWeb: !isLocalShell,
        fileRoot: isLocalShell ? __dirname : '',
      })) return
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      log('BLOCKED navigation protocol=' + getProtocol(url) + ' type=' + contents.getType())
    }
    // setWindowOpenHandler 只覆盖 window.open；抖音也会用 location/iframe/redirect
    // 唤起 bytedance://。三类导航都拦截，避免交给 Windows 触发“查找应用”弹框。
    contents.on('will-navigate', guardNavigation)
    contents.on('will-frame-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.setWindowOpenHandler(({ url }) => {
      log('HANDLER url=' + url + ' part=' + (loginPartition || '-'))
      // 非 http/https 协议（bitbrowser:// 等自定义协议）直接拦截，避免 Windows 弹"打开应用"提示
      if (url && !/^https?:\/\//i.test(url)) {
        return { action: 'deny' }
      }
      // 登录弹窗期间：放行抖音域名（登录授权回调需要）；其余一律拦截成内置标签页
      if (loginPartition && isAllowedDouyinWebUrl(url)) {
        try {
          const s = contents.session
          if (s && s.getPartition && s.getPartition() === loginPartition) {
            return { action: 'allow' }
          }
        } catch (err) {}
      }
      try {
        if (win && !win.isDestroyed()) {
          win.webContents.send('guest-open-tab', url)
        }
      } catch (err) {
        log('SEND ERR ' + String(err && err.message || err))
      }
      return { action: 'deny' }
    })
  } catch (err) {
    try {
      appendRotatingLog('open-window.log', `[${new Date().toISOString()}] SETUP ERR ${String(err && err.message || err)}`)
    } catch (e2) {}
  }
})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)

  let vcat
  ipcMain.handle('getCall', async (e, name, ...args) => {
    assertTrustedIpc(e)
    const result = await Promise.resolve(vcat._getCall(name, ...args))
    if (name !== 'Runtime.getStatus') return result
    const supervisor = runtimeSupervisor ? runtimeSupervisor.getStatus() : { blocking: false, lastError: '', lastCheckedAt: '' }
    return {
      ...(result || {}),
      blocking: !!supervisor.blocking,
      supervisorError: supervisor.lastError || '',
      supervisorCheckedAt: supervisor.lastCheckedAt || '',
    }
  })
  ipcMain.handle('getValue', (e, d) => { assertTrustedIpc(e); return vcat._getValue(d) })
  ipcMain.handle('addListenter', (e, d) => { assertTrustedIpc(e); return vcat._addListener(d, (ev) => {
    if (win && !win.isDestroyed()) win.webContents.send(ev.eventId, ev)
  }) })
  ipcMain.handle('removeListener', (e, d) => { assertTrustedIpc(e); return vcat._removeListener(d) })
  ipcMain.handle('isReady', (e) => { assertTrustedIpc(e); return true })
  ipcMain.handle('showDevtools', (e) => { assertTrustedIpc(e); return win.webContents.openDevTools() })
  ipcMain.handle('openExternalUrl', async (e, value) => {
    assertTrustedIpc(e)
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:') throw new Error('只允许打开 HTTPS 公开页面')
    await shell.openExternal(url.href)
    return true
  })
  ipcMain.on('bridgeLog', (e, msg) => {
    try { assertTrustedIpc(e); appendRotatingLog('bridge.log', msg) } catch (error) {}
  })

  vcat = require('./server/server.js')
  vcat.setRoot(path.resolve(__dirname))
  vcat.isDev = true
  vcat.manifest = JSON.parse(fs.readFileSync(path.join(__dirname, './package.json'), 'utf-8'))
  // 后台最小初始化完成后再显示窗口，避免 Windows 把尚不能处理消息的可见窗口
  // 标成“未响应”；账号 IPC 此时也已经可用，不会首屏误显示为空。
  win = createWindow()

  runtimeSupervisor = new RuntimeSupervisor({
    powerSaveBlocker,
    getState: () => Promise.resolve(vcat._getCall('Runtime.getStatus')),
    log: (message) => appendRotatingLog('runtime.log', `[${new Date().toISOString()}] ${message}`),
  })
  runtimeSupervisor.start()
  const stableTimer = setTimeout(() => clearPersistentCrashHistory(fatalCrashHistoryFile), 10 * 60 * 1000)
  if (stableTimer.unref) stableTimer.unref()
})

let fatalRestarting = false
process.on('uncaughtException', (error) => {
  appendRotatingLog('runtime.log', `[${new Date().toISOString()}] uncaughtException ${error && error.stack || error}`)
  if (fatalRestarting) return
  fatalRestarting = true
  appQuitting = true
  try { if (runtimeSupervisor) runtimeSupervisor.close() } catch (closeError) {}
  let recovery = { allowed: false, count: 0 }
  try { recovery = recordPersistentCrash(fatalCrashHistoryFile, { windowMs: 10 * 60 * 1000, maxRestarts: 3 }) } catch (historyError) {}
  if (recovery.allowed) {
    try { app.relaunch() } catch (relaunchError) {}
    app.exit(1)
  } else {
    appendRotatingLog('runtime.log', `[${new Date().toISOString()}] fatal recovery stopped after ${recovery.count} crashes`)
    // 退出码 0 可阻止外部计划任务在持续故障时无限重启。
    app.exit(0)
  }
})
process.on('unhandledRejection', (error) => {
  appendRotatingLog('runtime.log', `[${new Date().toISOString()}] unhandledRejection ${error && error.stack || error}`)
})

app.on('before-quit', () => {
  appQuitting = true
  if (runtimeSupervisor) runtimeSupervisor.close()
})

app.on('window-all-closed', () => {
  app.quit()
})
