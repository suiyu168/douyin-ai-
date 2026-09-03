/* 发布助手 - 全新前端（零依赖，深色主题） */
'use strict'

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

const state = {
  accounts: [],
  accMap: {},
  selectedAccounts: new Set(),
  images: [],
  music: null,
  tasks: [],
  loginHealth: {},
}

let currentPage = 'publish'
let loginFastBusy = false
let loginVerifyBusy = false
let accountLoadRetryTimer = null
let accountLoadRetryAttempts = 0
const ACCOUNT_LOAD_RETRY_LIMIT = 36

let toastTimer = null
function toast(msg, ok) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.toggle('ok', !!ok)
  el.classList.toggle('err', !ok)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.className = 'toast hidden' }, 3200)
}

function setStatus(text, cls) {
  $('#statusText').textContent = text
  const dot = $('#statusDot')
  dot.className = 'status-dot' + (cls ? ' ' + cls : '')
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason
  toast('操作失败：' + String((reason && reason.message) || reason || '未知错误').slice(0, 120))
  if (currentPage === 'tasks') loadTasks().catch(() => {})
})

/* ===== Navigation ===== */
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    $$('.page').forEach((p) => p.classList.remove('active'))
    $('#page-' + btn.dataset.page).classList.add('active')
    const page = btn.dataset.page
    currentPage = page
    document.body.dataset.page = page
    if (page === 'batch') { renderBatchAccountGrid(); renderBatchPosts() }
    if (page === 'browser') renderAccSideList()
    if (page === 'radar' && window.LeadRadarUI) window.LeadRadarUI.load()
    if (page === 'stats') loadStats()
    if (page === 'settings') { loadSettings(); loadLog() }
    if (page === 'tasks') loadTasks().catch(() => {})
  })
})

/* ===== Accounts ===== */
async function loadAccounts() {
  const list = await CatBridge.getCall('AccountManager.getAllAccounts')
  state.accounts = Array.isArray(list) ? list : []
  for (const a of state.accounts) {
    if (a.uid != null) a.uid = String(a.uid)
    const uid = String(a.uid)
    if (!state.loginHealth[uid] && ['online', 'offline', 'unknown', 'suspect'].includes(String(a.healthState || ''))) {
      state.loginHealth[uid] = {
        state: String(a.healthState),
        reason: String(a.healthReason || ''),
        checkedAt: Number(a.healthCheckedAt) || 0,
        definitive: ['online', 'offline'].includes(String(a.healthState)),
      }
    }
  }
  state.accMap = {}
  for (const a of state.accounts) state.accMap[String(a.uid)] = a.nickname || a.uid
  renderAccountGrid()
  renderAccountsTable()
  renderAccSideList()
  refreshLoginStates()
  return state.accounts
}

function cancelAccountLoadRetry() {
  if (accountLoadRetryTimer) clearTimeout(accountLoadRetryTimer)
  accountLoadRetryTimer = null
}

function scheduleAccountLoadRetry() {
  if (accountLoadRetryTimer || accountLoadRetryAttempts >= ACCOUNT_LOAD_RETRY_LIMIT) return
  const delay = Math.min(10000, 2500 + accountLoadRetryAttempts * 250)
  accountLoadRetryTimer = setTimeout(async () => {
    accountLoadRetryTimer = null
    accountLoadRetryAttempts++
    try {
      const accounts = await loadAccounts()
      setStatus('已连接', 'ok')
      renderBatchAccountGrid()
      if (accounts.length) {
        accountLoadRetryAttempts = 0
        cancelAccountLoadRetry()
      } else {
        // 启动早期后端可能暂时返回空列表；短期复检，真正无账号时达到上限后自然停止。
        scheduleAccountLoadRetry()
      }
    } catch (error) {
      setStatus('正在连接...', '')
      scheduleAccountLoadRetry()
    }
  }, delay)
}

async function loadAccountsWithRecovery(options = {}) {
  try {
    const accounts = await loadAccounts()
    setStatus('已连接', 'ok')
    if (accounts.length) {
      accountLoadRetryAttempts = 0
      cancelAccountLoadRetry()
    } else {
      scheduleAccountLoadRetry()
    }
    if (options.manual) toast(accounts.length ? `已加载 ${accounts.length} 个账号` : '账号服务已连接，当前列表为空', true)
    return accounts
  } catch (error) {
    setStatus('正在连接...', '')
    scheduleAccountLoadRetry()
    if (options.manual) toast('账号服务正在启动，已自动重试')
    return []
  }
}

/* 快速登录检测：读各账号分区 cookie（sessionid），秒级，更新在线/离线显示 */
async function refreshLoginStates() {
  if (loginFastBusy) return
  loginFastBusy = true
  try {
    const res = await CatBridge.getCall('Debug.checkAllLogin', state.accounts)
    if (!Array.isArray(res)) return
    for (const r of res) {
      const a = state.accounts.find((x) => String(x.uid) === String(r.uid))
      if (!a) continue
      const old = state.loginHealth[String(a.uid)] || {}
      const savedState = ['online', 'offline'].includes(String(a.healthState || '')) ? String(a.healthState) : ''
      const lastVerifiedState = ['online', 'offline'].includes(old.state) ? old.state : savedState
      state.loginHealth[String(a.uid)] = Object.assign({}, old, {
        // 快速检测只说明凭据是否还在，不能把完整在线检测结果每分钟覆盖成“检测中”。
        state: r.login ? (lastVerifiedState || 'unknown') : (lastVerifiedState === 'offline' ? 'offline' : 'suspect'),
        reason: r.login ? 'COOKIE_PRESENT' : 'COOKIE_MISSING',
        fastCheckedAt: Date.now(),
      })
    }
  } catch (e) {}
  finally { loginFastBusy = false }
  renderLoginHealth()
}

function loginMeta(a) {
  const h = state.loginHealth[String(a.uid)] || {}
  if (h.state === 'online') return { cls: 'success', side: 'on', text: '在线' }
  if (h.state === 'offline') return { cls: 'fail', side: '', text: '已掉线' }
  if (h.state === 'busy') return { cls: 'warning', side: 'checking', text: '任务中待复检' }
  if (h.state === 'unknown' || h.state === 'suspect') return { cls: 'warning', side: 'checking', text: '待复检' }
  if (h.state === 'checking') return { cls: 'info', side: 'checking', text: '检测中' }
  return a.isLogin ? { cls: 'success', side: 'on', text: '在线' } : { cls: 'fail', side: '', text: '未登录' }
}

function renderLoginHealth() {
  renderAccSideList()
  renderAccountsTable()
  renderAccountGrid()
  renderBatchAccountGrid()
  const el = $('#accountHealthSummary')
  if (!el) return
  const douyin = state.accounts.filter((a) => a.platform === 'Douyin')
  const counts = { online: 0, offline: 0, uncertain: 0 }
  for (const a of douyin) {
    const s = (state.loginHealth[String(a.uid)] || {}).state
    if (s === 'online') counts.online++
    else if (s === 'offline') counts.offline++
    else counts.uncertain++
  }
  el.innerHTML = `<div><strong>账号健康</strong><span>在线 ${counts.online}</span><span class="health-bad">掉线 ${counts.offline}</span><span>待复检 ${counts.uncertain}</span></div><small>每分钟检查凭据，每 10 分钟做一次在线验证；网络波动不会再误判掉线</small>`
  el.classList.toggle('has-problem', counts.offline > 0)
  const alert = $('#loginHealthAlert')
  if (alert) {
    const offlineNames = douyin.filter((a) => (state.loginHealth[String(a.uid)] || {}).state === 'offline').map((a) => a.nickname || a.uid)
    alert.classList.toggle('hidden', offlineNames.length === 0)
    $('#loginHealthAlertMessage').textContent = offlineNames.length ? `：${offlineNames.join('、')}。已暂停把网络异常误判为掉线，请尽快重新登录。` : ''
  }
}

async function verifyLoginStates(options) {
  if (loginVerifyBusy) return null
  loginVerifyBusy = true
  const manual = !!(options && options.manual)
  const result = { online: 0, offline: 0, unknown: 0, details: [] }
  try {
    for (const a of state.accounts) {
      if (a.platform !== 'Douyin') continue
      const uid = String(a.uid)
      const previous = state.loginHealth[uid] || {}
      // 后台巡检不闪烁覆盖已有结果；只有用户手动点击时才短暂显示检测中。
      if (manual) {
        state.loginHealth[uid] = { ...previous, state: 'checking', checkedAt: Date.now() }
        renderAccSideList()
      }
      try {
        const r = await CatBridge.getCall('Debug.checkAccountLogin', a)
        if (r && (r.busy || r.state === 'busy' || r.reason === 'ACTIVITY_BUSY')) {
          const restoredState = ['online', 'offline', 'unknown', 'suspect'].includes(previous.state)
            ? previous.state : ['online', 'offline', 'unknown'].includes(String(a.healthState || '')) ? String(a.healthState) : 'unknown'
          state.loginHealth[uid] = {
            ...previous,
            state: restoredState === 'checking' ? 'unknown' : restoredState,
            reason: 'ACTIVITY_BUSY',
            deferredAt: Date.now(),
          }
          result.unknown++
          result.details.push((a.nickname || a.uid) + ':任务中待复检')
          continue
        }
        const nextState = r && r.state ? r.state : (r && r.login ? 'online' : 'unknown')
        state.loginHealth[uid] = {
          state: nextState,
          reason: (r && r.reason) || '',
          checkedAt: (r && r.checkedAt) || Date.now(),
          definitive: !!(r && r.definitive),
        }
        if (nextState === 'online') result.online++
        else if (nextState === 'offline') result.offline++
        else result.unknown++
        result.details.push((a.nickname || a.uid) + ':' + (nextState === 'online' ? '在线' : nextState === 'offline' ? '掉线' : '待复检'))
        if (r && r.definitive && (nextState === 'online' || nextState === 'offline')) {
          const isLogin = nextState === 'online'
          if (!!a.isLogin !== isLogin) {
            a.isLogin = isLogin
            await CatBridge.getCall('AccountManager.updateAccount', { uid: a.uid, isLogin }).catch(() => {})
          }
        }
      } catch (e) {
        result.unknown++
        state.loginHealth[uid] = { ...previous, state: previous.state === 'online' || previous.state === 'offline' ? previous.state : 'unknown', reason: 'CHECK_FAILED', checkedAt: Date.now() }
      }
    }
  } finally {
    loginVerifyBusy = false
    renderLoginHealth()
  }
  if (manual) toast(`检测完成：在线 ${result.online}，掉线 ${result.offline}，待复检 ${result.unknown}`, result.offline === 0)
  return result
}

function renderAccSideList() {
  const wrap = $('#accSideList')
  const kw = ($('#accSearch').value || '').trim().toLowerCase()
  let list = state.accounts
  if (kw) {
    list = list.filter((a) =>
      (a.nickname || '').toLowerCase().includes(kw) ||
      String(a.uid).includes(kw) ||
      (a.remark || '').toLowerCase().includes(kw)
    )
  }
  if (!list.length) {
    wrap.innerHTML = '<div class="empty" style="padding:16px">' + (state.accounts.length ? '没有匹配的账号' : '暂无账号，点击上方「+ 添加账号」') + '</div>'
    return
  }
  wrap.innerHTML = ''
  for (const a of list) {
    if (a.platform !== 'Douyin') continue
    const item = document.createElement('div')
    item.className = 'acc-side-item' + (currentBrowserUid && String(a.uid) === currentBrowserUid ? ' active' : '')
    const initial = (a.nickname || '?').slice(0, 1)
    item.innerHTML = `
      <div class="side-avatar">${a.avatar ? '<img src="' + esc(a.avatar) + '" onerror="this.style.display=\'none\'">' : ''}<span>${initial}</span></div>
      <div class="side-info">
        <div class="side-name">${esc(a.nickname || a.uid)}</div>
        <div class="side-uid">${esc(String(a.uid))}</div>
      </div>
      <div class="side-state ${loginMeta(a).side}">${loginMeta(a).text}</div>
      <button class="side-del" data-del="${esc(String(a.uid))}" title="删除账号">×</button>`
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('side-del')) return
      openAccountInBrowser(a)
    })
    item.querySelector('.side-del').addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('确认删除账号 ' + (a.nickname || a.uid) + '？')) return
      await CatBridge.getCall('AccountManager.removeAccount', { uid: a.uid })
      toast('已删除', true)
      loadAccounts()
    })
    wrap.appendChild(item)
  }
}

