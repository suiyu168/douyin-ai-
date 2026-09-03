/**
 * 小V猫免费版 - 本地后端模块
 *
 * 取代原版 resources/app/server/server.jsc（宝特云 bytenode 字节码）。
 * 本模块向前端提供同样的接口（_getCall / _getValue / _addListener / _removeListener），
 * 恒定返回"已登录 + 永久 VIP"，因此软件免登录、免会员直接使用全部功能。
 *
 * 额外实现了账号登录监听（listenSession）：轮询 webview 分区 cookie，
 * 检测到平台登录后自动提取 cookie 并通知前端保存账号。
 *
 * 后续接入自建后端时，只需把各方法的返回值换成真实接口数据即可。
 */
const { app, session, safeStorage, Notification, net } = require('electron')
const PLATFORM_LIST = [
  { platKey: 'Douyin', title: '抖音', platIcon: '', loginPage: 'https://creator.douyin.com/', homePage: 'https://creator.douyin.com/' },
]

// 平台发布能力标记：选账号弹窗按 canPostPic / canPostVideo 过滤可用平台
PLATFORM_LIST.forEach((p) => {
  if (p.canPostPic === undefined) p.canPostPic = true
  if (p.canPostVideo === undefined) p.canPostVideo = true
})

/* ===== 抖音音乐搜索（真实接口版，2026-08 逆向自原版 server.jsc） =====
 * 原版链路（全部只需账号 cookie，无需 a_bogus/msToken）：
 *   分类：GET creator.douyin.com/web/api/media/music/category
 *   列表：GET creator.douyin.com/web/api/media/music/list?type=category&category_id=xx&offset=n
 *   搜索：① GET creator.douyin.com/web/api/media/aweme/search/post/auth → signature
 *         ② GET tsearch.amemv.com/openapi/aweme/v1/music/search/?keyword=..&count=20&cursor=n&type=1&aid=6383&device_platform=webapp
 *            带 header agw-auth: <signature>
 * 前端期望返回 {songs:[{id_str,title,author,duration,cover,play_url}], hasMore} 或 categories。 */

const { BrowserWindow } = require('electron')

function findCreatorWebContents(partition) {
  const all = require('electron').webContents.getAllWebContents()
  let target = null
  try { target = session.fromPartition(partition) } catch (e) { return null }
  const list = all.filter((wc) => {
    try { return !wc.isDestroyed() && wc.session === target } catch (e) { return false }
  })
  const dom = /^https?:\/\/(www\.)?creator\.douyin\.com/i
  return list.find((wc) => { try { return dom.test(wc.getURL()) } catch (e) { return false } }) || list.find((wc) => { try { return /^https?:\/\/(www\.)?douyin\.com/i.test(wc.getURL()) } catch (e) { return false } }) || null
}

async function douyinMusicFetch(partition, url, headers) {
  let wc = findCreatorWebContents(partition)
  let ownWin = null
  if (!wc) {
    try {
      ownWin = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { partition: partition } })
      await ownWin.loadURL('https://creator.douyin.com/creator-micro/home')
      wc = ownWin.webContents
    } catch (e) {
      return { status: 0, json: null, text: 'WINDOW_ERR: ' + String(e && e.message || e) }
    }
  }
  try {
    const opts = { method: 'GET', credentials: 'include' }
    if (headers && Object.keys(headers).length) opts.headers = headers
    const js = '(async function(){ try { const r = await fetch(' + JSON.stringify(url) + ', ' + JSON.stringify(opts) + '); const t = await r.text(); return { status: r.status, text: t }; } catch (e) { return { error: String(e && e.message || e) }; } })()'
    const data = await wc.executeJavaScript(js)
    if (data && data.error) return { status: 0, json: null, text: 'PAGE_FETCH_ERR: ' + data.error }
    let json = null
    try { json = JSON.parse(data.text) } catch (e) {}
    return { status: data.status, json: json, text: data.text }
  } catch (e) {
    return { status: 0, json: null, text: 'EXEC_ERR: ' + String(e && e.message || e) }
  } finally {
    if (ownWin) setTimeout(() => { try { ownWin.destroy() } catch (e) {} }, 2000)
  }
}

function mapListSong(s) {
  return {
    id_str: String(s.music_id),
    title: s.music_name,
    author: s.music_author,
    duration: s.duration,
    cover: s.cover_url,
    play_url: s.play_url,
  }
}

function mapSearchSong(m) {
  return {
    id_str: String(m.id_str || m.id),
    title: m.title,
    author: m.author,
    duration: m.duration,
    cover: m.cover_hd && m.cover_hd.url_list ? m.cover_hd.url_list[0] : '',
    play_url: m.play_url && m.play_url.url_list ? m.play_url.url_list[0] : '',
  }
}

async function getDouyinMusicReal(account, method, payload) {
  const partition = account && account.partition
  if (!partition) return { ok: false, error: 'NO_PARTITION' }
  try {
    if (/getMusicCategory/i.test(method)) {
      const r = await douyinMusicFetch(partition, 'https://creator.douyin.com/web/api/media/music/category')
      const list = (r.json && r.json.categories) || []
      return { ok: true, categories: list.map((c) => ({ category_id: String(c.category_id), category_name: c.category_name, type: c.type })) }
    }
    if (/getsongList/i.test(method)) {
      const cat = (payload && payload.category) || {}
      const offset = (payload && payload.offset) || 0
      const url = 'https://creator.douyin.com/web/api/media/music/list?type=' + encodeURIComponent(cat.type || 'category') +
        '&category_id=' + encodeURIComponent(cat.category_id || '') + '&offset=' + offset
      const r = await douyinMusicFetch(partition, url)
      const songs = (r.json && r.json.songs) || []
      return { ok: true, songs: songs.map(mapListSong), hasMore: !!(r.json && r.json.has_more) }
    }
    if (/searchMusic/i.test(method)) {
      const keyword = (payload && payload.keyword) || ''
      if (!keyword) return { ok: true, songs: [], hasMore: false }
      const auth = await douyinMusicFetch(partition, 'https://creator.douyin.com/web/api/media/aweme/search/post/auth')
      const sig = auth.json && auth.json.signature
      if (!sig) return { ok: false, error: 'NO_AGW_AUTH', detail: (auth.text || '').slice(0, 200) }
      const cursor = (payload && payload.offset) || 0
      const url = 'https://tsearch.amemv.com/openapi/aweme/v1/music/search/?keyword=' + encodeURIComponent(keyword) +
        '&count=20&cursor=' + cursor + '&type=1&aid=6383&device_platform=webapp'
      const r = await douyinMusicFetch(partition, url, { 'agw-auth': sig })
      const songs = (r.json && r.json.music) || []
      return { ok: true, songs: songs.map(mapSearchSong), hasMore: !!(r.json && r.json.has_more) }
    }
    return { ok: false, error: 'UNKNOWN_METHOD' }
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', msg: String(e && e.message || e) }
  }
}

function getWorkerMusicResult(account, method, payload) {
  return Promise.resolve(getDouyinMusicReal(account, method, payload))
}

let musicWinCache = null


const VIP_USER = {
  is_vip: true,
  isLogin: true,
  is_login: true,
  isOfficial: true,
  isMainUser: true,
  isSubUser: false,
  expire_at: '2099-12-31 23:59:59',
  user_id: 10001,
  uid: 10001,
  id: 10001,
  token: 'free-edition',
  nickname: '从前有座山',
  avatar: '',
  ctime: Date.now() / 1000,
  member_type: 'vip',
}

/* ===== 账号本地存储（原 server.jsc 的数据库逻辑） ===== */

const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('node:crypto')
const { spawn } = require('child_process')
const { LeadRadar } = require('./lead-radar')
const { LocalOcr } = require('./ocr')
const { GovernmentCollector, DEFAULT_ACTIVE_SOURCES } = require('./government-collector')
const { DouyinPublicCollector } = require('./douyin-public-collector')
const { PublishTaskStore } = require('./publish-task-store')
const { ExclusiveActivityCoordinator } = require('./activity-coordinator')
const { recoverInterruptedPublishing, decidePublishAccountHealth, settleUnexpectedPublishError } = require('./publish-safety')
const { DatabaseMaintenance } = require('./database-maintenance')

// 商机雷达使用独立 SQLite 数据库，默认保存在 D:\小V猫数据\商机雷达。
// 只暴露下方白名单方法，避免把数据库对象直接交给渲染进程。
const localOcr = new LocalOcr()
const leadRadar = new LeadRadar({
  ocr: localOcr,
  encryptText(value) {
    const text = String(value || '')
    if (!text) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储暂不可用，已停止保存敏感线索')
    return 'dpapi:' + safeStorage.encryptString(text).toString('base64')
  },
  decryptText(value) {
    const text = String(value || '')
    if (!text) return ''
    if (!text.startsWith('dpapi:')) return text // 兼容首版测试数据迁移
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储暂不可用，无法读取联系方式')
    return safeStorage.decryptString(Buffer.from(text.slice(6), 'base64'))
  },
})
const governmentCollector = new GovernmentCollector({
  leadRadar,
  sources: DEFAULT_ACTIVE_SOURCES,
  // 使用 Chromium 网络栈读取部分 Windows/Node TLS 不兼容的省级政府站点。
  fetchImpl: (url, options) => net.fetch(url, options),
  maxDetailsPerRun: 400,
  // 公共站点采用保守低频读取，降低给来源站造成压力和触发频控的概率。
  requestDelayMs: 3000,
})
let douyinPublicCollector = null
const douyinActivity = new ExclusiveActivityCoordinator()
governmentCollector.start()
app.once('before-quit', () => {
  governmentCollector.close()
  if (douyinPublicCollector) douyinPublicCollector.close()
  leadRadar.close()
  localOcr.close()
})

function getDouyinPublicCollector() {
  if (!douyinPublicCollector) {
    douyinPublicCollector = new DouyinPublicCollector({
      leadRadar,
      BrowserWindow,
      getAccounts: loadAccounts,
      isPublishing: () => publishBusy,
      acquireActivity: () => douyinActivity.acquire('collector'),
      releaseActivity: (token) => douyinActivity.release(token),
      async checkAccount(account, context = {}) {
        return checkDouyinAccountHealth(account, { activityHeld: !!context.activityHeld })
      },
      notify(alert) {
        if (!Notification || !Notification.isSupported()) return
        const notification = new Notification({
          title: alert.kind === 'login_expired' ? '抖音账号登录失效'
            : alert.kind === 'rate_limited' ? '抖音账号已自动限流' : '抖音账号触发风控',
          body: alert.message,
          urgency: 'critical',
        })
        notification.on('click', () => {
          const target = BrowserWindow.getAllWindows().find((item) => item.isVisible() && !item.isDestroyed())
          if (target) { target.show(); target.focus() }
        })
        notification.show()
      },
    })
    douyinPublicCollector.start()
  }
  return douyinPublicCollector
}

function exportAllBusinessData() {
  const collector = getDouyinPublicCollector()
  const decrypt = (value) => {
    try { return leadRadar.decryptText(value) } catch (error) { return '' }
  }
  const leads = leadRadar.db.prepare('SELECT * FROM leads ORDER BY updated_at DESC, id DESC').all().map((row) => ({
    id: Number(row.id), platform: row.platform, industry: row.industry, account_name: row.account_name,
    douyin_id: row.douyin_id, profile_url: row.profile_url, region: row.region,
    source_type: row.source_type, source_url: row.source_url,
    contact: decrypt(row.contact_normalized), contact_raw: decrypt(row.contact_raw), contact_type: row.contact_type,
    source_text: decrypt(row.source_text), evidence: row.evidence, public_business: Number(row.public_business),
    score: Number(row.score), status: row.status, assignee: row.assignee, notes: row.notes,
    opt_out: Number(row.opt_out), source_count: Number(row.source_count), created_at: row.created_at, updated_at: row.updated_at,
  }))
  const projects = governmentCollector.db.prepare('SELECT * FROM collector_items ORDER BY updated_at DESC, id DESC').all()
  const leadSources = leadRadar.db.prepare(`SELECT id, lead_id, platform, industry, account_name, profile_url, region,
    source_type, source_url, source_text, evidence, occurrences, first_seen_at, last_seen_at
    FROM lead_sources ORDER BY last_seen_at DESC, id DESC`).all().map((row) => ({
      ...row, source_text: decrypt(row.source_text),
    }))
  const processedProfiles = collector.stateDb.prepare('SELECT profile_url, industry, query, processed_at FROM processed_profiles ORDER BY processed_at DESC').all()
  const processedProfileRoles = collector.stateDb.prepare(`SELECT profile_url, profile_role, industry, query, processed_at
    FROM processed_profile_roles ORDER BY processed_at DESC`).all()
  const processedVideos = collector.stateDb.prepare(`SELECT aweme_id, query, industry, processed_at,
    next_check_at, last_comment_time, scan_count FROM processed_videos ORDER BY processed_at DESC`).all()
  const processedComments = collector.stateDb.prepare(`SELECT comment_key, comment_id, aweme_id, comment_time,
    profile_url, processed_at FROM processed_comments ORDER BY processed_at DESC`).all()
  const engagementCandidates = collector.stateDb.prepare('SELECT * FROM engagement_candidates ORDER BY detected_at DESC, id DESC').all()
  const engagementActionLogs = collector.stateDb.prepare('SELECT * FROM engagement_action_logs ORDER BY id DESC').all()
  const events = leadRadar.db.prepare('SELECT id, lead_id, event_type, details, created_at FROM lead_events ORDER BY created_at DESC, id DESC').all()
  const exportDir = path.join(leadRadar.dataDir, '导出')
  fs.mkdirSync(exportDir, { recursive: true })
  const outputPath = path.join(exportDir, '全部商机资料-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json')
  fs.writeFileSync(outputPath, JSON.stringify({ exportedAt: new Date().toISOString(), leads, leadSources, projects,
    processedProfiles, processedProfileRoles, processedVideos, processedComments, engagementCandidates, engagementActionLogs, events }), 'utf8')
  return { path: outputPath, leads: leads.length, leadSources: leadSources.length, projects: projects.length,
    processedProfiles: processedProfiles.length, processedProfileRoles: processedProfileRoles.length,
    processedVideos: processedVideos.length, processedComments: processedComments.length,
    engagementCandidates: engagementCandidates.length, engagementActionLogs: engagementActionLogs.length, events: events.length }
}

// 本地一次性导出请求：只接受数据目录内的固定标记，完成后立即删除。
const EXPORT_ALL_REQUEST_FILE = path.join(leadRadar.dataDir, '导出', '.export-all-request')
setTimeout(() => {
  if (!fs.existsSync(EXPORT_ALL_REQUEST_FILE)) return
  try { exportAllBusinessData() } finally { try { fs.rmSync(EXPORT_ALL_REQUEST_FILE, { force: true }) } catch (error) {} }
}, 3000)

// 即使用户没有先打开“商机雷达”页，也在软件启动后建立持续增量采集计划；隔离测试可显式关闭。
// 初始化涉及旧库迁移或磁盘瞬时占用时采用有限退避重试，避免一次异常后整晚都没有采集器。
function initializeDouyinCollectorWithRetry(attempt = 0) {
  try {
    getDouyinPublicCollector()
  } catch (error) {
    if (attempt >= 4) {
      console.error('[DouyinCollector] 初始化失败，已停止自动重试：', error)
      return
    }
    const delayMs = Math.min(60000, 5000 * (2 ** attempt))
    setTimeout(() => initializeDouyinCollectorWithRetry(attempt + 1), delayMs)
  }
}
if (process.env.VCAT_DISABLE_DOUYIN_COLLECTOR !== '1') {
  setTimeout(() => initializeDouyinCollectorWithRetry(), 20000)
}

const STATE_DIR = path.join(process.env.VCAT_APP_DATA_DIR || app.getPath('userData'), 'state')
fs.mkdirSync(STATE_DIR, { recursive: true })
const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.secure.json')
const LEGACY_ACCOUNTS_FILE = path.join(__dirname, 'accounts.json')
const LOCAL_CONFIG_FILE = path.join(STATE_DIR, 'localconfig.json')
const LEGACY_LOCAL_CONFIG_FILE = path.join(__dirname, 'localconfig.json')
const DEFAULT_AVATAR = ''

function readJsonWithBackup(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch (primaryError) {
    const backupPath = filePath + '.bak'
    if (!fs.existsSync(backupPath)) throw primaryError
    return JSON.parse(fs.readFileSync(backupPath, 'utf8'))
  }
}

