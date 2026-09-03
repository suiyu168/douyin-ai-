'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const {
  DouyinPublicCollector,
  extractAwemes,
  extractIntentComments,
  interleaveQueries,
  rotateQueries,
  balancedTargetReached,
  CollectionRiskError,
  NetworkCapture,
  RotatingCollectorWindow,
  NETWORK_TOTAL_BUFFER_BYTES,
  NETWORK_RESOURCE_BUFFER_BYTES,
  detectRiskText,
  normalizeProfileCards,
  mergePublicProfileDetail,
  hasPublicContact,
  PROFILE_QUERIES,
  detectAccountIssue,
  isWithinActiveHours,
  nextActiveStart,
  computeNextRunAt,
  computeNextCommentRunAt,
  subtractCollectorCounts,
  latestCommentTime,
  mergeVideoCandidates,
  engagementIntentScore,
  suggestedEngagementReply,
  commentFreshness,
  commentWatermarkCutoff,
  muteBackgroundCollectorWindow,
} = require('../app/server/douyin-public-collector')

test('从抖音搜索响应中递归提取作品并去重', () => {
  const payload = {
    data: [
      { aweme_info: { aweme_id: '1001', desc: '冷库安装多少钱' } },
      { nested: [{ aweme_id: '1002', desc: '冷库造价' }, { aweme_id: '1001', desc: '重复作品' }] },
    ],
  }
  assert.deepEqual(extractAwemes(payload, 10).map((item) => item.aweme_id), ['1001', '1002'])
  assert.equal(extractAwemes(payload, 1).length, 1)
})

test('后台抖音采集窗口创建后立即静音且不影响不支持静音的测试窗口', () => {
  const calls = []
  assert.equal(muteBackgroundCollectorWindow({
    webContents: { setAudioMuted: (muted) => calls.push(muted) },
  }), true)
  assert.deepEqual(calls, [true])
  assert.equal(muteBackgroundCollectorWindow({ webContents: {} }), false)
})

test('后台采集网络限制缓冲并按资源类型拦截媒体', async () => {
  const commands = []
  const listeners = {}
  let attached = false
  const webContents = {
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true },
      detach: () => { attached = false },
      on: (name, handler) => { listeners[name] = handler },
      off: (name) => { delete listeners[name] },
      sendCommand: async (name, params) => { commands.push({ name, params }); return {} },
    },
  }
  const capture = new NetworkCapture(webContents)
  await capture.attach()
  const network = commands.find((item) => item.name === 'Network.enable')
  assert.equal(network.params.maxTotalBufferSize, NETWORK_TOTAL_BUFFER_BYTES)
  assert.equal(network.params.maxResourceBufferSize, NETWORK_RESOURCE_BUFFER_BYTES)
  const fetch = commands.find((item) => item.name === 'Fetch.enable')
  assert.deepEqual(fetch.params.patterns.map((item) => item.resourceType), ['Image', 'Media', 'Font'])
  assert.equal(typeof listeners.message, 'function')
  listeners.message(null, 'Fetch.requestPaused', { requestId: 'blocked-media-request' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(commands.some((item) => item.name === 'Fetch.failRequest'
    && item.params.requestId === 'blocked-media-request' && item.params.errorReason === 'BlockedByClient'), true)
  capture.close()
  assert.equal(attached, false)
})

test('评论接口响应体全部读取失败时不把视频误判为采集成功', async () => {
  let capture
  const webContents = {
    loadURL: async () => {
      capture.responses.push({ requestId: 'oversized-body', response: { status: 200, url: 'https://www.douyin.com/aweme/v1/web/comment/list/' } })
    },
    executeJavaScript: async () => '',
    getURL: () => 'https://www.douyin.com/video/1',
    debugger: { sendCommand: async () => { throw new Error('body evicted') } },
  }
  capture = new NetworkCapture(webContents)
  await assert.rejects(() => capture.navigateAndCollectJson('https://www.douyin.com/video/1',
    '/aweme/v1/web/comment/list/', { timeoutMs: 5000, scrolls: -1 }), /响应体读取失败/)
})