$('#accSearch').addEventListener('input', renderAccSideList)
$('#btnAddAccountSide').addEventListener('click', startAddAccount)
$('#btnManageGroupsSide').addEventListener('click', () => {
  renderGroupsList()
  $('#groupsModal').classList.remove('hidden')
})
$('#btnCheckLoginSide').addEventListener('click', () => $('#btnCheckLogin').click())
$('#loginHealthAlertAction').addEventListener('click', () => {
  const btn = document.querySelector('.nav-item[data-page="accounts"]')
  if (btn) btn.click()
})

function renderAccountGrid() {
  const grid = $('#accountGrid')
  if (!state.accounts.length) {
    grid.innerHTML = '<div class="empty">暂无账号，请先到「账号」页添加</div>'
    return
  }
  grid.innerHTML = ''
  for (const a of state.accounts) {
    if (a.platform !== 'Douyin') continue
    const card = document.createElement('div')
    card.className = 'account-card' + (state.selectedAccounts.has(a.uid) ? ' selected' : '')
    const initial = (a.nickname || '?').slice(0, 1)
    card.innerHTML = `
      <div class="check">✓</div>
      <div class="avatar">${a.avatar ? '<img src="' + esc(a.avatar) + '" onerror="this.style.display=\'none\'">' : ''}<span>${initial}</span></div>
      <div class="name">${esc(a.nickname || a.uid)}</div>
      <div class="uid">${esc(String(a.uid))}</div>
      <div class="tag"><span class="badge ${loginMeta(a).cls}">${loginMeta(a).text}</span></div>
    `
    card.addEventListener('click', () => {
      if (state.selectedAccounts.has(a.uid)) state.selectedAccounts.delete(a.uid)
      else state.selectedAccounts.add(a.uid)
      renderAccountGrid()
    })
    grid.appendChild(card)
  }
}

function renderAccountsTable() {
  const wrap = $('#accountsTable')
  if (!state.accounts.length) {
    wrap.innerHTML = '<div class="empty">暂无账号</div>'
    return
  }
  const groups = loadGroups()
  const gFilter = $('#accGroupFilter').value
  let list = state.accounts
  if (gFilter) list = list.filter((a) => String(a.group_id) === gFilter)

  let html = '<table><thead><tr><th>昵称</th><th>UID</th><th>分组</th><th>状态</th><th>备注</th><th>操作</th></tr></thead><tbody>'
  for (const a of list) {
    const health = loginMeta(a)
    const gName = groups.find((g) => String(g.id) === String(a.group_id))
    const opts = '<option value="">未分组</option>' + groups.map((g) => `<option value="${g.id}"${String(g.id) === String(a.group_id) ? ' selected' : ''}>${esc(g.name)}</option>`).join('')
    html += `
      <tr>
        <td>${esc(a.nickname || a.uid)}</td>
        <td style="font-family:var(--mono);font-size:12px">${esc(String(a.uid))}</td>
        <td><select class="input select acc-group" data-uid="${esc(String(a.uid))}">${opts}</select></td>
        <td><span class="badge ${health.cls}">${health.text}</span></td>
        <td><input type="text" class="input acc-remark" data-uid="${esc(String(a.uid))}" value="${esc(a.remark || '')}" placeholder="备注" style="max-width:140px"></td>
        <td>
          <button class="btn ghost small" data-open="${esc(String(a.uid))}">创作者中心</button>
          <button class="btn ghost small" data-del="${esc(String(a.uid))}">删除</button>
        </td>
      </tr>`
  }
  html += '</tbody></table>'
  wrap.innerHTML = html

  wrap.querySelectorAll('.acc-group').forEach((sel) => {
    sel.addEventListener('change', async () => {
      await CatBridge.getCall('AccountManager.updateAccount', { uid: sel.dataset.uid, group_id: Number(sel.value) || 0 })
      loadAccounts()
    })
  })
  wrap.querySelectorAll('.acc-remark').forEach((inp) => {
    inp.addEventListener('change', async () => {
      await CatBridge.getCall('AccountManager.updateAccount', { uid: inp.dataset.uid, remark: inp.value })
      toast('备注已保存', true)
    })
  })
  wrap.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('确认删除账号 ' + btn.dataset.del + '？')) return
      await CatBridge.getCall('AccountManager.removeAccount', { uid: btn.dataset.del })
      toast('已删除', true)
      loadAccounts()
    })
  })
  wrap.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const acc = state.accounts.find((a) => String(a.uid) === btn.dataset.open)
      if (acc) openAccountInBrowser(acc)
    })
  })
}

/* ===== 内置浏览器（每账号独立浏览器 + 各自标签页） ===== */
let browserAcc = null
const accBrowsers = {} // uid -> { tabs: [{id, partition, wv, title}], activeId }
let currentBrowserUid = null

function getAccBrowser(uid) {
  if (!accBrowsers[uid]) accBrowsers[uid] = { tabs: [], activeId: null }
  return accBrowsers[uid]
}

function switchToBrowserPage() {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === 'browser'))
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-browser'))
}

/* 只显示当前账号激活标签的 webview，隐藏其他所有 webview */
function syncWebviewVisibility() {
  const cur = getAccBrowser(currentBrowserUid)
  for (const uid of Object.keys(accBrowsers)) {
    const b = accBrowsers[uid]
    for (const t of b.tabs) {
      if (!t.wv) continue
      t.wv.style.display = (uid === currentBrowserUid && t.id === b.activeId) ? '' : 'none'
    }
  }
  if (cur.activeId) {
    const at = cur.tabs.find((t) => t.id === cur.activeId)

  }
}

function createBrowserTab(partition, url, title) {
  if (!currentBrowserUid) { toast('请先选择账号'); return null }
  const view = $('#browserView')
  const wv = document.createElement('webview')
  wv.style.cssText = 'width:100%;height:100%'
  // allowpopups 让 window.open 走"创建窗口"路径 → 主进程 setWindowOpenHandler 才能拦截（deny+开标签）
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('partition', partition)
  wv.setAttribute('src', url)
  view.appendChild(wv)
  const tab = { id: 'bt' + Date.now() + Math.floor(Math.random() * 1000), partition, wv, title: title || '新页面' }
  const b = getAccBrowser(currentBrowserUid)
  b.tabs.push(tab)
  b.activeId = tab.id
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'open-tab' && e.args && e.args[0]) {
      openBrowserTab(String(e.args[0]))
    }
  })
  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || tab.title
    renderBrowserTabs()
  })
  wv.addEventListener('dom-ready', () => {

  })
  syncWebviewVisibility()
  renderBrowserTabs()
  return tab
}

function openBrowserTab(url) {
  if (!currentBrowserUid) { toast('请先选择账号'); return null }
  // 只处理 http/https 链接，自定义协议（bitbrowser:// 等）忽略
  if (!/^https?:\/\//i.test(String(url))) return null
  const partition = getAccBrowser(currentBrowserUid).tabs.find((t) => t.id === getAccBrowser(currentBrowserUid).activeId).partition
  const tab = createBrowserTab(partition, url)
  switchToBrowserPage()
  return tab
}

function renderBrowserTabs() {
  const wrap = $('#browserTabs')
  const b = getAccBrowser(currentBrowserUid)
  wrap.innerHTML = ''
  for (const tab of b.tabs) {
    const el = document.createElement('div')
    el.className = 'browser-tab' + (tab.id === b.activeId ? ' active' : '')
    el.innerHTML = `<span class="tab-title">${esc(tab.title || '新页面')}</span><button class="tab-close">×</button>`
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeBrowserTab(tab.id)
        return
      }
      activateBrowserTab(tab.id)
    })
    wrap.appendChild(el)
  }
}

function activateBrowserTab(id) {
  if (!currentBrowserUid) return
  const b = getAccBrowser(currentBrowserUid)
  const tab = b.tabs.find((t) => t.id === id)
  if (!tab) return
  b.activeId = id
  const view = $('#browserView')
  if (tab.wv && !tab.wv.isConnected) view.appendChild(tab.wv)
  syncWebviewVisibility()
  renderBrowserTabs()
}

function closeBrowserTab(id) {
  if (!currentBrowserUid) return
  const b = getAccBrowser(currentBrowserUid)
  const idx = b.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  const tab = b.tabs[idx]
  try { if (tab.wv) tab.wv.remove() } catch (e) {}
  b.tabs.splice(idx, 1)
  if (b.activeId === id) {
    b.activeId = (b.tabs[idx] || b.tabs[idx - 1] || {}).id || null
  }
  if (!b.tabs.length) {
    $('#browserView').innerHTML = '<div class="empty">点击上方账号，用该账号的登录态打开抖音创作者中心</div>'

  } else if (b.activeId) {
    activateBrowserTab(b.activeId)
  }
  renderBrowserTabs()
}

function openAccountInBrowser(acc) {
  currentBrowserUid = String(acc.uid)
  browserAcc = acc
  renderAccSideList()
  switchToBrowserPage()
  const partition = acc.partition || ('persist:' + String(acc.uid))
  const b = getAccBrowser(currentBrowserUid)
  if (!b.tabs.length) {
    // 该账号首次打开：新建创作者中心标签
    createBrowserTab(partition, 'https://creator.douyin.com/creator-micro/home', (state.accMap[acc.uid] || acc.uid) + ' · 创作者中心')
  } else {
    // 已有浏览器：恢复显示该账号的标签
    syncWebviewVisibility()
    renderBrowserTabs()
  }


}

// 商机雷达只读取业务员当前主动打开的公开页面，不在后台遍历账号或隐藏数据。
window.VcatBrowserBridge = {
  hasActivePage() {
    if (!currentBrowserUid) return false
    const browser = getAccBrowser(currentBrowserUid)
    return !!browser.tabs.find((tab) => tab.id === browser.activeId && tab.wv)
  },
  openUrl(url) {
    if (!currentBrowserUid) throw new Error('请先在左侧选择一个已登录账号')
    return !!openBrowserTab(String(url || ''))
  },
  async captureActivePublicPage() {
    if (!currentBrowserUid) throw new Error('请先在左侧选择账号并打开一个公开页面')
    const browser = getAccBrowser(currentBrowserUid)
    const tab = browser.tabs.find((item) => item.id === browser.activeId)
    if (!tab || !tab.wv) throw new Error('当前没有可采集的浏览器页面')
    const result = await tab.wv.executeJavaScript(`(function () {
      const text = document.body ? document.body.innerText : '';
      const description = document.querySelector('meta[name="description"]');
      const author = document.querySelector('meta[name="author"]');
      return {
        url: location.href,
        title: document.title || '',
        description: description ? description.content : '',
        author: author ? author.content : '',
        text: String(text || '').slice(0, 40000)
      };
    })()`)
    const url = String(result && result.url || '')
    if (!/^https?:\/\//i.test(url)) throw new Error('当前页面不是可记录的公开网页')
    return {
      sourceUrl: url,
      profileUrl: /\/user\//i.test(url) ? url : '',
      accountName: String(result.author || result.title || '').replace(/\s*[-—_].*$/, '').slice(0, 120),
      sourceType: /\/user\//i.test(url) ? 'profile' : (/\/video\//i.test(url) ? 'video' : 'manual'),
      rawText: [result.description, result.text].filter(Boolean).join('\n').slice(0, 40000),
    }
  },
}

/* F5 刷新当前标签页 */
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') {
    e.preventDefault()
    if (currentBrowserUid) {
      const b = getAccBrowser(currentBrowserUid)
      const at = b.tabs.find((t) => t.id === b.activeId)
      if (at && at.wv) at.wv.reload()
    }
  }
})

/* 主进程拦截到 window.open（页面覆写 preload 也没用，主进程层拦截最可靠） */
try {
  CatBridge.handle('guest-open-tab', (e, url) => {
    if (url && currentBrowserUid) {
      openBrowserTab(String(url))
    }
  })
} catch (e) {}