function writeJsonSafely(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`
  const backupPath = filePath + '.bak'
  const serialized = JSON.stringify(value, null, 2)
  fs.writeFileSync(tempPath, serialized, 'utf8')
  const handle = fs.openSync(tempPath, 'r')
  try {
    try { fs.fsyncSync(handle) } catch (error) {
      // 个别 Windows 文件系统/安全层拒绝对普通文件显式 fsync；文件已写完且后续还有解析校验。
      if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(String(error && error.code || ''))) throw error
    }
  } finally { fs.closeSync(handle) }
  if (fs.existsSync(filePath)) {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf8'))
      fs.copyFileSync(filePath, backupPath)
    } catch (error) {}
  }
  try {
    fs.renameSync(tempPath, filePath)
  } catch (renameError) {
    // Windows 的安全软件或索引器可能短暂占用目标文件；有限重试，不让账号状态悄悄滞留在 .tmp。
    let writeError = renameError
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.copyFileSync(tempPath, filePath)
        fs.rmSync(tempPath, { force: true })
        writeError = null
        break
      } catch (error) {
        writeError = error
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(String(error && error.code || '')) || attempt === 5) break
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
      }
    }
    if (writeError) throw writeError
  }
  // 落盘后立即解析校验；失败时保留 .bak 和临时文件，供人工恢复而不是假报成功。
  JSON.parse(fs.readFileSync(filePath, 'utf8'))
  // 清理旧版本或异常退出留下的同名临时文件；只有正式文件已成功落盘后才执行。
  const tempPrefix = path.basename(filePath) + '.tmp-'
  try {
    for (const entry of fs.readdirSync(path.dirname(filePath), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(tempPrefix)) continue
      const stalePath = path.join(path.dirname(filePath), entry.name)
      if (stalePath !== tempPath) fs.rmSync(stalePath, { force: true })
    }
  } catch (error) {}
}

/* ---------- LocalConfig 持久化（前端 c9 配置钩子的数据源） ---------- */

let localConfig = null
function loadLocalConfig() {
  if (localConfig) return localConfig
  try {
    const source = fs.existsSync(LOCAL_CONFIG_FILE) ? LOCAL_CONFIG_FILE : LEGACY_LOCAL_CONFIG_FILE
    localConfig = readJsonWithBackup(source)
    if (source === LEGACY_LOCAL_CONFIG_FILE) saveLocalConfig()
  } catch (e) {
    localConfig = {}
  }
  if (!localConfig || typeof localConfig !== 'object') localConfig = {}
  return localConfig
}
function saveLocalConfig() {
  writeJsonSafely(LOCAL_CONFIG_FILE, localConfig)
  return true
}

/* ---------- Camoufox 防关联浏览器集成（推荐方案） ---------- */

const { spawnSync } = require('child_process')

let camoCache = { at: 0, res: null }

function findCamoufoxCliInPath() {
  try {
    const r = spawnSync('where.exe', ['camoufox-cli'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.split(/\r?\n/).filter(Boolean)
      const hit =
        lines.find((l) => /\.cmd$/i.test(l)) ||
        lines.find((l) => /\.exe$/i.test(l)) ||
        lines.find((l) => /\.bat$/i.test(l)) ||
        lines[0]
      if (hit && fs.existsSync(hit)) return hit
    }
  } catch (e) {}
  return null
}

function detectCamoufox() {
  const now = Date.now()
  if (camoCache.res && now - camoCache.at < 30000) return camoCache.res
  const cfg = loadLocalConfig()
  let cli = cfg.camoufoxCliPath
  if (cli && !fs.existsSync(cli)) cli = null
  if (!cli) {
    const cands = []
    if (process.env.APPDATA) {
      cands.push(path.join(process.env.APPDATA, 'npm', 'camoufox-cli.cmd'))
      cands.push(path.join(process.env.APPDATA, 'npm', 'camoufox-cli'))
    }
    if (process.env.LOCALAPPDATA) {
      cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'camoufox-cli', 'camoufox-cli.exe'))
      cands.push(path.join(process.env.LOCALAPPDATA, 'camoufox-cli', 'camoufox-cli.exe'))
    }
    const inPath = findCamoufoxCliInPath()
    if (inPath) cands.push(inPath)
    for (const c of cands) {
      if (c && fs.existsSync(c)) {
        cli = c
        break
      }
    }
  }
  if (!cli) cli = 'camoufox-cli'
  let res = {
    key: 'camoufox',
    type: 'camoufox',
    name: 'Camoufox 指纹浏览器',
    exists: false,
    executablePath: cli,
    missingMessage:
      '未检测到 Camoufox 指纹浏览器。安装方法：\n1) 安装 Node.js 后运行：npm install -g camoufox-cli\n2) 下载浏览器内核：camoufox-cli install\n（也可在 server/localconfig.json 中设置 "camoufoxCliPath": "你的camoufox-cli路径"）',
    launchingMessage: '正在启动 Camoufox 指纹浏览器...',
  }
  try {
    const r = spawnSync(cli, ['--version'], {
      encoding: 'utf8',
      timeout: 6000,
      shell: /\.cmd$|\.bat$/i.test(cli),
      windowsHide: true,
    })
    if (r.status === 0 && (r.stdout || '').trim()) {
      res = Object.assign({}, res, {
        exists: true,
        version: (r.stdout || '').trim().slice(0, 80),
      })
    }
  } catch (e) {}
  camoCache = { at: now, res }
  return res
}

function runCamoufoxCli(cliPath, args, timeoutMs) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(cliPath, args, {
        shell: /\.cmd$|\.bat$/i.test(cliPath),
        windowsHide: true,
      })
    } catch (e) {
      return resolve({ error: e.message })
    }
    let out = ''
    let err = ''
    const t = setTimeout(() => {
      try { proc.kill() } catch (e) {}
      resolve({ timeout: true, out, err })
    }, timeoutMs || 60000)
    proc.stdout.on('data', (d) => (out += String(d)))
    proc.stderr.on('data', (d) => (err += String(d)))
    proc.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out, err })
    })
    proc.on('error', (e) => {
      clearTimeout(t)
      resolve({ error: e.message })
    })
  })
}

function buildCamoufoxCookieFile(account, targetUrl) {
  const profileDir = path.join(app.getPath('userData'), 'camoufox-cookie-import')
  try {
    fs.mkdirSync(profileDir, { recursive: true })
  } catch (e) {}
  const uid = String((account && (account.uid || account.id)) || 'default').replace(/[^\w.-]/g, '_')
  const file = path.join(profileDir, uid + '-cookies.json')
  let cookies = (account && account.cookies) || null
  if (!cookies || !cookies.length) {
    let domain = ''
    try {
      domain = new URL(targetUrl).hostname
    } catch (e) {}
    cookies = parseCookieString(account && account.cookieData).map((c) => ({
      name: c.name,
      value: c.value,
      domain: domain,
      path: '/',
    }))
  }
  if (!cookies.length) return null
  const out = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: String(c.domain || '').replace(/^\./, ''),
    path: c.path || '/',
    expires: c.expires,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || 'Lax',
  }))
  try {
    fs.writeFileSync(file, JSON.stringify(out, null, 2))
    return file
  } catch (e) {
    return null
  }
}

async function openAccountInCamoufox(account, url, proxy) {
  const det = detectCamoufox()
  if (!det.exists) {
    return { success: false, message: det.missingMessage || '未检测到 Camoufox' }
  }
  const uid = String((account && (account.uid || account.id)) || 'default').replace(/[^\w.-]/g, '_')
  const profilePath = path.join(app.getPath('userData'), 'camoufox-profiles', uid)
  const platform = (account && account.platform) || ''
  const platInfo = PLATFORM_LIST.find((p) => p.platKey === platform) || {}
  const targetUrl =
    (typeof url === 'string' && url.indexOf('http') === 0 && url) ||
    platInfo.homePage ||
    platInfo.loginPage ||
    'https://creator.douyin.com/'

  const base = ['--session', uid, '--persistent', profilePath, '--headed']
  if (proxy && proxy.host && proxy.port) {
    const proto = proxy.scheme || proxy.protocol || 'http'
    const auth = proxy.username || proxy.password ? `${proxy.username || ''}:${proxy.password || ''}@` : ''
    base.push('--proxy', `${proto}://${auth}${proxy.host}:${proxy.port}`)
  }

  const r1 = await runCamoufoxCli(det.executablePath, base.concat(['open', targetUrl]), 120000)
  if (r1.error || r1.timeout) {
    return { success: false, message: 'Camoufox 启动失败: ' + (r1.error || '超时') + ' ' + (r1.err || '').slice(0, 200) }
  }
  const cookieFile = buildCamoufoxCookieFile(account, targetUrl)
  if (cookieFile) {
    try {
      await runCamoufoxCli(det.executablePath, base.concat(['cookies', 'import', cookieFile]), 30000)
      await runCamoufoxCli(det.executablePath, base.concat(['open', targetUrl]), 30000)
    } finally {
      // 导入文件包含登录 Cookie，只允许短暂存在。
      try { fs.rmSync(cookieFile, { force: true }) } catch (e) {}
    }
  }
  return { success: true, message: '已在 Camoufox 指纹浏览器中打开账号环境（cookie 已注入）' }
}

function detectExternalBrowser() {
  return detectCamoufox()
}

function parseCookieString(cookieData) {
  const out = []
  if (!cookieData) return out
  for (const pair of String(cookieData).split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name) out.push({ name, value })
  }
  return out
}

function cdpGetJson(port, apiPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: apiPath, timeout: 3000 }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(d))
        } catch (e) {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { try { req.destroy() } catch (e) {} resolve(null) })
  })
}

let accountStore = null

function encryptAccountSecret(value) {
  if (value === undefined || value === null || value === '') return ''
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储暂不可用，账号登录凭证未保存')
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return 'dpapi:' + safeStorage.encryptString(text).toString('base64')
}

function decryptAccountSecret(value, json) {
  const text = String(value || '')
  if (!text) return json ? [] : ''
  if (!text.startsWith('dpapi:')) return json ? JSON.parse(text) : text
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储暂不可用，无法读取账号登录凭证')
  const plain = safeStorage.decryptString(Buffer.from(text.slice(6), 'base64'))
  return json ? JSON.parse(plain) : plain
}

function accountFromDisk(account) {
  const out = Object.assign({}, account || {})
  if (out.cookieData_enc) out.cookieData = decryptAccountSecret(out.cookieData_enc, false)
  if (out.cookies_enc) out.cookies = decryptAccountSecret(out.cookies_enc, true)
  delete out.cookieData_enc
  delete out.cookies_enc
  return out
}

function accountForDisk(account) {
  const out = Object.assign({}, account || {})
  if (out.cookieData) out.cookieData_enc = encryptAccountSecret(out.cookieData)
  if (out.cookies && out.cookies.length) out.cookies_enc = encryptAccountSecret(out.cookies)
  delete out.cookieData
  delete out.cookies
  return out
}

function loadAccounts() {
  if (accountStore) return accountStore
  let source = ACCOUNTS_FILE
  try {
    if (!fs.existsSync(source) && fs.existsSync(LEGACY_ACCOUNTS_FILE)) source = LEGACY_ACCOUNTS_FILE
    const diskAccounts = readJsonWithBackup(source)
    const accountList = Array.isArray(diskAccounts) ? diskAccounts : []
    accountStore = accountList.map((item) => {
      try { return accountFromDisk(item) } catch (error) {
        const safe = Object.assign({}, item, { isLogin: false, status: 0, credentialError: true })
        delete safe.cookieData_enc
        delete safe.cookies_enc
        return safe
      }
    })
    const containsPlaintext = accountList.some((item) => item && (item.cookieData || item.cookies))
    if ((source === LEGACY_ACCOUNTS_FILE || containsPlaintext) && saveAccounts()) {
      // 迁移成功后清除旧文件里的明文 Cookie，但保留可读迁移说明。
      if (source === LEGACY_ACCOUNTS_FILE) {
        fs.writeFileSync(LEGACY_ACCOUNTS_FILE, JSON.stringify({ migrated: true, secureFile: ACCOUNTS_FILE, migratedAt: new Date().toISOString() }, null, 2))
      }
    }
  } catch (e) {
    const noAccountFile = String(e && e.code || '') === 'ENOENT'
      && !fs.existsSync(ACCOUNTS_FILE) && !fs.existsSync(LEGACY_ACCOUNTS_FILE)
    if (noAccountFile) accountStore = []
    else {
      // 加密存储或文件被安全软件短暂占用时，不把一次读取失败永久缓存成“无账号”。
      // 页面会自动重试；已有账号元数据和 Cookie 文件保持原样。
      try {
        fs.appendFileSync(path.join(STATE_DIR, 'accounts-store-errors.log'),
          `[${new Date().toISOString()}] load ${String(e && e.code || 'ERROR')} ${String(e && e.message || e).slice(0, 500)}\n`, 'utf8')
      } catch (writeError) {}
      return []
    }
  }
  if (!Array.isArray(accountStore)) accountStore = []
  return accountStore
}
function saveAccounts() {
  try {
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true })
    const diskAccounts = (accountStore || []).map(accountForDisk)
    writeJsonSafely(ACCOUNTS_FILE, diskAccounts)
    return true
  } catch (e) {
    try {
      fs.appendFileSync(path.join(STATE_DIR, 'accounts-store-errors.log'),
        `[${new Date().toISOString()}] ${String(e && e.code || 'ERROR')} ${String(e && e.message || e).slice(0, 500)}\n`, 'utf8')
    } catch (writeError) {}
    return false
  }
}
function normalizeAccount(a) {
  if (!a) return a
  const out = {}
  const keep = ['uid', 'platform', 'nickname', 'avatar', 'remark', 'group_id', 'proxy_id', 'partition', 'cookieData', 'cookies', 'isLogin', 'status', 'add_time', 'sub_name',
    'healthState', 'healthCheckedAt', 'healthReason', 'lastOnlineAt', 'lastOfflineAt']
  for (const k of keep) {
    if (a[k] !== undefined && a[k] !== null) out[k] = a[k]
  }
  if (out.uid === undefined && a.id !== undefined) out.uid = a.id
  if (out.platform === undefined) out.platform = ''
  if (out.isLogin === undefined) out.isLogin = true
  if (out.status === undefined) out.status = 1
  if (out.group_id === undefined) out.group_id = 0
  if (out.proxy_id === undefined) out.proxy_id = 0
  if (out.add_time === undefined) out.add_time = Math.floor(Date.now() / 1000)
  if (out.accountInfo === undefined || typeof out.accountInfo !== 'object') {
    out.accountInfo = {
      with_commerce_entry: false,
      with_fusion_shop_entry: false,
      is_creator: false,
      is_star: false,
      star_grade: 0,
    }
  }
  return out
}

function accountForRenderer(account) {
  const out = normalizeAccount(Object.assign({}, account || {}))
  delete out.cookieData
  delete out.cookies
  return out
}

/* ===== 账号登录监听（替代原 server.jsc 的 cookie 提取逻辑） ===== */

const webviewListeners = new Map() // partition -> { id, cb }
const sessionPolls = new Map() // partition -> { timer, emittedUids, accountUid }

function cookieMapOf(cookies) {
  const m = {}
  for (const c of cookies) {
    if (!m[c.name]) m[c.name] = c.value
  }
  return m
}

function cookieStringOf(cookies) {
  const parts = []
  for (const c of cookies) {
    if (parts.length > 300) break
    parts.push(c.name + '=' + c.value)
  }
  return parts.join('; ')
}

function detectLogin(platform, map) {
  if (platform === 'Douyin') {
    if (map['sessionid'] || map['sessionid_ss'] || map['sid_guard'] || map['sid_tt']) {
      // uid_tt 可能没有（扫码登录），这里只确认会话存在；真实 uid 由页面接口获取。
      return map['uid_tt'] || 'douyin-session-detected'
    }
  } else if (platform === 'XiaoHongShu' || platform === 'Rednote') {
    if (map['web_session']) {
      return map['user_id'] || map['web_session'].slice(0, 24)
    }
  } else if (platform === 'KuaiShou') {
    if (map['kuaishou.server.web_st'] || map['passToken']) {
      return map['userId'] || map['kuaishou.server.st'] || 'kuaishou-' + Date.now()
    }
  } else if (platform === 'Channels') {
    if (map['wxsid'] || map['sessionid'] || map['wc_sessionid']) {
      return map['wxuin'] || map['wxsid'] || 'channels-' + Date.now()
    }
  } else if (platform === 'GongZhongHao') {
    if (map['appmsg_token'] || map['slave_sid']) {
      return map['slave_uin'] || map['appmsg_token'].slice(0, 24)
    }
  } else if (platform === 'Bili') {
    if (map['SESSDATA'] || map['bili_jct']) {
      return map['DedeUserID'] || map['SESSDATA'].slice(0, 24)
    }
  } else {
    const hit = Object.keys(map).find((k) => /session|sid|token|login/i.test(k))
    if (hit) {
      return map['uid'] || map['user_id'] || hit + '-detected'
    }
  }
  return null
}

/* 通过账号页面接口获取抖音真实 uid（内部数字 ID，稳定） */
/* 登录态检测：用账号分区加载抖音页面，fetch userInfo 判断是否登录 */
async function checkAccountLogin(account) {
  const partition = account && account.partition
  const checkedAt = Date.now()
  if (!partition) return { login: false, state: 'offline', definitive: true, reason: 'NO_PARTITION', checkedAt }
  try {
    const cookies = await session.fromPartition(partition).cookies.get({})
    const names = new Set(cookies.map((c) => c.name))
    const hasCredential = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'd_ticket', 'passport_auth_status'].some((name) => names.has(name))
    if (!hasCredential) {
      return { login: false, state: 'offline', definitive: true, reason: 'NO_LOGIN_COOKIE', checkedAt }
    }
  } catch (e) {
    return { login: !!(account && account.isLogin), state: 'unknown', definitive: false, reason: 'COOKIE_READ_ERR', checkedAt }
  }
  // 只能复用同一 partition 的页面。旧逻辑会误用别的账号的音乐窗口，造成账号状态串号。
  let wc = findWebContentsByPartition(partition)
  let ownWin = null
  if (!wc) {
    try {
      ownWin = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { partition: partition } })
      await Promise.race([
        ownWin.loadURL('https://creator.douyin.com/creator-micro/home'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LOGIN_CHECK_TIMEOUT')), 25000)),
      ])
      wc = ownWin.webContents
    } catch (e) {
      if (ownWin) { try { ownWin.destroy() } catch (e2) {} }
      return { login: !!(account && account.isLogin), state: 'unknown', definitive: false, reason: 'WINDOW_ERR', checkedAt }
    }
  }
  try {
    const data = await wc.executeJavaScript(`(async function(){
      try {
        const r = await fetch('https://creator.douyin.com/web/api/media/user/info/', { headers: { 'Accept': 'application/json' } });
        let j = null; try { j = await r.json(); } catch (e) {}
        if (j && j.user && j.user.uid) return { login: true, state: 'online', definitive: true, nickname: j.user.nickname || '', uid: j.user.uid, status: r.status };
        if (r.status === 401 || /passport|login/i.test(location.href)) return { login: false, state: 'offline', definitive: true, reason: 'AUTH_REJECTED', status: r.status };
        if (r.status === 403) return { login: null, state: 'unknown', definitive: false, reason: 'AUTH_CHECK_BLOCKED', status: r.status };
        return { login: null, state: 'unknown', definitive: false, reason: 'USER_INFO_EMPTY', status: r.status };
      } catch (e) { return { login: null, state: 'unknown', definitive: false, reason: 'NETWORK_ERR', err: String(e && e.message || e).slice(0, 100) }; }
    })()`)
    return Object.assign({ login: !!(account && account.isLogin), state: 'unknown', definitive: false, checkedAt }, data || {})
  } catch (e) {
    return { login: !!(account && account.isLogin), state: 'unknown', definitive: false, reason: 'EXEC_ERR', checkedAt }
  } finally {
    if (ownWin) { try { ownWin.destroy() } catch (e) {} }
  }
}

function cookieSnapshot(cookies) {
  return (Array.isArray(cookies) ? cookies : []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || 'Lax',
    expirationDate: Number(c.expirationDate) || undefined,
  }))
}

