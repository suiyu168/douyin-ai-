/* 商机雷达前端：公开商务线索发现、完整号码展示、审核和分配。 */
'use strict'

;(function () {
  const radar = {
    ready: false,
    loading: false,
    keywords: { industries: [], statuses: {} },
    leads: [],
    tasks: [],
    engagementCandidates: [],
    activeTaskId: null,
    collectorSettingsLoaded: false,
    current: null,
  }

  const el = (id) => document.getElementById(id)
  const htmlEscape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

  function industryName(id) {
    const hit = radar.keywords.industries.find((item) => item.id === id)
    return hit ? hit.name : '待分类'
  }

  function statusName(id) {
    return radar.keywords.statuses[id] || id || '待审核'
  }

  function sourceTypeName(id) {
    return radar.keywords.sourceTypes && radar.keywords.sourceTypes[id] || id || '其他公开来源'
  }

  function filters() {
    return {
      industry: el('radarFilterIndustry').value,
      status: el('radarFilterStatus').value,
      sourceType: el('radarFilterSource').value,
      freshness: el('radarFilterFreshness').value,
      contactOnly: el('radarContactOnly').checked,
      keyword: el('radarKeyword').value.trim(),
      page: 1,
      pageSize: 100,
    }
  }

  async function load() {
    if (radar.loading) return
    radar.loading = true
    try {
      if (!radar.ready) await initialize()
      await Promise.all([loadOverview(), loadLeads(), loadTasks(), loadCollector(), loadDouyinCollector(), loadRuntimeStatus()])
    } catch (error) {
      toast('商机雷达加载失败：' + error.message)
    } finally {
      radar.loading = false
    }
  }

  async function initialize() {
    radar.keywords = await CatBridge.getCall('LeadRadar.getKeywords')
    fillSelects()
    renderSourceChoices()
    renderIndustryCards()
    const info = await CatBridge.getCall('LeadRadar.getDataInfo')
    const ocrText = info && info.ocr && info.ocr.available ? ' · OCR 已就绪' : ' · OCR 模型未就绪'
    el('radarDataPath').textContent = '数据：' + (info && info.dataDir || 'D:\\小V猫数据\\商机雷达') + ocrText
    radar.ready = true
  }

  function renderSourceChoices() {
    const sources = radar.keywords.discoverySources || []
    el('radarSourceChoices').innerHTML = sources.map((source) => `<label class="radar-source-choice"><input type="checkbox" value="${htmlEscape(source.id)}" checked> ${htmlEscape(source.name)}</label>`).join('')
  }

  function fillSelects() {
    const industryOptions = radar.keywords.industries.map((item) => `<option value="${htmlEscape(item.id)}">${htmlEscape(item.name)}</option>`).join('')
    el('radarImportIndustry').innerHTML = '<option value="">自动识别行业</option>' + industryOptions
    el('radarFilterIndustry').innerHTML = '<option value="">全部行业</option>' + industryOptions
    el('radarEditIndustry').innerHTML = '<option value="unknown">待分类</option>' + industryOptions
    const statusOptions = Object.entries(radar.keywords.statuses).map(([id, name]) => `<option value="${htmlEscape(id)}">${htmlEscape(name)}</option>`).join('')
    el('radarFilterStatus').innerHTML = '<option value="">全部状态</option>' + statusOptions
    el('radarEditStatus').innerHTML = statusOptions
    const sourceOptions = Object.entries(radar.keywords.sourceTypes || {}).map(([id, name]) => `<option value="${htmlEscape(id)}">${htmlEscape(name)}</option>`).join('')
    el('radarFilterSource').innerHTML = '<option value="">全部来源</option>' + sourceOptions
  }

  function renderIndustryCards() {
    const initials = { flooring: '坪', cold_storage: '冷', membrane: '膜', retractable_shed: '棚', cleanroom: '净' }
    el('radarIndustryCards').innerHTML = radar.keywords.industries.map((industry) => `
      <article class="radar-industry-card">
        <div class="radar-industry-icon">${htmlEscape(initials[industry.id] || '业')}</div>
        <div>
          <div class="radar-industry-name">${htmlEscape(industry.name)}</div>
          <div class="radar-industry-keywords">${htmlEscape(industry.keywords.slice(0, 5).join(' · '))}</div>
        </div>
        <button class="btn ghost small" data-radar-search="${htmlEscape(industry.id)}">生成任务</button>
      </article>`).join('')
    el('radarIndustryCards').querySelectorAll('[data-radar-search]').forEach((button) => {
      button.addEventListener('click', () => createDiscoveryPlan(button.dataset.radarSearch))
    })
  }

  async function createDiscoveryPlan(industryId) {
    const industry = radar.keywords.industries.find((item) => item.id === industryId)
    if (!industry) return
    const region = el('radarRegion').value.trim()
    const intent = el('radarIntent').value
    const sources = [...el('radarSourceChoices').querySelectorAll('input:checked')].map((input) => input.value)
    if (!sources.length) return toast('请至少选择一个信息渠道')
    try {
      const result = await CatBridge.getCall('LeadRadar.createDiscoveryPlan', { industry: industryId, region, intent, sources })
      await loadTasks()
      toast(`已生成 ${result.created || 0} 个新任务，刷新 ${result.refreshed || 0} 个已有任务`, true)
    } catch (error) {
      toast(error.message)
    }
  }

  async function loadTasks() {
    const result = await CatBridge.getCall('LeadRadar.listDiscoveryTasks', { limit: 100 })
    radar.tasks = result && result.list || []
    renderTasks()
  }

  async function loadCollector() {
    const [status, items] = await Promise.all([
      CatBridge.getCall('GovCollector.getStatus'),
      CatBridge.getCall('GovCollector.listItems', { limit: 6, includeHistory: false }),
    ])
    renderCollector(status || {}, items && items.list || [])
  }

  async function loadDouyinCollector() {
    const [status, engagement] = await Promise.all([
      CatBridge.getCall('DouyinCollector.getStatus'),
      CatBridge.getCall('DouyinCollector.listEngagementCandidates', { status: 'pending', limit: 12 }),
    ])
    radar.engagementCandidates = engagement && engagement.list || []
    renderDouyinAlert(status || {})
    renderDouyinCollector(status || {})
    renderEngagementCandidates(engagement || {})
  }

  async function loadRuntimeStatus() {
    const [runtime, maintenance] = await Promise.all([
      CatBridge.getCall('Runtime.getStatus'),
      CatBridge.getCall('Maintenance.getStatus'),
    ])
    const state = el('radarRuntimeState')
    const detail = el('radarRuntimeDetail')
    const keepAwake = runtime && runtime.keepAwake !== false
    el('radarKeepAwake').checked = keepAwake
    state.textContent = keepAwake
      ? (runtime.blocking
          ? (runtime.douyinQuiet ? '24小时守护生效 · 抖音夜间暂停' : '24小时守护生效 · 自动采集运行中')
          : (runtime.supervisorError ? '24小时守护启动失败' : '24小时守护正在启用'))
      : '24小时守护已关闭'
    const last = maintenance && maintenance.lastRun
    if (!last) {
      detail.textContent = '数据库首次完整性检查和 D 盘备份将在启动后约 1 分钟执行'
      return
    }
    const errors = Array.isArray(last.errors) ? last.errors.length : 0
    const completed = Array.isArray(last.results) ? last.results.filter((item) => !item.skipped).length : 0
    const checked = Array.isArray(last.results) ? last.results.length : 0
    detail.textContent = errors
      ? `数据库维护发现 ${errors} 项异常，请检查磁盘空间或维护日志 · 备份目录：${last.backupDir || maintenance.backupDir || ''}`
      : `数据库检查正常 · 本轮检查 ${checked} 个库、新建 ${completed} 个备份 · 最近维护 ${new Date(last.finishedAt).toLocaleString()}`
  }

  async function runBackupNow() {
    const button = el('radarBackupNow')
    button.disabled = true
    button.textContent = '备份中...'
    try {
      const result = await CatBridge.getCall('Maintenance.runNow', { force: true })
      const errors = result && result.errors || []
      if (errors.length) throw new Error(errors.map((item) => `${item.key}：${item.message}`).join('；'))
      toast(`数据库备份完成：${(result.results || []).length} 个库`, true)
      await loadRuntimeStatus()
    } catch (error) {
      toast('数据库备份失败：' + error.message)
    } finally {
      button.disabled = false
      button.textContent = '立即备份'
    }
  }

  function renderDouyinAlert(status) {
    const wrap = el('douyinAccountAlert')
    const alert = status && status.alert || {}
    if (!wrap) return
    wrap.classList.toggle('hidden', !alert.active)
    if (!alert.active) return
    el('douyinAccountAlertTitle').textContent = alert.kind === 'login_expired' ? '抖音账号登录失效' : '抖音账号触发风控'
    const time = alert.detectedAt ? `（${new Date(alert.detectedAt).toLocaleString()}）` : ''
    const pool = status.accountPool || {}
    const recoveryHint = alert.kind === 'risk_control'
      ? (Number(pool.available) > 0
          ? `；该账号已单独隔离，系统将轮换使用其余 ${pool.available} 个可用账号。请稍后人工完成验证`
          : '；当前没有其他可用账号，请在浏览器中完成人工验证后再继续采集')
      : ''
    el('douyinAccountAlertMessage').textContent = String(alert.message || '请人工处理后再继续采集') + recoveryHint + time
  }

  async function checkDouyinAlert() {
    try {
      await CatBridge.getCall('DouyinCollector.checkAlertRecovery')
      const status = await CatBridge.getCall('DouyinCollector.getStatus')
      renderDouyinAlert(status || {})
    } catch (error) {}
  }

  function renderDouyinCollector(status) {
    const progress = status.progress || {}
    const last = status.lastRun
    const counts = status.counts || {}
    const targets = status.targets || {}
    const schedule = status.schedule || {}
    const pool = status.accountPool || { total: 0, available: 0 }
    const rolling = status.targetScope === 'per_run'
    const state = el('radarDouyinState')
    state.textContent = status.running ? '采集中' : schedule.quiet ? '夜间暂停' : pool.total && !pool.available ? '账号池暂停' : (last && last.status === 'success' ? '上次成功' : last && last.status === 'failed' ? '上次失败' : '等待运行')
    state.className = 'radar-collector-badge ' + (status.running ? 'running' : last && last.status || '')
    el('radarDouyinMessage').textContent = progress.message || '将复用当前抖音登录态'
    const percent = progress.total ? Math.min(100, Math.round((progress.current || 0) / progress.total * 100)) : 0
    el('radarDouyinProgress').style.width = percent + '%'
    el('radarDouyinRun').disabled = !!status.running || !!schedule.quiet || (pool.total > 0 && !pool.available)
    el('radarDouyinRun').textContent = status.running ? '采集中...' : schedule.quiet ? '安全时段外' : '开始采集'
    const nextComment = schedule.nextCommentRunAt ? new Date(schedule.nextCommentRunAt).toLocaleString() : '待定'
    const nextProfile = schedule.nextProfileRunAt ? new Date(schedule.nextProfileRunAt).toLocaleString() : '待定'
    const liveSummary = `账号池 ${pool.available || 0}/${pool.total || 0} 可用 · 已核验主页 ${counts.profileDetails || 0} · 有公开联系方式的主页 ${counts.profileContacts || 0} · 需求评论 ${counts.comments || 0}${rolling ? ' · 持续增量采集' : ''}`
    el('radarDouyinLastRun').textContent = last
      ? `${liveSummary} · 上次启动 ${new Date(last.startedAt).toLocaleString()} · 评论巡检 ${nextComment} · 主页检索 ${nextProfile}`
      : `${liveSummary} · 评论巡检 ${nextComment} · 主页检索 ${nextProfile}`
    const engagement = status.engagement || {}
    const values = [last && last.profileQueriesRun, last && last.profilesOpened, counts.profileDetails, counts.profileContacts,
      counts.comments, engagement.pending, last && last.imported, last && last.duplicates, last && last.errors]
    el('radarDouyinMetrics').querySelectorAll('strong').forEach((node, index) => { node.textContent = String(values[index] || 0) })
  }

  function renderEngagementCandidates(result) {
    const summary = result.summary || {}
    const list = result.list || []
    el('radarEngagementSummary').textContent = `待审核 ${summary.pending || 0} · 已准备 ${summary.prepared || 0} · 已联系 ${summary.contacted || 0} · 历史归档 ${summary.archived || 0}`
    const wrap = el('radarEngagementCandidates')
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">暂无待审核互动；新发现的高意向评论会自动进入这里</div>'
      return
    }
    const freshnessNames = { hot_7d: '7天内', recent_30d: '8—30天', unknown: '日期未知', stale: '超过30天' }
    wrap.innerHTML = list.map((item) => `<article class="radar-engagement-item">
      <div class="radar-engagement-main">
        <div><strong>${htmlEscape(item.author_name || '抖音用户')}</strong><span>${htmlEscape(industryName(item.industry))} · 意向 ${Number(item.intent_score) || 0} 分 · ${htmlEscape(freshnessNames[item.freshness_tier] || item.freshness_tier || '日期未知')}</span></div>
        <p>${htmlEscape(item.comment_text || '')}</p>
        <small>${item.comment_time ? `评论时间：${htmlEscape(new Date(Number(item.comment_time) * 1000).toLocaleString())} · ` : '评论时间未知 · '}建议回复：${htmlEscape(item.suggested_reply || '')}</small>
      </div>
      <div class="radar-engagement-actions">
        <button class="btn ghost small" data-engagement-open="${Number(item.id)}">打开原视频</button>
        <button class="btn primary small" data-engagement-prepare="${Number(item.id)}" ${item.freshness_tier === 'unknown' ? 'disabled' : ''}>复制回复并打开</button>
        <button class="btn ghost small" data-engagement-contacted="${Number(item.id)}">标记已联系</button>
        <button class="btn ghost small" data-engagement-dismiss="${Number(item.id)}">忽略</button>
      </div>
    </article>`).join('')
    wrap.querySelectorAll('[data-engagement-open]').forEach((button) => button.addEventListener('click', () => {
      const item = list.find((row) => Number(row.id) === Number(button.dataset.engagementOpen))
      if (item && item.source_url) CatBridge.openExternalUrl(item.source_url).catch((error) => toast(error.message))
    }))
    wrap.querySelectorAll('[data-engagement-prepare]').forEach((button) => button.addEventListener('click', () => {
      prepareEngagementReply(Number(button.dataset.engagementPrepare))
    }))
    wrap.querySelectorAll('[data-engagement-contacted]').forEach((button) => button.addEventListener('click', () => {
      updateEngagementCandidate(Number(button.dataset.engagementContacted), 'contacted')
    }))
    wrap.querySelectorAll('[data-engagement-dismiss]').forEach((button) => button.addEventListener('click', () => {
      updateEngagementCandidate(Number(button.dataset.engagementDismiss), 'dismissed')
    }))
  }

  async function copyPlainText(value) {
    const text = String(value || '')
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }

  async function prepareEngagementReply(id) {
    const item = radar.engagementCandidates.find((row) => Number(row.id) === Number(id))
    if (!item) return
    if (!confirm('本操作只会复制建议回复并打开原视频，不会自动发表评论。请在抖音页面再次核对后手动发送，是否继续？')) return
    try {
      const result = await CatBridge.getCall('DouyinCollector.prepareEngagementReply', { id, confirmed: true })
      await copyPlainText(result.reply || item.suggested_reply || '')
      if (result.sourceUrl || item.source_url) await CatBridge.openExternalUrl(result.sourceUrl || item.source_url)
      toast('建议回复已复制并打开原视频；请核对评论对象后手动发送', true)
      await loadDouyinCollector()
    } catch (error) {
      toast('准备回复失败：' + error.message)
    }
  }

  async function updateEngagementCandidate(id, status) {
    try {
      await CatBridge.getCall('DouyinCollector.updateEngagementCandidate', { id, status })
      toast(status === 'contacted' ? '已标记为已联系' : '已忽略该候选', true)
      await loadDouyinCollector()
    } catch (error) {
      toast('更新互动候选失败：' + error.message)
    }
  }

  async function runDouyinCollectorNow() {
    const button = el('radarDouyinRun')
    button.disabled = true
    button.textContent = '采集中...'
    try {
      const result = await CatBridge.getCall('DouyinCollector.runNow', { profileQueryLimit: 5, commentQueryLimit: 50, profileLimit: 8, videoLimit: 10, commentProfileLimit: 20, targetProfiles: 10000, targetProfileDetails: 10000, targetComments: 10000 })
      const added = result.runCounts || {}
      toast(`本轮抖音采集完成：搜索 ${result.profileQueriesRun || 0} 个关键词、扫描 ${result.videosScanned || 0} 个视频、补全 ${result.commentProfilesOpened || 0} 个意向客户主页；新增主页电话 ${added.profileContacts || 0}，新增需求评论 ${added.comments || 0}`, true)
      await Promise.all([loadDouyinCollector(), loadOverview(), loadLeads()])
    } catch (error) {
      toast('抖音采集失败：' + error.message)
      await loadDouyinCollector().catch(() => {})
    } finally {
      button.disabled = false
      button.textContent = '开始采集'
    }
  }

  function renderCollector(status, items) {
    const progress = status.progress || {}
    const last = status.lastRun
    const state = el('radarCollectorState')
    const stateName = status.running ? '采集中' : (last && last.status === 'success' ? '上次成功' : last && last.status === 'failed' ? '上次失败' : '等待运行')
    state.textContent = stateName
    state.className = 'radar-collector-badge ' + (status.running ? 'running' : last && last.status || '')
    const health = status.sourceHealth || {}
    const groups = status.sourceGroups || {}
    const webSearch = status.webSearch || {}
    const catalogText = webSearch.queryCatalogSize ? `，轮转词库 ${webSearch.queryCatalogSize} 组` : ''
    const webSearchText = webSearch.configured ? `${webSearch.providerName || '已配置'}已启用${catalogText}` : `待配置${catalogText}（固定公开入口仍正常采集）`
    el('radarCollectorScope').textContent = `当前接入 ${status.activeSourceCount || 0} 个自动公开入口：政府采购分类 ${groups.procurementCategories || 0}、行业关键词 ${groups.procurementKeywords || 0}、全国/省级公共资源 ${groups.publicResourcePlatforms || 0}、企业/建设单位采购 ${groups.publicWebPlatforms || 0}、招标前投资推介 ${groups.earlyStageProjects || 0}；通用网页搜索：${webSearchText}。工程信息无电话也保留`
    const healthText = `公开源：正常 ${health.healthy || 0} · 暂无结果 ${health.empty || 0} · 异常 ${health.error || 0} · 降级 ${health.degraded || 0} · 待首检 ${health.unknown || 0}`
    el('radarCollectorMessage').textContent = `${progress.message || (last && last.message) || '等待运行'} · ${healthText}`
    const percent = progress.total ? Math.min(100, Math.round((progress.current || 0) / progress.total * 100)) : 0
    el('radarCollectorProgress').style.width = percent + '%'
    el('radarCollectorLastRun').textContent = last
      ? `上次：${new Date(last.started_at).toLocaleString()} · 扫描 ${last.notices_scanned || 0} · 候选 ${last.candidates || 0} · 新增本地线索 ${last.imported || 0}`
      : '暂无运行记录，首次启动约15秒后自动执行'
    el('radarCollectorRun').disabled = !!status.running
    el('radarCollectorRun').textContent = status.running ? '采集中...' : '立即采集'
    const totals = status.totals || {}
    const values = [totals.actionable || 0, totals.imported || 0, (totals.stale || 0) + (totals.expired || 0)]
    el('radarCollectorMetrics').querySelectorAll('strong').forEach((node, index) => { node.textContent = String(values[index] || 0) })

    const settings = status.settings || {}
    if (!radar.collectorSettingsLoaded) {
      el('radarCollectorEnabled').checked = !!settings.enabled
      el('radarCollectorMode').value = settings.scanMode || 'broad'
      el('radarCollectorInterval').value = String(settings.intervalHours || 6)
      el('radarCollectorPages').value = String(settings.pagesPerRun || 5)
      el('radarCollectorRegions').value = (settings.focusRegions || []).join('、')
      el('radarCollectorWebProvider').value = settings.webSearchProvider || 'off'
      el('radarCollectorWebEndpoint').value = settings.webSearchEndpoint || ''
      el('radarCollectorWebQueries').value = String(settings.webSearchQueriesPerRun || 6)
      el('radarCollectorWebResults').value = String(settings.webSearchResultsPerQuery || 10)
      el('radarCollectorWebApiKey').placeholder = settings.webSearchApiKeyConfigured ? '密钥已加密保存；留空保持不变' : '输入搜索 API 密钥'
      radar.collectorSettingsLoaded = true
    }

    const sourceWrap = el('radarCollectorSources')
    const sourceStates = { active: '已启用', pending: '待验证', manual: '人工查询', blocked: '禁止采集' }
    const healthStates = { healthy: '正常', empty: '暂无匹配', error: '待重试', degraded: '部分异常/已降级', unknown: '待首检' }
    sourceWrap.innerHTML = (status.sources || []).map((source) => {
      const healthState = source.health && source.health.status || 'unknown'
      const error = source.health && source.health.last_error ? `\n最近错误：${source.health.last_error}` : ''
      const routeSummary = source.routeSummary || {}
      const routeInfo = `\n路由：正常 ${routeSummary.healthy || 0}，空结果 ${routeSummary.empty || 0}，异常 ${(routeSummary.error || 0) + (routeSummary.degraded || 0)}`
      const healthLabel = source.status === 'active' ? healthStates[healthState] || healthState : sourceStates[source.status] || source.status
      return `<span class="radar-collector-source ${htmlEscape(source.status)} health-${htmlEscape(healthState)}" title="${htmlEscape(source.compliance + routeInfo + error)}">${htmlEscape(source.name)} · ${htmlEscape(healthLabel)}</span>`
    }).join('')

    const wrap = el('radarCollectorItems')
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">暂无自动采集结果</div>'
      return
    }
    const opportunityNames = { active: '可跟进', deadline_soon: '7天内截止', stale: '历史项目', deadline_passed: '已过期', unknown: '日期未知' }
    wrap.innerHTML = items.map((item) => `<article class="radar-collector-item ${htmlEscape(item.opportunity_status || 'unknown')}">
      <div><strong title="${htmlEscape(item.title)}">${htmlEscape(item.title)}</strong><span>${htmlEscape(item.region || '地区待确认')} · ${htmlEscape(industryName(item.industry))} · ${htmlEscape(opportunityNames[item.opportunity_status] || item.opportunity_status || '日期未知')}${item.published_at ? ` · 发布 ${htmlEscape(item.published_at)}` : ''}${item.deadline_at_ts ? ` · 截止 ${htmlEscape(new Date(Number(item.deadline_at_ts) * 1000).toLocaleString())}` : ''}${item.buyer ? ` · 招标/采购方 ${htmlEscape(item.buyer)}` : ''}${item.agency ? ` · 代理机构 ${htmlEscape(item.agency)}` : ''}${item.project_address ? ` · 地址 ${htmlEscape(item.project_address)}` : ''}${item.budget ? ` · 预算 ${htmlEscape(item.budget)}` : ''}${item.project_code ? ` · 编号 ${htmlEscape(item.project_code)}` : ''}${item.contact_name ? ` · 联系人 ${htmlEscape(item.contact_name)}` : ''}${item.contact_phone ? ` · 电话 ${htmlEscape(item.contact_phone)}` : ''}${item.contact_email ? ` · 邮箱 ${htmlEscape(item.contact_email)}` : ''}</span></div>
      <button class="btn ghost small" data-collector-open="${item.id}">来源</button>
    </article>`).join('')
    wrap.querySelectorAll('[data-collector-open]').forEach((button) => button.addEventListener('click', () => {
      const item = items.find((row) => Number(row.id) === Number(button.dataset.collectorOpen))
      if (item) CatBridge.openExternalUrl(item.url).catch((error) => toast(error.message))
    }))
  }

  async function saveCollectorSettings(silent = false) {
    const focusRegions = el('radarCollectorRegions').value.split(/[、,，;；\s]+/).map((item) => item.trim()).filter(Boolean)
    const apiKey = el('radarCollectorWebApiKey').value.trim()
    const payload = {
      enabled: el('radarCollectorEnabled').checked,
      scanMode: el('radarCollectorMode').value,
      intervalHours: Number(el('radarCollectorInterval').value),
      pagesPerRun: Number(el('radarCollectorPages').value),
      focusRegions,
      webSearchProvider: el('radarCollectorWebProvider').value,
      webSearchEndpoint: el('radarCollectorWebEndpoint').value.trim(),
      webSearchQueriesPerRun: Number(el('radarCollectorWebQueries').value),
      webSearchResultsPerQuery: Number(el('radarCollectorWebResults').value),
    }
    if (apiKey) payload.webSearchApiKey = apiKey
    await CatBridge.getCall('GovCollector.updateSettings', payload)
    el('radarCollectorWebApiKey').value = ''
    if (!silent) toast('自动采集设置已保存', true)
    await loadCollector()
  }

  async function testCollectorWebSearch() {
    const button = el('radarCollectorWebTest')
    button.disabled = true
    button.textContent = '测试中...'
    try {
      await saveCollectorSettings(true)
      const result = await CatBridge.getCall('GovCollector.testWebSearch')
      const sample = (result.samples || []).map((item) => item.title).filter(Boolean).slice(0, 2).join('；')
      toast(`${result.providerName || '搜索服务'}连接成功，返回 ${result.matched || 0} 条${sample ? `：${sample}` : ''}`, true)
    } catch (error) {
      toast('搜索测试失败：' + error.message)
    } finally {
      button.disabled = false
      button.textContent = '测试搜索'
    }
  }

  async function runCollectorNow() {
    const button = el('radarCollectorRun')
    button.disabled = true
    button.textContent = '采集中...'
    try {
      const result = await CatBridge.getCall('GovCollector.runNow', { triggerType: 'manual' })
      toast(result.message || '公开项目采集完成', true)
      await Promise.all([loadCollector(), loadOverview(), loadLeads()])
    } catch (error) {
      toast('公开项目采集失败：' + error.message)
      await loadCollector().catch(() => {})
    } finally {
      button.disabled = false
      button.textContent = '立即采集'
    }
  }

  function renderTasks() {
    const wrap = el('radarDiscoveryTasks')
    if (!radar.tasks.length) {
      wrap.innerHTML = '<div class="empty">选择行业并生成任务后，会在这里列出官方渠道检索入口。</div>'
      return
    }
    wrap.innerHTML = radar.tasks.map((task) => `<article class="radar-task-item ${htmlEscape(task.status)}">
      <div><strong>${htmlEscape(task.source_name)}</strong><span>${htmlEscape(task.query)}</span></div>
      <span class="radar-task-status">${task.status === 'pending' ? '待打开' : task.status === 'opened' ? '已打开' : task.status === 'imported' ? '已采集' : task.status}</span>
      <button class="btn ghost small" data-radar-task-open="${task.id}">打开</button>
      <button class="btn ghost small" data-radar-task-skip="${task.id}">忽略</button>
    </article>`).join('')
    wrap.querySelectorAll('[data-radar-task-open]').forEach((button) => button.addEventListener('click', () => openTask(Number(button.dataset.radarTaskOpen))))
    wrap.querySelectorAll('[data-radar-task-skip]').forEach((button) => button.addEventListener('click', () => updateTask(Number(button.dataset.radarTaskSkip), 'skipped')))
  }

  async function updateTask(id, status) {
    await CatBridge.getCall('LeadRadar.updateDiscoveryTask', { id, status })
    await loadTasks()
  }

  async function openTask(id) {
    const task = radar.tasks.find((item) => Number(item.id) === Number(id))
    if (!task) return
    radar.activeTaskId = id
    try {
      if (window.VcatBrowserBridge.hasActivePage()) window.VcatBrowserBridge.openUrl(task.url)
      else await CatBridge.openExternalUrl(task.url)
      await CatBridge.getCall('LeadRadar.updateDiscoveryTask', { id, status: 'opened' })
      toast(`已打开 ${task.source_name}。检索词：${task.query}`, true)
    } catch (error) {
      radar.activeTaskId = null
      await CatBridge.getCall('LeadRadar.updateDiscoveryTask', { id, status: 'error' }).catch(() => {})
      toast('渠道页面打开失败：' + error.message)
    }
    await loadTasks()
  }

  async function loadOverview() {
    const data = await CatBridge.getCall('LeadRadar.getOverview')
    const values = [data.total || 0, data.pending || 0, data.with_contact || 0, data.profile_contacts || 0, data.active || 0, data.converted || 0]
    el('radarStats').querySelectorAll('strong').forEach((node, index) => { node.textContent = String(values[index] || 0) })
  }

  async function loadLeads() {
    const result = await CatBridge.getCall('LeadRadar.list', filters())
    radar.leads = (result && result.list) || []
    renderLeads(result && result.total || 0)
  }

  function renderLeads(total) {
    const wrap = el('radarLeadTable')
    if (!radar.leads.length) {
      wrap.innerHTML = `<div class="radar-empty-guide"><strong>还没有符合条件的线索</strong><span>从上方打开行业搜索，浏览公开页面后点击“采集当前公开页面”，或者粘贴公开资料进行识别。</span></div>`
      return
    }
    const rows = radar.leads.map((lead) => {
      const scoreClass = lead.score >= 70 ? ' high' : (lead.score < 40 ? ' low' : '')
      const source = displayEvidence(lead)
      return `<tr>
        <td><span class="radar-score${scoreClass}">${Number(lead.score) || 0}</span></td>
        <td><div class="radar-company" title="${htmlEscape(lead.account_name || '')}">${htmlEscape(lead.account_name || '待补充账号')}</div><div class="hint">${htmlEscape(lead.region || '地区待确认')}</div></td>
        <td>${htmlEscape(industryName(lead.industry))}</td>
        <td><span class="radar-contact${lead.contact ? '' : ' none'}">${htmlEscape(lead.contact || '未识别')}</span></td>
        <td><div class="radar-source-snippet" title="${htmlEscape(source)}">${htmlEscape(source)}</div></td>
        <td><span class="radar-status ${htmlEscape(lead.status)}">${htmlEscape(statusName(lead.status))}</span></td>
        <td>${htmlEscape(lead.assignee || '未分配')}</td>
        <td><button class="btn ghost small" data-radar-edit="${lead.id}">审核</button></td>
      </tr>`
    }).join('')
    wrap.innerHTML = `<table><thead><tr><th>评分</th><th>账号/地区</th><th>行业</th><th>公开联系方式</th><th>来源证据</th><th>状态</th><th>业务员</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table><div class="hint" style="padding:8px 10px">当前显示 ${radar.leads.length} / ${total} 条，公开号码均完整显示。</div>`
    wrap.querySelectorAll('[data-radar-edit]').forEach((button) => button.addEventListener('click', () => openLead(Number(button.dataset.radarEdit)).catch((error) => toast(error.message))))
  }

  function displayEvidence(lead) {
    let source = String(lead.evidence || lead.source_text || '未记录摘要')
    for (const candidate of radar.leads) {
      if (candidate.contact && candidate.contact_masked) {
        source = source.split(candidate.contact_masked).join(candidate.contact)
      }
    }
    return source
  }

  async function openLead(id) {
    const lead = radar.leads.find((item) => Number(item.id) === Number(id))
    if (!lead) return
    radar.current = lead
    el('radarEditId').value = String(lead.id)
    el('radarEditAccount').value = lead.account_name || ''
    el('radarEditRegion').value = lead.region || ''
    el('radarEditIndustry').value = lead.industry || 'unknown'
    el('radarEditStatus').value = lead.status || 'new'
    el('radarEditAssignee').value = lead.assignee || ''
    el('radarEditBusiness').checked = !!lead.public_business
    el('radarEditNotes').value = lead.notes || ''
    el('radarEditEvidence').textContent = [
      '联系方式：' + (lead.contact || '未识别'),
      '来源类型：' + sourceTypeName(lead.source_type || 'manual'),
      '来源链接：' + (lead.source_url || '未填写'),
      '',
      displayEvidence(lead),
    ].join('\n')
    el('radarAuditLog').textContent = '正在加载审计记录...'
    el('radarReveal').disabled = true
    el('radarOptOut').disabled = lead.status === 'opt_out'
    el('radarOpenSource').disabled = !lead.source_url
    el('radarLeadModal').classList.remove('hidden')
    const events = await CatBridge.getCall('LeadRadar.getEvents', { id })
    const labels = { opt_out: '拒绝联系', contact_revealed: '临时查看号码', status_changed: '状态变更' }
    el('radarAuditLog').textContent = events.list.length
      ? events.list.map((event) => `${new Date(event.created_at).toLocaleString()} · ${labels[event.event_type] || event.event_type} · ${event.details || ''}`).join('\n')
      : '暂无号码查看或状态变更记录'
  }

  function closeLead() {
    radar.current = null
    el('radarLeadModal').classList.add('hidden')
  }

  async function saveLead() {
    const id = Number(el('radarEditId').value)
    const payload = {
      id,
      account_name: el('radarEditAccount').value.trim(),
      region: el('radarEditRegion').value.trim(),
      industry: el('radarEditIndustry').value,
      status: el('radarEditStatus').value,
      assignee: el('radarEditAssignee').value.trim(),
      public_business: el('radarEditBusiness').checked,
      notes: el('radarEditNotes').value.trim(),
    }
    if (payload.assignee && payload.status === 'reviewed') payload.status = 'assigned'
    await CatBridge.getCall('LeadRadar.update', payload)
    toast('审核结果已保存', true)
    closeLead()
    await Promise.all([loadOverview(), loadLeads()])
  }

  async function importText(payloadOverride) {
    const payload = payloadOverride || {
      industry: el('radarImportIndustry').value,
      sourceType: el('radarSourceType').value,
      accountName: el('radarAccountName').value.trim(),
      region: el('radarImportRegion').value.trim(),
      sourceUrl: el('radarSourceUrl').value.trim(),
      profileUrl: el('radarSourceType').value === 'profile' ? el('radarSourceUrl').value.trim() : '',
      rawText: el('radarRawText').value.trim(),
    }
    const result = await CatBridge.getCall('LeadRadar.importText', payload)
    if (!payloadOverride) el('radarRawText').value = ''
    toast(`已新增 ${result.imported || 0} 条，合并重复 ${result.duplicates || 0} 条`, true)
    await Promise.all([loadOverview(), loadLeads()])
    return result
  }

  async function captureCurrentPage() {
    const button = el('radarCapturePage')
    button.disabled = true
    button.textContent = '正在读取...'
    try {
      const page = await window.VcatBrowserBridge.captureActivePublicPage()
      if (!page.rawText) throw new Error('当前页面没有可识别的公开文字')
      const task = radar.tasks.find((item) => Number(item.id) === Number(radar.activeTaskId))
      if (task) {
        page.sourceType = task.source_type
        page.platform = task.source_id
      }
      await importText(page)
      if (task) await updateTask(task.id, 'imported')
    } catch (error) {
      toast('采集失败：' + error.message)
    } finally {
      button.disabled = false
      button.textContent = '采集当前公开页面'
    }
  }

  async function recognizeOcrFile(file) {
    if (!file) return
    const button = el('radarOcrPick')
    button.disabled = true
    button.textContent = 'OCR 识别中...'
    try {
      const filePath = CatBridge.getPathForFile(file)
      const result = await CatBridge.getCall('LeadRadar.recognizeImage', { path: filePath, industry: el('radarImportIndustry').value })
      if (!result.text) throw new Error('图片中没有识别到文字')
      el('radarRawText').value = result.text
      el('radarSourceType').value = 'ocr'
      if (result.industry && result.industry !== 'unknown') el('radarImportIndustry').value = result.industry
      toast(`OCR 完成，识别到 ${(result.contacts || []).length} 个联系方式候选，请核对后入库`, true)
    } catch (error) {
      toast('OCR 失败：' + error.message)
    } finally {
      button.disabled = false
      button.textContent = '图片 OCR 识别'
      el('radarOcrFile').value = ''
    }
  }

  async function revealContact() {
    if (!radar.current) return
    if (radar.current.status === 'new') {
      toast('请先将状态改为“已审核”并保存')
      return
    }
    if (!confirm('仅可将该公开号码用于正当工程业务联系；对方拒绝后必须停止。是否临时显示？')) return
    try {
      const result = await CatBridge.getCall('LeadRadar.revealContact', { id: radar.current.id, acknowledged: true })
      el('radarReveal').textContent = result.contact || '无号码'
      setTimeout(() => { if (el('radarReveal')) el('radarReveal').textContent = '临时查看号码' }, 20000)
    } catch (error) {
      toast(error.message)
    }
  }

  async function markOptOut() {
    if (!radar.current) return
    if (!confirm('确认标记为“拒绝联系”？标记后该线索将锁定为不再业务跟进。')) return
    await CatBridge.getCall('LeadRadar.update', { id: radar.current.id, opt_out: true, notes: el('radarEditNotes').value.trim() })
    toast('已加入拒绝联系名单', true)
    closeLead()
    await Promise.all([loadOverview(), loadLeads()])
  }

  async function exportCsv() {
    try {
      const result = await CatBridge.getCall('LeadRadar.exportCsv', filters())
      toast(`已导出 ${result.count || 0} 条完整号码线索：${result.path}`, true)
    } catch (error) {
      toast('导出失败：' + error.message)
    }
  }

  function openSource() {
    if (!radar.current || !radar.current.source_url) return
    try {
      window.VcatBrowserBridge.openUrl(radar.current.source_url)
      closeLead()
    } catch (error) {
      toast(error.message)
    }
  }

  let keywordTimer = null
  function bindEvents() {
    el('radarRefresh').addEventListener('click', load)
    el('radarExport').addEventListener('click', exportCsv)
    el('radarCapturePage').addEventListener('click', captureCurrentPage)
    el('radarOcrPick').addEventListener('click', () => el('radarOcrFile').click())
    el('radarOcrFile').addEventListener('change', () => recognizeOcrFile(el('radarOcrFile').files[0]))
    el('radarReloadTasks').addEventListener('click', () => loadTasks().catch((error) => toast(error.message)))
    el('radarCollectorRefresh').addEventListener('click', () => loadCollector().catch((error) => toast(error.message)))
    el('radarCollectorSave').addEventListener('click', () => saveCollectorSettings().catch((error) => toast('保存失败：' + error.message)))
    el('radarCollectorBraveHelp').addEventListener('click', () => CatBridge.openExternalUrl('https://api-dashboard.search.brave.com/').catch((error) => toast(error.message)))
    el('radarCollectorWebTest').addEventListener('click', testCollectorWebSearch)
    el('radarCollectorRun').addEventListener('click', runCollectorNow)
    el('radarDouyinRefresh').addEventListener('click', () => loadDouyinCollector().catch((error) => toast(error.message)))
    el('radarDouyinRun').addEventListener('click', runDouyinCollectorNow)
    el('radarBackupNow').addEventListener('click', runBackupNow)
    el('radarKeepAwake').addEventListener('change', async () => {
      try {
        await CatBridge.getCall('Runtime.updateSettings', { keepAwake: el('radarKeepAwake').checked })
        await loadRuntimeStatus()
        toast(el('radarKeepAwake').checked ? '24小时守护已开启' : '24小时守护已关闭', true)
      } catch (error) {
        toast('守护设置保存失败：' + error.message)
      }
    })
    el('douyinAccountAlertAction').addEventListener('click', () => {
      const button = document.querySelector('.nav-item[data-page="accounts"]')
      if (button) button.click()
    })
    el('radarImport').addEventListener('click', async () => {
      try { await importText() } catch (error) { toast('识别失败：' + error.message) }
    })
    el('radarFilterIndustry').addEventListener('change', loadLeads)
    el('radarFilterStatus').addEventListener('change', loadLeads)
    el('radarFilterSource').addEventListener('change', loadLeads)
    el('radarFilterFreshness').addEventListener('change', loadLeads)
    el('radarContactOnly').addEventListener('change', loadLeads)
    el('radarKeyword').addEventListener('input', () => {
      clearTimeout(keywordTimer)
      keywordTimer = setTimeout(loadLeads, 250)
    })
    el('radarModalClose').addEventListener('click', closeLead)
    el('radarLeadModal').addEventListener('click', (event) => { if (event.target === el('radarLeadModal')) closeLead() })
    el('radarSaveLead').addEventListener('click', () => saveLead().catch((error) => toast('保存失败：' + error.message)))
    el('radarReveal').addEventListener('click', revealContact)
    el('radarOptOut').addEventListener('click', () => markOptOut().catch((error) => toast('操作失败：' + error.message)))
    el('radarOpenSource').addEventListener('click', openSource)
  }

  bindEvents()
  setInterval(() => {
    if (radar.ready && el('page-radar').classList.contains('active')) {
      loadCollector().catch(() => {})
      loadDouyinCollector().catch(() => {})
      loadRuntimeStatus().catch(() => {})
    }
  }, 10000)
  setTimeout(checkDouyinAlert, 20000)
  setInterval(checkDouyinAlert, 30000)
  window.LeadRadarUI = { load }
})()