/* ===== Groups (localStorage) ===== */
const GROUP_KEY = 'vcatNeoGroups'
function loadGroups() {
  try { return JSON.parse(localStorage.getItem(GROUP_KEY) || '[]') } catch (e) { return [] }
}
function saveGroups(list) {
  try { localStorage.setItem(GROUP_KEY, JSON.stringify(list)) } catch (e) {}
}
function renderGroupFilter() {
  const groups = loadGroups()
  const sel = $('#accGroupFilter')
  const cur = sel.value
  sel.innerHTML = '<option value="">全部分组</option>' + groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')
  if (groups.some((g) => String(g.id) === cur)) sel.value = cur
  renderAccountsTable()
}
function renderGroupsList() {
  const groups = loadGroups()
  const wrap = $('#groupsList')
  if (!groups.length) {
    wrap.innerHTML = '<div class="empty">暂无分组</div>'
    return
  }
  wrap.innerHTML = ''
  groups.forEach((g, i) => {
    const item = document.createElement('div')
    item.className = 'draft-item'
    item.innerHTML = `
      <div class="draft-info"><div class="draft-title">${esc(g.name)}</div></div>
      <button class="btn ghost small" data-gid="${g.id}">删除</button>`
    item.querySelector('[data-gid]').addEventListener('click', async () => {
      const all = loadGroups()
      all.splice(i, 1)
      saveGroups(all)
      const accs = state.accounts.filter((a) => String(a.group_id) === String(g.id))
      for (const a of accs) {
        await CatBridge.getCall('AccountManager.updateAccount', { uid: a.uid, group_id: 0 })
      }
      renderGroupsList()
      renderGroupFilter()
      loadAccounts()
    })
    wrap.appendChild(item)
  })
}
$('#btnManageGroups').addEventListener('click', () => {
  renderGroupsList()
  $('#groupsModal').classList.remove('hidden')
})
$('#btnGroupsClose').addEventListener('click', () => {
  $('#groupsModal').classList.add('hidden')
})
$('#btnAddGroup').addEventListener('click', () => {
  const name = $('#newGroupName').value.trim()
  if (!name) { toast('请输入分组名称'); return }
  const all = loadGroups()
  all.push({ id: Date.now(), name })
  saveGroups(all)
  $('#newGroupName').value = ''
  renderGroupsList()
  renderGroupFilter()
  toast('分组已添加', true)
})
$('#accGroupFilter').addEventListener('change', renderGroupFilter)

/* ===== Login status check ===== */
$('#btnCheckLogin').addEventListener('click', async () => {
  const btn = $('#btnCheckLogin')
  btn.disabled = true
  toast('检测中...')
  await verifyLoginStates({ manual: true })
  btn.disabled = false
})

/* ===== Add account (login) ===== */
let loginState = null

function randomPartition() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return 'persist:' + s
}

async function startAddAccount() {
  if (loginState) return
  const partition = randomPartition()
  $('#loginModal').classList.remove('hidden')
  if (window.CatBridge.setLoginPartition) window.CatBridge.setLoginPartition(partition)
  // 重建 webview 并设置 partition（partition 必须在创建时指定，与 listenSession 轮询的分区一致）
  const holder = $('#loginWebview').parentElement
  const old = $('#loginWebview')
  const wv = document.createElement('webview')
  wv.id = 'loginWebview'
  wv.className = 'login-webview'
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('partition', partition)
  holder.replaceChild(wv, old)
  wv.src = 'https://creator.douyin.com/'
  loginState = { partition }

  try {
    const listenerId = await CatBridge.addListenter('AccountManager', 'webview:' + partition, (event, payload) => {
      // 新版 preload 只传业务载荷；兼容旧版 Electron 监听器的 (ipcEvent, payload) 形态。
      const s = payload && payload.uid ? payload : (event || {})
      console.log('login event:', JSON.stringify(s).slice(0, 300))
      if (s.uid) {
        finishAddAccount(listenerId, s)
      }
    })
    loginState.listenerId = listenerId
    await CatBridge.getCall('AccountManager.listenSession', { partition, platform: 'Douyin' })
    toast('请在弹窗中扫码登录', true)
  } catch (e) {
    toast('添加失败：' + (e.message || ''))
    closeLoginModal()
  }
}

async function finishAddAccount(listenerId, s) {
  try {
    await CatBridge.getCall('AccountManager.addAccount', {
      uid: s.uid,
      platform: 'Douyin',
      partition: s.partition || loginState.partition,
      cookieData: s.cookieData,
      cookies: s.cookies,
    })
    toast('账号 ' + s.uid + ' 已添加', true)
  } catch (e) {
    toast('保存账号失败：' + (e.message || ''))
  } finally {
    closeLoginModal()
    loadAccounts()
  }
}

function closeLoginModal() {
  if (!loginState) return
  try {
    if (loginState.listenerId) CatBridge.removeListener(loginState.listenerId)
  } catch (e) {}
  if (window.CatBridge.setLoginPartition) window.CatBridge.setLoginPartition('')
  loginState = null
  $('#loginWebview').src = 'about:blank'
  $('#loginModal').classList.add('hidden')
}

$('#btnAddAccount').addEventListener('click', startAddAccount)
$('#btnLoginClose').addEventListener('click', closeLoginModal)

/* ===== Images ===== */
$('#btnPickImages').addEventListener('click', () => $('#fileInput').click())
$('#fileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || [])
  for (const f of files) {
    if (!/\.(jpe?g|png|gif|bmp|webp)$/i.test(f.name)) continue
    const path = CatBridge.getPathForFile ? CatBridge.getPathForFile(f) : f.path
    if (!path) continue
    state.images.push({ path: path, url: URL.createObjectURL(f) })
  }
  e.target.value = ''
  renderImages()
})

function renderImages() {
  const list = $('#imageList')
  list.innerHTML = ''
  state.images.forEach((img, i) => {
    const t = document.createElement('div')
    t.className = 'thumb'
    t.innerHTML = `<img src="${img.url}"><button class="del" data-i="${i}">×</button>`
    list.appendChild(t)
  })
  list.querySelectorAll('.del').forEach((b) => {
    b.addEventListener('click', () => {
      const img = state.images[Number(b.dataset.i)]
      if (img && img.url && img.url.startsWith('blob:')) URL.revokeObjectURL(img.url)
      state.images.splice(Number(b.dataset.i), 1)
      renderImages()
    })
  })
}

/* ===== Music ===== */
let musicSearchBusy = false
async function searchMusic(keyword) {
  if (musicSearchBusy) return
  musicSearchBusy = true
  const acc = state.accounts.find((a) => a.platform === 'Douyin')
  if (!acc) { toast('请先添加抖音账号'); musicSearchBusy = false; return }
  const list = $('#musicList')
  list.innerHTML = '<div class="empty">搜索中...</div>'
  try {
    const res = await CatBridge.getCall('AccountManager.getWorkerCall', acc, 'searchMusic', keyword, { offset: 0 })
    const songs = (res && res.songs) || []
    renderMusicList(songs)
  } catch (e) {
    list.innerHTML = '<div class="empty">搜索失败：' + esc(e.message || '') + '</div>'
  }
  musicSearchBusy = false
}

function renderMusicList(songs) {
  const list = $('#musicList')
  if (!songs.length) {
    list.innerHTML = '<div class="empty">无结果</div>'
    return
  }
  list.innerHTML = ''
  for (const s of songs) {
    const item = document.createElement('div')
    item.className = 'music-item'
    item.innerHTML = `
      <div>
        <div class="mi-name">${esc(s.title || '')}</div>
        <div class="mi-author">${esc(s.author || '')}</div>
      </div>
      <div>
        <span class="mi-meta">${s.duration ? s.duration + 's' : ''}</span>
        <button class="btn ghost small" style="margin-left:8px">选择</button>
      </div>`
    item.querySelector('button').addEventListener('click', () => {
      state.music = { title: s.title, author: s.author, id_str: s.id_str, duration: s.duration }
      $('#musicSelected').classList.remove('hidden')
      $('#musicSelected').innerHTML = `<span>🎵 ${esc(s.title)} - ${esc(s.author)}</span><button class="btn ghost small">清除</button>`
      $('#musicSelected').querySelector('button').addEventListener('click', () => {
        state.music = null
        $('#musicSelected').classList.add('hidden')
      })
      $('#musicSearch').value = ''
      list.innerHTML = '<div class="empty">已选择，可继续搜索其他歌</div>'
      toast('已选择音乐', true)
    })
    list.appendChild(item)
  }
}

$('#btnMusicSearch').addEventListener('click', () => {
  const kw = $('#musicSearch').value.trim()
  if (!kw) return
  searchMusic(kw)
})
$('#musicSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnMusicSearch').click()
})

/* ===== Publish mode ===== */
$('#selPublishMode').addEventListener('change', () => {
  $('#timedWrap').classList.toggle('hidden', $('#selPublishMode').value !== 'timed')
})

/* ===== Publish ===== */
function collectPublishData() {
  const accs = state.accounts.filter((a) => state.selectedAccounts.has(a.uid))
  if (!accs.length) { toast('请选择至少一个账号'); return null }
  if (!state.images.length) { toast('请选择至少一张图片'); return null }

  const title = $('#inputTitle').value.trim()
  const desc = $('#inputDesc').value.trim()
  const mode = $('#selPublishMode').value
  let timing = null
  if (mode === 'timed') {
    const t = $('#inputTimed').value
    if (!t) { toast('请选择定时时间'); return null }
    timing = { type: 3, time: new Date(t) }
  }

  const clientBatchId = clientRequestId('single')
  return {
    accs, title, desc, timing, clientBatchId,
    tasks: accs.map((a) => ({
      uid: a.uid,
      platform: 'Douyin',
      title: title,
      desc: desc,
      tags: [],
      images: state.images.map((im) => 'file://' + im.path.replace(/\\/g, '/')),
      timing: timing,
      music: state.music ? Object.assign({}, state.music) : null,
      musicRequired: !!(state.music && state.music.title),
      clientBatchId,
    })),
  }
}

function showPublishPreview() {
  const data = collectPublishData()
  if (!data) return
  const accNames = data.accs.map((a) => (state.accMap[a.uid] || a.uid)).join('、')
  const html = `
    <div class="preview-section">
      <div class="ps-label">目标账号（${data.accs.length}）</div>
      ${esc(accNames)}
    </div>
    <div class="preview-section">
      <div class="ps-label">图片（${state.images.length} 张）</div>
      <div class="preview-thumbs">${state.images.map((im) => `<div class="thumb"><img src="${im.url}"></div>`).join('')}</div>
    </div>
    <div class="preview-section">
      <div class="ps-label">标题</div>
      ${esc(data.title || '（无）')}
    </div>
    <div class="preview-section">
      <div class="ps-label">正文</div>
      ${esc(data.desc || '（无）')}
    </div>
    <div class="preview-section">
      <div class="ps-label">音乐</div>
      ${state.music ? '🎵 ' + esc(state.music.title) + ' - ' + esc(state.music.author) : '（默认原声）'}
    </div>
    <div class="preview-section">
      <div class="ps-label">发布方式</div>
      ${data.timing ? '定时 ' + new Date(data.timing.time).toLocaleString() : '立即发布'}
    </div>`
  $('#previewContent').innerHTML = html
  $('#previewModal').classList.remove('hidden')
  return data
}