async function refreshAccountCredentialSnapshot(account) {
  if (!account || !account.partition) return false
  try {
    const targetSession = session.fromPartition(account.partition)
    const cookies = await targetSession.cookies.get({})
    account.cookieData = cookieStringOf(cookies)
    account.cookies = cookieSnapshot(cookies)
    if (targetSession.cookies.flushStore) await targetSession.cookies.flushStore()
    return true
  } catch (error) {
    return false
  }
}

const accountRestoreAttempts = new Map()

function normalizedSameSite(value) {
  const text = String(value || '').toLowerCase().replace(/-/g, '_')
  if (['no_restriction', 'lax', 'strict', 'unspecified'].includes(text)) return text
  if (text === 'none') return 'no_restriction'
  return 'unspecified'
}

async function restoreAccountSessionFromSnapshot(account) {
  if (!account || !account.partition || !Array.isArray(account.cookies) || !account.cookies.length) return false
  const key = String(account.uid || account.partition)
  const lastAttempt = Number(accountRestoreAttempts.get(key)) || 0
  if (Date.now() - lastAttempt < 60 * 60 * 1000) return false
  const targetSession = session.fromPartition(account.partition)
  const current = await targetSession.cookies.get({}).catch(() => [])
  const names = new Set(current.map((cookie) => cookie.name))
  const hasCredential = ['sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'd_ticket', 'passport_auth_status']
    .some((name) => names.has(name))
  if (hasCredential) return false
  accountRestoreAttempts.set(key, Date.now())
  let restored = 0
  for (const cookie of account.cookies) {
    const domain = String(cookie && cookie.domain || '').replace(/^\./, '').toLowerCase()
    if (!domain || !/(^|\.)(?:douyin|iesdouyin|amemv|bytedance|snssdk)\.com$/i.test(domain)) continue
    const expirationDate = Number(cookie.expirationDate) || 0
    if (expirationDate && expirationDate <= Date.now() / 1000) continue
    const pathName = String(cookie.path || '/').startsWith('/') ? String(cookie.path || '/') : '/' + String(cookie.path || '/')
    const details = {
      url: `${cookie.secure === false ? 'http' : 'https'}://${domain}${pathName}`,
      name: String(cookie.name || ''),
      value: String(cookie.value || ''),
      domain: String(cookie.domain || domain),
      path: pathName,
      secure: cookie.secure !== false,
      httpOnly: !!cookie.httpOnly,
      sameSite: normalizedSameSite(cookie.sameSite),
    }
    if (!details.name || !details.value) continue
    if (expirationDate) details.expirationDate = expirationDate
    try { await targetSession.cookies.set(details); restored++ } catch (error) {}
  }
  if (restored && targetSession.cookies.flushStore) await targetSession.cookies.flushStore().catch(() => {})
  return restored > 0
}

async function checkDouyinAccountHealth(account, options = {}) {
  const activityToken = options.activityHeld ? null : douyinActivity.acquire('health_check')
  if (!options.activityHeld && !activityToken) {
    return { ok: false, verified: false, state: 'busy', reason: 'ACTIVITY_BUSY', busy: true,
      kind: 'account_unknown', message: '抖音账号正在采集或发布，本次健康检查已延后' }
  }
  try {
    const store = loadAccounts()
    const saved = store.find((item) => item.platform === 'Douyin' && String(item.uid) === String(account && account.uid)) || account
    try { await restoreAccountSessionFromSnapshot(saved) } catch (error) {}
    const result = await checkAccountLogin(saved)
    if (saved) {
      saved.healthState = String(result.state || 'unknown')
      saved.healthCheckedAt = Number(result.checkedAt) || Date.now()
      saved.healthReason = String(result.reason || '')
      if (result.login === true) {
        saved.isLogin = true
        saved.status = 1
        saved.lastOnlineAt = saved.healthCheckedAt
        await refreshAccountCredentialSnapshot(saved)
      } else if (result.login === false && result.definitive) {
        saved.isLogin = false
        saved.status = 0
        saved.lastOfflineAt = saved.healthCheckedAt
      }
      saveAccounts()
    }
    if (result.login === true) return { ...result, ok: true, verified: true }
    if (result.login === false && result.definitive) {
      return { ...result, ok: false, kind: 'login_expired', message: '抖音登录状态已失效，请重新登录' }
    }
    if (Number(result.status) === 403 || Number(result.status) === 429 || result.reason === 'AUTH_CHECK_BLOCKED') {
      return { ...result, ok: false, kind: 'risk_control', message: '抖音账号状态检查受到限制，已暂停该账号以避免继续触发验证' }
    }
    // 网络抖动只能标成 unknown，不能把仍有效的账号误判成掉线；发布端会延迟复检而不是直接继续。
    return { ...result, ok: true, verified: false, uncertain: true }
  } finally {
    if (activityToken) douyinActivity.release(activityToken)
  }
}

async function fetchDouyinUid(partition) {
  let wc = findWebContentsByPartition(partition)
  let ownWin = null
  if (!wc) {
    try {
      ownWin = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { partition: partition } })
      await ownWin.loadURL('https://creator.douyin.com/creator-micro/home')
      wc = ownWin.webContents
    } catch (e) {
      return null
    }
  }
  try {
    const data = await wc.executeJavaScript(`(async function(){
      const r = await fetch('https://creator.douyin.com/aweme/v1/creator/pc/user/info/', { headers: { 'Accept': 'application/json' } });
      const j = await r.json();
      return { uid: j && (j.uid || (j.data && j.data.uid)) || null };
    })()`)
    return data && data.uid ? String(data.uid) : null
  } catch (e) {
    return null
  } finally {
    if (ownWin) setTimeout(() => { try { ownWin.destroy() } catch (e) {} }, 2000)
  }
}

function pickCookie(cookieData, name) {
  const re = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')
  const m = String(cookieData || '').match(re)
  return m ? m[1] : ''
}

async function pollPartition(partition, platform, accountUid, emittedUids) {
  try {
    const cookies = await session.fromPartition(partition).cookies.get({})
    const map = cookieMapOf(cookies)
    const loggedIn = !!detectLogin(platform, map)
    if (!loggedIn) return
    let uid = detectLogin(platform, map)
    // 抖音：cookie 的 uid_tt 可能是 hash（扫码登录），必须用页面接口拿稳定数字 uid。
    // 页面接口暂时失败时等待下次轮询，绝不能把 hash 或占位值保存成账号 uid。
    if (platform === 'Douyin') {
      const realUid = await fetchDouyinUid(partition)
      if (!realUid) return
      uid = realUid
    }
    if (!uid) return
    {
      const store = loadAccounts()
      const existing = store.find((x) => String(x.uid) === String(uid) && x.platform === platform)
      const curSession = map['sessionid'] || map['sessionid_ss'] || map['web_session'] || map['wxsid'] || ''
      const oldSession = existing ? (pickCookie(existing.cookieData, 'sessionid') || pickCookie(existing.cookieData, 'sessionid_ss') || pickCookie(existing.cookieData, 'web_session') || pickCookie(existing.cookieData, 'wxsid')) : ''
      const isNew = uid !== accountUid && !emittedUids.has(uid)
      const isRefreshed = !!existing && !!curSession && curSession !== oldSession
      if (isNew || isRefreshed) {
        emittedUids.add(uid)
        if (existing) {
          existing.cookieData = cookieStringOf(cookies)
          existing.cookies = cookieSnapshot(cookies)
          existing.isLogin = true
          existing.status = 1
          existing.healthState = 'online'
          existing.healthCheckedAt = Date.now()
          existing.healthReason = ''
          existing.lastOnlineAt = existing.healthCheckedAt
          saveAccounts()
          try {
            const targetSession = session.fromPartition(partition)
            if (targetSession.cookies.flushStore) await targetSession.cookies.flushStore()
          } catch (error) {}
        }
        const entry = webviewListeners.get(partition)
        if (entry) {
          entry.cb({
            eventId: entry.id,
            uid: String(uid),
            platform: platform,
            partition: partition,
            cookieData: cookieStringOf(cookies),
            cookies: cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || '/',
              secure: !!c.secure,
              httpOnly: !!c.httpOnly,
              sameSite: c.sameSite || 'Lax',
            })),
            realLogin: true,
          })
        }
        // 异步补全真实账号资料（昵称/头像），存入本地账号库
        if (platform === 'Douyin') {
          syncDouyinAccountProfile(partition, String(uid)).catch(() => {})
        }
      }
    }
  } catch (e) {}
}

/* ---------- 抖音账号资料补全（昵称/头像） ---------- */

function findWebContentsByPartition(partition) {
  try {
    const target = session.fromPartition(partition)
    return require('electron').webContents.getAllWebContents().find((wc) => {
      try {
        return !wc.isDestroyed() && wc.session === target
      } catch (e) {
        return false
      }
    })
  } catch (e) {
    return null
  }
}

async function syncDouyinAccountProfile(partition, uid) {
  let wc = findWebContentsByPartition(partition)
  let ownWin = null
  if (!wc) {
    try {
      ownWin = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { partition: partition } })
      await ownWin.loadURL('https://creator.douyin.com/creator-micro/home')
      wc = ownWin.webContents
    } catch (e) {
      return
    }
  }
  let data
  try {
    data = await wc.executeJavaScript(`(async function(){
      const r = await fetch('https://creator.douyin.com/web/api/media/user/info/', { headers: { 'Accept': 'application/json' } });
      const j = await r.json();
      if (j && j.user) {
        const u = j.user;
        return {
          nickname: u.nickname || '',
          avatar: (u.avatar_larger && u.avatar_larger.url_list && u.avatar_larger.url_list[0]) || '',
          unique_id: u.unique_id || u.short_id || '',
          signature: u.signature || '',
          accountInfo: {
            with_commerce_entry: !!u.with_commerce_entry,
            with_fusion_shop_entry: !!u.with_fusion_shop_entry,
            with_shop_entry: !!u.with_shop_entry,
            is_star: !!u.is_star,
          },
        };
      }
      return null;
    })()`)
  } catch (e) {
    return
  } finally {
    if (ownWin) setTimeout(() => { try { ownWin.destroy() } catch (e) {} }, 2000)
  }
  if (!data) return
  const store = loadAccounts()
  const hit = store.find((x) => String(x.uid) === String(uid) && x.platform === 'Douyin')
  if (hit) {
    if (data.nickname) hit.nickname = data.nickname
    if (data.avatar) hit.avatar = data.avatar
    if (data.unique_id) hit.douyin_unique_id = data.unique_id
    if (data.signature !== undefined) hit.signature = data.signature
    if (data.accountInfo) hit.accountInfo = Object.assign({}, hit.accountInfo, data.accountInfo)
    saveAccounts()
  }
}

const LEGACY_PUBLISH_TASKS_FILE = path.join(__dirname, 'publish-tasks.json')
const PUBLISH_STATE_FILE = path.join(STATE_DIR, 'publish-state.json')
const publishTaskStore = new PublishTaskStore({ dataDir: STATE_DIR })
try { publishTaskStore.importLegacyJson(LEGACY_PUBLISH_TASKS_FILE) } catch (error) {
  try { fs.appendFileSync(path.join(STATE_DIR, 'publish-store-errors.log'), `[${new Date().toISOString()}] legacy migration: ${String(error && error.message || error)}\n`) } catch (writeError) {}
}
app.once('before-quit', () => publishTaskStore.close())

const databaseMaintenance = new DatabaseMaintenance({
  // 商机、采集和发布任务的备份统一落在 D 盘业务数据目录，避免继续挤占系统盘。
  dataDir: leadRadar.dataDir,
  getEntries() {
    const entries = [
      { key: 'lead-radar', db: leadRadar.db, dbPath: leadRadar.dbPath },
      { key: 'government-collector', db: governmentCollector.db, dbPath: governmentCollector.dbPath },
      { key: 'publish-tasks', db: publishTaskStore.db, dbPath: publishTaskStore.dbPath },
    ]
    if (douyinPublicCollector && douyinPublicCollector.stateDb) {
      entries.push({
        key: 'douyin-public-collector',
        db: douyinPublicCollector.stateDb,
        dbPath: path.join(leadRadar.dataDir, 'douyin-public-collector.sqlite'),
      })
    }
    return entries
  },
  notify(alert) {
    if (!Notification || !Notification.isSupported()) return
    new Notification({
      title: alert.kind === 'disk_space' ? '数据磁盘空间不足' : '业务数据库异常',
      body: alert.message,
      urgency: 'critical',
    }).show()
  },
})
databaseMaintenance.start()
app.once('before-quit', () => databaseMaintenance.close())

function loadPublishTasks() {
  try {
    return publishTaskStore.loadTasks()
  } catch (error) {
    try { fs.appendFileSync(path.join(STATE_DIR, 'publish-store-errors.log'), `[${new Date().toISOString()}] load: ${String(error && error.message || error)}\n`) } catch (writeError) {}
  }
  return []
}
const publishTasks = loadPublishTasks()
/* 启动恢复：发布结果未知时绝不自动重发，避免实际已发布却重复发作品。 */
;(function recoverStalePublishing() {
  const changed = recoverInterruptedPublishing(publishTasks)
  if (changed.length) savePublishTasks(changed)
})()

/* 侦察发布页音乐面板交互 */
async function probePublishMusic(account) {
  const partition = account && account.partition
  if (!partition) return { error: 'NO_PARTITION' }
  const out = { partition }
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: partition, backgroundThrottling: false } })
  let dbg = null
  try {
    await win.loadURL('https://creator.douyin.com/creator-micro/content/post/image')
    await new Promise((r) => setTimeout(r, 9000))
    dbg = win.webContents.debugger
    dbg.attach('1.3')
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    dbg.on('message', (e, method, params) => {
      if (method === 'Page.fileChooserOpened') {
        dbg.sendCommand('DOM.setFileInputFiles', { files: [account.imgPath], backendNodeId: params.backendNodeId }).catch(() => {})
      }
    })
    const clickUpload = async () => {
      const pt = await win.webContents.executeJavaScript(`(function(){
        const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => (el.innerText || '').includes('点击上传') && (el.innerText || '').includes('拖入此区域'));
        if (!hits.length) return null;
        let best = null, bestArea = Infinity;
        for (const el of hits) {
          const r = el.getBoundingClientRect();
          const a = r.width * r.height;
          if (a > 100 && a < bestArea) { bestArea = a; best = el; }
        }
        if (!best) return null;
        const r = best.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`)
      if (!pt) return false
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      return true
    }
    if (!(await clickUpload())) { out.step = 'NO_UPLOAD'; return out }
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const n = await win.webContents.executeJavaScript(`(function(){ const z = document.querySelector('div[class*="phone-screen"]'); return z ? z.querySelectorAll('img').length : 0; })()`)
      if (n > 0) { out.uploaded = true; break }
    }
    await new Promise((r) => setTimeout(r, 2000))
    const scrolled = await win.webContents.executeJavaScript(`(function(){
      const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
        const t = (el.innerText || '').trim();
        return t.includes('选择音乐') && t.length < 40;
      });
      let best = null, bestArea = Infinity;
      for (const el of hits) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > 50 && a < bestArea) { bestArea = a; best = el; }
      }
      if (!best) return null;
      best.scrollIntoView({ block: 'center' });
      return true;
    })()`)
    if (!scrolled) { out.step = 'NO_MUSIC_ZONE'; return out }
    await new Promise((r) => setTimeout(r, 800))
    const pt = await win.webContents.executeJavaScript(`(function(){
      const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
        const t = (el.innerText || '').trim();
        return t.includes('选择音乐') && t.length < 40;
      });
      let best = null, bestArea = Infinity;
      for (const el of hits) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > 50 && a < bestArea) { bestArea = a; best = el; }
      }
      if (!best) return null;
      const r = best.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (best.innerText || '').trim().slice(0, 30) };
    })()`)
    if (!pt) { out.step = 'NO_MUSIC_ZONE2'; return out }
    out.clickAt = pt
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 8000))
    try {
      const img = await win.webContents.capturePage()
      const shotPath = path.join(__dirname, 'probe-music-shot.png')
      fs.writeFileSync(shotPath, img.toPNG())
      out.shotPath = shotPath
    } catch (e) {
      out.shotErr = String(e && e.message || e)
    }
    out.navLog = []
    try {
      const h1 = (e, url) => out.navLog.push('nav:' + (url || ''))
      const h2 = (e, url) => out.navLog.push('inpage:' + (url || ''))
      win.webContents.on('did-navigate', h1)
      win.webContents.on('did-navigate-in-page', h2)
      win.webContents.on('did-fail-load', (e, code, desc) => out.navLog.push('fail:' + code + ' ' + desc))
      win.webContents.on('render-process-gone', (e, d) => out.navLog.push('gone:' + JSON.stringify(d)))
      const urlNow = win.webContents.getURL()
      out.url = urlNow
      await win.webContents.executeJavaScript('1 + 1')
      out.evalOk = true
      win.webContents.removeListener('did-navigate', h1)
      win.webContents.removeListener('did-navigate-in-page', h2)
    } catch (e) {
      out.domError = String(e && e.message || e)
      out.url2 = win.webContents.getURL()
    }
    try {
      const script = `(function(){
        const out = {};
        out.portalCount = document.querySelectorAll('div.semi-portal').length;
        out.portals = [...document.querySelectorAll('div.semi-portal')].map((p, i) => {
          const rect = p.getBoundingClientRect();
          const inputs = [...p.querySelectorAll('input')].map((inp) => ({ ph: inp.placeholder || '', cls: String(inp.className || '').slice(0, 60) }));
          const btns = [...p.querySelectorAll('button, div[role="button"]')].map((b) => (b.innerText || '').trim().slice(0, 30)).filter((t) => t);
          const iframes = p.querySelectorAll('iframe').length;
          const imgs = p.querySelectorAll('img').length;
          const texts = [...new Set([...p.querySelectorAll('div,span,li')].map((el) => (el.innerText || '').trim()).filter((t) => t && t.length < 60))].slice(0, 40);
          return { i, vis: rect.width > 0 && rect.height > 0, w: Math.round(rect.width), h: Math.round(rect.height),
                   top: Math.round(rect.top), left: Math.round(rect.left), inputs, btns, iframes, imgs, texts };
        });
        const vis = out.portals.filter((p) => p.vis);
        out.visiblePortal = vis.length ? vis[vis.length - 1] : null;
        out.iframes = [...document.querySelectorAll('iframe')].map((f) => ({ cls: String(f.className || '').slice(0, 60), src: String(f.src || '').slice(0, 100), vis: f.offsetParent !== null }));
        out.bodyText = (document.body.innerText || '').replace(/\\n/g, '|').slice(0, 1500);
        return out;
      })()`
      const rr = await dbg.sendCommand('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true })
      out.dom = rr && rr.result && rr.result.value
      if (rr && rr.exceptionDetails) out.domEx = JSON.stringify(rr.exceptionDetails).slice(0, 200)
    } catch (e) {
      out.domError = String(e && e.message || e)
    }
  } catch (e) {
    out.error = String(e && e.message || e)
  } finally {
    try { if (dbg && dbg.isAttached()) dbg.detach() } catch (e) {}
    try { win.destroy() } catch (e) {}
  }
  try {
    fs.appendFileSync(path.join(__dirname, 'publish-probe.log'), '\n===== MUSIC ' + new Date().toISOString() + ' =====\n' + JSON.stringify(out, null, 1) + '\n')
  } catch (e) {}
  return out
}
async function probePublishTiming(account) {
  const partition = account && account.partition
  if (!partition) return { error: 'NO_PARTITION' }
  const out = { partition }
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: partition, backgroundThrottling: false } })
  try {
    await win.loadURL('https://creator.douyin.com/creator-micro/content/post/image')
    await new Promise((r) => setTimeout(r, 9000))
    out.dom = await win.webContents.executeJavaScript(`(function(){
      const out = {};
      const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
        const t = (el.innerText || '').trim();
        return /定时|立即发布|发布时间|选择时间|时间/.test(t) && t.length < 40;
      });
      out.timingTexts = [...new Set(hits.map((el) => (el.innerText || '').trim()))].slice(0, 20);
      out.timingEls = hits.slice(0, 8).map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, cls: String(el.className || '').slice(0, 60), text: (el.innerText || '').trim().slice(0, 20), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      const input = document.querySelector('input[placeholder="添加作品标题"]');
      out.titleInputCls = input ? input.className : 'NO';
      return out;
    })()`)
  } catch (e) {
    out.error = String(e && e.message || e)
  } finally {
    try { win.destroy() } catch (e) {}
  }
  try {
    fs.appendFileSync(path.join(__dirname, 'publish-probe.log'), '\n===== TIMING ' + new Date().toISOString() + ' =====\n' + JSON.stringify(out, null, 1) + '\n')
  } catch (e) {}
  return out
}
function savePublishTasks(changedTasks) {
  try {
    const rows = Array.isArray(changedTasks) ? changedTasks : publishTasks
    publishTaskStore.upsertTasks(rows)
    return true
  } catch (error) {
    try { fs.appendFileSync(path.join(STATE_DIR, 'publish-store-errors.log'), `[${new Date().toISOString()}] save: ${String(error && error.message || error)}\n`) } catch (writeError) {}
    throw error
  }
}
let publishBusy = false
let timedScheduler = null