test('隐藏采集窗口达到导航上限后轮换并复用同一登录分区', async () => {
  const windows = []
  const captures = []
  class MockWindow {
    constructor(options) {
      this.options = options
      this.destroyed = false
      this.muted = []
      this.loaded = []
      this.webContents = { setAudioMuted: (value) => this.muted.push(value) }
      windows.push(this)
    }
    async loadURL(url) { this.loaded.push(url) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  }
  const session = new RotatingCollectorWindow({
    BrowserWindow: MockWindow,
    partition: 'persist:test-account',
    maxNavigations: 2,
    captureFactory: () => {
      const capture = { attached: 0, closed: 0, attach: async () => { capture.attached++ }, close: () => { capture.closed++ } }
      captures.push(capture)
      return capture
    },
  })
  await session.create()
  const first = await session.nextNavigation()
  const second = await session.nextNavigation()
  const third = await session.nextNavigation()
  assert.equal(first.window, second.window)
  assert.notEqual(third.window, first.window)
  assert.equal(windows.length, 2)
  assert.equal(windows[0].destroyed, true)
  assert.equal(captures[0].closed, 1)
  windows[1].destroy()
  const afterExternalDestroy = await session.nextNavigation()
  assert.notEqual(afterExternalDestroy.window, windows[1])
  assert.equal(captures[1].closed, 1)
  assert.deepEqual(windows.map((win) => win.options.webPreferences.partition),
    ['persist:test-account', 'persist:test-account', 'persist:test-account'])
  assert.deepEqual(windows.map((win) => win.muted), [[true], [true], [true]])
  session.close()
  assert.equal(windows[2].destroyed, true)
  assert.equal(captures[2].closed, 1)
})

test('只保留公开评论中的明确工程需求意向', () => {
  const rows = extractIntentComments({
    comments: [
      { text: '我想建一个冷库，大概多少钱？', user: { nickname: '需求方', sec_uid: 'secure-user' } },
      { text: '厂家直销，专业承接冷库安装，欢迎咨询', user: { nickname: '广告账号' } },
      { text: '视频拍得不错', user: { nickname: '普通观众' } },
    ],
  }, { industry: 'cold_storage', sourceUrl: 'https://www.douyin.com/video/1001' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].accountName, '需求方')
  assert.equal(rows[0].industry, 'cold_storage')
  assert.equal(rows[0].sourceType, 'comment')
  assert.equal(rows[0].profileUrl, 'https://www.douyin.com/user/secure-user')
})

test('识别找施工队和询价意向，同时继续排除施工方广告', () => {
  const rows = extractIntentComments({
    comments: [
      { text: '车库地坪多少一平，想找施工队', user: { nickname: '需求甲' } },
      { text: '本公司专业承接地坪，包工包料欢迎咨询', user: { nickname: '施工方' } },
    ],
  }, { industry: 'flooring', sourceUrl: 'https://www.douyin.com/video/1002' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].accountName, '需求甲')
})

test('评论增量水位只过滤更早内容并保留同秒新评论', () => {
  const payload = { comments: [
    { cid: 'old', create_time: 99, text: '想建冷库多少钱', user: { nickname: '旧评论' } },
    { cid: 'same', create_time: 100, text: '附近有做冷库的吗', user: { nickname: '同秒评论' } },
    { cid: 'new', create_time: 101, text: '想了解冷库预算', user: { nickname: '新评论' } },
  ] }
  const rows = extractIntentComments(payload, { industry: 'cold_storage', minCommentTime: 100 })
  assert.deepEqual(rows.map((row) => row.commentId), ['new', 'same'])
  assert.equal(latestCommentTime([payload]), 101)
})

test('评论按7天和30天分层且首次扫描使用30天硬边界', () => {
  const now = Date.parse('2026-08-29T12:00:00+08:00')
  const day = 86400
  const nowSeconds = Math.floor(now / 1000)
  assert.equal(commentFreshness(nowSeconds - 7 * day, now), 'hot_7d')
  assert.equal(commentFreshness(nowSeconds - 8 * day, now), 'recent_30d')
  assert.equal(commentFreshness(nowSeconds - 31 * day, now), 'stale')
  assert.equal(commentFreshness(0, now), 'unknown')
  assert.equal(commentWatermarkCutoff(0, now), nowSeconds - 30 * day)
  assert.equal(commentWatermarkCutoff(nowSeconds - day, now), nowSeconds - day)
})

test('累计数量只作为展示，本轮目标使用相对增量', () => {
  const baseline = {
    profileContacts: 10000, profileContactsByIndustry: { flooring: 2000 },
    profileDetails: 12000, profileDetailsByIndustry: { flooring: 2400 },
    comments: 10000, commentsByIndustry: { flooring: 2000 },
  }
  const current = {
    profileContacts: 10002, profileContactsByIndustry: { flooring: 2002 },
    profileDetails: 12003, profileDetailsByIndustry: { flooring: 2403 },
    comments: 10004, commentsByIndustry: { flooring: 2004 },
  }
  const delta = subtractCollectorCounts(current, baseline)
  assert.equal(delta.profileContacts, 2)
  assert.equal(delta.profileDetails, 3)
  assert.equal(delta.comments, 4)
  assert.equal(delta.commentsByIndustry.flooring, 4)
  assert.equal(delta.commentsByIndustry.cleanroom, 0)
})

test('已扫描视频到期后重新进入评论巡检并推进水位', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-video-revisit-'))
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir }, BrowserWindow: function BrowserWindow() {}, getAccounts: () => [],
  })
  const base = Date.parse('2026-08-29T01:00:00.000Z')
  try {
    assert.equal(collector.isVideoDue('video-1', base), true)
    collector.markVideoProcessed('video-1', '冷库工程案例', {
      industry: 'cold_storage', nowMs: base, revisitMs: 30 * 60 * 1000, lastCommentTime: 100,
    })
    assert.equal(collector.isVideoDue('video-1', base + 29 * 60 * 1000), false)
    assert.equal(collector.isVideoDue('video-1', base + 31 * 60 * 1000), true)
    collector.markVideoProcessed('video-1', '冷库工程案例', {
      industry: 'cold_storage', nowMs: base + 31 * 60 * 1000, revisitMs: 30 * 60 * 1000, lastCommentTime: 120,
    })
    const state = collector.getVideoScanState('video-1')
    assert.equal(state.scan_count, 2)
    assert.equal(state.last_comment_time, 120)
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('历史监控视频即使掉出搜索结果仍保留固定复查名额', () => {
  const monitored = Array.from({ length: 6 }, (_, index) => ({ aweme_id: `old-${index}` }))
  const discovered = Array.from({ length: 10 }, (_, index) => ({ aweme_id: `new-${index}` }))
  const merged = mergeVideoCandidates(monitored, discovered, 10)
  assert.deepEqual(merged.slice(0, 5).map((item) => item.aweme_id), ['old-0', 'old-1', 'old-2', 'old-3', 'old-4'])
  assert.equal(merged.filter((item) => item.aweme_id.startsWith('new-')).length, 5)
})

test('独立监控池会按到期时间返回已离开搜索结果的视频', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-video-watchlist-'))
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir }, BrowserWindow: function BrowserWindow() {}, getAccounts: () => [],
  })
  const base = Date.parse('2026-08-29T01:00:00.000Z')
  try {
    collector.markVideoProcessed('due-video', '旧关键词', { industry: 'flooring', nowMs: base, revisitMs: 30 * 60 * 1000 })
    collector.markVideoProcessed('future-video', '旧关键词', { industry: 'flooring', nowMs: base + 60 * 60 * 1000, revisitMs: 30 * 60 * 1000 })
    const rows = collector.getDueMonitoredVideos('flooring', 10, base + 31 * 60 * 1000)
    assert.deepEqual(rows.map((row) => row.aweme_id), ['due-video'])
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('评论 ID 跨轮次和重启持久去重', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-comment-id-'))
  const options = { leadRadar: { dataDir }, BrowserWindow: function BrowserWindow() {}, getAccounts: () => [] }
  let collector = new DouyinPublicCollector(options)
  const row = { commentId: 'comment-100', commentTime: 100, profileUrl: 'https://www.douyin.com/user/a', rawText: '想做地坪多少钱' }
  const key = collector.commentKey(row, 'video-100')
  try {
    assert.notEqual(key, collector.commentKey(row, 'video-200'))
    assert.equal(collector.isCommentProcessed(key), false)
    collector.markCommentsProcessed([row], 'video-100')
    assert.equal(collector.isCommentProcessed(key), true)
    collector.close()
    collector = new DouyinPublicCollector(options)
    assert.equal(collector.isCommentProcessed(key), true)
    const stored = collector.stateDb.prepare('SELECT comment_id, aweme_id, comment_time FROM processed_comments WHERE comment_key = ?').get(key)
    assert.deepEqual({ ...stored }, { comment_id: 'comment-100', aweme_id: 'video-100', comment_time: 100 })
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('高意向评论进入逐条审核队列且不会产生自动互动', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-engagement-'))
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir }, BrowserWindow: function BrowserWindow() {}, getAccounts: () => [],
  })
  const row = {
    commentId: 'comment-engage-1', industry: 'cold_storage', accountName: '需求客户',
    profileUrl: 'https://www.douyin.com/user/customer', sourceUrl: 'https://www.douyin.com/video/video-engage-1',
    rawText: '我在郑州准备建一个200平方冷库，怎么联系报价？', commentTime: Math.floor(Date.now() / 1000),
  }
  try {
    assert.ok(engagementIntentScore(row) >= 70)
    assert.match(suggestedEngagementReply(row), /冷库项目/)
    assert.equal(collector.queueEngagementCandidates([row], 'video-engage-1'), 1)
    assert.equal(collector.queueEngagementCandidates([row], 'video-engage-1'), 0)
    const pending = collector.listEngagementCandidates({ status: 'pending' })
    assert.equal(pending.list.length, 1)
    assert.equal(pending.policy.mode, 'review_only')
    assert.equal(pending.policy.automaticThirdPartyInteraction, false)
    assert.equal(pending.list[0].freshness_tier, 'hot_7d')
    const prepared = collector.prepareEngagementReply({ id: pending.list[0].id, confirmed: true })
    assert.equal(prepared.sent, false)
    assert.equal(collector.listEngagementActionLogs({ candidateId: pending.list[0].id }).list.length, 1)
    collector.updateEngagementCandidate({ id: pending.list[0].id, status: 'contacted' })
    assert.equal(collector.engagementSummary().contacted, 1)
    assert.equal(collector.engagementSummary().pending, 0)
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('查询按五个行业轮转，避免单一行业先耗尽目标数量', () => {
  const rows = interleaveQueries([
    { query: '地坪甲', industry: 'flooring' },
    { query: '地坪乙', industry: 'flooring' },
    { query: '冷库甲', industry: 'cold_storage' },
    { query: '膜结构甲', industry: 'membrane' },
    { query: '推拉棚甲', industry: 'retractable_shed' },
    { query: '无尘甲', industry: 'cleanroom' },
  ])
  assert.deepEqual(rows.map((item) => item.query), ['地坪甲', '冷库甲', '膜结构甲', '推拉棚甲', '无尘甲', '地坪乙'])
})

test('查询游标轮转后会从上次位置继续而不是总从第一个词开始', () => {
  const rows = [{ query: '甲' }, { query: '乙' }, { query: '丙' }]
  assert.deepEqual(rotateQueries(rows, 1).map((item) => item.query), ['乙', '丙', '甲'])
  assert.deepEqual(rotateQueries(rows, 4).map((item) => item.query), ['乙', '丙', '甲'])
})

test('主动搜用户关键词覆盖五个行业的厂家、公司和施工队', () => {
  for (const industry of ['flooring', 'cold_storage', 'membrane', 'retractable_shed', 'cleanroom']) {
    const queries = PROFILE_QUERIES.filter((item) => item.industry === industry).map((item) => item.query)
    assert.ok(queries.length >= 80)
    assert.ok(queries.some((query) => /厂家/.test(query)))
    assert.ok(queries.some((query) => /公司|施工队|施工/.test(query)))
  }
})

test('总数达到目标但行业覆盖不足时仍继续采集', () => {
  assert.equal(balancedTargetReached(120, {
    flooring: 40,
    cold_storage: 40,
    membrane: 40,
    retractable_shed: 0,
    cleanroom: 0,
  }, 100), false)
  assert.equal(balancedTargetReached(100, {
    flooring: 20,
    cold_storage: 20,
    membrane: 20,
    retractable_shed: 20,
    cleanroom: 20,
  }, 100), true)
})

test('主页获客同时按联系方式和已核验详情的五行业目标判断达标', () => {
  const reached = DouyinPublicCollector.prototype.profileTargetReached
  const counts = {
    profileContacts: 124,
    profileContactsByIndustry: {
      flooring: 51, cold_storage: 26, membrane: 39, retractable_shed: 7, cleanroom: 1,
    },
    profileDetails: 100,
    profileDetailsByIndustry: {
      flooring: 20, cold_storage: 20, membrane: 20, retractable_shed: 20, cleanroom: 20,
    },
  }
  assert.equal(reached.call({}, counts, 100, 100), false)
  counts.profileContactsByIndustry = { flooring: 20, cold_storage: 20, membrane: 20, retractable_shed: 20, cleanroom: 20 }
  assert.equal(reached.call({}, counts, 100, 100), true)
  counts.profileDetails = 99
  assert.equal(reached.call({}, counts, 100, 100), false)
})

test('抖音公开接口 401/403/429 分别映射登录失效、风控和限流', () => {
  const capture = Object.create(NetworkCapture.prototype)
  assert.throws(() => capture.assertUsableResponse({ response: { status: 401 } }), (error) => error instanceof CollectionRiskError && error.kind === 'login_expired')
  assert.throws(() => capture.assertUsableResponse({ response: { status: 403 } }), (error) => error instanceof CollectionRiskError && error.kind === 'risk_control')
  assert.throws(() => capture.assertUsableResponse({ response: { status: 429 } }), (error) => error instanceof CollectionRiskError && error.kind === 'rate_limited')
  assert.doesNotThrow(() => capture.assertUsableResponse({ response: { status: 200 } }))
})

test('规范厂家主页卡片并排除当前账号主页', () => {
  const rows = normalizeProfileCards([
    { href: 'https://www.douyin.com/user/vendor?from=search', text: '郑州冷库厂家 抖音号：vendor123 业务电话 13800138000' },
    { href: 'https://www.douyin.com/user/self', text: '我的主页' },
    { href: 'https://example.com/user/vendor', text: '外站账号' },
  ], 'cold_storage')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sourceUrl, 'https://www.douyin.com/user/vendor')
  assert.equal(rows[0].accountName, '郑州冷库厂家 ')
})

test('把公开主页简介合并到厂家资料后再识别联系方式', () => {
  const row = mergePublicProfileDetail({
    platform: 'douyin', sourceType: 'profile', industry: 'cleanroom',
    accountName: '净化工程公司', profileUrl: 'https://www.douyin.com/user/vendor',
    sourceUrl: 'https://www.douyin.com/user/vendor', rawText: '净化工程公司',
  }, { description: '主营无尘车间工程，业务电话 13800138000', headerText: '山东净化施工' })
  assert.match(row.rawText, /主页公开简介/)
  assert.match(row.rawText, /13800138000/)
  assert.equal(row.sourceUrl, 'https://www.douyin.com/user/vendor')
  assert.equal(hasPublicContact(row), true)
  assert.equal(hasPublicContact({ rawText: '主营无尘车间工程，欢迎咨询' }), false)
})

test('高意向评论者会复用公开主页读取并把联系方式合并后一次入库', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-comment-profile-'))
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir }, BrowserWindow: function BrowserWindow() {}, getAccounts: () => [],
  })
  const stats = { commentProfilesOpened: 0, commentContactsAdded: 0, errors: 0 }
  const rotatedWebContents = { id: 'rotated-window' }
  let navigationCalls = 0
  collector.collectPublicProfileDetail = async (webContents, row) => {
    assert.equal(webContents, rotatedWebContents)
    return mergePublicProfileDetail(row, {
    description: '项目咨询电话 13800138000', headerText: '河南冷库需求方',
    })
  }
  try {
    const rows = await collector.enrichIntentCommentProfiles({}, [{
      platform: 'douyin', sourceType: 'comment', industry: 'cold_storage', accountName: '需求方',
      profileUrl: 'https://www.douyin.com/user/commenter', sourceUrl: 'https://www.douyin.com/video/1', rawText: '想建冷库多少钱',
    }], { stats, profileLimit: 5, query: '冷库工程案例', industry: 'cold_storage', profileDelayMs: 0,
      beforeProfileNavigation: async () => { navigationCalls++; return rotatedWebContents } })
    assert.equal(rows.length, 1)
    assert.match(rows[0].rawText, /13800138000/)
    assert.equal(rows[0].sourceType, 'comment')
    assert.equal(rows[0].sourceUrl, 'https://www.douyin.com/video/1')
    assert.equal(stats.commentProfilesOpened, 1)
    assert.equal(stats.commentContactsAdded, 1)
    assert.equal(navigationCalls, 1)
    assert.equal(collector.isProfileRecentlyProcessed('https://www.douyin.com/user/commenter', 14, 'commenter'), true)
    assert.equal(collector.isProfileRecentlyProcessed('https://www.douyin.com/user/commenter', 14, 'supplier'), false)
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('识别验证码和访问频繁等风险页面并要求人工处理', () => {
  assert.equal(detectRiskText('请完成滑块验证后继续访问'), '滑块验证')
  assert.equal(detectRiskText('当前访问频繁，请稍后再试'), '访问频繁')
  assert.equal(detectRiskText('这期视频讲解短信验证码的作用'), '')
  assert.equal(detectRiskText('账号正常在线，登录弹层按钮写着获取验证码'), '')
  assert.equal(detectRiskText('账号中心提供安全验证设置入口'), '')
  assert.equal(detectRiskText('请输入验证码后继续访问'), '请输入验证码')
  assert.equal(detectRiskText('正常的厂家公开主页'), '')
})

test('账号池会隔离触发风控的账号并轮换到其他可用账号', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-pool-'))
  const accounts = [
    { uid: 'account-1', nickname: '一号', platform: 'Douyin', partition: 'persist:one', isLogin: true, status: 1 },
    { uid: 'account-2', nickname: '二号', platform: 'Douyin', partition: 'persist:two', isLogin: true, status: 1 },
  ]
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir }, BrowserWindow: function BrowserWindow() {}, getAccounts: () => accounts,
  })
  try {
    assert.equal(collector.findAccount({}).uid, 'account-1')
    collector.setAlert('risk_control', '请完成滑块验证', accounts[0])
    assert.equal(collector.findAccount({}).uid, 'account-2')
    const pool = collector.getAccountPoolStatus()
    assert.equal(pool.total, 2)
    assert.equal(pool.available, 1)
    assert.equal(pool.list.find((item) => item.uid === 'account-1').state, 'cooldown')
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('升级时自动撤销旧版孤立验证码和获取验证码误报', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-alert-migrate-'))
  const accounts = [{ uid: 'account-1', nickname: '一号', platform: 'Douyin', partition: 'persist:one', isLogin: true, status: 1 }]
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir }, BrowserWindow: function BrowserWindow() {}, getAccounts: () => accounts,
  })
  try {
    for (const word of ['验证码', '获取验证码']) {
      collector.setAlert('risk_control', `抖音触发风控或验证：${word}，请人工处理`, accounts[0])
      assert.equal(collector.getAlert().active, true)
      const pool = collector.getAccountPoolStatus()
      assert.equal(collector.getAlert().active, false)
      assert.equal(pool.available, 1)
      assert.equal(pool.list[0].state, 'ready')
    }
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('旧版互动候选表先补字段再创建新鲜度索引且原数据不丢', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-engagement-migrate-'))
  const dbPath = path.join(dataDir, 'douyin-public-collector.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`CREATE TABLE engagement_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_key TEXT NOT NULL UNIQUE,
    aweme_id TEXT NOT NULL DEFAULT '',
    comment_id TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT 'unknown',
    author_name TEXT NOT NULL DEFAULT '',
    profile_url TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    comment_text TEXT NOT NULL DEFAULT '',
    intent_score INTEGER NOT NULL DEFAULT 0,
    suggested_reply TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    detected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  legacy.prepare(`INSERT INTO engagement_candidates
    (candidate_key, aweme_id, comment_id, comment_text, detected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('legacy-1', 'video-1', 'comment-1', '想做冷库', new Date().toISOString(), new Date().toISOString())
  legacy.close()
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir }, BrowserWindow: function BrowserWindow() {}, getAccounts: () => [],
  })
  try {
    const columns = new Set(collector.stateDb.prepare('PRAGMA table_info(engagement_candidates)').all().map((row) => row.name))
    assert.ok(columns.has('comment_time'))
    assert.ok(columns.has('freshness_tier'))
    assert.ok(columns.has('prepared_at'))
    assert.ok(columns.has('prepare_count'))
    assert.equal(collector.stateDb.prepare('SELECT COUNT(*) count FROM engagement_candidates').get().count, 1)
    assert.equal(collector.stateDb.prepare('SELECT status FROM engagement_candidates WHERE candidate_key = ?').get('legacy-1').status, 'archived')
    assert.ok(collector.stateDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_engagement_candidates_freshness'").get())
    assert.ok(collector.stateDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engagement_action_logs'").get())
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('区分登录失效和抖音风控页面', () => {
  assert.equal(detectAccountIssue('https://www.douyin.com/passport/login', '').kind, 'login_expired')
  assert.equal(detectAccountIssue('https://www.douyin.com/search/test', '登录已失效，请重新登录').kind, 'login_expired')
  assert.equal(detectAccountIssue('https://www.douyin.com/search/test', '请完成滑块验证').kind, 'risk_control')
  assert.equal(detectAccountIssue('https://www.douyin.com/search/test', '页面隐藏区域包含扫码登录和手机号登录入口'), null)
  assert.equal(detectAccountIssue('https://www.douyin.com/search/test', '正常搜索结果'), null)
})

test('账号告警持久化、相同告警只通知一次并可在恢复后清除', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-alert-'))
  const notifications = []
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir },
    BrowserWindow: function BrowserWindow() {},
    getAccounts: () => [],
    notify: (alert) => notifications.push(alert),
  })
  try {
    collector.setAlert('login_expired', '请重新登录', { uid: 'account-1' })
    collector.setAlert('login_expired', '请重新登录', { uid: 'account-1' })
    assert.equal(collector.getAlert().active, true)
    assert.equal(collector.getAlert().kind, 'login_expired')
    assert.equal(notifications.length, 1)
    collector.clearAlert()
    assert.equal(collector.getAlert().active, false)
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('账号经真实接口复检在线后即使无需继续搜索主页也会清除登录告警', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-recovered-'))
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir },
    BrowserWindow: function BrowserWindow() {},
    getAccounts: () => [{ uid: 'account-1', platform: 'Douyin', partition: 'persist:test', isLogin: true, status: 1 }],
    checkAccount: async () => ({ ok: true, verified: true, state: 'online', login: true }),
  })
  collector.profileTargetReached = () => true
  collector.commentTargetReached = () => true
  collector.databaseCounts = () => ({ profileContacts: 10000, profileDetails: 10000, profileDetailsByIndustry: {}, comments: 10000, commentsByIndustry: {} })
  collector.setAlert('login_expired', '请重新登录', { uid: 'account-1' })
  try {
    await collector.checkAlertRecovery()
    assert.equal(collector.getAlert().active, false)
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('登录失效告警每分钟可独立复检并恢复采集资格', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-alert-recheck-'))
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir },
    BrowserWindow: function BrowserWindow() {},
    getAccounts: () => [{ uid: 'account-1', platform: 'Douyin', partition: 'persist:test', isLogin: true, status: 1 }],
    checkAccount: async () => ({ ok: true, verified: true, state: 'online', login: true }),
  })
  try {
    collector.lastAttemptAt = Date.now()
    collector.setAlert('login_expired', '请重新登录', { uid: 'account-1' })
    const result = await collector.checkAlertRecovery()
    assert.equal(result.active, false)
    assert.equal(collector.lastAttemptAt, 0)
    assert.equal(collector.progress.stage, 'recovered')
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('发布或采集锁占用时账号告警复检不会创建竞争窗口', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-douyin-alert-lock-'))
  let checks = 0
  const collector = new DouyinPublicCollector({
    leadRadar: { dataDir },
    BrowserWindow: function BrowserWindow() {},
    getAccounts: () => [{ uid: 'account-1', platform: 'Douyin', partition: 'persist:test', isLogin: true, status: 1 }],
    checkAccount: async () => { checks++; return { ok: true, verified: true, state: 'online', login: true } },
    acquireActivity: () => null,
  })
  try {
    collector.setAlert('login_expired', '请重新登录', { uid: 'account-1' })
    const result = await collector.checkAlertRecovery()
    assert.equal(result.active, true)
    assert.equal(checks, 0)
  } finally {
    collector.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('抖音安全时段为08:30至22:30，夜间顺延到次日早间', () => {
  assert.equal(isWithinActiveHours(new Date(2026, 7, 28, 8, 29)), false)
  assert.equal(isWithinActiveHours(new Date(2026, 7, 28, 8, 30)), true)
  assert.equal(isWithinActiveHours(new Date(2026, 7, 28, 22, 29)), true)
  assert.equal(isWithinActiveHours(new Date(2026, 7, 28, 22, 30)), false)
  const next = new Date(nextActiveStart(new Date(2026, 7, 28, 23, 0).getTime(), () => 0))
  assert.equal(next.getDate(), 29)
  assert.equal(next.getHours(), 8)
  assert.equal(next.getMinutes(), 30)
})

test('白天下一轮随机间隔保持在4至6小时并不跨入夜间', () => {
  const morning = new Date(2026, 7, 28, 9, 0).getTime()
  assert.equal(computeNextRunAt(morning, () => 0) - morning, 4 * 60 * 60 * 1000)
  assert.equal(computeNextRunAt(morning, () => 1) - morning, 6 * 60 * 60 * 1000)
  const evening = new Date(computeNextRunAt(new Date(2026, 7, 28, 20, 0).getTime(), () => 0))
  assert.equal(evening.getDate(), 29)
  assert.equal(evening.getHours(), 8)
})

test('需求评论巡检间隔保持在75至120分钟且不跨入夜间', () => {
  const morning = new Date(2026, 7, 28, 9, 0).getTime()
  assert.equal(computeNextCommentRunAt(morning, () => 0) - morning, 75 * 60 * 1000)
  assert.equal(computeNextCommentRunAt(morning, () => 1) - morning, 120 * 60 * 1000)
  const evening = new Date(computeNextCommentRunAt(new Date(2026, 7, 28, 21, 45).getTime(), () => 1))
  assert.equal(evening.getDate(), 29)
  assert.equal(evening.getHours(), 9)
})