let pendingPublish = null
$('#btnPublish').addEventListener('click', () => {
  pendingPublish = showPublishPreview()
})
$('#btnPreviewClose').addEventListener('click', () => {
  $('#previewModal').classList.add('hidden')
})
$('#btnPreviewConfirm').addEventListener('click', async () => {
  const data = pendingPublish
  $('#previewModal').classList.add('hidden')
  pendingPublish = null
  if (!data) return
  const btn = $('#btnPublish')
  btn.disabled = true
  $('#publishMsg').textContent = '创建任务中...'
  try {
    const res = await CatBridge.getCall('PublishController.bulkCreateWithStat', { requestId: data.clientBatchId, tasks: data.tasks })
    const n = res && (res.total || (res.list || []).length)
    if (n) {
      const paused = Number(res && res.paused) || 0
      $('#publishMsg').textContent = paused === n ? `已创建 ${n} 个任务，当前保持暂停` : `已创建 ${n} 个任务，开始发布`
      $('#publishMsg').className = 'msg ok'
      if (paused < n) CatBridge.getCall('PublishController.startPublishTask')
      showResultModal('任务已保存', paused === n ? `已创建 ${n} 个发布任务，当前保持暂停` : `已创建 ${n} 个发布任务，正在后台执行`)
      loadTasks().catch(() => {})
    } else {
      $('#publishMsg').textContent = '创建失败'
      $('#publishMsg').className = 'msg err'
    }
  } catch (e) {
    $('#publishMsg').textContent = '发布失败：' + (e.message || '')
    $('#publishMsg').className = 'msg err'
  }
  btn.disabled = false
})

/* ===== Drafts (localStorage) ===== */
const DRAFT_KEY = 'vcatNeoDrafts'
function loadDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]') } catch (e) { return [] }
}
function saveDrafts(list) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(list.slice(0, 30))) } catch (e) {}
}
function renderDrafts() {
  const list = loadDrafts()
  const wrap = $('#draftsList')
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">暂无草稿</div>'
    return
  }
  wrap.innerHTML = ''
  list.forEach((d, i) => {
    const item = document.createElement('div')
    item.className = 'draft-item'
    item.innerHTML = `
      <div class="draft-info">
        <div class="draft-title">${esc(d.title || '（无标题）')}${d.music ? ' 🎵' : ''}</div>
        <div class="draft-meta">${d.images.length} 张图 · ${new Date(d.savedAt).toLocaleString()}</div>
      </div>
      <div class="form-row">
        <button class="btn ghost small" data-act="load">恢复</button>
        <button class="btn ghost small" data-act="del">删除</button>
      </div>`
    item.querySelector('[data-act="load"]').addEventListener('click', () => {
      state.images = (d.images || []).map((p) => ({ path: p.path, url: 'file://' + p.path.replace(/\\/g, '/') }))
      state.music = d.music || null
      $('#inputTitle').value = d.title || ''
      $('#inputDesc').value = d.desc || ''
      $('#musicSelected').classList.toggle('hidden', !d.music)
      if (d.music) {
        $('#musicSelected').innerHTML = `<span>🎵 ${esc(d.music.title)} - ${esc(d.music.author)}</span><button class="btn ghost small" id="btnClearMusic2">清除</button>`
        const c = $('#btnClearMusic2')
        if (c) c.addEventListener('click', () => {
          state.music = null
          $('#musicSelected').classList.add('hidden')
        })
      }
      renderImages()
      $('#draftsModal').classList.add('hidden')
      toast('已恢复草稿', true)
    })
    item.querySelector('[data-act="del"]').addEventListener('click', () => {
      const all = loadDrafts()
      all.splice(i, 1)
      saveDrafts(all)
      renderDrafts()
    })
    wrap.appendChild(item)
  })
}
$('#btnSaveDraft').addEventListener('click', () => {
  if (!state.images.length) { toast('请先选择图片'); return }
  const d = {
    title: $('#inputTitle').value,
    desc: $('#inputDesc').value,
    images: state.images.map((im) => ({ path: im.path })),
    music: state.music,
    savedAt: Date.now(),
  }
  const all = loadDrafts()
  all.unshift(d)
  saveDrafts(all)
  toast('草稿已保存', true)
})
$('#btnOpenDrafts').addEventListener('click', () => {
  renderDrafts()
  $('#draftsModal').classList.remove('hidden')
})
$('#btnDraftsClose').addEventListener('click', () => {
  $('#draftsModal').classList.add('hidden')
})

/* ===== Music picker modal (batch reuse) ===== */
let musicPickerCb = null
let musicPickerCatMode = false
let musicCatList = []
let musicActiveCat = null

async function loadMusicCats() {
  const acc = state.accounts.find((a) => a.platform === 'Douyin')
  const wrap = $('#musicModalCats')
  if (!acc) {
    wrap.innerHTML = '<div class="empty" style="padding:8px">请先添加抖音账号</div>'
    if (musicPickerCatMode) batchMusicRandomBusy = false
    return
  }
  wrap.innerHTML = '<span class="hint">分类加载中...</span>'
  try {
    const res = await CatBridge.getCall('AccountManager.getWorkerCall', acc, 'getMusicCategory')
    musicCatList = Array.isArray(res) ? res : []
    if (!musicCatList.length) {
      wrap.innerHTML = '<span class="hint">分类加载失败，请使用搜索</span>'
      if (musicPickerCatMode) batchMusicRandomBusy = false
      return
    }
    wrap.innerHTML = ''
    for (const c of musicCatList) {
      const el = document.createElement('div')
      el.className = 'music-cat' + (musicActiveCat && String(musicActiveCat.category_id) === String(c.category_id) && musicActiveCat.type === c.type ? ' active' : '')
      el.textContent = c.category_name
      el.addEventListener('click', () => {
        musicActiveCat = c
        $('#musicModalSearch').value = ''
        document.querySelectorAll('.music-cat').forEach((x) => x.classList.remove('active'))
        el.classList.add('active')
        if (musicPickerCatMode) {
          if (musicPickerCb) {
            const cb = musicPickerCb
            musicPickerCb = null
            cb(c)
          }
          return
        }
        loadCatSongs(c)
      })
      wrap.appendChild(el)
    }
    // 默认加载第一个分类（推荐）
    if (!musicActiveCat && musicCatList.length) {
      musicActiveCat = musicCatList[0]
      loadCatSongs(musicActiveCat)
    }
  } catch (e) {
    wrap.innerHTML = '<span class="hint">分类加载失败：' + esc(e.message || '') + '</span>'
    if (musicPickerCatMode) batchMusicRandomBusy = false
  }
}

async function loadCatSongs(cat) {
  const acc = state.accounts.find((a) => a.platform === 'Douyin')
  const list = $('#musicModalList')
  list.innerHTML = '<div class="empty">加载中...</div>'
  if (!acc) return
  try {
    const res = await CatBridge.getCall('AccountManager.getWorkerCall', acc, 'getsongList', cat, 0)
    const songs = (res && res.songs) || []
    renderMusicModalList(songs, '分类：' + (cat.category_name || ''))
  } catch (e) {
    list.innerHTML = '<div class="empty">加载失败：' + esc(e.message || '') + '</div>'
  }
}

function renderMusicModalList(songs, title) {
  const list = $('#musicModalList')
  if (!songs.length) {
    list.innerHTML = '<div class="empty">' + esc(title || '') + ' · 无歌曲</div>'
    return
  }
  list.innerHTML = ''
  for (const s of songs) {
    const item = document.createElement('div')
    item.className = 'music-item'
    item.innerHTML = `
      <div>
        <div class="mi-name">${esc(s.title || '')}</div>
        <div class="mi-author">${esc(s.author || '')}</div>
      </div>
      <div>
        <span class="mi-meta">${s.duration ? s.duration + 's' : ''}</span>
        <button class="btn ghost small" style="margin-left:8px">使用</button>
      </div>`
    item.querySelector('button').addEventListener('click', () => {
      const song = { title: s.title, author: s.author, id_str: s.id_str, duration: s.duration }
      if (musicPickerCb) musicPickerCb(song)
      closeMusicPicker()
    })
    list.appendChild(item)
  }
}

function closeMusicPicker() {
  if (musicPickerCatMode) batchMusicRandomBusy = false
  musicPickerCb = null
  musicActiveCat = null
  $('#musicModal').classList.add('hidden')
}

function openMusicPicker(cb, catMode) {
  musicPickerCb = cb
  musicPickerCatMode = !!catMode
  musicActiveCat = null
  $('#musicModalList').innerHTML = musicPickerCatMode ? '<div class="empty">随机模式：点击上方分类直接分配</div>' : '<div class="empty">加载分类中...</div>'
  $('#musicModalSearch').value = ''
  $('#musicModal').classList.remove('hidden')
  loadMusicCats()
  if (!musicPickerCatMode) $('#musicModalSearch').focus()
}

async function searchMusicModal(keyword) {
  const acc = state.accounts.find((a) => a.platform === 'Douyin')
  const list = $('#musicModalList')
  list.innerHTML = '<div class="empty">搜索中...</div>'
  if (!acc) { list.innerHTML = '<div class="empty">请先添加抖音账号</div>'; return }
  try {
    const res = await CatBridge.getCall('AccountManager.getWorkerCall', acc, 'searchMusic', keyword, { offset: 0 })
    const songs = (res && res.songs) || []
    renderMusicModalList(songs, '搜索：' + keyword)
  } catch (e) {
    list.innerHTML = '<div class="empty">搜索失败：' + esc(e.message || '') + '</div>'
  }
}

$('#btnMusicModalSearch').addEventListener('click', () => {
  const kw = $('#musicModalSearch').value.trim()
  if (kw) searchMusicModal(kw)
})
$('#musicModalSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btnMusicModalSearch').click()
})
$('#btnMusicModalClose').addEventListener('click', closeMusicPicker)

/* ===== Batch publish ===== */
const batchState = {
  posts: [],
  accounts: new Set(),
}

/* 批量发布状态持久化（重启后恢复，避免重复录入） */
const BATCH_KEY = 'vcatNeoBatchState'
function saveBatchState() {
  try {
    const d = {
      posts: batchState.posts.map((p) => ({
        images: (p.images || []).map((im) => im.path),
        title: p.title || '',
        desc: p.desc || '',
        tags: p.tags || '',
        music: p.music || null,
      })),
      accounts: [...batchState.accounts],
      musicMode: $('#batchMusicMode').value,
      order: $('#batchOrder').value,
      timingMode: $('#batchTimingMode').value,
      startTime: $('#batchStartTime').value,
      schedMode: $('#batchSchedMode').value,
      dailyMax: $('#batchDailyMax').value,
      postGap: $('#batchPostGap').value,
      accGap: $('#batchAccGap').value,
      schedConfigShown: !$('#batchSchedConfig').classList.contains('hidden'),
    }
    localStorage.setItem(BATCH_KEY, JSON.stringify(d))
  } catch (e) {}
}
function restoreBatchState() {
  try {
    const d = JSON.parse(localStorage.getItem(BATCH_KEY) || 'null')
    if (!d || !Array.isArray(d.posts)) return
    batchState.posts = d.posts.map((p) => ({
      id: 'bp' + Date.now() + Math.floor(Math.random() * 1000),
      images: (p.images || []).map((path) => ({ path: path, url: 'file://' + String(path).replace(/\\/g, '/') })),
      title: p.title || '',
      desc: p.desc || '',
      tags: p.tags || '',
      music: p.music || null,
    }))
    batchState.accounts = new Set(Array.isArray(d.accounts) ? d.accounts : [])
    if (d.musicMode) { $('#batchMusicMode').value = d.musicMode; applyBatchMusicMode() }
    if (d.order) $('#batchOrder').value = d.order
    if (d.timingMode) $('#batchTimingMode').value = d.timingMode
    if (d.schedMode) $('#batchSchedMode').value = d.schedMode
    if (d.dailyMax) $('#batchDailyMax').value = d.dailyMax
    if (d.postGap) $('#batchPostGap').value = d.postGap
    if (d.accGap) $('#batchAccGap').value = d.accGap
    if (d.schedConfigShown) $('#batchSchedConfig').classList.remove('hidden')
    // 开始时间：过去的值一律纠正为 当前+3分钟（防止恢复旧值导致定时任务立即发布）
    const now = Date.now()
    let startMs = d.startTime ? new Date(d.startTime).getTime() : NaN
    if (Number.isNaN(startMs) || startMs <= now + 30000) {
      const t = new Date(now + 3 * 60000)
      const pad = (n) => String(n).padStart(2, '0')
      $('#batchStartTime').value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
    } else {
      $('#batchStartTime').value = d.startTime
    }
  } catch (e) {}
}