/* 统一解析任务定时：兼容 {type,time} 对象 / ISO 字符串 / 数字时间戳；返回 {type, time:epochMs} 或 null */
function parseTiming(v) {
  if (!v) return null
  let time = null
  let type = 0
  if (typeof v === 'object') {
    time = v.time
    type = v.type || 2
  } else {
    time = v
    type = 2
  }
  if (time === null || time === undefined || time === '') return null
  let ms
  if (typeof time === 'number') ms = time
  else if (time instanceof Date) ms = time.getTime()
  else if (typeof time === 'string') ms = new Date(time).getTime()
  else ms = NaN
  if (!Number.isFinite(ms)) return null
  return { type: type, time: ms }
}

function isTimedFuture(t) {
  const due = effectiveTaskDueAt(t)
  return t.status === 'pending' && due > Date.now()
}

function configuredPublishPolicy() {
  const config = loadLocalConfig()
  return {
    dailyMax: Math.max(1, Math.min(20, Number(config.publishDailyMax) || 4)),
    accountGapMinutes: Math.max(30, Math.min(720, Number(config.publishAccountGapMinutes) || 80)),
    activeStartMinutes: 9 * 60,
    activeEndMinutes: 21 * 60 + 30,
  }
}

function activeWindowAllowedAt(value) {
  const date = new Date(Number(value) || Date.now())
  const policy = configuredPublishPolicy()
  const minute = date.getHours() * 60 + date.getMinutes()
  if (minute >= policy.activeStartMinutes && minute < policy.activeEndMinutes) return date.getTime()
  const next = new Date(date)
  if (minute >= policy.activeEndMinutes) next.setDate(next.getDate() + 1)
  next.setHours(Math.floor(policy.activeStartMinutes / 60), policy.activeStartMinutes % 60, 0, 0)
  return next.getTime()
}

function effectiveTaskDueAt(task) {
  const explicit = parseTiming(task && task.timing)
  return Math.max(Number(explicit && explicit.time) || 0, Number(task && task.deferredUntil) || 0)
}

function accountPolicyAllowedAt(task, value = Date.now()) {
  const now = Number(value) || Date.now()
  const policy = configuredPublishPolicy()
  let allowedAt = activeWindowAllowedAt(now)
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const nextDayStart = new Date(dayStart)
  nextDayStart.setDate(nextDayStart.getDate() + 1)
  const successes = publishTasks.filter((item) => String(item.uid) === String(task.uid)
    && item.status === 'success' && Number(item.finishTime) >= dayStart.getTime() && Number(item.finishTime) < nextDayStart.getTime())
  if (successes.length >= policy.dailyMax) {
    const next = new Date(nextDayStart)
    next.setHours(Math.floor(policy.activeStartMinutes / 60), policy.activeStartMinutes % 60, 0, 0)
    allowedAt = Math.max(allowedAt, next.getTime())
  }
  const lastSuccess = publishTasks.filter((item) => String(item.uid) === String(task.uid)
    && item.status === 'success' && Number(item.finishTime) > 0)
    .reduce((latest, item) => Math.max(latest, Number(item.finishTime) || 0), 0)
  if (lastSuccess) allowedAt = Math.max(allowedAt, lastSuccess + policy.accountGapMinutes * 60000)
  return activeWindowAllowedAt(allowedAt)
}

function publishTaskDueNow(task, now = Date.now()) {
  if (!task || task.status !== 'pending') return false
  const due = effectiveTaskDueAt(task)
  return !due || due <= now
}

/* 本地定时：每 30s 扫描一次，到点的 pending 定时任务触发发布队列 */
function ensureTimedScheduler() {
  if (timedScheduler) return
  timedScheduler = setInterval(() => {
    try {
      const due = publishTasks.some((t) => publishTaskDueNow(t))
      if (!due) return
      fs.appendFileSync(path.join(__dirname, 'publish.log'), `[${new Date().toISOString()}] timed trigger\n`)
      runPublishQueue().catch(() => {})
    } catch (e) {}
  }, 10000)
  if (timedScheduler.unref) timedScheduler.unref()
}

function normImagePath(p) {
  if (!p) return null
  let s = String(p)
  if (s.startsWith('file://')) s = s.slice('file://'.length)
  s = s.split('?')[0]
  try {
    s = decodeURIComponent(s)
  } catch (e) {}
  s = s.replace(/\\/g, '\\\\')
  if (fs.existsSync(s)) return s
  if (fs.existsSync(s.replace(/\\\\/g, '\\'))) return s.replace(/\\\\/g, '\\')
  return s
}

function normalizeTaskFromFrontend(t) {
  const batchSource = String(t && t.batchSource || '')
  const initialStatus = batchSource && Number(loadLocalConfig().taskInitialStatus) === 3 ? 'paused' : 'pending'
  const out = {
    id: String((t && (t.localId || t.id)) || crypto.randomUUID()),
    clientBatchId: String(t && t.clientBatchId || ''),
    batchSource,
    platform: (t && t.platform) || '',
    uid: (t && (t.uid || (t.formData && t.formData.uid))) || '',
    partition: (t && t.partition) || '',
    title: (t && (t.title || (t.commonValues && t.commonValues.title) || (t.formData && t.formData.title))) || '',
    desc: (t && (t.desc || (t.commonValues && t.commonValues.desc) || (t.formData && t.formData.text))) || '',
    tags: [],
    images: [],
    cover: '',
    timing: null,
    status: initialStatus,
    error: '',
    errorCode: '',
    stage: 'queued',
    attempts: 0,
    lastAttemptAt: 0,
    uploadedCount: 0,
    expectedImages: 0,
    uncertain: false,
    accountUnknownChecks: 0,
    publishIntentAt: 0,
    createTime: Date.now(),
    finishTime: 0,
    music: null,
    musicRequired: false,
    musicResult: '',
    musicSelectionMethod: '',
    matchedMusic: null,
  }
  const tags = (t && (t.tags || (t.commonValues && t.commonValues.tags))) || []
  if (Array.isArray(tags)) out.tags = tags.map(String).filter(Boolean)
  else if (typeof tags === 'string' && tags.trim()) out.tags = tags.split(/[,，#\s]+/).filter(Boolean)
  const imgs = (t && t.images) || (t && t.uploadData && t.uploadData.images) || []
  if (Array.isArray(imgs)) {
    out.images = imgs
      .map((it) => (typeof it === 'string' ? normImagePath(it) : normImagePath(it && (it.path || it.url || it.src))))
      .filter(Boolean)
  } else if (typeof imgs === 'string') {
    try {
      const arr = JSON.parse(imgs)
      out.images = Array.isArray(arr) ? arr.map(normImagePath).filter(Boolean) : []
    } catch (e) {
      out.images = imgs.split(',').map(normImagePath).filter(Boolean)
    }
  }
  if (t && t.cover) out.cover = normImagePath(t.cover)
  else if (t && t.uploadData && t.uploadData.cover) out.cover = normImagePath(t.uploadData.cover)
  if (out.cover && !out.images.length) out.images.push(out.cover)
  if (!out.images.length && out.cover) out.images.push(out.cover)
    if (t && t.timing) out.timing = parseTiming(t.timing)
    else if (t && t.formData && t.formData.CAT_timing) out.timing = parseTiming(t.formData.CAT_timing)
    if (t && t.music) out.music = {
      title: String(t.music.title || ''),
      author: String(t.music.author || ''),
      id_str: String(t.music.id_str || ''),
      duration: Number(t.music.duration) || 0,
    }
    else if (t && t.formData && t.formData.CAT_music) {
      const m = t.formData.CAT_music
      out.music = { title: String(m.title || ''), author: String(m.author || ''), id_str: String(m.id_str || ''), duration: Number(m.duration) || 0 }
    }
    out.musicRequired = !!(t && t.musicRequired) || !!(out.music && out.music.title)
    return out
}

function pushPublishTasks(list, options = {}) {
  const inserted = []
  for (const t of list) {
    const hit = publishTasks.find((x) => x.id === t.id)
    if (hit) continue
    publishTasks.push(t)
    inserted.push(t)
  }
  if (inserted.length && options.persist !== false) savePublishTasks(inserted)
  return inserted
}

/* 抖音图文发布核心：窗口复用，支持多图上传、标题、正文、发布、轮询 */
async function runDouyinImagePublish(task, onLog) {
  const log = (s) => {
    if (onLog) onLog(s)
    try {
      fs.appendFileSync(path.join(__dirname, 'publish.log'), `[${new Date().toISOString()}] ${task.id} ${s}\n`)
    } catch (e) {}
  }
  // 发布过程只消费局部副本，持久化任务中的图片永远不被 shift，失败重试不会少图。
  const originalImages = (task.images || []).slice()
  const workingImages = originalImages.slice()
  const partition = task.partition
  if (!partition) return { ok: false, error: 'NO_PARTITION' }
  if (!originalImages.length) return { ok: false, error: 'NO_IMAGES' }
  const missingImage = originalImages.find((imagePath) => !fs.existsSync(imagePath))
  if (missingImage) return { ok: false, error: 'IMAGE_NOT_FOUND：' + String(missingImage).slice(0, 180) }
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: partition } })
  let dbg = null
  try {
    log('open publish page')
    task.stage = 'opening_page'
    savePublishTasks([task])
    await withTimeout(win.loadURL('https://creator.douyin.com/creator-micro/content/post/image'), 30000, 'PAGE_LOAD_TIMEOUT')
    await new Promise((r) => setTimeout(r, 9000))
    const pageUrl = String(win.webContents.getURL() || '')
    const pageText = await win.webContents.executeJavaScript("String(document.body && document.body.innerText || '').slice(0, 4000)").catch(() => '')
    if (/\/(?:passport|login|auth)(?:\/|\?|$)/i.test(pageUrl) || /请先登录|登录已失效|请重新登录/.test(pageText)) {
      return { ok: false, error: 'ACCOUNT_OFFLINE：抖音创作者中心登录已失效' }
    }
    // 隐藏登录弹层常驻的“获取验证码/安全验证”不能单独判风控；这里只接受明确的操作阻断语句。
    if (/请输入验证码|验证码错误|请完成验证|操作频繁|访问频繁|人机验证|滑块验证|账号异常/.test(pageText)) {
      return { ok: false, error: 'RISK_CONTROL：抖音要求验证或限制操作，请人工处理后再发布' }
    }
    dbg = win.webContents.debugger
    dbg.attach('1.3')
    dbg.on('message', (e, method, params) => {
      if (method === 'Page.fileChooserOpened' && workingImages.length) {
        const p = workingImages.shift()
        dbg.sendCommand('DOM.setFileInputFiles', { files: [p], backendNodeId: params.backendNodeId }).catch(() => {})
      }
    })
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })

    const clickUpload = async (retryVisible) => {
      if (retryVisible && !win.isVisible()) win.show()
      const pt = await win.webContents.executeJavaScript(`(function(){
        const cands = ['点击上传', '继续添加', '添加图片', '再传一张', '上传图片', '添加照片'];
        const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
          const t = (el.innerText || '').trim();
          return cands.some((c) => t.includes(c)) && t.length < 80 && el.offsetParent !== null;
        });
        if (!hits.length) return null;
        let best = null, bestArea = Infinity;
        for (const el of hits) {
          const r = el.getBoundingClientRect();
          const a = r.width * r.height;
          if (a > 60 && a < bestArea) { bestArea = a; best = el; }
        }
        if (!best) return null;
        const r = best.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (best.innerText || '').trim().slice(0, 20) };
      })()`)
      if (!pt) return false
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      return true
    }

    task.stage = 'uploading'
    const totalImgs = originalImages.length
    task.expectedImages = totalImgs
    task.uploadedCount = 0
    savePublishTasks([task])
    let uploaded = 0
    while (workingImages.length) {
      log('upload img ' + (totalImgs - workingImages.length + 1) + '/' + totalImgs)
      if (!(await clickUpload(false))) {
        if (!(await clickUpload(true))) return { ok: false, error: 'UPLOAD_ZONE_NOT_FOUND' }
      }
      let done = false
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const n = await win.webContents.executeJavaScript(`(function(){
          const zone = document.querySelector('div[class*="phone-screen"]');
          return zone ? zone.querySelectorAll('img').length : 0;
        })()`)
        if (n > uploaded) { uploaded = n; done = true; break }
        if (i === 24 && !done) { log('img upload wait timeout, retry visible'); if (!(await clickUpload(true))) { log('visible click also failed'); break } }
      }
      if (!done) return { ok: false, error: `UPLOAD_TIMEOUT：图片 ${uploaded + 1}/${totalImgs} 上传未完成` }
      task.uploadedCount = uploaded
      savePublishTasks([task])
      await new Promise((r) => setTimeout(r, 2000))
    }
    if (uploaded !== totalImgs || workingImages.length) {
      return { ok: false, error: `UPLOAD_INCOMPLETE：应上传 ${totalImgs} 张，实际确认 ${uploaded} 张` }
    }

    const title = (task.title || '').slice(0, 30)
    let desc = task.desc || ''
    if (task.tags && task.tags.length) desc = (desc ? desc + '\n' : '') + task.tags.map((t) => '#' + t.replace(/^#/, '')).join(' ')
    if (!title && !desc) { return { ok: false, error: 'EMPTY_CONTENT' } }
    log('fill title+desc')
    try {
      await win.webContents.executeJavaScript(`(function(){
        const input = document.querySelector('input[placeholder="添加作品标题"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(title)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector('[contenteditable]');
        if (editor) { editor.innerText = ${JSON.stringify(desc)}; editor.dispatchEvent(new Event('input', { bubbles: true })); }
        return true;
      })()`)
    } catch (e) {
      log('fill EXCEPTION ' + String(e && e.message || e))
    }
    await new Promise((r) => setTimeout(r, 1500))

    const musicTitle = task.music && String(task.music.title || '').trim()
    const musicAuthor = task.music && String(task.music.author || '').trim()
    if (musicTitle) {
      let ok = false
      for (let musicRetry = 0; musicRetry < 2 && !ok; musicRetry++) {
      log('select music' + (musicRetry ? ' (retry' + musicRetry + ')' : '') + ': ' + musicTitle)
      try {
        ok = await (async () => {
          // 1) 找"选择音乐"区域（带重试：冷分区页面加载慢，最多等 30s）
          let scrollZone = false
          let zoneElInfo = ''
          for (let attempt = 0; attempt < 6; attempt++) {
            scrollZone = await win.webContents.executeJavaScript(`(function(){
              const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
                const t = (el.innerText || '').trim();
                return t.includes('选择音乐') && t.length < 40;
              });
              let best = null, bestArea = Infinity;
              for (const el of hits) {
                const r = el.getBoundingClientRect();
                const a = r.width * r.height;
                if (a > 50 && a < bestArea) { bestArea = a; best = el; }
              }
              if (!best) return false;
              best.scrollIntoView({ block: 'center' });
              return true;
            })()`)
            if (scrollZone) break
            if (attempt < 5) {
              log('MUSIC zone not found, retry ' + (attempt + 1) + '/6 (waiting 5s)')
              await new Promise((r) => setTimeout(r, 5000))
            }
          }
          if (!scrollZone) { log('MUSIC zone not found after 6 attempts'); return false }
          await new Promise((r) => setTimeout(r, 800))
          const pt = await win.webContents.executeJavaScript(`(function(){
            const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
              const t = (el.innerText || '').trim();
              return t.includes('选择音乐') && t.length < 40;
            });
            let best = null, bestArea = Infinity;
            for (const el of hits) {
              const r = el.getBoundingClientRect();
              const a = r.width * r.height;
              if (a > 50 && a < bestArea) { bestArea = a; best = el; }
            }
            if (!best) return null;
            const r = best.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`)
          if (!pt) { log('MUSIC zone pos not found'); return false }
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
          await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
          await new Promise((r) => setTimeout(r, 3000))
          // 1.4) 等面板列表加载完成（"使用"按钮出现），避免列表未加载完就匹配
          for (let w = 0; w < 10; w++) {
            const ready = await win.webContents.executeJavaScript(`(function(){
              const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '使用');
              return btns.length > 0;
            })()`)
            if (ready) break
            await new Promise((r) => setTimeout(r, 1000))
          }
          // 1.5) 先直接匹配面板当前列表（原声类歌搜索不到，但分类歌单里有）；找不到就滚动加载更多
          let listHit = false
          for (let sc = 0; sc < 12 && !listHit; sc++) {
            const res = await win.webContents.executeJavaScript(`(function(){
               const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '使用');
               const target = ${JSON.stringify(musicTitle)};
               const author = ${JSON.stringify(musicAuthor)};
               const matches = [];
               for (const b of btns) {
                 let best = null, bestLen = Infinity;
                let pp = b.parentElement;
                for (let k = 0; k < 7 && pp; k++, pp = pp.parentElement) {
                  const t = (pp.innerText || '').trim();
                  if (t.includes(target) && t.length < bestLen) { bestLen = t.length; best = pp; }
                }
                 if (best && bestLen < 300) matches.push({ button: b, text: (best.innerText || '').trim() });
               }
               const exact = author ? matches.filter((item) => item.text.includes(author)) : [];
               const choice = exact.length === 1 ? exact[0] : (!exact.length && matches.length === 1 ? matches[0] : null);
               if (choice) { choice.button.click(); return exact.length ? 'hit_author' : 'hit_unique_title'; }
              // 滚动到可滚动容器底部，触发加载更多
              const scrollers = [...document.querySelectorAll('div,ul')].filter((d) => d.scrollHeight > d.clientHeight + 80);
              let scrolled = false;
              for (const d of scrollers) {
                if (d.scrollTop + d.clientHeight < d.scrollHeight - 30) { d.scrollTop = d.scrollHeight; scrolled = true; }
              }
              return scrolled ? 'scroll' : false;
            })()`)
            if (res === 'hit_author' || res === 'hit_unique_title') { listHit = res; break }
            if (res !== 'scroll') break
            await new Promise((r) => setTimeout(r, 2000))
          }
          if (listHit) {
            task.musicSelectionMethod = listHit
            await new Promise((r) => setTimeout(r, 4000))
            const doneL = await win.webContents.executeJavaScript(`(function(){
              const panelOpen = !!document.querySelector('input[placeholder="搜索音乐"]');
              return !panelOpen && (document.body.innerText || '').includes(${JSON.stringify(musicTitle)});
            })()`)
            log(doneL ? 'MUSIC selected (from list)' : 'MUSIC select uncertain (from list)')
            if (!doneL) {
              // 诊断：dump 音乐区域实际文本（判断是否真的选中了）
              try {
                const diag = await win.webContents.executeJavaScript(`(function(){
                  const txt = document.body.innerText || '';
                  const idx = txt.indexOf('修改音乐');
                  const idx2 = txt.indexOf('选择音乐');
                  let zone = '';
                  if (idx >= 0) zone = txt.substring(Math.max(0, idx - 200), idx + 50);
                  else if (idx2 >= 0) zone = txt.substring(Math.max(0, idx2 - 100), idx2 + 50);
                  return { zone: zone, hasQuery: txt.includes(${JSON.stringify(musicTitle)}), panelOpen: !!document.querySelector('input[placeholder="搜索音乐"]') };
                })()`)
                log('MUSIC UNCERTAIN DIAG: ' + JSON.stringify(diag).slice(0, 400))
              } catch (e) {}
            }
            return doneL
          }
          // 1.6) 推荐列表没有 → 遍历其他分类找（推荐列表是动态的，目标歌可能在收藏/热门榜等）
          if (!listHit) {
            const otherCats = ['收藏', '热门榜', '飙升榜', '原创榜', '卡点', '纯音乐', '旅行', 'DJ', '搞笑', '流行', '伤感']
            for (const cat of otherCats) {
              const catClicked = await win.webContents.executeJavaScript(`(function(){
                const els = [...document.querySelectorAll('div,span')].filter((el) => {
                  const t = (el.innerText || '').trim();
                  return t === ${JSON.stringify(cat)} && el.children.length === 0 && el.offsetParent !== null;
                });
                if (!els.length) return false;
                els[0].click();
                return true;
              })()`)
              if (!catClicked) continue
              await new Promise((r) => setTimeout(r, 2500))
              // 滚动匹配该分类
              let catHit = false
              for (let sc = 0; sc < 5 && !catHit; sc++) {
                const res = await win.webContents.executeJavaScript(`(function(){
                   const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '使用');
                   const target = ${JSON.stringify(musicTitle)};
                   const author = ${JSON.stringify(musicAuthor)};
                   const matches = [];
                   for (const b of btns) {
                    let best = null, bestLen = Infinity;
                    let pp = b.parentElement;
                    for (let k = 0; k < 7 && pp; k++, pp = pp.parentElement) {
                      const t = (pp.innerText || '').trim();
                      if (t.includes(target) && t.length < bestLen) { bestLen = t.length; best = pp; }
                    }
                     if (best && bestLen < 300) matches.push({ button: b, text: (best.innerText || '').trim() });
                   }
                   const exact = author ? matches.filter((item) => item.text.includes(author)) : [];
                   const choice = exact.length === 1 ? exact[0] : (!exact.length && matches.length === 1 ? matches[0] : null);
                   if (choice) { choice.button.click(); return exact.length ? 'hit_author' : 'hit_unique_title'; }
                  const scrollers = [...document.querySelectorAll('div,ul')].filter((d) => d.scrollHeight > d.clientHeight + 80);
                  let scrolled = false;
                  for (const d of scrollers) {
                    if (d.scrollTop + d.clientHeight < d.scrollHeight - 30) { d.scrollTop = d.scrollHeight; scrolled = true; }
                  }
                  return scrolled ? 'scroll' : false;
                })()`)
                if (res === 'hit_author' || res === 'hit_unique_title') { catHit = res; break }
                if (res !== 'scroll') break
                await new Promise((r) => setTimeout(r, 2000))
              }
              if (catHit) {
                task.musicSelectionMethod = catHit
                await new Promise((r) => setTimeout(r, 4000))
                const doneC = await win.webContents.executeJavaScript(`(function(){
                  const panelOpen = !!document.querySelector('input[placeholder="搜索音乐"]');
                  return !panelOpen && (document.body.innerText || '').includes(${JSON.stringify(musicTitle)});
                })()`)
                log(doneC ? 'MUSIC selected (cat ' + cat + ')' : 'MUSIC select uncertain (cat ' + cat + ')')
                return doneC
              }
              // 回推荐分类（继续下一个分类前）
              await win.webContents.executeJavaScript(`(function(){
                const els = [...document.querySelectorAll('div,span')].filter((el) => {
                  const t = (el.innerText || '').trim();
                  return t === '推荐' && el.children.length === 0 && el.offsetParent !== null;
                });
                if (els.length) els[0].click();
                return true;
              })()`)
              await new Promise((r) => setTimeout(r, 2000))
            }
          }
          const typed = await win.webContents.executeJavaScript(`(function(){
            const inp = document.querySelector('input[placeholder="搜索音乐"]');
            if (!inp || inp.offsetParent === null) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, ${JSON.stringify(musicTitle)});
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.focus();
            return true;
          })()`)
          if (!typed) { log('MUSIC panel not open'); return false }
          const keyPt = await win.webContents.executeJavaScript(`(function(){
            const inp = document.querySelector('input[placeholder="搜索音乐"]');
            if (!inp) return null;
            const r = inp.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`)
          if (keyPt) {
            await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: keyPt.x, y: keyPt.y })
            await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: keyPt.x, y: keyPt.y, button: 'left', clickCount: 1 })
            await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: keyPt.x, y: keyPt.y, button: 'left', clickCount: 1 })
            await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
            await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
          }
          // 2) 等搜索结果出现"使用"按钮（20s 上限）
          let resultCount = 0
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 1000))
            const rr = await dbg.sendCommand('Runtime.evaluate', { expression: `(function(){
              const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '使用');
              return btns.length ? btns.length : 0;
            })()`, returnByValue: true })
            if (rr && rr.result && rr.result.value > 0) { resultCount = rr.result.value; break }
            if (i === 19) { log('MUSIC search result timeout'); return false }
          }
          // 3) 匹配目标歌名：只点击精确匹配项，绝不盲目点第一首
          const used = await win.webContents.executeJavaScript(`(function(){
             const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '使用');
             if (!btns.length) return { clicked: false, reason: 'no_buttons' };
             const target = ${JSON.stringify(musicTitle)};
             const author = ${JSON.stringify(musicAuthor)};
             const matches = [];
             for (const b of btns) {
              let best = null, bestLen = Infinity;
              let pp = b.parentElement;
              for (let k = 0; k < 7 && pp; k++, pp = pp.parentElement) {
                const t = (pp.innerText || '').trim();
                if (t.includes(target) && t.length < bestLen) { bestLen = t.length; best = pp; }
              }
               if (best && bestLen < 300) matches.push({ button: b, text: (best.innerText || '').trim() });
             }
             const exact = author ? matches.filter((item) => item.text.includes(author)) : [];
             const choice = exact.length === 1 ? exact[0] : (!exact.length && matches.length === 1 ? matches[0] : null);
             if (!choice) {
              const samples = btns.slice(0, 5).map((b) => {
                let p = b; for (let k = 0; k < 6 && p; k++, p = p.parentElement) {}
                return (p && p.innerText || '').slice(0, 80);
              });
               return { clicked: false, reason: matches.length > 1 ? 'ambiguous_title' : 'no_match', samples: samples };
             }
             choice.button.click();
             return { clicked: true, method: exact.length ? 'title_author' : 'unique_title' };
          })()`)
          if (!used || !used.clicked) {
            if (used && used.reason === 'no_match') {
              log('MUSIC target not in results: ' + JSON.stringify(used.samples))
            } else {
              log('MUSIC use btn not found')
            }
            return false
          }
          task.musicSelectionMethod = used.method || 'title_match'
          await new Promise((r) => setTimeout(r, 4000))
          const done = await win.webContents.executeJavaScript(`(function(){
            const panelOpen = !!document.querySelector('input[placeholder="搜索音乐"]');
            return !panelOpen && (document.body.innerText || '').includes(${JSON.stringify(musicTitle)});
          })()`)
          log(done ? 'MUSIC selected' : 'MUSIC select uncertain (continue)')
          return done
        })()
        if (!ok) log('MUSIC select failed' + (musicRetry ? ' (retry' + musicRetry + ')' : ''))
      } catch (e) {
        log('MUSIC EXCEPTION ' + String(e && e.message || e))
      }
      if (!ok && musicRetry === 0) {
        // 面板重开再试：推荐列表动态，可能变化
        try {
          await win.webContents.executeJavaScript('document.activeElement && document.activeElement.blur && document.activeElement.blur()')
        } catch (e) {}
        try {
          await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
          await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 1500))
      }
      }
      if (!ok) {
        task.musicResult = 'failed'
        return { ok: false, error: 'MUSIC_SELECT_FAILED：未能应用指定音乐「' + musicTitle + '」，已停止发布，避免作品无音乐' }
      }
      task.musicResult = 'selected'
      task.matchedMusic = { title: musicTitle, author: musicAuthor }
      savePublishTasks([task])
    }

    /* 取消检查：任务被暂停/删除后不点发布 */
    try {
      const cur = publishTasks.find((x) => x.id === task.id)
      if (!cur || cur.status !== 'publishing') {
        log('CANCELLED before click publish')
        return { ok: false, error: 'CANCELLED' }
      }
    } catch (e) {}

    log('click publish')
    // 先持久化发布意图，再执行有副作用的点击；保存失败时不会继续点击。
    task.stage = 'publish_intent'
    task.uncertain = true
    task.publishIntentAt = Date.now()
    savePublishTasks([task])
    try {
      const clickResult = await win.webContents.executeJavaScript(`(function(){
        const visible = (button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return !button.disabled && style.display !== 'none' && style.visibility !== 'hidden'
            && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        };
        const publishText = (button) => (button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim();
        const scoped = [...document.querySelectorAll('div[class*="form-container"] div[class*="container-"] button')];
        let candidates = scoped.filter((button) => visible(button) && /^(发布|发布作品|发布图文|发布视频)$/.test(publishText(button)));
        if (!candidates.length) {
          candidates = [...document.querySelectorAll('button')].filter((button) => visible(button) && /^(发布|发布作品|发布图文|发布视频)$/.test(publishText(button)));
        }
        if (candidates.length !== 1) return { clicked: false, reason: candidates.length ? 'ambiguous' : 'not_found', candidates: candidates.length };
        candidates[0].click();
        return { clicked: true, reason: 'unique_visible_button', candidates: 1 };
      })()`)
      if (!clickResult || !clickResult.clicked) {
        task.stage = clickResult && clickResult.reason === 'ambiguous' ? 'publish_button_ambiguous' : 'publish_button_not_found'
        task.uncertain = false
        savePublishTasks([task])
        return { ok: false, error: task.stage === 'publish_button_ambiguous'
          ? `PUBLISH_BUTTON_AMBIGUOUS：发现 ${Number(clickResult && clickResult.candidates) || 0} 个候选按钮，已停止以避免重复发布`
          : 'PUBLISH_BUTTON_NOT_FOUND' }
      }
      task.stage = 'publish_clicked'
      task.uncertain = true
      savePublishTasks([task])
    } catch (e) {
      log('click publish EXCEPTION ' + String(e && e.message || e))
      return { ok: false, error: 'PUBLISH_CLICK_UNCERTAIN：' + String(e && e.message || e).slice(0, 120) }
    }

    log('waiting result')
    task.stage = 'waiting_result'
    savePublishTasks([task])
    let finalUrl = ''
    let navTimer = null
    const navDone = new Promise((resolve) => {
      const onNav = (e, url) => {
        finalUrl = url || ''
        if ((finalUrl || '').includes('content/manage')) resolve('manage')
      }
      const onInPage = (e, url) => {
        finalUrl = url || ''
        if ((finalUrl || '').includes('content/manage')) resolve('manage')
      }
      win.webContents.on('did-navigate', onNav)
      win.webContents.on('did-navigate-in-page', onInPage)
      navTimer = setTimeout(() => {
        try {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.removeListener('did-navigate', onNav)
            win.webContents.removeListener('did-navigate-in-page', onInPage)
          }
        } catch (e) {}
        resolve('timeout')
      }, 70000)
    })
    const navRes = await navDone
    if (navTimer) { clearTimeout(navTimer); navTimer = null }
    if (navRes === 'manage') {
      log('PUBLISH SUCCESS nav=' + finalUrl)
      task.uncertain = false
      return { ok: true, url: finalUrl }
    }
    let body = ''
    try {
      const rr = await dbg.sendCommand('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true })
      body = (rr && rr.result && rr.result.value) || ''
    } catch (e) {}
    const errM = body.match(/发布失败[^\n]{0,80}|提交失败[^\n]{0,60}|保存失败[^\n]{0,60}|网络错误[^\n]{0,60}/)
    if (errM) {
      log('PUBLISH ERR: ' + errM[0])
      task.uncertain = false
      savePublishTasks([task])
      return { ok: false, error: errM[0] }
    }
    // 抖音安全验证：发布时要求短信验证码（账号风控），明确报错
    const smsM = body.match(/接收短信验证码|请输入当前手机号|为确保是本人操作抖音账号/)
    if (smsM) {
      log('PUBLISH BLOCKED: 抖音要求短信验证（账号安全验证）')
      task.uncertain = false
      savePublishTasks([task])
      return { ok: false, error: 'NEED_SMS_VERIFY：抖音要求短信验证（账号安全验证），请打开创作者中心完成验证后重试' }
    }
    log('no nav, page tail: ' + JSON.stringify(body.slice(-200)))
    try {
      fs.appendFileSync(path.join(__dirname, 'publish-fail-dump.log'), `\n[${new Date().toISOString()}] ${task.id} ${task.title || ''}\n${body}\n`)
    } catch (e) {}
    return { ok: false, error: 'RESULT_TIMEOUT', detail: body.slice(-200) }
  } catch (e) {
    log('EXCEPTION ' + String(e && e.message || e))
    return { ok: false, error: String(e && e.message || e) }
  } finally {
    try { if (dbg && dbg.isAttached()) dbg.detach() } catch (e) {}
    try { win.destroy() } catch (e) {}
  }
}

function publishErrorCode(value) {
  const text = String(value || '')
  const match = text.match(/^([A-Z][A-Z0-9_]+)/)
  return match ? match[1] : (text ? 'PUBLISH_FAILED' : '')
}

function publishIntervalMs() {
  const seconds = Math.max(30, Math.min(3600, Number(loadLocalConfig().publishInterval) || 60))
  const jitter = 0.85 + Math.random() * 0.3
  return Math.round(seconds * 1000 * jitter)
}

async function preflightPublishAccount(task) {
  const account = loadAccounts().find((item) => item.platform === 'Douyin' && String(item.uid) === String(task.uid))
  if (!account || !account.partition) return { ok: false, kind: 'login_expired', message: 'INVALID_ACCOUNT：找不到对应抖音账号或持久分区' }
  task.partition = account.partition
  const health = await checkDouyinAccountHealth(account, { activityHeld: true })
  const decision = decidePublishAccountHealth(health, task.accountUnknownChecks)
  return { ...health, ...decision, account }
}

function pausePendingPublishTasksForAccount(uid, message, errorCode) {
  const changed = []
  for (const item of publishTasks) {
    if (item.status !== 'pending' || String(item.uid) !== String(uid)) continue
    item.status = 'paused'
    item.stage = 'account_paused'
    item.error = String(message || '账号需要人工处理').slice(0, 300)
    item.errorCode = String(errorCode || 'ACCOUNT_PAUSED')
    item.finishTime = Date.now()
    changed.push(item)
  }
  if (changed.length) savePublishTasks(changed)
  return changed.length
}