function renderBatchAccountGrid() {
  const grid = $('#batchAccountGrid')
  if (!state.accounts.length) {
    grid.innerHTML = '<div class="empty">暂无账号，请先到「账号」页添加</div>'
    $('#batchAccCount').textContent = '未选择'
    return
  }
  grid.innerHTML = ''
  for (const a of state.accounts) {
    if (a.platform !== 'Douyin') continue
    const health = loginMeta(a)
    const unavailable = health.text === '已掉线' || health.text === '未登录'
    if (unavailable) batchState.accounts.delete(a.uid)
    const card = document.createElement('div')
    card.className = 'account-card' + (batchState.accounts.has(a.uid) ? ' selected' : '') + (unavailable ? ' disabled' : '')
    const initial = (a.nickname || '?').slice(0, 1)
    card.innerHTML = `
      <div class="check">✓</div>
      <div class="avatar">${a.avatar ? '<img src="' + esc(a.avatar) + '" onerror="this.style.display=\'none\'">' : ''}<span>${initial}</span></div>
      <div class="name">${esc(a.nickname || a.uid)}</div>
      <div class="uid">${esc(String(a.uid))}</div>
      <div class="tag"><span class="badge ${health.cls}">${esc(health.text)}</span></div>
    `
    card.addEventListener('click', () => {
      if (unavailable) { toast('该账号已确认掉线，请重新登录后再选择'); return }
      if (batchState.accounts.has(a.uid)) batchState.accounts.delete(a.uid)
      else batchState.accounts.add(a.uid)
      renderBatchAccountGrid()
      saveBatchState()
    })
    grid.appendChild(card)
  }
  $('#batchAccCount').textContent = batchState.accounts.size ? batchState.accounts.size + ' 个账号' : '未选择'
}

function addBatchPost(images) {
  batchState.posts.push({
    id: 'bp' + Date.now() + Math.floor(Math.random() * 1000),
    images: images || [],
    title: '',
    desc: '',
    tags: '',
    music: null,
  })
  renderBatchPosts()
}

function renderBatchPosts() {
  const list = $('#batchPostList')
  $('#batchPostCount').textContent = String(batchState.posts.length)
  if (!batchState.posts.length) {
    list.innerHTML = '<div class="empty">暂无作品。点击「添加图片」选择图片，将按每作品图数自动分组为多个作品</div>'
    return
  }
  list.innerHTML = ''
  batchState.posts.forEach((p, i) => {
    const card = document.createElement('div')
    card.className = 'post-card'
    card.innerHTML = `
      <div class="post-card-head">
        <span class="post-card-title">作品 ${i + 1}</span>
        <div class="post-card-actions">
          <button class="btn ghost small" data-act="up">↑</button>
          <button class="btn ghost small" data-act="down">↓</button>
          <button class="btn ghost small" data-act="del">删除</button>
        </div>
      </div>
      <div class="post-card-body">
        <div class="post-thumbs"></div>
        <div class="batch-bar-row">
          <button class="btn ghost small" data-act="addimg">+ 图片</button>
          <button class="btn ghost small" data-act="music">音乐</button>
          <span class="post-music">${p.music ? '🎵 ' + esc(p.music.title) + ' - ' + esc(p.music.author) : ''}</span>
        </div>
        <input type="text" class="input" placeholder="作品标题（可选）" maxlength="40" value="${esc(p.title)}" data-f="title">
        <textarea class="textarea" rows="2" placeholder="作品描述，支持 #话题" data-f="desc">${esc(p.desc)}</textarea>
        <input type="text" class="input" placeholder="话题（#话题 空格分隔）" value="${esc(p.tags || '')}" data-f="tags">
        <input type="file" accept="image/*" multiple hidden data-f="file">
      </div>`
    const thumbs = card.querySelector('.post-thumbs')
    p.images.forEach((im, j) => {
      const t = document.createElement('div')
      t.className = 'post-thumb'
      t.innerHTML = `<img src="${im.url}"><button class="del" data-j="${j}">×</button>`
      thumbs.appendChild(t)
    })
    card.querySelectorAll('.post-thumb .del').forEach((b) => {
      b.addEventListener('click', () => {
        const im = p.images[Number(b.dataset.j)]
        if (im && im.url && im.url.startsWith('blob:')) URL.revokeObjectURL(im.url)
        p.images.splice(Number(b.dataset.j), 1)
        renderBatchPosts()
      })
    })
      card.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const act = btn.dataset.act
          if (act === 'up' && i > 0) { batchState.posts.splice(i - 1, 0, batchState.posts.splice(i, 1)[0]) }
          else if (act === 'down' && i < batchState.posts.length - 1) { batchState.posts.splice(i + 1, 0, batchState.posts.splice(i, 1)[0]) }
          else if (act === 'del') {
            const removed = batchState.posts.splice(i, 1)[0]
            if (removed) for (const im of removed.images) {
              if (im.url && im.url.startsWith('blob:')) URL.revokeObjectURL(im.url)
            }
          }
          else if (act === 'addimg') { card.querySelector('[data-f="file"]').click() }
          else if (act === 'music') {
            openMusicPicker((song) => {
              p.music = Object.assign({}, song)
              renderBatchPosts()
            })
          }
          renderBatchPosts()
        })
      })
    const file = card.querySelector('[data-f="file"]')
    file.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || [])
      for (const f of files) {
        if (!/\.(jpe?g|png|gif|bmp|webp)$/i.test(f.name)) continue
        const path = CatBridge.getPathForFile ? CatBridge.getPathForFile(f) : f.path
        if (path) p.images.push({ path: path, url: URL.createObjectURL(f) })
      }
      e.target.value = ''
      renderBatchPosts()
    })
    card.querySelector('[data-f="title"]').addEventListener('input', (e) => { p.title = e.target.value })
    card.querySelector('[data-f="desc"]').addEventListener('input', (e) => { p.desc = e.target.value })
    card.querySelector('[data-f="tags"]').addEventListener('input', (e) => { p.tags = e.target.value })
    list.appendChild(card)
  })
  saveBatchState()
}

$('#btnBatchAddImages').addEventListener('click', () => {
  if ($('#batchRecognition').value === 'subdirectory') $('#batchDirInput').click()
  else $('#batchFileInput').click()
})
$('#btnBatchAddImages2').addEventListener('click', () => $('#batchFileInput').click())
$('#btnBatchPickDir').addEventListener('click', () => $('#batchDirInput').click())
$('#btnBatchAddPost2').addEventListener('click', () => addBatchPost())
$('#btnBatchClearPosts').addEventListener('click', () => {
  if (!batchState.posts.length) { toast('暂无作品'); return }
  if (!confirm('确认清空全部 ' + batchState.posts.length + ' 个作品？')) return
  for (const p of batchState.posts) {
    for (const im of p.images) {
      if (im.url && im.url.startsWith('blob:')) URL.revokeObjectURL(im.url)
    }
  }
  batchState.posts = []
  batchState.accounts.clear()
  renderBatchPosts()
  renderBatchAccountGrid()
  saveBatchState()
  toast('已清空全部作品', true)
})
$('#batchFileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []).filter((f) => /\.(jpe?g|png|gif|bmp|webp)$/i.test(f.name))
  const perPost = Math.max(1, Number($('#batchImagesPerPost').value) || 3)
  const pool = []
  for (const f of files) {
    const path = CatBridge.getPathForFile ? CatBridge.getPathForFile(f) : f.path
    if (path) pool.push({ path: path, url: URL.createObjectURL(f) })
  }
  if (!pool.length) { toast('未选择有效图片'); return }
  for (let i = 0; i < pool.length; i += perPost) {
    addBatchPost(pool.slice(i, i + perPost))
  }
  e.target.value = ''
  toast('已按每作品 ' + perPost + ' 张生成 ' + Math.ceil(pool.length / perPost) + ' 个作品', true)
})
$('#batchDirInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []).filter((f) => /\.(jpe?g|png|gif|bmp|webp)$/i.test(f.name))
  const groups = {}
  for (const f of files) {
    const path = CatBridge.getPathForFile ? CatBridge.getPathForFile(f) : f.path
    if (!path) continue
    const parts = path.replace(/\\/g, '/').split('/')
    parts.pop()
    const dir = parts.pop() || '未分组作品'
    if (!groups[dir]) groups[dir] = []
    groups[dir].push({ path: path, url: URL.createObjectURL(f) })
  }
  const names = Object.keys(groups)
  if (!names.length) { toast('未找到有效图片'); return }
  for (const n of names) addBatchPost(groups[n])
  e.target.value = ''
  toast('已按子目录生成 ' + names.length + ' 个作品', true)
})
$('#batchRecognition').addEventListener('change', (e) => {
  const v = e.target.value
  $('#batchImagesPerPost').style.display = v === 'imagefile' ? '' : 'none'
})

$('#btnBatchAddPost').addEventListener('click', () => addBatchPost())

$('#btnApplyBatchMusic').addEventListener('click', () => {
  openMusicPicker((song) => {
    batchState.posts.forEach((p) => { p.music = Object.assign({}, song) })
    $('#batchMusicInfo').textContent = '已应用到 ' + batchState.posts.length + ' 个作品'
    renderBatchPosts()
  })
})

/* ===== 批量音乐模式：统一 / 每作品随机（按分类随机取歌） ===== */
let batchMusicRandomBusy = false
function applyBatchMusicMode() {
  const mode = $('#batchMusicMode').value
  $('#btnApplyBatchMusic').classList.toggle('hidden', mode !== 'uniform')
  $('#btnRandomBatchMusic').classList.toggle('hidden', mode !== 'random')
  if (mode === 'random') {
    $('#batchMusicInfo').textContent = '随机模式：每作品从所选分类歌单随机分配一首'
  }
}
$('#batchMusicMode').addEventListener('change', () => {
  applyBatchMusicMode()
  saveBatchState()
})
$('#btnRandomBatchMusic').addEventListener('click', () => {
  if (!batchState.posts.length) { toast('请先添加作品'); return }
  if (batchMusicRandomBusy) return
  batchMusicRandomBusy = true
  openMusicPicker(async (cat) => {
    // 随机模式：回调收到的是分类对象，拉取该分类歌单多页随机分配
    if (!cat || !cat.category_id) return
    const acc = state.accounts.find((a) => a.platform === 'Douyin')
    const list = $('#musicModalList')
    list.innerHTML = '<div class="empty">正在拉取分类歌单随机分配...</div>'
    if (!acc) { toast('请先添加抖音账号'); batchMusicRandomBusy = false; return }
    try {
      const pool = []
      for (let off = 0; off < 200 && pool.length < 100; off += 20) {
        const res = await CatBridge.getCall('AccountManager.getWorkerCall', acc, 'getsongList', cat, off)
        const songs = (res && res.songs) || []
        for (const s of songs) {
                    if (/创作的原声/.test(String(s.title || ''))) continue
if (!pool.some((x) => String(x.id_str) === String(s.id_str))) pool.push(Object.assign({}, s))
        }
        if (!res || !res.hasMore || songs.length < 20) break
      }
      if (!pool.length) { toast('分类「' + (cat.category_name || '') + '」无歌曲'); batchMusicRandomBusy = false; return }
      batchState.posts.forEach((p) => {
        const s = pool[Math.floor(Math.random() * pool.length)]
        p.music = Object.assign({ title: s.title, author: s.author, id_str: s.id_str, duration: s.duration })
      })
      $('#batchMusicInfo').textContent = '已随机分配 ' + batchState.posts.length + ' 个作品（分类：' + (cat.category_name || '') + '）'
      renderBatchPosts()
      toast('已按分类随机分配 ' + batchState.posts.length + ' 个作品', true)
    } catch (e) {
      toast('随机分配失败：' + (e.message || ''))
    } finally {
      batchMusicRandomBusy = false
      closeMusicPicker()
    }
  }, true)
})