async function runOnePublishTask(task) {
  if (task.status !== 'pending') return false
  const policyAllowedAt = accountPolicyAllowedAt(task)
  if (policyAllowedAt > Date.now()) {
    task.deferredUntil = policyAllowedAt
    task.stage = 'policy_deferred'
    task.error = ''
    task.errorCode = ''
    savePublishTasks([task])
    return false
  }
  task.deferredUntil = 0
  task.stage = 'account_preflight'
  task.lastAttemptAt = Date.now()
  task.attempts = Number(task.attempts) + 1 || 1
  task.uncertain = false
  savePublishTasks([task])
  const preflight = await preflightPublishAccount(task)
  task.accountUnknownChecks = Number(preflight.unknownChecks) || 0
  if (!preflight.ok) {
    task.error = String(preflight.message || '账号状态不可用').slice(0, 300)
    if (preflight.action === 'defer') {
      task.status = 'pending'
      task.deferredUntil = Date.now() + Math.max(60000, Number(preflight.delayMs) || 5 * 60 * 1000)
      task.errorCode = preflight.errorCode || 'ACCOUNT_STATUS_UNKNOWN'
      task.stage = 'account_check_deferred'
      task.finishTime = 0
      savePublishTasks([task])
      return false
    }
    if (preflight.action === 'pause' && preflight.kind === 'account_unknown') {
      task.status = 'paused'
      task.errorCode = preflight.errorCode || 'ACCOUNT_UNVERIFIED'
      task.stage = 'account_check_unknown'
      task.finishTime = Date.now()
      savePublishTasks([task])
      pausePendingPublishTasksForAccount(task.uid, task.error, task.errorCode)
      return false
    }
    task.status = preflight.kind === 'risk_control' ? 'paused' : 'fail'
    task.errorCode = preflight.kind === 'risk_control' ? 'RISK_CONTROL' : 'ACCOUNT_OFFLINE'
    task.stage = 'preflight_failed'
    task.finishTime = Date.now()
    savePublishTasks([task])
    if (preflight.account) {
      try { getDouyinPublicCollector().setAlert(preflight.kind || 'login_expired', task.error, preflight.account) } catch (alertError) {}
    }
    pausePendingPublishTasksForAccount(task.uid, task.error, task.errorCode)
    return false
  }
  task.accountUnknownChecks = 0
  task.status = 'publishing'
  task.stage = 'starting'
  savePublishTasks([task])
  const result = await runDouyinImagePublish(task, () => {})
  // 任务被用户暂停/删除后，不再覆盖其状态。
  const stillThere = publishTasks.find((item) => item.id === task.id)
  if (result && result.error === 'CANCELLED') {
    if (stillThere) {
      task.status = 'paused'
      task.error = '已取消'
      task.errorCode = 'CANCELLED'
      task.stage = 'cancelled'
      task.finishTime = Date.now()
      savePublishTasks([task])
    }
    return true
  }
  if (!stillThere) return true
  const resultError = result && result.error ? String(result.error) : ''
  const errorCode = publishErrorCode(resultError)
  const resultUnknown = !!task.uncertain && (!result || !result.ok)
  task.status = result && result.ok ? 'success'
    : resultUnknown ? 'interrupted'
      : ['RISK_CONTROL', 'NEED_SMS_VERIFY'].includes(errorCode) ? 'paused' : 'fail'
  task.error = resultError.slice(0, 200)
  task.errorCode = resultUnknown ? 'RESULT_UNKNOWN' : errorCode
  task.stage = result && result.ok ? 'completed' : resultUnknown ? 'result_unknown' : 'failed'
  task.uncertain = !!resultUnknown
  task.finishTime = Date.now()
  savePublishTasks([task])
  if (result && result.ok && preflight.account) refreshAccountCredentialSnapshot(preflight.account).then(() => saveAccounts()).catch(() => {})
  if (['RISK_CONTROL', 'NEED_SMS_VERIFY', 'ACCOUNT_OFFLINE'].includes(errorCode) && preflight.account) {
    try {
      const collector = getDouyinPublicCollector()
      const kind = errorCode === 'ACCOUNT_OFFLINE' ? 'login_expired' : 'risk_control'
      collector.setAlert(kind, task.error || errorCode, preflight.account)
    } catch (alertError) {}
    pausePendingPublishTasksForAccount(task.uid, task.error || errorCode, errorCode)
  }
  try {
    fs.appendFileSync(path.join(__dirname, 'publish.log'), `[${new Date().toISOString()}] ${task.id} -> ${task.status} ${task.error}\n`)
  } catch (error) {}
  return true
}

async function runPublishQueue() {
  if (publishBusy) return
  if (douyinPublicCollector && douyinPublicCollector.running) return
  const activityToken = douyinActivity.acquire('publisher')
  if (!activityToken) return
  publishBusy = true
  try {
    const pending = publishTasks.filter((task) => publishTaskDueNow(task))
    for (const task of pending) {
      let attemptedPublish = false
      try {
        attemptedPublish = await runOnePublishTask(task)
      } catch (error) {
        const stillThere = publishTasks.find((item) => item.id === task.id)
        if (stillThere) {
          settleUnexpectedPublishError(task, error)
          try { savePublishTasks([task]) } catch (saveError) {}
        }
        try {
          fs.appendFileSync(path.join(__dirname, 'publish.log'), `[${new Date().toISOString()}] task ${task.id} error: ${String(error && error.message || error)}\n`)
        } catch (writeError) {}
      }
      const moreDue = publishTasks.some((item) => publishTaskDueNow(item))
      if (attemptedPublish && moreDue) await new Promise((resolve) => setTimeout(resolve, publishIntervalMs()))
    }
  } catch (error) {
    try {
      fs.appendFileSync(path.join(__dirname, 'publish.log'), `[${new Date().toISOString()}] queue error: ${String(error && error.message || error)}\n`)
    } catch (writeError) {}
  } finally {
    publishBusy = false
    douyinActivity.release(activityToken)
  }
}

function publishTaskToRecord(t) {
  return {
    id: t.id,
    localId: t.id,
    batchSource: t.batchSource,
    platform: t.platform,
    uid: t.uid,
    title: t.title,
    desc: t.desc,
    tags: t.tags,
    type: 'image',
    status: t.status === 'pending' ? (isTimedFuture(t) ? 6 : 0) : t.status === 'publishing' ? 1 : t.status === 'paused' ? 3 : t.status === 'success' ? 2 : 4,
    error: t.error,
    createdAt: t.createTime,
    updatedAt: t.finishTime || t.createTime,
    finishTime: t.finishTime,
    timing: t.timing || null,
    deferredUntil: Number(t.deferredUntil) || 0,
    effectiveDueAt: effectiveTaskDueAt(t),
    accountIds: t.uid ? [t.uid] : [],
    images: t.images,
    cover: t.cover,
    music: t.music || null,
    musicRequired: !!t.musicRequired,
    musicResult: t.musicResult || '',
    musicSelectionMethod: t.musicSelectionMethod || '',
    matchedMusic: t.matchedMusic || null,
    clientBatchId: t.clientBatchId || '',
    errorCode: t.errorCode || '',
    stage: t.stage || '',
    attempts: Number(t.attempts) || 0,
    uploadedCount: Number(t.uploadedCount) || 0,
    expectedImages: Number(t.expectedImages) || 0,
    uncertain: !!t.uncertain,
    accountUnknownChecks: Number(t.accountUnknownChecks) || 0,
    publishIntentAt: Number(t.publishIntentAt) || 0,
    commonValues: { title: t.title, desc: t.desc, tags: t.tags },
    uploadData: { images: t.images },
  }
}

/* 抖音图文发布完整链路测试：传图 + 标题 + 正文 + 点发布 + 轮询结果 */
async function testPublishFull(account) {
  const partition = account && account.partition
  if (!partition) return { error: 'NO_PARTITION' }
  const imgPath = account && account.imgPath
  if (!imgPath || !fs.existsSync(imgPath)) return { error: 'NO_IMG' }
  const out = { partition, steps: [] }
  const win = new BrowserWindow({ width: 1100, height: 800, show: true, webPreferences: { partition: partition } })
  let dbg = null
  try {
    await win.loadURL('https://creator.douyin.com/creator-micro/content/post/image')
    await new Promise((r) => setTimeout(r, 9000))
    dbg = win.webContents.debugger
    dbg.attach('1.3')
    dbg.on('message', (e, method, params) => {
      if (method === 'Page.fileChooserOpened') {
        dbg.sendCommand('DOM.setFileInputFiles', { files: [imgPath], backendNodeId: params.backendNodeId }).catch(() => {})
      }
    })
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })

    const clickUpload = async () => {
      const pt = await win.webContents.executeJavaScript(`(function(){
        const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => (el.innerText || '').includes('点击上传') && (el.innerText || '').includes('拖入此区域'));
        if (!hits.length) return null;
        let best = null, bestArea = Infinity;
        for (const el of hits) {
          const r = el.getBoundingClientRect();
          const a = r.width * r.height;
          if (a > 100 && a < bestArea) { bestArea = a; best = el; }
        }
        if (!best) return null;
        const r = best.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`)
      if (!pt) return false
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      return true
    }

    out.steps.push('click upload zone')
    if (!(await clickUpload())) { out.steps.push('NO_UPLOAD_ZONE'); return out }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const st = await win.webContents.executeJavaScript(`(function(){
        const zone = document.querySelector('div[class*="phone-screen"]');
        return { imgs: zone ? zone.querySelectorAll('img').length : 0 };
      })()`)
      if (st.imgs > 0) { out.steps.push('img uploaded'); break }
      if (i === 29) { out.steps.push('IMG_UPLOAD_TIMEOUT'); return out }
    }

    const title = '免费版自动化测试 ' + Date.now()
    const desc = '这是小V猫免费版自动化测试发布的图文内容，用于验证一键发布功能。'
    await win.webContents.executeJavaScript(`(function(){
      const input = document.querySelector('input[placeholder="添加作品标题"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(title)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const editor = document.querySelector('[contenteditable]');
      if (editor) { editor.innerText = ${JSON.stringify(desc)}; editor.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    })()`)
    out.steps.push('title+desc filled')
    await new Promise((r) => setTimeout(r, 1500))

    out.steps.push('click publish button')
    await win.webContents.executeJavaScript(`(function(){
      const btns = document.querySelectorAll('div[class*="form-container"] div[class*="container-"] button');
      let clicked = false;
      for (let i of btns) {
        if (i.innerText.includes('发布') && !i.disabled) { i.click(); clicked = true; }
      }
      if (!clicked) {
        const b2 = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '发布' && !b.disabled);
        if (b2) { b2.click(); clicked = true; }
      }
      return clicked;
    })()`)

    out.steps.push('waiting publish result...')
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const st = await win.webContents.executeJavaScript(`(function(){
        const body = document.body ? document.body.innerText : '';
        return {
          url: location.href,
          publishBtnGone: ![...document.querySelectorAll('button')].some((b) => (b.innerText || '').trim() === '发布'),
          hasSuccess: /发布成功|作品已发布|发布完成/.test(body),
          hasErr: /发布失败|保存失败|网络错误|提交失败/.test(body),
          tail: body.slice(-200),
        };
      })()`)
      if (st.hasSuccess || st.hasErr || (st.publishBtnGone && i > 5)) {
        out.final = st
        out.steps.push('RESULT at ' + i + 's')
        break
      }
      if (i === 59) { out.steps.push('NO_RESULT_60S'); out.final = st }
    }
  } catch (e) {
    out.error = String(e && e.message || e)
  } finally {
    try { if (dbg && dbg.isAttached()) dbg.detach() } catch (e) {}
    try { win.destroy() } catch (e) {}
  }
  try {
    fs.appendFileSync(path.join(__dirname, 'publish-probe.log'), '\n===== MUSIC ' + new Date().toISOString() + ' =====\n' + JSON.stringify(out, null, 1) + '\n')
  } catch (e) {}
  return out
}

/* 侦察音乐面板：打开面板 -> 搜索歌曲 -> 点击使用 -> 验证选中 */
async function probePublishMusicSelect(account) {
  const partition = account && account.partition
  if (!partition) return { error: 'NO_PARTITION' }
  const query = (account && (account.musicTitle || account.query)) || '踏遍青山'
  const out = { partition, query }
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: partition, backgroundThrottling: false } })
  let dbg = null
  try {
    await win.loadURL('https://creator.douyin.com/creator-micro/content/post/image')
    await new Promise((r) => setTimeout(r, 9000))
    dbg = win.webContents.debugger
    dbg.attach('1.3')
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    dbg.on('message', (e, method, params) => {
      if (method === 'Page.fileChooserOpened' && account.imgPath) {
        dbg.sendCommand('DOM.setFileInputFiles', { files: [account.imgPath], backendNodeId: params.backendNodeId }).catch(() => {})
      }
    })
    if (account.imgPath) {
      await win.webContents.executeJavaScript(`(function(){
        const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
          const t = (el.innerText || '').trim();
          return t.includes('点击上传') && t.includes('拖入此区域');
        });
        if (!hits.length) return null;
        let best = null, bestArea = Infinity;
        for (const el of hits) {
          const r = el.getBoundingClientRect();
          const a = r.width * r.height;
          if (a > 100 && a < bestArea) { bestArea = a; best = el; }
        }
        if (!best) return null;
        const r = best.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`).then(async (pt) => {
        if (!pt) return
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      })
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const n = await win.webContents.executeJavaScript(`(function(){ const z = document.querySelector('div[class*="phone-screen"]'); return z ? z.querySelectorAll('img').length : 0; })()`)
        if (n > 0) { out.uploaded = true; break }
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    const scrollMusicZone = await win.webContents.executeJavaScript(`(function(){
      const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
        const t = (el.innerText || '').trim();
        return t.includes('选择音乐') && t.length < 40;
      });
      let best = null, bestArea = Infinity;
      for (const el of hits) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > 50 && a < bestArea) { bestArea = a; best = el; }
      }
      if (!best) return false;
      best.scrollIntoView({ block: 'center' });
      return true;
    })()`)
    if (!scrollMusicZone) { out.step = 'NO_MUSIC_ZONE'; return out }
    await new Promise((r) => setTimeout(r, 800))
    const pt = await win.webContents.executeJavaScript(`(function(){
      const hits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
        const t = (el.innerText || '').trim();
        return t.includes('选择音乐') && t.length < 40;
      });
      let best = null, bestArea = Infinity;
      for (const el of hits) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > 50 && a < bestArea) { bestArea = a; best = el; }
      }
      if (!best) return null;
      const r = best.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)
    if (!pt) { out.step = 'NO_MUSIC_ZONE2'; return out }
    out.clickAt = pt
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 3000))
    const hasPanel = await win.webContents.executeJavaScript(`(function(){
      const inp = document.querySelector('input[placeholder="搜索音乐"]');
      return inp && inp.offsetParent !== null;
    })()`)
    out.panelOpen = !!hasPanel
    if (!hasPanel) { out.step = 'PANEL_NOT_OPEN'; return out }
    await win.webContents.executeJavaScript(`(function(){
      const inp = document.querySelector('input[placeholder="搜索音乐"]');
      if (!inp) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(query)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.focus();
      return true;
    })()`)
    out.typed = true
    const keyPt = await win.webContents.executeJavaScript(`(function(){
      const inp = document.querySelector('input[placeholder="搜索音乐"]');
      if (!inp) return null;
      const r = inp.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)
    if (keyPt) {
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: keyPt.x, y: keyPt.y })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: keyPt.x, y: keyPt.y, button: 'left', clickCount: 1 })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: keyPt.x, y: keyPt.y, button: 'left', clickCount: 1 })
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      out.enterSent = true
    }
    let rows = []
    let inputVal = ''
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const rr = await dbg.sendCommand('Runtime.evaluate', { expression: `(function(){
        const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '使用');
        return { val: (document.querySelector('input[placeholder="搜索音乐"]') || {}).value || '',
                 rows: btns.slice(0, 10).map((b) => {
          let p = b.parentElement;
          let row = b;
          for (let k = 0; k < 6 && p; k++, p = p.parentElement) {
            if ((p.innerText || '').includes('00:')) { row = p; break; }
          }
          return (row.innerText || '').replace(/\\n/g, '|').slice(0, 80);
        }) };
      })()`, returnByValue: true })
      const v = (rr && rr.result && rr.result.value) || {}
      inputVal = v.val || ''
      rows = v.rows || []
      if (rows.length) break
    }
    out.inputVal = inputVal
    out.rows = rows.slice(0, 10)
    if (!rows.length) {
      const dump = await win.webContents.executeJavaScript(`(function(){
        const panel = [...document.querySelectorAll('div.semi-portal')].find((p) => p.querySelector('input[placeholder="搜索音乐"]'));
        return panel ? { text: (panel.innerText || '').replace(/\\n/g, '|').slice(0, 600), imgs: panel.querySelectorAll('img').length } : null;
      })()`)
      out.panelText = dump
      out.step = 'NO_RESULTS'
      return out
    }
    const clicked = await win.webContents.executeJavaScript(`(function(){
      const btns = [...document.querySelectorAll('button')].filter((b) => (b.innerText || '').trim() === '使用');
      if (!btns.length) return false;
      const target = ${JSON.stringify(query)};
      let hit = null;
      for (const b of btns) {
        let best = null, bestLen = Infinity;
        let pp = b.parentElement;
        for (let k = 0; k < 7 && pp; k++, pp = pp.parentElement) {
          const t = (pp.innerText || '').trim();
          if (t.includes(target) && t.length < bestLen) { bestLen = t.length; best = pp; }
        }
        if (best && bestLen < 300) { hit = b; break; }
      }
      if (!hit) hit = btns[0];
      hit.click();
      return true;
    })()`)
    out.useClicked = !!clicked
    await new Promise((r) => setTimeout(r, 4000))
    const verify = await win.webContents.executeJavaScript(`(function(){
      const panelOpen = !!document.querySelector('input[placeholder="搜索音乐"]');
      const zoneHits = [...document.querySelectorAll('div,span,button,p')].filter((el) => {
        const t = (el.innerText || '').trim();
        return t.includes('选择音乐') && t.length < 60;
      });
      let zone = null, zoneArea = Infinity;
      for (const el of zoneHits) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > 50 && a < zoneArea) { zoneArea = a; zone = el; }
      }
      const selected = document.querySelector('span[class*="music-select-name"]');
      return { panelOpen, zoneText: zone ? (zone.innerText || '').trim().replace(/\\n/g, '|').slice(0, 80) : '', selectedText: selected ? selected.innerText.slice(0, 80) : '',
               bodyHasQuery: (document.body.innerText || '').includes(${JSON.stringify(query)}),
               delBtn: !!document.querySelector('span[class*="music-select-delete"], span[class*="music-select-icon2"], span[class*="music-select-replace"]'),
               bodyTail: (document.body.innerText || '').replace(/\\n/g, '|').slice(-600) };
    })()`)
    out.afterUse = verify
    try {
      const img = await win.webContents.capturePage()
      const shotPath = path.join(__dirname, 'probe-music-select-shot.png')
      fs.writeFileSync(shotPath, img.toPNG())
      out.shotPath = shotPath
    } catch (e) {
      out.shotErr = String(e && e.message || e)
    }
  } catch (e) {
    out.error = String(e && e.message || e)
  } finally {
    try { if (dbg && dbg.isAttached()) dbg.detach() } catch (e) {}
    try { win.destroy() } catch (e) {}
  }
  try {
    fs.appendFileSync(path.join(__dirname, 'publish-probe.log'), '\n===== MUSIC SELECT ' + new Date().toISOString() + ' =====\n' + JSON.stringify(out, null, 1) + '\n')
  } catch (e) {}
  return out
}