/* ===== 批量设置弹框（原版交互：多行输入，按换行分割逐条填充） ===== */
let batchSetField = null
function batchSplitValues(raw, mode) {
  if (mode === 'sep') {
    return raw.split(/\r?\n*----+\r?\n*/).map((x) => x.trim()).filter(Boolean)
  }
  // 换行模式：去掉开头空行（粘贴/预填残留），后续非空行按序对应作品（第 1 行 → 作品 1）
  const lines = raw.split(/\r?\n/).map((x) => x.trim())
  const first = lines.findIndex((x) => x !== '')
  if (first < 0) return []
  return lines.slice(first).filter((x) => x !== '')
}
function openBatchSetModal(field) {
  const posts = batchState.posts
  if (!posts.length) { toast('请先添加作品'); return }
  batchSetField = field
  const label = { title: '批量设置标题', desc: '批量设置文案', tags: '批量设置话题' }[field]
  const ph = { title: '标题', desc: '文案', tags: '话题' }[field]
  $('#batchSetTitle').textContent = label
  $('#batchSetTip').innerHTML = `共 ${posts.length} 个作品，每行一条${ph}（或用 ---- 分隔多条），按所选方式分割后逐条填充（第 1 条 → 作品 1，第 2 条 → 作品 2...）；条数不足则剩余作品留空`
  $('#batchSetInput').value = posts.map((p) => p[field] || '').join('\n').replace(/^\n+/, '')
  $('#batchSetModal').classList.remove('hidden')
  $('#batchSetInput').focus()
}
$('#btnBatchSetTitle').addEventListener('click', () => openBatchSetModal('title'))
$('#btnBatchSetDesc').addEventListener('click', () => openBatchSetModal('desc'))
$('#btnBatchSetTags').addEventListener('click', () => openBatchSetModal('tags'))
$('#btnBatchSetClose').addEventListener('click', () => {
  batchSetField = null
  $('#batchSetModal').classList.add('hidden')
})
$('#btnBatchSetConfirm').addEventListener('click', () => {
  if (!batchSetField) return
  const mode = $('#batchSetSplit').value
  const lines = batchSplitValues($('#batchSetInput').value, mode)
  batchState.posts.forEach((p, i) => {
    const v = lines[i]
    if (v !== undefined) p[batchSetField] = v
  })
  const n = lines.length
  $('#batchSetModal').classList.add('hidden')
  batchSetField = null
  renderBatchPosts()
  saveBatchState()
  toast(`已按 ${n} 条填充到前 ${Math.min(n, batchState.posts.length)} 个作品`, true)
})

/* ===== 定时调度计划生成器 =====
 * 均分模式：作品按账号轮转分配；同一账号两次发布间隔 >= 发布间隔；
 * 相邻账号事件间隔 >= 账号间隔；每账号每日发布数 <= 每日上限。
 */
function generateSchedule(accs, posts, startTime, dailyMax, postGapMin, accGapMin) {
  const M = accs.length
  const dayOf = (t) => new Date(t).toDateString()
  const dailyCount = {} // uid -> { dayStr: count }
  const lastTime = {} // uid -> last publish ts
  const plan = [] // { post, account, time }
  let prevT = null
  let pi = 0
  let scheduledAny = true
  while (pi < posts.length && scheduledAny) {
    scheduledAny = false
    for (let ai = 0; ai < M && pi < posts.length; ai++) {
      const a = accs[ai]
      const uid = String(a.uid)
      // 当天已满上限则跳过该账号
      let t = prevT == null ? startTime : prevT + accGapMin * 60000
      const dayStr = dayOf(t)
      const dCount = (dailyCount[uid] && dailyCount[uid][dayStr]) || 0
      if (dCount >= dailyMax) continue
      // 同账号间隔约束
      if (lastTime[uid] != null) {
        const minT = lastTime[uid] + postGapMin * 60000
        if (t < minT) t = minT
      }
      plan.push({ post: posts[pi], account: a, time: t })
      if (!dailyCount[uid]) dailyCount[uid] = {}
      dailyCount[uid][dayStr] = (dailyCount[uid][dayStr] || 0) + 1
      lastTime[uid] = t
      prevT = t
      pi++
      scheduledAny = true
    }
  }
  return plan
}