/* 图片上传测试：CDP 真实点击上传区 + fileChooser 拦截 + setFileInputFiles */
async function testPublishUpload(account) {
  const partition = account && account.partition
  if (!partition) return { error: 'NO_PARTITION' }
  const imgPath = account && account.imgPath
  if (!imgPath || !fs.existsSync(imgPath)) return { error: 'NO_IMG', imgPath }
  const out = { partition, imgPath, steps: [] }
  const win = new BrowserWindow({ width: 1100, height: 800, show: true, webPreferences: { partition: partition } })
  let dbg = null
  try {
    await win.loadURL('https://creator.douyin.com/creator-micro/content/post/image')
    await new Promise((r) => setTimeout(r, 9000))
    dbg = win.webContents.debugger
    dbg.attach('1.3')
    const chooser = new Promise((resolve) => {
      dbg.on('message', (e, method, params) => {
        if (method === 'Page.fileChooserOpened') resolve(params)
      })
    })
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    out.steps.push('intercept enabled')
    const pt = await win.webContents.executeJavaScript(`(function(){
      const all = [...document.querySelectorAll('div,span,button,p')];
      const hits = all.filter((el) => {
        const t = (el.innerText || '').trim();
        return t.includes('点击上传') && t.includes('拖入此区域');
      });
      if (!hits.length) return null;
      let best = hits[0], bestArea = Infinity;
      for (const el of hits) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > 100 && a < bestArea) { bestArea = a; best = el; }
      }
      const r = best.getBoundingClientRect();
      const chain = [];
      let n = best;
      for (let i = 0; n && i < 4; i++) { chain.push((n.tagName || '') + '.' + String(n.className || '').split(' ').slice(0, 2).join('.')); n = n.parentElement; }
      return {
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height),
        top: Math.round(r.top), bottom: Math.round(r.bottom), scrollY: window.scrollY, vh: window.innerHeight,
        chain: chain, html: best.outerHTML.slice(0, 260),
      };
    })()`)
    if (!pt) { out.steps.push('NO_UPLOAD_ZONE'); return out }
    const cx = pt.x
    const cy = pt.y
    out.steps.push('click target ' + cx + ',' + cy + ' rect=' + pt.w + 'x' + pt.h + '@' + pt.top + '-' + pt.bottom + ' scrollY=' + pt.scrollY + ' chain=' + pt.chain.join(' > '))
    win.webContents.focus()
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })
    const fc = await Promise.race([
      chooser,
      new Promise((res) => setTimeout(() => res({ timeout: true }), 12000)),
    ])
    if (fc.timeout) { out.steps.push('CHOOSER_TIMEOUT'); return out }
    out.steps.push('chooser: backendNodeId=' + fc.backendNodeId)
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [imgPath], backendNodeId: fc.backendNodeId })
    out.steps.push('files set, waiting upload...')
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const st = await win.webContents.executeJavaScript(`(function(){
        const zone = document.querySelector('div[class*="content-upload"]');
        if (!zone) return { empty: true };
        const imgs = zone.querySelectorAll('img');
        const texts = [...zone.querySelectorAll('span,div')].map((el) => (el.innerText || '').trim()).filter((t) => t && t.length < 20);
        return { imgs: imgs.length, texts: texts.slice(0, 6), htmlLen: zone.innerHTML.length };
      })()`)
      if (st.imgs > 0) { out.steps.push('UPLOADED imgs=' + st.imgs); out.final = st; break }
      if (i === 29) out.steps.push('NO_IMG_AFTER_30S')
    }
  } catch (e) {
    out.error = String(e && e.message || e)
  } finally {
    try { if (dbg && dbg.isAttached()) dbg.detach() } catch (e) {}
    try { win.destroy() } catch (e) {}
  }
  try {
    fs.appendFileSync(path.join(__dirname, 'publish-probe.log'), '\n===== UPLOAD ' + new Date().toISOString() + ' =====\n' + JSON.stringify(out, null, 1) + '\n')
  } catch (e) {}
  return out
}

/* 标题/正文填充测试：验证 React 受控组件的值能否注入 */
async function testPublishFill(account) {
  const partition = account && account.partition
  if (!partition) return { error: 'NO_PARTITION' }
  const out = { partition, steps: [] }
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: partition } })
  try {
    await win.loadURL('https://creator.douyin.com/creator-micro/content/post/image')
    await new Promise((r) => setTimeout(r, 9000))
    const title = '自动化测试标题 ' + Date.now()
    const desc = '自动化测试正文内容 ' + Date.now() + '\n第二行测试 #话题一 #话题二'
    const js = `(async function(){
      const out = {};
      const input = document.querySelector('input[placeholder="添加作品标题"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(title)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        out.titleAfterSet = input.value;
        out.titleLen = input.value.length;
      } else { out.titleAfterSet = 'NO_INPUT'; }
      await new Promise((r) => setTimeout(r, 800));
      out.titleAfterWait = input ? input.value : 'NO_INPUT';
      const editor = document.querySelector('[contenteditable]');
      if (editor) {
        editor.focus();
        const setter2 = Object.getOwnPropertyDescriptor(window.HTMLDivElement.prototype, 'innerText');
        editor.innerText = ${JSON.stringify(desc)};
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        out.editorAfterSet = editor.innerText;
      } else { out.editorAfterSet = 'NO_EDITOR'; }
      await new Promise((r) => setTimeout(r, 800));
      out.editorAfterWait = editor ? editor.innerText : 'NO_EDITOR';
      out.titleFinal = input ? input.value : 'NO_INPUT';
      return out;
    })()`
    out.dom = await win.webContents.executeJavaScript(js)
    await new Promise((r) => setTimeout(r, 500))
  } catch (e) {
    out.error = String(e && e.message || e)
  } finally {
    try { win.destroy() } catch (e) {}
  }
  try {
    fs.appendFileSync(path.join(__dirname, 'publish-probe.log'), '\n===== FILL ' + new Date().toISOString() + ' =====\n' + JSON.stringify(out, null, 1) + '\n')
  } catch (e) {}
  return out
}

/* 抖音图文发布页侦查：用账号分区打开发布页并 dump 关键 DOM 元素 */
async function probePublishPage(account) {
  const partition = account && (account.partition || account.partitionKey)
  if (!partition) return { error: 'NO_PARTITION' }
  const out = { partition, url: 'https://creator.douyin.com/creator-micro/content/post/image', loaded: false, steps: [] }
  try {
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: partition, backgroundThrottling: false } })
    await win.loadURL(out.url)
    await new Promise((r) => setTimeout(r, 12000))
    out.loaded = true
    const js = `(async function(){
      const out = { title: document.title, url: location.href, bodyLen: document.body ? document.body.innerHTML.length : 0 };
      try {
        const r = await fetch('https://creator.douyin.com/web/api/media/user/info/', { headers: { 'Accept': 'application/json' } });
        const j = await r.json();
        out.user = j && j.user ? { nickname: j.user.nickname, uid: j.user.uid, sec_uid: (j.user.sec_uid || '').slice(0, 12) } : j;
      } catch (e) { out.user = 'FETCH_ERR ' + String(e && e.message || e); }
      const texts = [...document.querySelectorAll('div,span,button')].map((el) => (el.innerText || '').trim()).filter((t) => t && t.length < 30 && /上传|图片|相册|选择/.test(t));
      out.clickableUpload = [...new Set(texts)].slice(0, 20);
      out.uploadish = [...document.querySelectorAll('[class*="upload" i],[class*="Upload" i],[class*="atlas"]')].map((el) => ({
        tag: el.tagName, cls: (el.className || '').slice(0, 90), role: el.getAttribute('role') || '',
      })).slice(0, 20);
      const zone = document.querySelector('div[class*="content-upload"]');
      out.zoneHtmlBefore = zone ? zone.outerHTML.slice(0, 600) : 'NO_ZONE';
      if (zone) {
        zone.click();
        await new Promise((r) => setTimeout(r, 1500));
        out.fileInputsAfterClick = [...document.querySelectorAll('input[type=file]')].map((el) => ({
          cls: (el.className || '').slice(0, 80), accept: el.accept || '', id: el.id || '', inShadow: !!el.getRootNode && el.getRootNode() !== document,
        }));
        out.zoneHtmlAfter = zone.outerHTML.slice(0, 600);
      }
      out.inputs = [...document.querySelectorAll('input')].map((el) => ({
        type: el.type, name: el.name, id: el.id, cls: (el.className || '').slice(0, 80),
        accept: el.accept || '', placeholder: el.placeholder || '',
      })).slice(0, 40);
      out.textareas = [...document.querySelectorAll('textarea')].map((el) => ({
        id: el.id, cls: (el.className || '').slice(0, 80), placeholder: el.placeholder || '',
      })).slice(0, 20);
      out.buttons = [...document.querySelectorAll('button')].map((el) => ({
        text: (el.innerText || '').trim().slice(0, 20), cls: (el.className || '').slice(0, 60),
      })).filter((b) => b.text).slice(0, 40);
      out.contenteditable = [...document.querySelectorAll('[contenteditable]')].map((el) => ({
        cls: (el.className || '').slice(0, 80),
      })).slice(0, 10);
      return out;
    })()`
    out.dom = await win.webContents.executeJavaScript(js)
    await new Promise((r) => setTimeout(r, 500))
    win.destroy()
    try {
      fs.appendFileSync(path.join(__dirname, 'publish-probe.log'), '\n===== ' + new Date().toISOString() + ' =====\n' + JSON.stringify(out, null, 1) + '\n')
    } catch (e) {}
  } catch (e) {
    out.error = String(e && e.message || e)
  }
  return out
}