function buildBatchTasks(accs, posts, schedule, batchSource, order, clientBatchId) {
  const tasks = []
  if (schedule) {
    for (const item of schedule) {
      const p = item.post
      const a = item.account
      tasks.push({
        uid: a.uid,
        platform: 'Douyin',
        title: p.title.trim(),
        desc: p.desc.trim(),
        tags: String(p.tags || '').split(/[\s,，#]+/).filter(Boolean),
        images: p.images.map((im) => 'file://' + im.path.replace(/\\/g, '/')),
        timing: { type: 3, time: item.time },
        music: p.music ? Object.assign({}, p.music) : null,
        musicRequired: !!(p.music && p.music.title),
        batchSource: batchSource,
        clientBatchId,
      })
    }
    return tasks
  }
  const outer = order === 'account' ? accs : posts
  const inner = order === 'account' ? posts : accs
  for (const first of outer) {
    for (const second of inner) {
      const p = order === 'account' ? second : first
      const a = order === 'account' ? first : second
      tasks.push({
        uid: a.uid,
        platform: 'Douyin',
        title: p.title.trim(),
        desc: p.desc.trim(),
        tags: String(p.tags || '').split(/[\s,，#]+/).filter(Boolean),
        images: p.images.map((im) => 'file://' + im.path.replace(/\\/g, '/')),
        timing: null,
        music: p.music ? Object.assign({}, p.music) : null,
        musicRequired: !!(p.music && p.music.title),
        batchSource: batchSource,
        clientBatchId,
      })
    }
  }
  return tasks
}

function renderSchedulePreview() {
  const accs = state.accounts.filter((a) => batchState.accounts.has(a.uid))
  if (!accs.length) { toast('请先选择账号'); return }
  const posts = batchState.posts.filter((p) => p.images.length)
  if (!posts.length) { toast('请先添加带图片的作品'); return }
  const mode = $('#batchTimingMode').value
  if (mode !== 'timed') { toast('请先选择「定时发布」'); return }

  let startTime = new Date($('#batchStartTime').value).getTime()
  if (Number.isNaN(startTime)) startTime = Date.now() + 3 * 60000
  const schedMode = $('#batchSchedMode').value
  const dailyMax = Math.max(1, Number($('#batchDailyMax').value) || 4)
  const postGap = Math.max(1, Number($('#batchPostGap').value) || 80)
  const accGap = Math.max(0, Number($('#batchAccGap').value) || 1)

  let plan
  if (schedMode === 'even') {
    plan = generateSchedule(accs, posts, startTime, dailyMax, postGap, accGap)
  } else {
    // all 模式：每个作品发所有账号，按作品顺序排列
    plan = []
    let t = startTime
    for (const p of posts) {
      for (const a of accs) {
        plan.push({ post: p, account: a, time: t })
        t += accGap * 60000
      }
      t += Math.max(0, postGap - accGap * accs.length) * 60000
    }
  }
  if (!plan.length) { toast('调度结果为空（可能账号已达每日上限）'); return }

  $('#scheduleTip').textContent = `共 ${plan.length} 个定时任务，从 ${new Date(plan[0].time).toLocaleString()} 开始`
  let html = '<table><thead><tr><th>#</th><th>作品</th><th>账号</th><th>发布时间</th></tr></thead><tbody>'
  plan.forEach((it, i) => {
    html += `
      <tr>
        <td>${i + 1}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.post.title || '作品' + (posts.indexOf(it.post) + 1))}</td>
        <td>${esc(state.accMap[it.account.uid] || it.account.uid)}</td>
        <td style="font-size:12px;color:var(--text-dim)">${new Date(it.time).toLocaleString()}</td>
      </tr>`
  })
  html += '</tbody></table>'
  $('#scheduleTable').innerHTML = html
  $('#scheduleModal').classList.remove('hidden')
  window.__lastSchedule = plan
}

$('#btnPreviewSchedule').addEventListener('click', renderSchedulePreview)
$('#btnScheduleClose').addEventListener('click', () => {
  $('#scheduleModal').classList.add('hidden')
})
$('#batchTimingMode').addEventListener('change', () => {
  $('#batchSchedConfig').classList.toggle('hidden', $('#batchTimingMode').value !== 'timed')
  saveBatchState()
})
;['batchOrder', 'batchStartTime', 'batchSchedMode', 'batchDailyMax', 'batchPostGap', 'batchAccGap'].forEach((id) => {
  const el = document.getElementById(id)
  if (el) el.addEventListener('change', saveBatchState)
})
/* 默认开始时间：当前 + 3 分钟 */
;(function initStartTime() {
  const d = new Date(Date.now() + 3 * 60000)
  const pad = (n) => String(n).padStart(2, '0')
  $('#batchStartTime').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
})()

/* ===== 发布结果弹窗 ===== */
function showResultModal(title, content) {
  $('#resultTitle').textContent = title
  $('#resultContent').textContent = content
  $('#resultModal').classList.remove('hidden')
}
$('#btnResultClose').addEventListener('click', () => {
  $('#resultModal').classList.add('hidden')
})
$('#btnResultGoTasks').addEventListener('click', () => {
  $('#resultModal').classList.add('hidden')
  const navBtn = document.querySelector('.nav-item[data-page="tasks"]')
  if (navBtn) navBtn.click()
  loadTasks().catch(() => {})
})

/* ===== 批量发布（作品 × 账号） ===== */
let batchPublishing = false
$('#btnBatchPublish').addEventListener('click', async () => {
  if (batchPublishing) { toast('正在发布中，请勿重复点击'); return }
  const msgEl = $('#batchPublishMsg')
  const accs = state.accounts.filter((a) => batchState.accounts.has(a.uid))
  if (!accs.length) {
    msgEl.textContent = '请先在「目标账号」区勾选至少一个账号（点击账号卡片）'
    msgEl.className = 'msg err'
    toast('请选择至少一个账号')
    return
  }
  const posts = batchState.posts.filter((p) => p.images.length)
  if (!posts.length) {
    msgEl.textContent = '请至少添加一个带图片的作品'
    msgEl.className = 'msg err'
    toast('请至少添加一个带图片的作品')
    return
  }
  if ($('#batchMusicMode').value === 'random') {
    const missing = posts.filter((p) => !(p.music && p.music.title))
    if (missing.length) {
      msgEl.textContent = `随机音乐尚未分配完整：还有 ${missing.length} 个作品没有音乐`
      msgEl.className = 'msg err'
      toast('请先点击“按分类随机”，确保每个作品都分配到音乐')
      return
    }
  }

  const clientBatchId = clientRequestId('batch')
  const batchSource = 'batch-' + Date.now()
  const batchOrder = $('#batchOrder').value
  let tasks = null
  const mode = $('#batchTimingMode').value

  if (mode === 'timed') {
    const schedMode = $('#batchSchedMode').value
    let startTime = new Date($('#batchStartTime').value).getTime()
    if (Number.isNaN(startTime) || startTime <= Date.now() + 30000) {
      // 开始时间缺失或已过去：纠正为 当前+3分钟，并提示用户
      startTime = Date.now() + 3 * 60000
      const t = new Date(startTime)
      const pad = (n) => String(n).padStart(2, '0')
      $('#batchStartTime').value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`
      toast('开始时间已过，已自动调整为当前 +3 分钟', true)
    }
    const dailyMax = Math.max(1, Number($('#batchDailyMax').value) || 4)
    const postGap = Math.max(1, Number($('#batchPostGap').value) || 80)
    const accGap = Math.max(0, Number($('#batchAccGap').value) || 1)
    if (schedMode === 'even') {
      const plan = generateSchedule(accs, posts, startTime, dailyMax, postGap, accGap)
      if (!plan.length) { toast('调度结果为空（可能账号已达每日上限）'); return }
      tasks = buildBatchTasks(accs, posts, plan, batchSource, batchOrder, clientBatchId)
      toast(`定时计划 ${plan.length} 条（剩余 ${posts.length - plan.length} 个作品超出每日上限未排入）`, true)
    } else {
      const plan = []
      let t = startTime
      const outer = batchOrder === 'account' ? accs : posts
      const inner = batchOrder === 'account' ? posts : accs
      for (const first of outer) {
        for (const second of inner) {
          const p = batchOrder === 'account' ? second : first
          const a = batchOrder === 'account' ? first : second
          plan.push({ post: p, account: a, time: t })
          t += accGap * 60000
        }
        t += Math.max(0, postGap - accGap * accs.length) * 60000
      }
      tasks = buildBatchTasks(accs, posts, plan, batchSource, batchOrder, clientBatchId)
    }
  } else {
    tasks = buildBatchTasks(accs, posts, null, batchSource, batchOrder, clientBatchId)
  }

  const btn = $('#btnBatchPublish')
  btn.disabled = true
  batchPublishing = true
  $('#batchPublishMsg').textContent = '创建任务中...'
  try {
    const res = await CatBridge.getCall('PublishController.bulkCreateWithStat', { requestId: clientBatchId, tasks })
    const n = res && (res.total || (res.list || []).length)
    if (n) {
      const paused = Number(res && res.paused) || 0
      $('#batchPublishMsg').textContent = paused === n ? `已创建 ${n} 个任务，当前保持暂停` : `已创建 ${n} 个任务，开始发布`
      $('#batchPublishMsg').className = 'msg ok'
      if (paused < n) CatBridge.getCall('PublishController.startPublishTask')
      loadTasks().catch(() => {})
      showResultModal('任务已保存', paused === n ? `已创建 ${n} 个发布任务，当前保持暂停` : `已创建 ${n} 个发布任务，正在后台执行`)
    } else {
      $('#batchPublishMsg').textContent = '创建失败，请检查任务是否有效（需有图片）'
      $('#batchPublishMsg').className = 'msg err'
    }
  } catch (e) {
    $('#batchPublishMsg').textContent = '发布失败：' + (e.message || '')
    $('#batchPublishMsg').className = 'msg err'
  }
  btn.disabled = false
  batchPublishing = false
})

/* ===== Stats ===== */
async function loadStats() {
  let res
  try {
    const taskRes = await CatBridge.getCall('Models.PublishLog.queryAll')
    state.tasks = (taskRes && taskRes.list) || state.tasks
    res = await CatBridge.getCall('Models.PublishTaskStat.querySummary')
  } catch (e) {
    $('#statsUpdated').textContent = '加载失败：' + (e.message || '')
    return
  }
  $('#statsUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString()
  const o = (res && res.overview) || {}
  const cards = [
    ['创建总数', o.createCount || 0, 'blue'],
    ['成功', o.successCount || 0, 'green'],
    ['失败', o.failCount || 0, 'red'],
    ['成功率', (o.successRate != null ? o.successRate : 0) + '%', 'yellow'],
    ['今日创建', o.todayCreateCount || 0, 'blue'],
    ['今日成功', o.todaySuccessCount || 0, 'green'],
  ]
  $('#statCards').innerHTML = cards.map(([label, value, cls]) => `
    <div class="stat-card">
      <div class="sc-label">${label}</div>
      <div class="sc-value ${cls}">${value}</div>
    </div>`).join('')

  const daily = (res && res.dailyList) || []
  const chart = $('#trendChart')
  if (!daily.length) {
    chart.innerHTML = '<div class="empty">暂无数据</div>'
  } else {
    const max = Math.max(1, ...daily.flatMap((d) => [d.createCount, d.successCount, d.failCount]))
    chart.innerHTML = '<div class="trend-chart">' + daily.map((d) => {
      const h = (n) => Math.max(2, Math.round((n / max) * 140))
      const bar = (cls, n) => n > 0 ? `<div class="trend-bar ${cls}" style="height:${h(n)}px"></div>` : ''
      return `
        <div class="trend-col">
          <div class="trend-bars">${bar('create', d.createCount)}${bar('success', d.successCount)}${bar('fail', d.failCount)}</div>
          <div class="trend-num">${d.createCount}/${d.successCount}/${d.failCount}</div>
          <div class="trend-day">${d.date}</div>
        </div>`
    }).join('') + '</div><div class="trend-legend"><span class="lg-create">创建</span><span class="lg-success">成功</span><span class="lg-fail">失败</span></div>'
  }

  const accList = (res && res.accountList) || []
  const accMap = {}
  for (const a of state.accounts) accMap[a.uid] = a.nickname || a.uid
  const wrap = $('#statsTable')
  if (!accList.length) {
    wrap.innerHTML = '<div class="empty">暂无数据</div>'
    return
  }
  let html = '<table><thead><tr><th>账号</th><th>创建</th><th>成功</th><th>失败</th><th>成功率</th></tr></thead><tbody>'
  for (const a of accList) {
    const rate = a.createCount ? Math.round((a.successCount / a.createCount) * 10000) / 100 : 0
    html += `
      <tr>
        <td>${esc(accMap[a.uid] || a.uid || a.platform || '未知')}</td>
        <td>${a.createCount || 0}</td>
        <td style="color:var(--green)">${a.successCount || 0}</td>
        <td style="color:var(--red)">${a.failCount || 0}</td>
        <td>${rate}%</td>
      </tr>`
  }
  html += '</tbody></table>'
  wrap.innerHTML = html

  const fails = state.tasks.filter((t) => t.status === 4)
  const fwrap = $('#failTable')
  if (!fails.length) {
    fwrap.innerHTML = '<div class="empty">暂无失败任务</div>'
    return
  }
  let fhtml = '<table><thead><tr><th>标题</th><th>账号</th><th>时间</th><th>错误</th></tr></thead><tbody>'
  for (const t of fails.slice(0, 50)) {
    const ftime = t.finishTime ? new Date(t.finishTime).toLocaleString() : ''
    fhtml += `
      <tr>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title || '')}</td>
        <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(accMap[t.uid] || t.uid || '')}</td>
        <td style="font-size:12px;color:var(--text-dim)">${ftime}</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--red)" title="${esc(t.error || '')}">${esc(t.error || '')}</td>
      </tr>`
  }
  fhtml += '</tbody></table>'
  fwrap.innerHTML = fhtml
}

$('#btnRefreshStats').addEventListener('click', () => loadStats().then(() => toast('已刷新', true)))

/* ===== Tasks ===== */
const TASK_STATUS = { 0: ['pending', '待发布'], 1: ['publishing', '发布中'], 2: ['success', '已发布'], 3: ['paused', '已暂停'], 4: ['fail', '失败'], 6: ['pending', '定时等待'] }
const taskSel = new Set() // 选中的任务 id

async function loadTasks() {
  const res = await CatBridge.getCall('Models.PublishLog.queryAll')
  const list = (res && res.list) || []
  state.tasks = list
  const validIds = new Set(list.map((t) => String(t.id)))
  for (const id of [...taskSel]) if (!validIds.has(String(id))) taskSel.delete(id)
  renderTaskFilters(list)
  renderTasks(list)
}

function renderTaskFilters(list) {
  const accSel = $('#taskAccountFilter')
  const cur = accSel.value
  const uids = [...new Set(list.map((t) => String(t.uid)).filter(Boolean))]
  let html = '<option value="">全部账号</option>'
  for (const uid of uids) {
    const name = (state.accMap && state.accMap[uid]) || uid
    html += `<option value="${esc(uid)}">${esc(name)}</option>`
  }
  accSel.innerHTML = html
  if (uids.includes(cur)) accSel.value = cur

  const batchSel = $('#taskBatchFilter')
  const batchCur = batchSel.value
  const batches = [...new Set(list.map((t) => String(t.batchSource || '')).filter(Boolean))].sort().reverse()
  batchSel.innerHTML = '<option value="">全部批次</option>' + batches.map((b) => `<option value="${esc(b)}">${esc(b.replace(/^batch-/, '批次 '))}</option>`).join('')
  if (batches.includes(batchCur)) batchSel.value = batchCur
}

function renderTasks(list) {
  const wrap = $('#tasksTable')
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">暂无任务</div>'
    $('#taskStat').textContent = '显示 0 条'
    $('#taskSummary').innerHTML = ['全部任务', '执行中', '等待发布', '发布成功', '需要处理'].map((label) => `<div class="task-summary-card"><span>${label}</span><strong>0</strong></div>`).join('')
    $('#taskSelectionCount').textContent = '未选择任务'
    $('#smsVerifyBanner').innerHTML = ''
    return
  }
  // 短信验证提示：存在因抖音安全验证失败的任务时，显示醒目提示条
  const smsBanner = $('#smsVerifyBanner')
  if (smsBanner) {
    const smsTasks = list.filter((t) => t.status === 4 && t.error && String(t.error).indexOf('NEED_SMS_VERIFY') >= 0)
    if (smsTasks.length) {
      const uids = [...new Set(smsTasks.map((t) => t.uid))]
      const names = uids.map((u) => (state.accMap && state.accMap[u]) || u).join('、')
      smsBanner.innerHTML = `
        <div class="sms-banner">
          <div>
            <strong>有 ${smsTasks.length} 个任务因抖音短信验证未发布成功</strong>
            <div class="sms-banner-sub">账号：${esc(names)}。请在「浏览器」页打开该账号的创作者中心，手动发布一次完成短信验证后，再点击「重试」重新发布这些任务。</div>
          </div>
          <button class="btn small" id="btnSmsGoBrowser">打开浏览器验证</button>
        </div>`
      const goBtn = $('#btnSmsGoBrowser')
      if (goBtn) {
        goBtn.addEventListener('click', () => {
          const acc = state.accounts.find((a) => String(a.uid) === String(uids[0]))
          if (acc) openAccountInBrowser(acc)
          else {
            const navBtn = document.querySelector('.nav-item[data-page="browser"]')
            if (navBtn) navBtn.click()
          }
        })
      }
    } else {
      smsBanner.innerHTML = ''
    }
  }
  const stFilter = $('#taskStatusFilter').value
  const accFilter = $('#taskAccountFilter').value
  const batchFilter = $('#taskBatchFilter').value
  const keyword = ($('#taskKeyword').value || '').trim().toLowerCase()
  const problemOnly = $('#taskProblemOnly').checked
  let filtered = list
  if (stFilter !== '') filtered = filtered.filter((t) => String(t.status) === stFilter)
  if (accFilter !== '') filtered = filtered.filter((t) => String(t.uid) === accFilter)
  if (batchFilter !== '') filtered = filtered.filter((t) => String(t.batchSource || '') === batchFilter)
  if (problemOnly) filtered = filtered.filter((t) => t.status === 4 || (t.error && String(t.error).trim()))
  if (keyword) {
    filtered = filtered.filter((t) => [t.title, t.uid, state.accMap && state.accMap[t.uid], t.batchSource, t.error, t.music && t.music.title, t.music && t.music.author]
      .some((v) => String(v || '').toLowerCase().includes(keyword)))
  }

  const stat = {}
  for (const t of list) {
    const k = TASK_STATUS[t.status] ? TASK_STATUS[t.status][1] : '未知'
    stat[k] = (stat[k] || 0) + 1
  }
  $('#taskStat').textContent = `显示 ${Math.min(filtered.length, 200)} / ${filtered.length} 条`
  const count = (status) => list.filter((t) => status.includes(Number(t.status))).length
  $('#taskSummary').innerHTML = [
    ['全部任务', list.length, 'all'],
    ['执行中', count([1]), 'running'],
    ['等待发布', count([0, 6]), 'waiting'],
    ['发布成功', count([2]), 'success'],
    ['需要处理', count([4]), 'fail'],
  ].map(([label, value, cls]) => `<div class="task-summary-card ${cls}"><span>${label}</span><strong>${value}</strong></div>`).join('')

  if (!filtered.length) {
    wrap.innerHTML = '<div class="empty">没有符合筛选条件的任务</div>'
    return
  }

  let html = '<table class="task-table"><thead><tr><th style="width:32px"><input type="checkbox" id="taskSelAll"></th><th>任务内容</th><th>账号</th><th>状态</th><th>计划时间</th><th>更新时间</th><th>操作</th></tr></thead><tbody>'
  // 最新在最上面（按创建时间倒序）
  const recent = [...filtered].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 200)
  recent.forEach((t, rowIdx) => {
    const st = t.uncertain ? ['paused', '结果待确认'] : (TASK_STATUS[t.status] || ['pending', '未知'])
    const ctime = t.createdAt ? new Date(t.createdAt).toLocaleString() : ''
    const ftime = t.finishTime ? new Date(t.finishTime).toLocaleString() : ''
    let ptime = '立即'
    if (t.timing && t.timing.time) {
      const pt = new Date(t.timing.time)
      ptime = pt.toLocaleString() + (t.status === 6 || t.status === 0 ? '（定时）' : '')
    } else if (t.deferredUntil && t.deferredUntil > Date.now()) {
      ptime = new Date(t.deferredUntil).toLocaleString() + '（安全排队）'
    }
    const errTip = t.error ? ` title="${esc(t.error)}"` : ''
    const musicText = t.music && t.music.title ? `${t.music.title}${t.music.author ? ' · ' + t.music.author : ''}` : '未指定音乐'
    const batchText = t.batchSource ? String(t.batchSource).replace(/^batch-/, '批次 ') : '单次发布'
    const errorLine = t.error ? `<div class="task-error">${esc(t.error)}</div>` : ''
    let ops = ''
    if (t.status === 4 || t.status === 3) {
      ops += `<button class="btn ghost small" data-act="retry" data-id="${esc(t.id)}"${errTip}>重试</button>`
    }
    if (t.status === 0 || t.status === 6) {
      ops += `<button class="btn ghost small" data-act="pause" data-id="${esc(t.id)}">暂停</button>`
    }
    if (t.status !== 1) ops += `<button class="btn ghost small" data-act="del" data-id="${esc(t.id)}">删除</button>`
    const checked = (taskSel.has(t.id) ? ' checked' : '')
    html += `
      <tr>
        <td><input type="checkbox" class="task-sel" data-id="${esc(t.id)}"${checked}></td>
        <td><div class="task-title">${esc(t.title || '无标题作品')}</div><div class="task-meta"><span>${esc(batchText)}</span><span>音乐：${esc(musicText)}</span></div>${errorLine}</td>
        <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((state.accMap && state.accMap[t.uid]) || t.uid || '')}</td>
        <td><span class="badge ${st[0]}"${errTip}>${st[1]}</span>${t.musicResult === 'selected' ? '<div class="task-music-ok">音乐已应用</div>' : t.musicResult === 'failed' ? '<div class="task-music-fail">音乐未应用</div>' : ''}</td>
        <td style="font-size:12px;color:${t.timing && t.timing.time ? 'var(--accent)' : 'var(--text-faint)'}">${esc(ptime)}</td>
        <td style="font-size:12px;color:var(--text-dim)">${ftime || ctime}</td>
        <td style="white-space:nowrap">${ops}</td>
      </tr>`
  })
  html += '</tbody></table>'
  wrap.innerHTML = html
  const selAll = $('#taskSelAll')
  if (selAll) {
    selAll.checked = recent.length > 0 && recent.every((t) => taskSel.has(t.id))
    selAll.addEventListener('change', () => {
      if (selAll.checked) recent.forEach((t) => taskSel.add(t.id))
      else recent.forEach((t) => taskSel.delete(t.id))
      renderTasks(list)
    })
  }
  $('#taskSelectionCount').textContent = taskSel.size ? `已选择 ${taskSel.size} 个任务` : '未选择任务'
  wrap.querySelectorAll('.task-sel').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) taskSel.add(cb.dataset.id)
      else taskSel.delete(cb.dataset.id)
      renderTasks(list)
    })
  })
  wrap.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act
      const id = btn.dataset.id
      try {
        if (act === 'retry') {
          const task = state.tasks.find((item) => item.id === id)
          if (task && task.uncertain && !confirm('这条任务在点击发布后中断，抖音端结果未知。请先到创作者中心确认没有同一作品；确认核对后仍要重新发布吗？')) return
          const result = await CatBridge.getCall('PublishController.updateTaskStatus', { id, status: 'pending', error: '', confirmedAfterCheck: !!(task && task.uncertain) })
          if (result && result.success === false) { toast('无法重试：' + (result.error || '任务状态不允许')); return }
          toast('已加入重试队列', true)
          loadTasks()
          CatBridge.getCall('PublishController.startPublishTask').catch(() => {})
        } else if (act === 'pause') {
          const result = await CatBridge.getCall('PublishController.updateTaskStatus', { id, status: 'paused' })
          if (!result || result.success === false) { toast('无法暂停：' + (result && result.error || '任务状态不允许')); return }
          toast('已暂停', true)
          loadTasks()
        } else if (act === 'del') {
          if (!confirm('确认删除该任务？')) return
          const result = await CatBridge.getCall('PublishController.deleteTask', { id })
          if (!result || Number(result.deleted) < 1) { toast(result && result.blocked ? '任务正在发布，不能删除' : '删除失败：任务不存在或状态已变化'); return }
          toast('已删除', true)
          loadTasks()
        }
      } catch (error) {
        toast('任务操作失败：' + String(error && error.message || error || '未知错误'))
      }
    })
  })
}

$('#taskStatusFilter').addEventListener('change', () => renderTasks(state.tasks))
$('#taskAccountFilter').addEventListener('change', () => renderTasks(state.tasks))
$('#taskBatchFilter').addEventListener('change', () => renderTasks(state.tasks))
$('#taskProblemOnly').addEventListener('change', () => renderTasks(state.tasks))
$('#taskKeyword').addEventListener('input', () => renderTasks(state.tasks))
$('#btnRetryFailed').addEventListener('click', async () => {
  const failed = state.tasks.filter((t) => t.status === 4)
  if (!failed.length) { toast('没有失败任务'); return }
  const uncertain = failed.filter((t) => t.uncertain)
  if (uncertain.length && !confirm(`其中 ${uncertain.length} 条任务的抖音端结果未知。请先在创作者中心逐条核对没有发布成功；确认核对完毕并重新排队吗？`)) return
  for (const t of failed) {
    await CatBridge.getCall('PublishController.updateTaskStatus', { id: t.id, status: 'pending', error: '', confirmedAfterCheck: !!t.uncertain })
  }
  toast('已将 ' + failed.length + ' 个失败任务重新排队', true)
  loadTasks()
  CatBridge.getCall('PublishController.startPublishTask').catch(() => {})
})
$('#btnClearDone').addEventListener('click', async () => {
  if (!confirm('清空已发布/失败/暂停的历史任务？发布中的不受影响')) return
  const r = await CatBridge.getCall('PublishController.clearTasks', { status: ['success', 'fail', 'paused'] })
  toast('已清空 ' + (r && r.deleted || 0) + ' 条', true)
  loadTasks()
})
$('#btnClearAll').addEventListener('click', async () => {
  if (!confirm('清空全部任务（发布中除外）？此操作不可恢复')) return
  const r = await CatBridge.getCall('PublishController.clearTasks', {})
  toast('已清空 ' + (r && r.deleted || 0) + ' 条', true)
  loadTasks()
})

/* ===== 任务批量操作 ===== */
async function getSelectedTasks() {
  const ids = [...taskSel]
  const res = await CatBridge.getCall('Models.PublishLog.queryAll')
  const all = (res && res.list) || []
  return all.filter((t) => ids.includes(t.id))
}
$('#btnBatchPause').addEventListener('click', async () => {
  const sel = await getSelectedTasks()
  if (!sel.length) { toast('请先勾选要暂停的任务（表格左侧复选框）'); return }
  let n = 0
  for (const t of sel) {
    if (t.status === 0 || t.status === 6 || t.status === 4) {
      await CatBridge.getCall('PublishController.updateTaskStatus', { id: t.id, status: 'paused' })
      n++
    }
  }
  taskSel.clear()
  toast('已暂停 ' + n + ' 个任务', true)
  loadTasks()
})
$('#btnBatchResume').addEventListener('click', async () => {
  const sel = await getSelectedTasks()
  if (!sel.length) { toast('请先勾选要恢复的任务'); return }
  let n = 0
  for (const t of sel) {
    if (t.status === 3 || t.status === 4) {
      if (t.uncertain && !confirm('选中的任务包含发布结果未知项。请先到创作者中心确认没有发布成功；确认仍要重新发布这条吗？')) continue
      await CatBridge.getCall('PublishController.updateTaskStatus', { id: t.id, status: 'pending', error: '', confirmedAfterCheck: !!t.uncertain })
      n++
    }
  }
  taskSel.clear()
  toast('已恢复 ' + n + ' 个任务', true)
  loadTasks()
  if (n) CatBridge.getCall('PublishController.startPublishTask').catch(() => {})
})
$('#btnBatchDelete').addEventListener('click', async () => {
  const sel = await getSelectedTasks()
  if (!sel.length) { toast('请先勾选要删除的任务'); return }
  if (!confirm('确认删除选中的 ' + sel.length + ' 个任务？')) return
  let n = 0
  for (const t of sel) {
    if (t.status === 1) continue
    await CatBridge.getCall('PublishController.deleteTask', { id: t.id })
    n++
  }
  taskSel.clear()
  toast('已删除 ' + n + ' 个任务', true)
  loadTasks()
})

/* ===== Settings ===== */
async function loadSettings() {
  try {
    const interval = await CatBridge.getCall('LocalConfig.getItem', 'publishInterval')
    if (interval != null) $('#inputInterval').value = interval
    const accountGap = await CatBridge.getCall('LocalConfig.getItem', 'publishAccountGapMinutes')
    if (accountGap != null) $('#inputAccountGap').value = accountGap
    const dailyMax = await CatBridge.getCall('LocalConfig.getItem', 'publishDailyMax')
    if (dailyMax != null) $('#inputDailyMax').value = dailyMax
    const initStatus = await CatBridge.getCall('LocalConfig.getItem', 'taskInitialStatus')
    if (initStatus != null) $('#selTaskInitialStatus').value = String(initStatus)
  } catch (e) {}
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const v = Math.max(30, Number($('#inputInterval').value) || 60)
  $('#inputInterval').value = v
  const accountGap = Math.max(30, Math.min(720, Number($('#inputAccountGap').value) || 80))
  const dailyMax = Math.max(1, Math.min(20, Number($('#inputDailyMax').value) || 4))
  $('#inputAccountGap').value = accountGap
  $('#inputDailyMax').value = dailyMax
  await CatBridge.getCall('LocalConfig.setItem', 'publishInterval', v)
  await CatBridge.getCall('LocalConfig.setItem', 'publishAccountGapMinutes', accountGap)
  await CatBridge.getCall('LocalConfig.setItem', 'publishDailyMax', dailyMax)
  await CatBridge.getCall('LocalConfig.setItem', 'taskInitialStatus', Number($('#selTaskInitialStatus').value) || 0)
  $('#settingsMsg').textContent = '已保存'
  $('#settingsMsg').className = 'msg ok'
  setTimeout(() => { $('#settingsMsg').textContent = '' }, 2000)
})

/* ===== Log viewer ===== */
async function loadLog() {
  const el = $('#logView')
  try {
    const r = await CatBridge.getCall('Debug.getPublishLog', { lines: 150 })
    const lines = (r && r.lines) || []
    el.textContent = lines.length ? lines.join('\n') : '（暂无日志）'
  } catch (e) {
    el.textContent = '加载日志失败：' + (e.message || '')
  }
}
$('#btnRefreshLog').addEventListener('click', loadLog)
$('#btnClearLogView').addEventListener('click', () => {
  $('#logView').textContent = ''
})

/* ===== Misc ===== */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function clientRequestId(prefix) {
  const id = window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(36).slice(2)
  return String(prefix || 'request') + '-' + id
}

/* ===== Init ===== */
;(async function init() {
  await loadAccountsWithRecovery()
  $('#btnReloadAccounts').addEventListener('click', () => loadAccountsWithRecovery({ manual: true }))
  $('#btnRefreshTasks').addEventListener('click', loadTasks)
  loadTasks().catch(() => {})
  loadSettings().catch(() => {})
  restoreBatchState()
  renderBatchAccountGrid()
  renderGroupFilter()
  setInterval(() => {
    if (currentPage === 'tasks') loadTasks().catch(() => {})
  }, 10000)
  setInterval(() => refreshLoginStates().catch(() => {}), 60000)
  setTimeout(() => verifyLoginStates().catch(() => {}), 15000)
  setInterval(() => verifyLoginStates().catch(() => {}), 10 * 60 * 1000)
})()