function call(name, ...args) {
  try {
    if (name === 'LeadRadar.getKeywords') return leadRadar.getKeywords()
    if (name === 'LeadRadar.getDataInfo') return leadRadar.getDataInfo()
    if (name === 'LeadRadar.getOverview') return leadRadar.getOverview()
    if (name === 'LeadRadar.list') return leadRadar.list(args[0] || {})
    if (name === 'LeadRadar.createDiscoveryPlan') return leadRadar.createDiscoveryPlan(args[0] || {})
    if (name === 'LeadRadar.listDiscoveryTasks') return leadRadar.listDiscoveryTasks(args[0] || {})
    if (name === 'LeadRadar.updateDiscoveryTask') return leadRadar.updateDiscoveryTask(args[0] || {})
    if (name === 'LeadRadar.getEvents') return leadRadar.getEvents(args[0] || {})
    if (name === 'LeadRadar.getSources') return leadRadar.getSources(args[0] || {})
    if (name === 'LeadRadar.recognizeImage') return leadRadar.recognizeImage(args[0] || {})
    if (name === 'LeadRadar.importText') return leadRadar.importText(args[0] || {})
    if (name === 'LeadRadar.update') return leadRadar.update(args[0] || {})
    if (name === 'LeadRadar.revealContact') return leadRadar.revealContact(args[0] || {})
    if (name === 'LeadRadar.exportCsv') return leadRadar.exportCsv(args[0] || {})
    if (name === 'LeadRadar.exportAllJson') return exportAllBusinessData()
    if (name === 'GovCollector.getStatus') return governmentCollector.getStatus()
    if (name === 'GovCollector.getSettings') return governmentCollector.getSettings()
    if (name === 'GovCollector.updateSettings') return governmentCollector.updateSettings(args[0] || {})
    if (name === 'GovCollector.testWebSearch') return governmentCollector.testWebSearch()
    if (name === 'GovCollector.runNow') return governmentCollector.runNow(args[0] || {})
    if (name === 'GovCollector.getSources') return governmentCollector.getSources()
    if (name === 'GovCollector.listRuns') return governmentCollector.listRuns(args[0])
    if (name === 'GovCollector.listItems') return governmentCollector.listItems(args[0] || {})
    if (name === 'DouyinCollector.getStatus') return getDouyinPublicCollector().getStatus()
    if (name === 'DouyinCollector.runNow') return getDouyinPublicCollector().runNow(args[0] || {})
    if (name === 'DouyinCollector.checkAlertRecovery') return getDouyinPublicCollector().checkAlertRecovery()
    if (name === 'DouyinCollector.listEngagementCandidates') return getDouyinPublicCollector().listEngagementCandidates(args[0] || {})
    if (name === 'DouyinCollector.updateEngagementCandidate') return getDouyinPublicCollector().updateEngagementCandidate(args[0] || {})
    if (name === 'DouyinCollector.prepareEngagementReply') return getDouyinPublicCollector().prepareEngagementReply(args[0] || {})
    if (name === 'DouyinCollector.listEngagementActionLogs') return getDouyinPublicCollector().listEngagementActionLogs(args[0] || {})
    if (name === 'Maintenance.getStatus') return databaseMaintenance.getStatus()
    if (name === 'Maintenance.runNow') return databaseMaintenance.runNow(args[0] || {})
    if (name === 'Runtime.getStatus') {
      const douyinStatus = getDouyinPublicCollector().getStatus()
      const keepAwake = loadLocalConfig().automationKeepAwake !== false
      return {
        keepAwake,
        active: !!(publishBusy || governmentCollector.running || douyinPublicCollector.running),
        // 抖音公开线索增量采集默认持续启用；夜间由采集器自己的安全时段硬门禁暂停。
        automationEnabled: true,
        douyinQuiet: !!(douyinStatus.schedule && douyinStatus.schedule.quiet),
        message: douyinStatus.schedule && douyinStatus.schedule.quiet
          ? '24小时守护中；抖音夜间安全暂停，仅保留公开工程信息任务'
          : '24小时守护中；自动任务按安全节奏运行',
      }
    }
    if (name === 'Runtime.updateSettings') {
      const cfg = loadLocalConfig()
      cfg.automationKeepAwake = args[0] && args[0].keepAwake !== false
      saveLocalConfig()
      return { keepAwake: cfg.automationKeepAwake }
    }
    if (/AccountManager\.listenSession/i.test(name)) {
      const d = args[0] || {}
      const partition = d.partition
      const platform = d.platform || ''
      const accountUid = (d.account && (d.account.uid || d.account.id)) || null
      if (partition && !sessionPolls.has(partition)) {
        const emittedUids = new Set()
        const timer = setInterval(() => pollPartition(partition, platform, accountUid, emittedUids), 2500)
        sessionPolls.set(partition, { timer, emittedUids, accountUid })
      }
      return { success: true }
    }
    if (/AccountManager\.addAccount/i.test(name)) {
      const a = normalizeAccount(args[0] || {})
      if (a.uid !== undefined && a.uid !== null && a.uid !== '') {
        delete a.eventId
        const store = loadAccounts()
        const exists = store.find((x) => String(x.uid) === String(a.uid) && x.platform === a.platform)
        if (exists) {
          Object.assign(exists, a)
        } else {
          if (a.nickname === undefined || a.nickname === '') a.nickname = String(a.uid)
          if (a.avatar === undefined || a.avatar === '') a.avatar = DEFAULT_AVATAR
          store.push(a)
        }
        saveAccounts()
        // 抖音：保存后立即抓真实资料（昵称/头像），让前端第一次渲染就是对的
        if (a.platform === 'Douyin' && a.partition) {
          const uidStr = String(a.uid)
          return syncDouyinAccountProfile(a.partition, uidStr)
            .then(() => {
              // 兜底：资料抓取失败也延迟重试一次
              setTimeout(() => { syncDouyinAccountProfile(a.partition, uidStr).catch(() => {}) }, 4000)
              const latest = loadAccounts().find((x) => String(x.uid) === uidStr && x.platform === 'Douyin')
              return accountForRenderer(latest || a)
            })
            .catch(() => accountForRenderer(a))
        }
        return accountForRenderer(a)
      }
      return {}
    }
    if (/AccountManager\.getAllAccounts|AccountManager\.getAccountList/i.test(name)) {
      return loadAccounts().map(accountForRenderer)
    }
    if (/LoginAccount\.getUidAccount|getuidaccount/i.test(name)) {
      const uid = args[0]
      const platform = args[1]
      const hit = loadAccounts().find((x) => String(x.uid) === String(uid) && (!platform || x.platform === platform))
      return hit ? accountForRenderer(hit) : {}
    }
    if (/AccountManager\.removeAccount|delAccount|deleteAccount|removeaccount/i.test(name)) {
      const uid = args[0] && (args[0].uid || args[0].id || args[0])
      const store = loadAccounts()
      const idx = store.findIndex((x) => String(x.uid) === String(uid))
      if (idx > -1) {
        store.splice(idx, 1)
        saveAccounts()
      }
      return { success: true }
    }
    if (/AccountManager\.updateAccount|updateWorkerValues|updateaccount/i.test(name)) {
      const a = args[0] || {}
      const store = loadAccounts()
      const hit = store.find((x) => String(x.uid) === String(a.uid || a.id))
      if (hit) {
        Object.assign(hit, normalizeAccount(Object.assign({}, hit, a)))
        saveAccounts()
      }
      return { success: true }
    }
    if (/AccountManager\.getWorkerCall/i.test(name)) {
      const method = String(args[1] || '')
      const account = args[0]
      if (/getMusicCategory|getsongList|searchMusic/i.test(method)) {
        const payload = {}
        if (/getsongList/i.test(method)) {
          payload.category = (args[2] && typeof args[2] === 'object') ? args[2] : {}
          payload.offset = typeof args[3] === 'number' ? args[3] : 0
        } else if (/searchMusic/i.test(method)) {
          if (typeof args[2] === 'string') payload.keyword = args[2]
          payload.offset = args[3] && typeof args[3] === 'object' ? (args[3].offset || 0) : 0
        }
        const p = getWorkerMusicResult(account, method, payload)
        if (p && typeof p.then === 'function') {
          return p.then((r) => {
            if (r && !r.ok) {
              try {
                fs.appendFileSync(path.join(__dirname, 'music-debug.log'), `[${new Date().toISOString()}] ${method} -> ${JSON.stringify(r).slice(0, 600)}\n`)
              } catch (e) {}
            }
            if (/getMusicCategory/i.test(method)) {
              return (r && r.ok && r.categories) || []
            }
            return { songs: (r && r.ok && r.songs) || [], hasMore: false }
          })
        }
        return /getMusicCategory/i.test(method) ? [] : { songs: [], hasMore: false }
      }
      return {}
    }
    if (/Debug\.probePublishPage/i.test(name)) {
      return probePublishPage(args[0] || {})
    }
    if (/Debug\.getPublishLog/i.test(name)) {
      const n = Number((args[0] && args[0].lines) || 100)
      try {
        const txt = fs.readFileSync(path.join(__dirname, 'publish.log'), 'utf8')
        const lines = txt.split(/\r?\n/).filter(Boolean)
        return { lines: lines.slice(-n) }
      } catch (e) {
        return { lines: [] }
      }
    }
    if (/Debug\.checkAccountLogin/i.test(name)) {
      const account = args[0] || {}
      return checkDouyinAccountHealth(account)
    }
    if (/Debug\.checkAllLogin/i.test(name)) {
      const list = (Array.isArray(args[0]) && args[0].length) ? args[0] : loadAccounts()
      return (async () => {
        const results = []
        for (const a of list) {
          const p = a.partition
          let login = false
          let cookieNames = []
          if (p) {
            try {
              const cookies = await session.fromPartition(p).cookies.get({})
              const map = {}
              for (const c of cookies) { if (!map[c.name]) map[c.name] = c.value; cookieNames.push(c.name) }
              login = !!(map['sessionid'] || map['sessionid_ss'] || map['sid_guard'] || map['sid_tt'] || map['d_ticket'] || map['passport_auth_status'])
            } catch (e) {}
          }
          results.push({ uid: String(a.uid), login: login, cookies: cookieNames.slice(0, 20) })
        }
        return results
      })()
    }
    if (/Debug\.testPublishFill/i.test(name)) {
      return testPublishFill(args[0] || {})
    }
    if (/Debug\.testPublishUpload/i.test(name)) {
      return testPublishUpload(args[0] || {})
    }
    if (/Debug\.testPublishFull/i.test(name)) {
      return testPublishFull(args[0] || {})
    }
    if (/Debug\.probePublishTiming/i.test(name)) {
      return probePublishTiming(args[0] || {})
    }
    if (/Debug\.probePublishMusicSelect/i.test(name)) {
      return probePublishMusicSelect(args[0] || {})
    }
    if (/Debug\.probePublishMusic/i.test(name)) {
      return probePublishMusic(args[0] || {})
    }
    if (/Debug\.getPublishTasks/i.test(name)) {
      return { tasks: publishTasks }
    }
    if (/^(Models|AccountTaskManager|PublishController|PublishWindowManager|Cleaner)\.|^db:/i.test(name)) {
      if (/PublishController\.bulkCreateWithStat/i.test(name)) {
        const request = args[0]
        const list = Array.isArray(request) ? request : (request && Array.isArray(request.tasks) ? request.tasks : [])
        const requestId = String(!Array.isArray(request) && request && request.requestId
          || (list[0] && list[0].clientBatchId) || '')
        const rememberedIds = requestId ? publishTaskStore.getBatchTaskIds(requestId) : []
        const remembered = requestId
          ? publishTasks.filter((task) => task.clientBatchId === requestId || rememberedIds.includes(String(task.id)))
          : []
        if (remembered.length) {
          return { list: remembered.map(publishTaskToRecord), total: remembered.length,
            paused: remembered.filter((task) => task.status === 'paused').length, duplicateRequest: true, rejected: [] }
        }
        const store = loadAccounts()
        const created = []
        const rejected = []
        try {
          const dump = list.slice(0, 10).map((t, i) => {
            const fd = (t && t.formData) || {}
            const g = (m) => (m ? { title: m.title, author: m.author, id_str: m.id_str, duration: m.duration } : null)
            return {
              i,
              uid: t && t.uid,
              title: (t && t.title || '').slice(0, 30),
              music: g(t && t.music),
              fdCAT_music: g(fd.CAT_music),
              fdDouyinCAT_music: g(fd.Douyin_CAT_music),
              fdKeys: Object.keys(fd).filter((k) => /music/i.test(k)),
            }
          })
          fs.appendFileSync(path.join(__dirname, 'publish.log'), `[${new Date().toISOString()}] bulkCreatePayload ${JSON.stringify(dump)}\n`)
        } catch (e) {}
        for (let index = 0; index < list.length; index++) {
          const t = list[index]
          const task = normalizeTaskFromFrontend(t)
          task.clientBatchId = requestId || task.clientBatchId
          if (task.platform !== 'Douyin') { rejected.push({ index, reason: 'UNSUPPORTED_PLATFORM' }); continue }
          if (!task.images.length) { rejected.push({ index, reason: 'NO_IMAGES' }); continue }
          const missing = task.images.find((imagePath) => !fs.existsSync(imagePath))
          if (missing) { rejected.push({ index, reason: 'IMAGE_NOT_FOUND', detail: String(missing).slice(0, 180) }); continue }
          const acc = store.find((x) => String(x.uid) === String(task.uid) && x.platform === 'Douyin')
          if (acc && acc.partition) task.partition = acc.partition
          else if (!task.partition) { rejected.push({ index, reason: 'INVALID_ACCOUNT' }); continue }
          created.push(task)
        }
        let inserted = []
        if (requestId && created.length) {
          // 任务与幂等标记在同一 SQLite 事务内落盘；即使响应前崩溃，重试也不会重复创建或发布。
          const batch = publishTaskStore.createBatchWithTasks(requestId, created)
          if (batch.created) {
            inserted = pushPublishTasks(created, { persist: false })
          } else {
            const rememberedIds = new Set(batch.taskIds.map(String))
            const loaded = publishTaskStore.loadTasks().filter((task) => rememberedIds.has(String(task.id)))
            pushPublishTasks(loaded, { persist: false })
            const remembered = publishTasks.filter((task) => rememberedIds.has(String(task.id)))
            return { list: remembered.map(publishTaskToRecord), total: remembered.length,
              paused: remembered.filter((task) => task.status === 'paused').length, duplicateRequest: true, rejected: [] }
          }
        } else {
          inserted = pushPublishTasks(created)
        }
        if (inserted.length) {
          try {
            fs.appendFileSync(path.join(__dirname, 'publish.log'), `[${new Date().toISOString()}] bulkCreate ${created.length} tasks: ${created.map((t) => t.id + ':' + t.title + '[' + t.images.length + 'img]' + (isTimedFuture(t) ? '[timed@' + new Date(parseTiming(t.timing).time).toLocaleString() + ']' : '')).join(' | ')}\n`)
          } catch (e) {}
        }
        ensureTimedScheduler()
        // 定时时间已过/立即的任务：创建后立即触发队列，不等扫描器
        const hasDueNow = inserted.some((t) => {
          const d = parseTiming(t.timing)
          return !d || d.time <= Date.now()
        })
        if (hasDueNow) runPublishQueue().catch(() => {})
        return { list: inserted.map(publishTaskToRecord), total: inserted.length,
          paused: inserted.filter((task) => task.status === 'paused').length, inputTotal: list.length, rejected }
      }
      if (/PublishController\.startPublishTask/i.test(name)) {
        runPublishQueue().catch(() => {})
        return { success: true }
      }
      if (/PublishController\.updateTaskStatus|PublishController\.updateItem/i.test(name)) {
        const u = args[0] || {}
        const hit = publishTasks.find((x) => x.id === String(u.id || u.localId || ''))
        if (!hit) return { success: false, error: 'TASK_NOT_FOUND' }
        const nextStatus = u.status === undefined ? hit.status : String(u.status)
        if (hit.status === 'publishing' && nextStatus !== 'paused') return { success: false, error: 'TASK_IS_PUBLISHING' }
        if (hit.uncertain && nextStatus === 'pending' && !u.confirmedAfterCheck) {
          return { success: false, error: 'RESULT_UNKNOWN_REQUIRES_CONFIRMATION' }
        }
        if (u.status !== undefined) hit.status = nextStatus
        if (u.error !== undefined) hit.error = String(u.error || '').slice(0, 300)
        if (nextStatus === 'pending') {
          hit.uncertain = false
          hit.publishIntentAt = 0
          hit.errorCode = ''
          hit.stage = 'queued'
          hit.finishTime = 0
          hit.deferredUntil = 0
        }
        savePublishTasks([hit])
        return { success: true, task: publishTaskToRecord(hit) }
      }
      if (/PublishController\.deleteTask/i.test(name)) {
        const u = args[0] || {}
        const ids = Array.isArray(u) ? u.map(String) : String(u.id || u.localId || '').split(',').filter(Boolean)
        const before = publishTasks.length
        const removed = []
        for (let i = publishTasks.length - 1; i >= 0; i--) {
          if (!ids.includes(String(publishTasks[i].id))) continue
          if (publishTasks[i].status === 'publishing') continue
          removed.push(String(publishTasks[i].id))
          publishTasks.splice(i, 1)
        }
        if (removed.length) publishTaskStore.deleteTasks(removed)
        return { success: true, deleted: before - publishTasks.length, blocked: ids.length - removed.length }
      }
      if (/PublishController\.clearTasks/i.test(name)) {
        const u = args[0] || {}
        const statuses = Array.isArray(u.status) ? u.status.map(String) : (u.status ? [String(u.status)] : null)
        const before = publishTasks.length
        const removed = []
        for (let i = publishTasks.length - 1; i >= 0; i--) {
          const t = publishTasks[i]
          if (t.status === 'publishing') continue
          if (!statuses || statuses.includes(String(t.status))) {
            removed.push(String(t.id))
            publishTasks.splice(i, 1)
          }
        }
        if (removed.length) publishTaskStore.deleteTasks(removed)
        return { success: true, deleted: before - publishTasks.length }
      }
      if (/PublishLog\.(queryAll|getBatchSourceOptions)/i.test(name)) {
        if (/getBatchSourceOptions/i.test(name)) {
          return [...new Set(publishTasks.map((t) => String(t.batchSource || '')).filter(Boolean))]
            .sort((a, b) => b.localeCompare(a))
        }
        const rows = publishTasks.map(publishTaskToRecord).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        return { list: rows, total: rows.length }
      }
      if (/PublishTaskStat\.querySummary/i.test(name)) {
        const total = publishTasks.length
        const succ = publishTasks.filter((t) => t.status === 'success').length
        const fail = publishTasks.filter((t) => t.status === 'fail').length
        const today0 = new Date()
        today0.setHours(0, 0, 0, 0)
        const todayC = publishTasks.filter((t) => t.createTime >= today0.getTime()).length
        const todayS = publishTasks.filter((t) => t.status === 'success' && t.finishTime >= today0.getTime()).length
        const accMap = new Map()
        for (const t of publishTasks) {
          const key = t.platform + ':' + t.uid
          if (!accMap.has(key)) accMap.set(key, { platform: t.platform, uid: t.uid, createCount: 0, successCount: 0, failCount: 0 })
          const a = accMap.get(key)
          a.createCount++
          if (t.status === 'success') a.successCount++
          if (t.status === 'fail') a.failCount++
        }
        return {
          overview: {
            createCount: total,
            successCount: succ,
            failCount: fail,
            todayCreateCount: todayC,
            todaySuccessCount: todayS,
            successRate: total ? Math.round((succ / total) * 10000) / 100 : 0,
          },
          accountList: [...accMap.values()],
          dailyList: [],
        }
      }
      if (/Order\.queryAll|Order\.getLocalCount/i.test(name)) {
        return /getLocalCount/i.test(name) ? 0 : { list: [], total: 0 }
      }
      if (/FormHistory\.getHistoryList|AccountTask\.loadAll|MsgRecord\.findAllJson|PublishLog\.getBatchSourceOptions/i.test(name)) {
        return []
      }
      if (/FormHistory\.getFormData/i.test(name)) return {}
      if (/getPublishPageStatus|PublishWindowManager\.show/i.test(name)) return null
      return { success: true }
    }
    if (/vipinfo|getvip|userinfo|user_info|getuser|loginstatus|islogin|is_login|accountinfo|userinfo2|getme|getself/i.test(name)) {
      return Object.assign({}, VIP_USER)
    }
    if (/\.init$/i.test(name)) {
      return Object.assign({}, VIP_USER)
    }
    if (/runner\.exit|app\.quit|quitapp|shutdown/i.test(name)) {
      try { require('electron').app.exit(0) } catch (e) {}
      return { success: true }
    }
    if (/runner\.relaunch|restart/i.test(name)) {
      try { const { app } = require('electron'); app.relaunch(); app.exit(0) } catch (e) {}
      return { success: true }
    }
    if (/grouplist|taglist|product|coupon|category|platformlist|accountlist|getlist|list$|getallaccounts|getaccounts|getgroups|platkeys|serializ/i.test(name)) {
      return /platkeys|serializ/i.test(name) ? PLATFORM_LIST : []
    }
    if (/downloadmodule|loadall|accounttmpl|verifyresults/i.test(name)) {
      return []
    }
    if (/createorder|create_order|pay|order|renew|charge/i.test(name)) {
      return { errno: 0, order_id: 'free-' + Date.now(), message: 'ok' }
    }
    if (/logout|delete|remove|delaccount|quit/i.test(name)) {
      return { errno: 0, success: true }
    }
    if (/LocalConfig\.getItem/i.test(name)) {
      return loadLocalConfig()[args[0]]
    }
    if (/LocalConfig\.setItem/i.test(name)) {
      const cfg = loadLocalConfig()
      cfg[args[0]] = args[1]
      saveLocalConfig()
      return { success: true }
    }
    if (/Chrome\.getActiveExternalBrowser/i.test(name)) {
      return detectExternalBrowser()
    }
    if (/Chrome\.checkExternalBrowserPath/i.test(name)) {
      return detectExternalBrowser()
    }
    if (/Chrome\.openAccountInExternalBrowser/i.test(name)) {
      let key = args[0]
      let partition = null
      let url = ''
      let account = null
      let proxy = null
      for (const a of args.slice(1)) {
        if (a && typeof a === 'object' && (a.uid !== undefined || a.cookieData !== undefined || a.platform !== undefined)) {
          account = a
        } else if (typeof a === 'string' && a.indexOf('persist:') === 0) {
          partition = a
        } else if (typeof a === 'string' && a.indexOf('http') === 0) {
          url = a
        } else if (a && typeof a === 'object' && (a.id !== undefined || a.host !== undefined)) {
          proxy = a
        }
      }
      const camo = detectCamoufox()
      if (camo.exists) {
        return openAccountInCamoufox(account, url, proxy)
      }
      return { success: false, message: camo.missingMessage || '未检测到可用的外部浏览器' }
    }
    if (/Chrome\.checkManagedBrowserPath|Chrome\.downloadManagedBrowser/i.test(name)) {
      return {
        exists: false,
        executablePath: null,
        missingMessage: '托管浏览器(CloakBrowser)功能在免费版中不可用，请使用比特浏览器（外部浏览器打开）。',
      }
    }
    if (/Chrome\.getSystemInfo/i.test(name)) {
      return { platform: process.platform, arch: process.arch }
    }
    if (/config|setting|option|preference/i.test(name)) {
      return {}
    }
    return {}
  } catch (e) {
    if (/^(LeadRadar|GovCollector|DouyinCollector|Maintenance|Runtime|PublishController|PublishLog|PublishTaskStat)\./.test(String(name || ''))) throw e
    return {}
  }
}

module.exports = {
  setRoot(root) {},
  isDev: false,
  manifest: null,
  _getCall(name, ...args) {
    return call(name, ...args)
  },
  _getValue(d) {
    try {
      let keys = (d && d.keys) || []
      if (typeof keys === 'string') keys = [keys]
      const o = {}
      keys.forEach((k) => {
        if (/userinfo|user_info/i.test(k)) {
          o[k] = Object.assign({}, VIP_USER)
        } else if (/manifest/i.test(k)) {
          o[k] = { env: 'public', name: '小V猫', version: '2.0.0' }
        } else if (/serializ/i.test(k)) {
          o[k] = PLATFORM_LIST
        } else {
          o[k] = null
        }
      })
      return keys.length === 1 ? o[keys[0]] : o
    } catch (e) {
      return {}
    }
  },
  _addListener(d, cb) {
    if (d && d.name && d.name.startsWith('webview:')) {
      const partition = d.name.slice('webview:'.length)
      webviewListeners.set(partition, { id: d.id, cb })
    }
    return d && d.id
  },
  _removeListener(d) {
    try {
      const id = typeof d === 'string' ? d : d && d.id
      const m = typeof id === 'string' ? id.match(/webview:(.+):\d+$/) : null
      if (m) {
        const partition = m[1]
        const poll = sessionPolls.get(partition)
        if (poll) {
          clearInterval(poll.timer)
          sessionPolls.delete(partition)
        }
        webviewListeners.delete(partition)
      }
    } catch (e) {}
    return true
  },
}

/* 启动时注册本地定时调度（重启后恢复未到点的定时任务） */
try {
  ensureTimedScheduler()
} catch (e) {}
