'use strict'

const path = require('node:path')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { extractContacts } = require('./lead-radar')

const INDUSTRIES = ['flooring', 'cold_storage', 'membrane', 'retractable_shed', 'cleanroom']
const CONTINUOUS_TARGET = 10000
const CONTINUOUS_INTERVAL_MS = 6 * 60 * 60 * 1000
const VIDEO_REVISIT_INTERVAL_MS = 4 * 60 * 60 * 1000
const MAX_COMMENT_PROFILE_ENRICH_PER_RUN = 20
const ACTIVE_START_MINUTES = 8 * 60 + 30
const ACTIVE_END_MINUTES = 22 * 60 + 30
const MIN_RUN_INTERVAL_MS = 4 * 60 * 60 * 1000
const MAX_RUN_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_RUN_DURATION_MS = 75 * 60 * 1000
const MIN_COMMENT_INTERVAL_MS = 75 * 60 * 1000
const MAX_COMMENT_INTERVAL_MS = 120 * 60 * 1000
const MAX_COMMENT_RUN_DURATION_MS = 30 * 60 * 1000
const COMMENT_HOT_MAX_AGE_DAYS = 7
const COMMENT_REVIEW_MAX_AGE_DAYS = 30
const MAX_NAVIGATIONS_PER_COLLECTOR_WINDOW = 5
const NETWORK_TOTAL_BUFFER_BYTES = 24 * 1024 * 1024
const NETWORK_RESOURCE_BUFFER_BYTES = 4 * 1024 * 1024

const BASE_PROFILE_QUERIES = [
  { query: '地坪厂家', industry: 'flooring' },
  { query: '环氧地坪施工厂家', industry: 'flooring' },
  { query: '固化地坪厂家', industry: 'flooring' },
  { query: '金刚砂耐磨地坪厂家', industry: 'flooring' },
  { query: '地坪工程公司', industry: 'flooring' },
  { query: '厂房地坪施工队', industry: 'flooring' },
  { query: '停车场地坪施工', industry: 'flooring' },
  { query: '地坪翻新施工', industry: 'flooring' },
  { query: '冷库厂家', industry: 'cold_storage' },
  { query: '冷库安装厂家', industry: 'cold_storage' },
  { query: '冷链设备厂家', industry: 'cold_storage' },
  { query: '果蔬保鲜库厂家', industry: 'cold_storage' },
  { query: '冷库工程公司', industry: 'cold_storage' },
  { query: '冷库安装施工队', industry: 'cold_storage' },
  { query: '制冷设备工程公司', industry: 'cold_storage' },
  { query: '冷库维修厂家', industry: 'cold_storage' },
  { query: '膜结构厂家', industry: 'membrane' },
  { query: '膜结构车棚厂家', industry: 'membrane' },
  { query: '张拉膜厂家', industry: 'membrane' },
  { query: '污水池膜结构加盖厂家', industry: 'membrane' },
  { query: '膜结构工程公司', industry: 'membrane' },
  { query: '膜结构施工队', industry: 'membrane' },
  { query: '充电桩车棚厂家', industry: 'membrane' },
  { query: '景观膜结构施工', industry: 'membrane' },
  { query: '推拉棚厂家', industry: 'retractable_shed' },
  { query: '移动推拉棚厂家', industry: 'retractable_shed' },
  { query: '电动伸缩棚厂家', industry: 'retractable_shed' },
  { query: '厂房活动棚厂家', industry: 'retractable_shed' },
  { query: '推拉棚工程公司', industry: 'retractable_shed' },
  { query: '推拉棚施工队', industry: 'retractable_shed' },
  { query: '移动仓库棚厂家', industry: 'retractable_shed' },
  { query: '物流装卸棚厂家', industry: 'retractable_shed' },
  { query: '无尘车间厂家', industry: 'cleanroom' },
  { query: '净化车间工程厂家', industry: 'cleanroom' },
  { query: '洁净室工程公司', industry: 'cleanroom' },
  { query: 'GMP净化工程厂家', industry: 'cleanroom' },
  { query: '无尘车间工程公司', industry: 'cleanroom' },
  { query: '净化工程施工队', industry: 'cleanroom' },
  { query: '食品厂净化车间施工', industry: 'cleanroom' },
  { query: '实验室净化工程公司', industry: 'cleanroom' },
]

const PROFILE_QUERY_FAMILIES = {
  flooring: ['地坪', '环氧地坪', '固化地坪', '金刚砂地坪', '耐磨地坪', '聚氨酯地坪', '防静电地坪', '车库地坪', '厂房地坪', '停车场地坪', '地坪翻新', '水磨石地坪'],
  cold_storage: ['冷库', '冷藏库', '冷冻库', '保鲜库', '果蔬保鲜库', '气调库', '速冻库', '医药冷库', '食品冷库', '小型冷库', '冷链仓库', '制冷机组'],
  membrane: ['膜结构', '张拉膜', '膜结构车棚', '充电桩车棚', '景观膜', '体育看台棚', '污水池加盖', '膜结构雨棚', 'ETFE膜结构', 'PTFE膜结构'],
  retractable_shed: ['推拉棚', '移动推拉棚', '伸缩棚', '电动推拉棚', '活动雨棚', '移动仓库棚', '物流装卸棚', '厂房活动棚', '折叠棚'],
  cleanroom: ['无尘车间', '净化车间', '洁净室', '洁净厂房', '无菌车间', 'GMP车间', '食品净化车间', '电子厂无尘车间', '实验室净化', '手术室净化', '医药洁净车间', '百级洁净室', '千级洁净室', '十万级净化车间'],
}

const PROFILE_INTENTS = ['厂家', '工程公司', '施工队', '安装', '施工', '设计施工', '改造', '维修', '定制', '本地厂家', '全国施工']

function dedupeQueries(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = `${item.industry}:${String(item.query || '').replace(/\s+/g, '')}`
    if (!item.query || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildExpandedQueries(families, intents) {
  const rows = []
  for (const [industry, terms] of Object.entries(families)) {
    for (const term of terms) {
      for (const intent of intents) rows.push({ query: `${term}${intent}`, industry })
    }
  }
  return dedupeQueries(rows)
}

const PROFILE_QUERIES = dedupeQueries([...BASE_PROFILE_QUERIES, ...buildExpandedQueries(PROFILE_QUERY_FAMILIES, PROFILE_INTENTS)])

const BASE_COMMENT_QUERIES = [
  { query: '地坪多少钱', industry: 'flooring' },
  { query: '环氧地坪报价', industry: 'flooring' },
  { query: '固化地坪多少钱一平方', industry: 'flooring' },
  { query: '厂房地坪施工', industry: 'flooring' },
  { query: '厂房环氧地坪怎么收费', industry: 'flooring' },
  { query: '车库地坪找施工队', industry: 'flooring' },
  { query: '环氧地坪多少一平方', industry: 'flooring' },
  { query: '地坪包工包料价格', industry: 'flooring' },
  { query: '冷库多少钱', industry: 'cold_storage' },
  { query: '建冷库多少钱', industry: 'cold_storage' },
  { query: '冷库安装报价', industry: 'cold_storage' },
  { query: '果蔬保鲜库造价', industry: 'cold_storage' },
  { query: '农村建冷库预算', industry: 'cold_storage' },
  { query: '小型冷库怎么收费', industry: 'cold_storage' },
  { query: '冷库找安装施工队', industry: 'cold_storage' },
  { query: '冷库一平方多少钱', industry: 'cold_storage' },
  { query: '膜结构车棚多少钱', industry: 'membrane' },
  { query: '膜结构报价', industry: 'membrane' },
  { query: '张拉膜车棚造价', industry: 'membrane' },
  { query: '污水池加盖多少钱', industry: 'membrane' },
  { query: '膜结构车棚怎么收费', industry: 'membrane' },
  { query: '膜结构找施工厂家', industry: 'membrane' },
  { query: '张拉膜一平方多少钱', industry: 'membrane' },
  { query: '停车棚膜结构预算', industry: 'membrane' },
  { query: '推拉棚多少钱', industry: 'retractable_shed' },
  { query: '移动推拉棚报价', industry: 'retractable_shed' },
  { query: '电动伸缩棚多少钱', industry: 'retractable_shed' },
  { query: '厂房活动棚造价', industry: 'retractable_shed' },
  { query: '推拉棚一平方多少钱', industry: 'retractable_shed' },
  { query: '仓库移动棚找厂家', industry: 'retractable_shed' },
  { query: '伸缩棚怎么收费', industry: 'retractable_shed' },
  { query: '厂房推拉棚预算', industry: 'retractable_shed' },
  { query: '无尘车间造价', industry: 'cleanroom' },
  { query: '净化车间多少钱一平方', industry: 'cleanroom' },
  { query: '洁净室工程报价', industry: 'cleanroom' },
  { query: 'GMP净化工程造价', industry: 'cleanroom' },
  { query: '无尘车间一平方多少钱', industry: 'cleanroom' },
  { query: '洁净室找施工公司', industry: 'cleanroom' },
  { query: '净化车间怎么收费', industry: 'cleanroom' },
  { query: '食品厂无尘车间预算', industry: 'cleanroom' },
  { query: '药厂净化车间改造报价', industry: 'cleanroom' },
  { query: '电子厂无尘车间装修多少钱', industry: 'cleanroom' },
  { query: '实验室净化工程预算', industry: 'cleanroom' },
  { query: '医院手术室净化工程报价', industry: 'cleanroom' },
  { query: '无菌车间建设多少钱', industry: 'cleanroom' },
  { query: '千级洁净室造价', industry: 'cleanroom' },
  { query: '十万级净化车间多少钱', industry: 'cleanroom' },
  { query: '食品厂洁净车间找施工队', industry: 'cleanroom' },
]

const COMMENT_VIDEO_INTENTS = ['厂家施工现场', '工程案例', '施工案例', '安装现场', '施工过程', '完工效果', '改造案例', '报价讲解']
const COMMENT_QUERIES = dedupeQueries([...BASE_COMMENT_QUERIES, ...buildExpandedQueries(PROFILE_QUERY_FAMILIES, COMMENT_VIDEO_INTENTS)])

const DEMAND_RE = /(需要|准备做|计划做|想建|想做|想了解|多少钱|多少一平|一平方多少|怎么收费|求报价|预算|哪里有|附近有做|有没有推荐|求推荐|找厂家|找施工|找施工队|怎么联系|联系方式|留个电话|发个方案|能做吗|可以做吗|能不能做|有做|包工包料|多大面积|多少面积)/
const SELLER_RE = /(厂家直销|专业承接|主营|欢迎咨询|本公司|我们公司|可承接)/
const HIGH_INTENT_RE = /(怎么联系|联系方式|留个电话|发个方案|求报价|预算|找厂家|找施工|找施工队|附近有做|能做吗|可以做吗|准备做|计划做)/
const SIZE_OR_LOCATION_RE = /([0-9]{2,}\s*(?:平|平方|㎡|亩)|在(?:哪里|哪儿|.+省|.+市)|附近|本地)/
const INDUSTRY_REPLY_NAMES = {
  flooring: '地坪', cold_storage: '冷库', membrane: '膜结构', retractable_shed: '推拉棚', cleanroom: '净化工程',
}
// “获取验证码”“安全验证”会长期存在于已登录页面的隐藏登录弹层或帮助文案中，不能单独作为风控证据。
const RISK_RE = /(请输入验证码|验证码验证|验证码错误|完成验证码|滑块验证|人机验证|访问频繁|操作频繁|请完成验证|登录确认|账号异常)/
const ACCOUNT_RISK_COOLDOWN_MS = 6 * 60 * 60 * 1000
// “扫码登录/手机号登录”等文字可能长期藏在已登录页面的弹层 DOM 中，不能单独作为失效证据。
const LOGIN_TEXT_RE = /(请先登录(?:后再试|后继续|后使用)?|登录已失效|登录状态失效|登录过期|请重新登录)/
const LOGIN_URL_RE = /\/(?:passport|login|auth)(?:\/|\?|$)/i

class CollectionRiskError extends Error {
  constructor(message, kind = 'risk_control') {
    super(message)
    this.name = 'CollectionRiskError'
    this.kind = kind
  }
}

function detectRiskText(text) {
  const match = String(text || '').match(RISK_RE)
  return match ? match[0] : ''
}

function engagementIntentScore(row = {}) {
  const text = String(row.rawText || '').trim()
  let score = 40
  if (HIGH_INTENT_RE.test(text)) score += 30
  if (SIZE_OR_LOCATION_RE.test(text)) score += 15
  if (/(电话|微信|联系|报价|预算)/.test(text)) score += 10
  if (text.length >= 12) score += 5
  return Math.min(100, score)
}

function suggestedEngagementReply(row = {}) {
  const industry = INDUSTRY_REPLY_NAMES[row.industry] || '工程'
  return `您好，看您在咨询${industry}项目。如果还没定，可以说下所在地区和大概规模，方便判断。`
}

function normalizeUnixSeconds(value) {
  const number = Math.max(0, Number(value) || 0)
  return number > 100000000000 ? Math.floor(number / 1000) : Math.floor(number)
}

function commentFreshness(commentTime, nowMs = Date.now()) {
  const seconds = normalizeUnixSeconds(commentTime)
  if (!seconds) return 'unknown'
  const ageMs = Math.max(0, Number(nowMs) - seconds * 1000)
  if (ageMs <= COMMENT_HOT_MAX_AGE_DAYS * 86400000) return 'hot_7d'
  if (ageMs <= COMMENT_REVIEW_MAX_AGE_DAYS * 86400000) return 'recent_30d'
  return 'stale'
}

function commentWatermarkCutoff(lastCommentTime, nowMs = Date.now(), maxAgeDays = COMMENT_REVIEW_MAX_AGE_DAYS) {
  const hardCutoff = Math.floor((Number(nowMs) - Math.max(1, Number(maxAgeDays) || COMMENT_REVIEW_MAX_AGE_DAYS) * 86400000) / 1000)
  return Math.max(0, normalizeUnixSeconds(lastCommentTime), hardCutoff)
}

function detectAccountIssue(url, text) {
  const pageUrl = String(url || '')
  const pageText = String(text || '')
  if (LOGIN_URL_RE.test(pageUrl) || LOGIN_TEXT_RE.test(pageText)) {
    return { kind: 'login_expired', message: '抖音登录状态已失效，请重新登录后再采集' }
  }
  const risk = detectRiskText(pageText)
  if (risk) return { kind: 'risk_control', message: `抖音触发风控或验证：${risk}，请人工处理` }
  return null
}

function interleaveQueries(items) {
  const queues = INDUSTRIES.map((industry) => items.filter((item) => item.industry === industry))
  const result = []
  for (let index = 0; queues.some((queue) => index < queue.length); index++) {
    for (const queue of queues) {
      if (index < queue.length) result.push(queue[index])
    }
  }
  return result
}

function rotateQueries(items, cursor = 0) {
  if (!items.length) return []
  const offset = ((Number(cursor) || 0) % items.length + items.length) % items.length
  return items.slice(offset).concat(items.slice(0, offset))
}

function balancedTargetReached(total, countsByIndustry, target) {
  const perIndustryTarget = Math.max(1, Math.floor(target / INDUSTRIES.length))
  return total >= target
    && INDUSTRIES.every((industry) => Number(countsByIndustry[industry] || 0) >= perIndustryTarget)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function muteBackgroundCollectorWindow(win) {
  try {
    if (!win || !win.webContents || typeof win.webContents.setAudioMuted !== 'function') return false
    win.webContents.setAudioMuted(true)
    return true
  } catch (error) {
    return false
  }
}

function isWithinActiveHours(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  const minutes = date.getHours() * 60 + date.getMinutes()
  return minutes >= ACTIVE_START_MINUTES && minutes < ACTIVE_END_MINUTES
}

function nextActiveStart(value = Date.now(), random = Math.random) {
  const date = new Date(value)
  const start = new Date(date)
  start.setHours(8, 30, 0, 0)
  if (date.getTime() >= start.getTime()) start.setDate(start.getDate() + 1)
  return start.getTime() + Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 30 * 60 * 1000)
}

function computeNextRunAt(value = Date.now(), random = Math.random) {
  const now = Number(value)
  const date = new Date(now)
  if (!isWithinActiveHours(date)) return nextActiveStart(now, random)
  const ratio = Math.max(0, Math.min(1, Number(random()) || 0))
  const candidate = now + MIN_RUN_INTERVAL_MS + Math.floor((MAX_RUN_INTERVAL_MS - MIN_RUN_INTERVAL_MS) * ratio)
  return isWithinActiveHours(new Date(candidate)) ? candidate : nextActiveStart(candidate, random)
}

function computeNextCommentRunAt(value = Date.now(), random = Math.random) {
  const now = Number(value)
  if (!isWithinActiveHours(new Date(now))) return nextActiveStart(now, random)
  const ratio = Math.max(0, Math.min(1, Number(random()) || 0))
  const candidate = now + MIN_COMMENT_INTERVAL_MS + Math.floor((MAX_COMMENT_INTERVAL_MS - MIN_COMMENT_INTERVAL_MS) * ratio)
  return isWithinActiveHours(new Date(candidate)) ? candidate : nextActiveStart(candidate, random)
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

function extractAwemes(value, limit = 20) {
  const result = []
  const seen = new Set()
  let visited = 0
  function walk(item, depth = 0) {
    if (!item || depth > 9 || visited++ > 50000 || result.length >= limit) return
    if (Array.isArray(item)) {
      for (const child of item) walk(child, depth + 1)
      return
    }
    if (typeof item !== 'object') return
    if (item.aweme_id && item.desc !== undefined && !seen.has(String(item.aweme_id))) {
      seen.add(String(item.aweme_id))
      result.push(item)
    }
    for (const child of Object.values(item)) walk(child, depth + 1)
  }
  walk(value)
  return result
}

function extractIntentComments(payload, options = {}) {
  const industry = String(options.industry || 'unknown')
  const sourceUrl = String(options.sourceUrl || '')
  const max = Math.max(1, Math.min(100, Number(options.max) || 50))
  const minCommentTime = Math.max(0, Number(options.minCommentTime) || 0)
  const requireCommentTime = !!options.requireCommentTime
  const nowMs = Number(options.nowMs) || Date.now()
  const comments = Array.isArray(payload && payload.comments)
    ? [...payload.comments].sort((left, right) => normalizeUnixSeconds(right && (right.create_time || right.createTime))
      - normalizeUnixSeconds(left && (left.create_time || left.createTime)))
    : []
  const result = []
  for (const comment of comments) {
    const text = String(comment && comment.text || '').trim()
    const commentTime = normalizeUnixSeconds(comment && (comment.create_time || comment.createTime))
    if (requireCommentTime && !commentTime) continue
    // 同一秒可能出现多条评论，因此只过滤严格早于水位线的数据；最终仍由线索库去重。
    if (commentTime && commentTime < minCommentTime) continue
    if (!text || !DEMAND_RE.test(text) || SELLER_RE.test(text)) continue
    const user = comment.user || {}
    result.push({
      platform: 'douyin',
      sourceType: 'comment',
      industry,
      accountName: String(user.nickname || '抖音用户').slice(0, 120),
      douyinId: String(user.unique_id || user.short_id || '').slice(0, 80),
      profileUrl: user.sec_uid ? `https://www.douyin.com/user/${user.sec_uid}` : '',
      sourceUrl,
      rawText: text,
      commentId: String(comment.cid || comment.comment_id || comment.id || '').slice(0, 100),
      commentTime,
      freshnessTier: commentFreshness(commentTime, nowMs),
    })
    if (result.length >= max) break
  }
  return result
}

function subtractCollectorCounts(current = {}, baseline = {}) {
  const subtractMap = (left = {}, right = {}) => Object.fromEntries(INDUSTRIES.map((industry) => [
    industry,
    Math.max(0, Number(left[industry]) || 0) - Math.max(0, Number(right[industry]) || 0),
  ]))
  return {
    profileContacts: Math.max(0, (Number(current.profileContacts) || 0) - (Number(baseline.profileContacts) || 0)),
    profileContactsByIndustry: subtractMap(current.profileContactsByIndustry, baseline.profileContactsByIndustry),
    profileDetails: Math.max(0, (Number(current.profileDetails) || 0) - (Number(baseline.profileDetails) || 0)),
    profileDetailsByIndustry: subtractMap(current.profileDetailsByIndustry, baseline.profileDetailsByIndustry),
    comments: Math.max(0, (Number(current.comments) || 0) - (Number(baseline.comments) || 0)),
    commentsByIndustry: subtractMap(current.commentsByIndustry, baseline.commentsByIndustry),
  }
}

function latestCommentTime(payloads = []) {
  let latest = 0
  for (const payload of payloads) {
    for (const comment of Array.isArray(payload && payload.comments) ? payload.comments : []) {
      latest = Math.max(latest, Number(comment && (comment.create_time || comment.createTime)) || 0)
    }
  }
  return latest
}

function mergeVideoCandidates(monitored = [], discovered = [], limit = 10) {
  const max = Math.max(1, Number(limit) || 10)
  const monitoredQuota = Math.min(monitored.length, Math.max(1, Math.floor(max / 2)))
  const ordered = [...monitored.slice(0, monitoredQuota), ...discovered, ...monitored.slice(monitoredQuota)]
  const seen = new Set()
  const result = []
  for (const video of ordered) {
    const awemeId = String(video && video.aweme_id || '')
    if (!awemeId || seen.has(awemeId)) continue
    seen.add(awemeId)
    result.push(video)
    if (result.length >= max) break
  }
  return result
}

function normalizeProfileCards(cards, industry) {
  const rows = Array.isArray(cards) ? cards : []
  return rows.slice(0, 50).map((row) => {
    const text = String(row && row.text || '').trim().slice(0, 1200)
    const url = String(row && row.href || '').split('?')[0]
    return {
      platform: 'douyin',
      sourceType: 'profile',
      industry,
      accountName: text.split(/关注|抖音号|获赞/)[0].slice(0, 120),
      profileUrl: url,
      sourceUrl: url,
      rawText: text,
    }
  }).filter((row) => row.rawText && /^https:\/\/www\.douyin\.com\/user\//.test(row.sourceUrl) && !row.sourceUrl.endsWith('/user/self'))
}

function mergePublicProfileDetail(row, detail = {}) {
  const parts = [row.rawText, detail.description, detail.headerText]
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const unique = [...new Set(parts)]
  return { ...row, rawText: unique.join('\n主页公开简介：').slice(0, 12000) }
}

function hasPublicContact(row) {
  return extractContacts(String(row && row.rawText || '')).length > 0
}

class NetworkCapture {
  constructor(webContents) {
    this.webContents = webContents
    this.responses = []
    this.ownsDebugger = false
    this.fetchInterceptionEnabled = false
    this.onMessage = (_event, method, params) => {
      if (method === 'Fetch.requestPaused') {
        const requestId = String(params && params.requestId || '')
        if (requestId) {
          this.webContents.debugger.sendCommand('Fetch.failRequest', {
            requestId,
            errorReason: 'BlockedByClient',
          }).catch(() => {})
        }
        return
      }
      if (method !== 'Network.responseReceived') return
      const url = String(params && params.response && params.response.url || '')
      if (/\/aweme\/v1\/web\/(?:general\/search\/single|comment\/list)\//.test(url)) this.responses.push(params)
    }
  }

  async attach() {
    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach('1.3')
      this.ownsDebugger = true
    }
    this.webContents.debugger.on('message', this.onMessage)
    await this.webContents.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
      maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
      maxPostDataSize: 64 * 1024,
    })
    await this.webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
    await this.webContents.debugger.sendCommand('Network.setBypassServiceWorker', { bypass: true }).catch(() => {})
    // URL 后缀不能覆盖抖音的全部媒体 CDN。Fetch 按资源类型拦截，只作用于这个隐藏采集 target。
    try {
      await this.webContents.debugger.sendCommand('Fetch.enable', { patterns: [
        { urlPattern: '*', resourceType: 'Image', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Media', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Font', requestStage: 'Request' },
      ] })
      this.fetchInterceptionEnabled = true
    } catch (error) {}
    // 隐藏采集窗口只需要公开文字和 JSON；不下载图片、视频、音频和字体，降低内存/显存占用。
    await this.webContents.debugger.sendCommand('Network.setBlockedURLs', { urls: [
      '*.jpg*', '*.jpeg*', '*.png*', '*.webp*', '*.avif*', '*.gif*', '*.svg*',
      '*.mp4*', '*.webm*', '*.m3u8*', '*.mp3*', '*.wav*', '*.aac*', '*.m4a*', '*.woff*', '*.ttf*',
    ] }).catch(() => {})
  }

  assertUsableResponse(hit) {
    const status = Number(hit && hit.response && hit.response.status) || 0
    if (status === 401) throw new CollectionRiskError('抖音公开接口拒绝登录凭证，请重新登录', 'login_expired')
    if (status === 403) throw new CollectionRiskError('抖音公开接口返回 403，账号已进入冷却，避免继续触发验证', 'risk_control')
    if (status === 429) throw new CollectionRiskError('抖音公开接口请求过于频繁，账号已自动限流冷却', 'rate_limited')
    if (status >= 400) throw new Error(`抖音公开接口 HTTP ${status}`)
  }

  async navigateForJson(url, pathFragment, timeoutMs = 15000) {
    this.responses.length = 0
    const start = 0
    await this.webContents.loadURL(url)
    const deadline = Date.now() + timeoutMs
    let hit = null
    while (Date.now() < deadline) {
      hit = this.responses.slice(start).reverse().find((item) => String(item.response && item.response.url || '').includes(pathFragment))
      if (hit) break
      await sleep(400)
    }
    if (!hit) {
      const pageText = await this.webContents.executeJavaScript("String(document.body && document.body.innerText || '').slice(0, 4000)").catch(() => '')
      const issue = detectAccountIssue(this.webContents.getURL(), pageText)
      if (issue) throw new CollectionRiskError(issue.message, issue.kind)
      throw new Error(`未读取到抖音公开接口：${pathFragment}`)
    }
    this.assertUsableResponse(hit)
    await sleep(500)
    const body = await this.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: hit.requestId })
    return JSON.parse(body.body)
  }

  async navigateAndCollectJson(url, pathFragment, options = {}) {
    const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 15000)
    const scrolls = Math.max(0, Math.min(12, Number(options.scrolls) || 5))
    this.responses.length = 0
    const start = 0
    await this.webContents.loadURL(url)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.responses.slice(start).some((item) => String(item.response && item.response.url || '').includes(pathFragment))) break
      await sleep(400)
    }
    for (let index = 0; index < scrolls; index++) {
      await this.webContents.executeJavaScript('window.scrollBy(0, Math.max(900, innerHeight * 0.9))').catch(() => {})
      await sleep(900)
    }
    const hits = this.responses.slice(start).filter((item) => String(item.response && item.response.url || '').includes(pathFragment))
    const unique = [...new Map(hits.map((item) => [item.requestId, item])).values()]
    if (!unique.length) {
      const pageText = await this.webContents.executeJavaScript("String(document.body && document.body.innerText || '').slice(0, 4000)").catch(() => '')
      const issue = detectAccountIssue(this.webContents.getURL(), pageText)
      if (issue) throw new CollectionRiskError(issue.message, issue.kind)
      throw new Error(`未读取到抖音公开接口：${pathFragment}`)
    }
    for (const hit of unique) this.assertUsableResponse(hit)
    const payloads = []
    for (const hit of unique) {
      try {
        const body = await this.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: hit.requestId })
        payloads.push(JSON.parse(body.body))
      } catch (error) {}
    }
    if (!payloads.length) throw new Error(`抖音公开接口响应体读取失败：${pathFragment}`)
    return payloads
  }

  close() {
    try { this.webContents.debugger.off('message', this.onMessage) } catch (error) {}
    if (this.fetchInterceptionEnabled) {
      try { this.webContents.debugger.sendCommand('Fetch.disable').catch(() => {}) } catch (error) {}
    }
    try { if (this.ownsDebugger && this.webContents.debugger.isAttached()) this.webContents.debugger.detach() } catch (error) {}
  }
}

class RotatingCollectorWindow {
  constructor(options = {}) {
    this.BrowserWindow = options.BrowserWindow
    this.partition = String(options.partition || '')
    this.maxNavigations = Math.max(1, Number(options.maxNavigations) || MAX_NAVIGATIONS_PER_COLLECTOR_WINDOW)
    this.onWindowChange = typeof options.onWindowChange === 'function' ? options.onWindowChange : () => {}
    this.captureFactory = typeof options.captureFactory === 'function'
      ? options.captureFactory : (webContents) => new NetworkCapture(webContents)
    this.win = null
    this.capture = null
    this.navigationCount = 0
    this.windowsCreated = 0
  }

  async create() {
    const win = new this.BrowserWindow({
      width: 1180,
      height: 820,
      show: false,
      webPreferences: { partition: this.partition, backgroundThrottling: false },
    })
    muteBackgroundCollectorWindow(win)
    const capture = this.captureFactory(win.webContents)
    this.win = win
    this.capture = capture
    this.navigationCount = 0
    this.onWindowChange(win)
    try {
      await withTimeout(win.loadURL('about:blank'), 10000, '初始化抖音浏览器窗口超时')
      await withTimeout(capture.attach(), 10000, '初始化抖音网络读取超时')
    } catch (error) {
      this.destroyCurrent()
      throw error
    }
    this.windowsCreated++
    return win
  }

  destroyCurrent() {
    const win = this.win
    const capture = this.capture
    this.win = null
    this.capture = null
    this.navigationCount = 0
    try { if (capture) capture.close() } catch (error) {}
    try { if (win && !win.isDestroyed()) win.destroy() } catch (error) {}
    this.onWindowChange(null)
  }

  async nextNavigation() {
    if (!this.win || (typeof this.win.isDestroyed === 'function' && this.win.isDestroyed())) {
      if (this.win || this.capture) this.destroyCurrent()
      await this.create()
    }
    if (this.navigationCount >= this.maxNavigations) {
      this.destroyCurrent()
      await this.create()
    }
    this.navigationCount++
    return { window: this.win, webContents: this.win.webContents, capture: this.capture }
  }

  close() {
    this.destroyCurrent()
  }
}

class DouyinPublicCollector {
  constructor(options = {}) {
    if (!options.leadRadar) throw new Error('DouyinPublicCollector 需要 LeadRadar 实例')
    if (!options.BrowserWindow) throw new Error('DouyinPublicCollector 需要 BrowserWindow')
    if (typeof options.getAccounts !== 'function') throw new Error('DouyinPublicCollector 需要账号读取器')
    this.leadRadar = options.leadRadar
    this.BrowserWindow = options.BrowserWindow
    this.getAccounts = options.getAccounts
    this.checkAccount = typeof options.checkAccount === 'function' ? options.checkAccount : null
    this.isPublishing = typeof options.isPublishing === 'function' ? options.isPublishing : () => false
    this.acquireActivity = typeof options.acquireActivity === 'function' ? options.acquireActivity : () => ({ owner: 'collector' })
    this.releaseActivity = typeof options.releaseActivity === 'function' ? options.releaseActivity : () => true
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
    this.notify = typeof options.notify === 'function' ? options.notify : () => {}
    this.waitMs = Math.max(1500, Number(options.waitMs) || 5500)
    this.running = false
    this.progress = { stage: 'idle', message: '等待运行', current: 0, total: 0 }
    this.lastRun = null
    this.lastAttemptAt = 0
    this.random = typeof options.random === 'function' ? options.random : Math.random
    const initialRunAt = isWithinActiveHours(new Date()) ? Date.now() + 15000 : nextActiveStart(Date.now(), this.random)
    this.nextCommentRunAt = initialRunAt
    this.nextProfileRunAt = initialRunAt + 45000
    this.nextRunAt = Math.min(this.nextCommentRunAt, this.nextProfileRunAt)
    this.timer = null
    this.startTimeout = null
    this.targets = { targetProfiles: CONTINUOUS_TARGET, targetProfileDetails: CONTINUOUS_TARGET, targetComments: CONTINUOUS_TARGET }
    this.activeWindow = null
    this.countsCache = null
    this.stateDb = new DatabaseSync(path.join(this.leadRadar.dataDir, 'douyin-public-collector.sqlite'))
    this.stateDb.exec(`
      CREATE TABLE IF NOT EXISTS processed_videos (
        aweme_id TEXT PRIMARY KEY,
        query TEXT NOT NULL DEFAULT '',
        industry TEXT NOT NULL DEFAULT 'unknown',
        processed_at TEXT NOT NULL,
        next_check_at TEXT NOT NULL DEFAULT '',
        last_comment_time INTEGER NOT NULL DEFAULT 0,
        scan_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS processed_profiles (
        profile_url TEXT PRIMARY KEY,
        industry TEXT NOT NULL DEFAULT 'unknown',
        query TEXT NOT NULL DEFAULT '',
        processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processed_comments (
        comment_key TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL DEFAULT '',
        aweme_id TEXT NOT NULL DEFAULT '',
        comment_time INTEGER NOT NULL DEFAULT 0,
        profile_url TEXT NOT NULL DEFAULT '',
        processed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_processed_comments_video ON processed_comments(aweme_id, comment_time DESC);
      CREATE TABLE IF NOT EXISTS processed_profile_roles (
        profile_url TEXT NOT NULL,
        profile_role TEXT NOT NULL,
        industry TEXT NOT NULL DEFAULT 'unknown',
        query TEXT NOT NULL DEFAULT '',
        processed_at TEXT NOT NULL,
        PRIMARY KEY (profile_url, profile_role)
      );
      CREATE INDEX IF NOT EXISTS idx_processed_profile_roles_time ON processed_profile_roles(profile_role, processed_at DESC);
      CREATE TABLE IF NOT EXISTS engagement_candidates (
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
        comment_time INTEGER NOT NULL DEFAULT 0,
        freshness_tier TEXT NOT NULL DEFAULT 'unknown',
        prepared_at TEXT NOT NULL DEFAULT '',
        prepare_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        detected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_engagement_candidates_status ON engagement_candidates(status, intent_score DESC, detected_at DESC);
      CREATE TABLE IF NOT EXISTS engagement_action_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id INTEGER NOT NULL,
        action_type TEXT NOT NULL DEFAULT 'reply',
        mode TEXT NOT NULL DEFAULT 'dry_run',
        status TEXT NOT NULL DEFAULT 'prepared',
        reply_text TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_engagement_action_logs_candidate ON engagement_action_logs(candidate_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS collector_alerts (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        account_uid TEXT NOT NULL DEFAULT '',
        detected_at TEXT NOT NULL DEFAULT '',
        cleared_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS collector_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS collector_account_state (
        account_uid TEXT PRIMARY KEY,
        partition_name TEXT NOT NULL DEFAULT '',
        nickname TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'ready',
        cooldown_until TEXT NOT NULL DEFAULT '',
        last_used_at TEXT NOT NULL DEFAULT '',
        last_success_at TEXT NOT NULL DEFAULT '',
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT ''
      );
    `)
    const videoColumns = new Set(this.stateDb.prepare('PRAGMA table_info(processed_videos)').all().map((item) => item.name))
    if (!videoColumns.has('industry')) this.stateDb.exec("ALTER TABLE processed_videos ADD COLUMN industry TEXT NOT NULL DEFAULT 'unknown'")
    if (!videoColumns.has('next_check_at')) this.stateDb.exec("ALTER TABLE processed_videos ADD COLUMN next_check_at TEXT NOT NULL DEFAULT ''")
    if (!videoColumns.has('last_comment_time')) this.stateDb.exec('ALTER TABLE processed_videos ADD COLUMN last_comment_time INTEGER NOT NULL DEFAULT 0')
    if (!videoColumns.has('scan_count')) this.stateDb.exec('ALTER TABLE processed_videos ADD COLUMN scan_count INTEGER NOT NULL DEFAULT 0')
    const profileColumns = new Set(this.stateDb.prepare('PRAGMA table_info(processed_profiles)').all().map((item) => item.name))
    if (!profileColumns.has('industry')) this.stateDb.exec("ALTER TABLE processed_profiles ADD COLUMN industry TEXT NOT NULL DEFAULT 'unknown'")
    if (!profileColumns.has('query')) this.stateDb.exec("ALTER TABLE processed_profiles ADD COLUMN query TEXT NOT NULL DEFAULT ''")
    if (!profileColumns.has('processed_at')) this.stateDb.exec("ALTER TABLE processed_profiles ADD COLUMN processed_at TEXT NOT NULL DEFAULT ''")
    const engagementColumns = new Set(this.stateDb.prepare('PRAGMA table_info(engagement_candidates)').all().map((item) => item.name))
    if (!engagementColumns.has('comment_time')) this.stateDb.exec('ALTER TABLE engagement_candidates ADD COLUMN comment_time INTEGER NOT NULL DEFAULT 0')
    if (!engagementColumns.has('freshness_tier')) this.stateDb.exec("ALTER TABLE engagement_candidates ADD COLUMN freshness_tier TEXT NOT NULL DEFAULT 'unknown'")
    if (!engagementColumns.has('prepared_at')) this.stateDb.exec("ALTER TABLE engagement_candidates ADD COLUMN prepared_at TEXT NOT NULL DEFAULT ''")
    if (!engagementColumns.has('prepare_count')) this.stateDb.exec('ALTER TABLE engagement_candidates ADD COLUMN prepare_count INTEGER NOT NULL DEFAULT 0')
    this.stateDb.exec('CREATE INDEX IF NOT EXISTS idx_engagement_candidates_freshness ON engagement_candidates(status, freshness_tier, comment_time DESC, intent_score DESC)')
    // 旧版只用 comment_id 作唯一键；升级后把作品 ID 纳入键，避免跨作品误去重。
    this.stateDb.exec(`UPDATE OR IGNORE processed_comments
      SET comment_key = 'id:' || aweme_id || ':' || comment_id
      WHERE comment_id <> '' AND aweme_id <> '' AND comment_key = 'id:' || comment_id`)
    this.stateDb.exec(`INSERT OR IGNORE INTO processed_profile_roles (profile_url, profile_role, industry, query, processed_at)
      SELECT profile_url, 'supplier', industry, query, processed_at FROM processed_profiles`)
    this.stateDb.exec(`UPDATE engagement_candidates SET comment_time = COALESCE((
        SELECT MAX(comment_time) FROM processed_comments
        WHERE processed_comments.aweme_id = engagement_candidates.aweme_id
          AND processed_comments.comment_id = engagement_candidates.comment_id
      ), 0)
      WHERE comment_time = 0 AND aweme_id <> '' AND comment_id <> ''`)
    this.syncAccountPool()
    this.backfillEngagementCandidatesFromLeads()
    this.refreshEngagementFreshness()
    this.archiveStaleEngagementCandidates()
  }

  getStatus() {
    return {
      running: this.running,
      progress: { ...this.progress },
      lastRun: this.lastRun,
      counts: this.databaseCounts(),
      engagement: {
        ...this.engagementSummary(),
        mode: 'review_only',
        automaticThirdPartyInteraction: false,
        workflow: 'copy_and_open',
        hotDays: COMMENT_HOT_MAX_AGE_DAYS,
        reviewDays: COMMENT_REVIEW_MAX_AGE_DAYS,
      },
      targets: { ...this.targets },
      targetScope: 'per_run',
      modes: { activeProfileSearch: true, profileDetailContactScan: true, demandCommentScan: true },
      profileQueryCount: PROFILE_QUERIES.length,
      commentQueryCount: COMMENT_QUERIES.length,
      queryCursors: {
        profiles: this.getStateNumber('profile_query_cursor'),
        comments: this.getStateNumber('comment_query_cursor'),
      },
      accountPool: this.getAccountPoolStatus(),
      alert: this.getAlert(),
      schedule: {
        activeStart: '08:30',
        activeEnd: '22:30',
        quiet: !isWithinActiveHours(new Date()),
        nextRunAt: new Date(this.nextRunAt).toISOString(),
        nextCommentRunAt: new Date(this.nextCommentRunAt).toISOString(),
        nextProfileRunAt: new Date(this.nextProfileRunAt).toISOString(),
        commentIntervalMinutes: '75—120',
        profileIntervalHours: '4—6',
        maxRunMinutes: Math.round(MAX_RUN_DURATION_MS / 60000),
      },
    }
  }

  getStateNumber(key) {
    const row = this.stateDb.prepare('SELECT value FROM collector_state WHERE key = ?').get(String(key))
    return row ? Math.max(0, Number(row.value) || 0) : 0
  }

  advanceQueryCursor(key, amount, total) {
    const next = total > 0 ? (this.getStateNumber(key) + Math.max(0, Number(amount) || 0)) % total : 0
    this.stateDb.prepare(`INSERT INTO collector_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(key), String(next))
    return next
  }

  syncAccountPool() {
    const accounts = this.getAccounts().filter((account) => account.platform === 'Douyin' && account.partition && account.uid !== undefined && account.uid !== null)
    const insert = this.stateDb.prepare(`INSERT INTO collector_account_state (account_uid, partition_name, nickname)
      VALUES (?, ?, ?) ON CONFLICT(account_uid) DO UPDATE SET partition_name = excluded.partition_name, nickname = excluded.nickname`)
    for (const account of accounts) insert.run(String(account.uid), String(account.partition), String(account.nickname || account.uid).slice(0, 120))
    const alert = this.getAlert()
    // 旧版曾把隐藏登录弹层里的“验证码/获取验证码”当成风控。该告警缺乏操作语境，升级时自动撤销。
    const legacyIsolatedRisk = new Set([
      '抖音触发风控或验证：验证码，请人工处理',
      '抖音触发风控或验证：获取验证码，请人工处理',
    ])
    if (alert.active && alert.kind === 'risk_control' && legacyIsolatedRisk.has(alert.message)) {
      if (alert.accountUid) {
        this.stateDb.prepare(`UPDATE collector_account_state SET state = 'ready', cooldown_until = '',
          failure_count = 0, last_error = '' WHERE account_uid = ?`).run(alert.accountUid)
      }
      this.clearAlert()
      return accounts
    }
    if (alert.active && alert.accountUid) {
      const state = this.stateDb.prepare('SELECT state FROM collector_account_state WHERE account_uid = ?').get(alert.accountUid)
      if (state && state.state === 'ready') {
        this.markAccountIssue(accounts.find((item) => String(item.uid) === alert.accountUid), alert.kind, alert.message, false)
      }
    }
    return accounts
  }

  getAccountPoolStatus() {
    const accounts = this.syncAccountPool()
    const rows = new Map(this.stateDb.prepare('SELECT * FROM collector_account_state').all().map((row) => [String(row.account_uid), row]))
    const now = Date.now()
    const list = accounts.map((account) => {
      const row = rows.get(String(account.uid)) || {}
      const cooldownUntil = String(row.cooldown_until || '')
      const cooling = cooldownUntil && Date.parse(cooldownUntil) > now
      const credentialsOk = !account.credentialError && account.isLogin !== false && Number(account.status) !== 0
      return {
        uid: String(account.uid), nickname: String(account.nickname || account.uid),
        state: credentialsOk ? (cooling ? 'cooldown' : String(row.state || 'ready')) : 'login_expired',
        cooldownUntil, lastUsedAt: String(row.last_used_at || ''), lastSuccessAt: String(row.last_success_at || ''),
        available: credentialsOk && !cooling && String(row.state || 'ready') !== 'login_expired',
      }
    })
    return { total: list.length, available: list.filter((item) => item.available).length, list }
  }

  markAccountUsed(account) {
    if (!account) return
    this.stateDb.prepare('UPDATE collector_account_state SET last_used_at = ? WHERE account_uid = ?')
      .run(new Date().toISOString(), String(account.uid))
  }

  markAccountIssue(account, kind, message, notify = true) {
    if (!account || account.uid === undefined || account.uid === null) return
    const uid = String(account.uid)
    const current = this.stateDb.prepare('SELECT failure_count FROM collector_account_state WHERE account_uid = ?').get(uid)
    const cooldownMs = kind === 'rate_limited' ? 2 * 60 * 60 * 1000
      : kind === 'risk_control' ? ACCOUNT_RISK_COOLDOWN_MS : 24 * 60 * 60 * 1000
    const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString()
    this.stateDb.prepare(`INSERT INTO collector_account_state
      (account_uid, partition_name, nickname, state, cooldown_until, failure_count, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_uid) DO UPDATE SET state = excluded.state, cooldown_until = excluded.cooldown_until,
        failure_count = excluded.failure_count, last_error = excluded.last_error`)
      .run(uid, String(account.partition || ''), String(account.nickname || uid).slice(0, 120), String(kind || 'risk_control'),
        cooldownUntil, Number(current && current.failure_count || 0) + 1, String(message || '').slice(0, 500))
    if (notify) return this.setAlert(kind, message, account, false)
  }

  markAccountSuccess(account, verifiedPage = false) {
    if (!account) return
    const uid = String(account.uid)
    const row = this.stateDb.prepare('SELECT state FROM collector_account_state WHERE account_uid = ?').get(uid)
    if (row && row.state === 'risk_control' && !verifiedPage) return
    this.stateDb.prepare(`UPDATE collector_account_state SET state = 'ready', cooldown_until = '',
      last_success_at = ?, failure_count = 0, last_error = '' WHERE account_uid = ?`)
      .run(new Date().toISOString(), uid)
    const alert = this.getAlert()
    if (alert.active && alert.accountUid === uid && verifiedPage) this.clearAlert()
  }

  getAlert() {
    const row = this.stateDb.prepare('SELECT active, kind, message, account_uid, detected_at, cleared_at FROM collector_alerts WHERE id = 1').get()
    if (!row) return { active: false, kind: '', message: '', accountUid: '', detectedAt: '', clearedAt: '' }
    return {
      active: !!row.active,
      kind: String(row.kind || ''),
      message: String(row.message || ''),
      accountUid: String(row.account_uid || ''),
      detectedAt: String(row.detected_at || ''),
      clearedAt: String(row.cleared_at || ''),
    }
  }

  setAlert(kind, message, account, recordAccount = true) {
    const current = this.getAlert()
    const accountUid = String(account && account.uid || '')
    const nextKind = String(kind || 'risk_control')
    const nextMessage = String(message || '抖音账号需要人工处理').slice(0, 500)
    if (recordAccount && account) this.markAccountIssue(account, nextKind, nextMessage, false)
    const sameAlert = current.active && current.kind === nextKind && current.message === nextMessage && current.accountUid === accountUid
    const detectedAt = sameAlert ? current.detectedAt : new Date().toISOString()
    this.stateDb.prepare(`INSERT INTO collector_alerts (id, active, kind, message, account_uid, detected_at, cleared_at)
      VALUES (1, 1, ?, ?, ?, ?, '')
      ON CONFLICT(id) DO UPDATE SET active = 1, kind = excluded.kind, message = excluded.message,
        account_uid = excluded.account_uid, detected_at = excluded.detected_at, cleared_at = ''`)
      .run(nextKind, nextMessage, accountUid, detectedAt)
    const alert = this.getAlert()
    if (!sameAlert) {
      try { this.notify(alert) } catch (error) {}
    }
    return alert
  }

  clearAlert() {
    const current = this.getAlert()
    if (!current.active) return current
    this.stateDb.prepare('UPDATE collector_alerts SET active = 0, cleared_at = ? WHERE id = 1')
      .run(new Date().toISOString())
    return this.getAlert()
  }

  async checkAlertRecovery() {
    const alert = this.getAlert()
    if (!alert.active || alert.kind !== 'login_expired' || this.running || this.isPublishing()) return alert
    const account = this.findAccount({ accountUid: alert.accountUid, includeUnavailable: true })
    if (!account || account.credentialError || account.isLogin === false || Number(account.status) === 0 || !this.checkAccount) return alert
    const activityToken = this.acquireActivity()
    if (!activityToken) return alert
    try {
      const check = await this.checkAccount(account, { activityHeld: true })
      if (!check || !check.ok || !(check.verified || check.state === 'online' || check.login === true)) return alert
      this.markAccountSuccess(account, true)
      const cleared = this.clearAlert()
      this.lastAttemptAt = 0
      this.nextCommentRunAt = Date.now()
      this.nextProfileRunAt = Date.now() + 60000
      this.nextRunAt = this.nextCommentRunAt
      this.progress = { stage: 'recovered', message: '抖音登录状态复检正常，自动恢复采集', current: 0, total: 0 }
      return cleared
    } finally {
      this.releaseActivity(activityToken)
    }
  }

  findAccount(payload = {}) {
    const list = this.syncAccountPool()
    const requested = String(payload.accountUid || '')
    if (requested && payload.includeUnavailable) return list.find((account) => String(account.uid) === requested) || null
    const now = Date.now()
    const states = new Map(this.stateDb.prepare('SELECT account_uid, state, cooldown_until, last_used_at FROM collector_account_state').all().map((row) => [String(row.account_uid), row]))
    const eligible = list.filter((account) => {
      if (account.credentialError || account.isLogin === false || Number(account.status) === 0) return false
      const row = states.get(String(account.uid)) || {}
      if (row.state === 'login_expired') return false
      if (row.cooldown_until && Date.parse(row.cooldown_until) > now) return false
      return true
    }).sort((a, b) => {
      const left = Date.parse((states.get(String(a.uid)) || {}).last_used_at || 0) || 0
      const right = Date.parse((states.get(String(b.uid)) || {}).last_used_at || 0) || 0
      return left - right
    })
    return (requested ? eligible.find((account) => String(account.uid) === requested) : eligible[0]) || null
  }

  async collectProfileCards(webContents, query, industry, limit) {
    const url = `https://www.douyin.com/search/${encodeURIComponent(query)}?type=user`
    await webContents.loadURL(url)
    await sleep(this.waitMs)
    const pageText = await webContents.executeJavaScript("String(document.body && document.body.innerText || '').slice(0, 4000)").catch(() => '')
    const issue = detectAccountIssue(webContents.getURL(), pageText)
    if (issue) throw new CollectionRiskError(issue.message, issue.kind)
    const cards = await webContents.executeJavaScript(`(async function () {
      for (let index = 0; index < 6; index += 1) {
        window.scrollBy(0, Math.max(700, innerHeight * 0.8));
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      const seen = new Set();
      const result = [];
      for (const anchor of document.links) {
        const href = String(anchor.href || '').split('?')[0];
        if (!href.includes('/user/') || href.endsWith('/user/self') || seen.has(href)) continue;
        let node = anchor;
        let text = '';
        for (let depth = 0; depth < 5 && node; depth += 1, node = node.parentElement) {
          const value = String(node.innerText || '').replace(/\\s+/g, ' ').trim();
          if (!text && value.length >= 15 && value.length <= 1200) text = value;
          if (/(抖音号|获赞|粉丝)/.test(value) && value.length <= 1200) { text = value; break; }
        }
        if (!text) continue;
        seen.add(href);
        result.push({ href, text: text.slice(0, 1200) });
      }
      return result;
    })()`)
    return normalizeProfileCards(cards, industry).slice(0, limit)
  }

  async collectPublicProfileDetail(webContents, row) {
    if (!row || !/^https:\/\/www\.douyin\.com\/user\//.test(String(row.profileUrl || ''))) {
      throw new Error('主页地址不是受支持的抖音公开主页')
    }
    await withTimeout(webContents.loadURL(row.profileUrl), 15000, '打开抖音公开主页超时')
    await sleep(Math.max(2500, this.waitMs))
    const finalUrl = String(webContents.getURL() || '').split('?')[0]
    if (!/^https:\/\/www\.douyin\.com\/user\//.test(finalUrl)) {
      const issue = detectAccountIssue(finalUrl, '')
      throw new CollectionRiskError(issue ? issue.message : '抖音公开主页跳转到登录或验证页面', issue ? issue.kind : 'risk_control')
    }
    const detail = await webContents.executeJavaScript(`(function () {
      const clean = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const description = clean((document.querySelector('meta[name="description"]') || {}).content).slice(0, 3000);
      const selectors = [
        '[data-e2e="user-info"]', '[data-e2e="user-detail"]', '[data-e2e="user-desc"]',
        '[data-e2e="user-title"]', '[data-e2e="user-subtitle"]', 'main header'
      ];
      const snippets = [];
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          const text = clean(node.innerText);
          if (text && text.length <= 3000 && !snippets.includes(text)) snippets.push(text);
          if (snippets.length >= 8) break;
        }
        if (snippets.length >= 8) break;
      }
      return {
        description,
        headerText: snippets.join(' | ').slice(0, 6000),
        pageText: clean(document.body && document.body.innerText).slice(0, 4000)
      };
    })()`)
    const issue = detectAccountIssue(finalUrl, detail.pageText)
    if (issue) throw new CollectionRiskError(issue.message, issue.kind)
    if (!detail.description && !detail.headerText) throw new Error('公开主页未找到可核验的简介区域')
    return mergePublicProfileDetail(row, detail)
  }

  async enrichIntentCommentProfiles(webContents, rows, options = {}) {
    const stats = options.stats || {}
    const profileLimit = Math.max(0, Number(options.profileLimit) || 0)
    const shouldStopSafely = typeof options.shouldStopSafely === 'function' ? options.shouldStopSafely : () => false
    const beforeProfileNavigation = typeof options.beforeProfileNavigation === 'function'
      ? options.beforeProfileNavigation : async () => webContents
    const enrichedRows = []
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]
      if (shouldStopSafely()) {
        stats.stoppedBySchedule = true
        enrichedRows.push(...rows.slice(rowIndex))
        break
      }
      let enriched = row
      if (row.profileUrl && Number(stats.commentProfilesOpened || 0) < profileLimit && !this.isProfileRecentlyProcessed(row.profileUrl, 14, 'commenter')) {
        this.progress = { stage: 'comment_profile_details', message: `补全意向客户公开主页：${row.accountName || '抖音用户'}`,
          current: Number(options.current) || 0, total: Number(options.total) || 0 }
        try {
          stats.commentProfilesOpened = Number(stats.commentProfilesOpened || 0) + 1
          const currentWebContents = await beforeProfileNavigation()
          enriched = await this.collectPublicProfileDetail(currentWebContents, row)
          this.markAccountSuccess(options.account, true)
          this.markProfileProcessed(row.profileUrl, options.query, options.industry, 'commenter')
          if (hasPublicContact(enriched)) stats.commentContactsAdded = Number(stats.commentContactsAdded || 0) + 1
        } catch (error) {
          if (error instanceof CollectionRiskError) throw error
          stats.errors = Number(stats.errors || 0) + 1
        }
        const delayMs = options.profileDelayMs == null ? 2500 : Math.max(0, Number(options.profileDelayMs) || 0)
        if (delayMs) await sleep(delayMs)
      }
      enrichedRows.push(enriched)
    }
    return enrichedRows
  }

  importRows(rows) {
    let imported = 0
    let duplicates = 0
    let contacts = 0
    for (const row of rows) {
      const result = this.leadRadar.importText(row)
      imported += result.imported || 0
      duplicates += result.duplicates || 0
      contacts += (result.list || []).filter((item) => !!item.contact_masked).length
    }
    if (imported) this.countsCache = null
    return { imported, duplicates, contacts }
  }

  databaseCounts() {
    if (this.countsCache && Date.now() - this.countsCache.at < 2000) return this.countsCache.value
    const row = this.leadRadar.db.prepare(`SELECT
      SUM(CASE WHEN source_type = 'profile' AND length(contact_normalized) > 0 THEN 1 ELSE 0 END) AS all_profile_contacts,
      SUM(CASE WHEN source_type = 'comment' THEN 1 ELSE 0 END) AS comments
      FROM leads`).get()
    const commentIndustryRows = this.leadRadar.db.prepare(`SELECT industry, COUNT(*) AS comments
      FROM leads
      WHERE source_type = 'comment'
      GROUP BY industry`).all()
    const profileContactsByIndustry = Object.fromEntries(INDUSTRIES.map((industry) => [industry, 0]))
    const commentsByIndustry = Object.fromEntries(INDUSTRIES.map((industry) => [industry, 0]))
    const profileDetailsByIndustry = Object.fromEntries(INDUSTRIES.map((industry) => [industry, 0]))
    for (const item of commentIndustryRows) {
      if (Object.hasOwn(commentsByIndustry, item.industry)) {
        commentsByIndustry[item.industry] = Number(item.comments) || 0
      }
    }
    let profileContacts = 0
    const contactRows = this.leadRadar.db.prepare(`SELECT source_url, COUNT(*) AS contacts FROM leads
      WHERE source_type = 'profile' AND length(contact_normalized) > 0
      GROUP BY source_url`).all()
    const contactsByUrl = new Map(contactRows.map((item) => [String(item.source_url || ''), Number(item.contacts) || 0]))
    const detailRows = this.stateDb.prepare('SELECT industry, profile_url FROM processed_profiles').all()
    for (const item of detailRows) {
      if (Object.hasOwn(profileDetailsByIndustry, item.industry)) {
        profileDetailsByIndustry[item.industry]++
        const contacts = contactsByUrl.get(String(item.profile_url || '')) || 0
        profileContacts += contacts
        profileContactsByIndustry[item.industry] += contacts
      }
    }
    const value = {
      profileContacts,
      allProfileContacts: Number(row.all_profile_contacts) || 0,
      profileContactsByIndustry,
      profileDetails: Object.values(profileDetailsByIndustry).reduce((sum, value) => sum + value, 0),
      profileDetailsByIndustry,
      comments: Number(row.comments) || 0,
      commentsByIndustry,
    }
    this.countsCache = { at: Date.now(), value }
    return value
  }

  profileTargetReached(counts, targetProfiles, targetProfileDetails) {
    return balancedTargetReached(counts.profileContacts, counts.profileContactsByIndustry, targetProfiles)
      && balancedTargetReached(counts.profileDetails, counts.profileDetailsByIndustry, targetProfileDetails)
  }

  commentTargetReached(counts, targetComments) {
    return balancedTargetReached(counts.comments, counts.commentsByIndustry, targetComments)
  }

  getVideoScanState(awemeId) {
    return this.stateDb.prepare(`SELECT aweme_id, query, industry, processed_at, next_check_at,
      last_comment_time, scan_count FROM processed_videos WHERE aweme_id = ?`).get(String(awemeId)) || null
  }

  isVideoProcessed(awemeId) {
    return !!this.getVideoScanState(awemeId)
  }

  isVideoDue(awemeId, nowMs = Date.now()) {
    const row = this.getVideoScanState(awemeId)
    if (!row) return true
    const dueAt = Date.parse(String(row.next_check_at || ''))
    if (Number.isFinite(dueAt)) return dueAt <= nowMs
    const processedAt = Date.parse(String(row.processed_at || ''))
    return !Number.isFinite(processedAt) || processedAt + VIDEO_REVISIT_INTERVAL_MS <= nowMs
  }

  getDueMonitoredVideos(industry, limit = 10, nowMs = Date.now()) {
    const dueAt = new Date(nowMs).toISOString()
    const legacyCutoff = new Date(nowMs - VIDEO_REVISIT_INTERVAL_MS).toISOString()
    return this.stateDb.prepare(`SELECT aweme_id, query, industry, processed_at, next_check_at,
        last_comment_time, scan_count
      FROM processed_videos
      WHERE (industry = ? OR industry = 'unknown')
        AND ((next_check_at <> '' AND next_check_at <= ?)
          OR (next_check_at = '' AND processed_at <= ?))
      ORDER BY CASE WHEN next_check_at = '' THEN processed_at ELSE next_check_at END ASC
      LIMIT ?`).all(String(industry || 'unknown'), dueAt, legacyCutoff, Math.max(1, Math.min(100, Number(limit) || 10)))
  }

  markVideoProcessed(awemeId, query, options = {}) {
    const nowMs = Math.max(0, Number(options.nowMs) || Date.now())
    const processedAt = new Date(nowMs).toISOString()
    const revisitMs = Math.max(30 * 60 * 1000, Number(options.revisitMs) || VIDEO_REVISIT_INTERVAL_MS)
    const nextCheckAt = new Date(nowMs + revisitMs).toISOString()
    const lastCommentTime = Math.max(0, Number(options.lastCommentTime) || 0)
    this.stateDb.prepare(`INSERT INTO processed_videos
      (aweme_id, query, industry, processed_at, next_check_at, last_comment_time, scan_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(aweme_id) DO UPDATE SET query = excluded.query, industry = excluded.industry,
        processed_at = excluded.processed_at, next_check_at = excluded.next_check_at,
        last_comment_time = MAX(processed_videos.last_comment_time, excluded.last_comment_time),
        scan_count = processed_videos.scan_count + 1`)
      .run(String(awemeId), String(query || '').slice(0, 200), String(options.industry || 'unknown'), processedAt, nextCheckAt, lastCommentTime)
  }

  commentKey(row, awemeId) {
    const commentId = String(row && row.commentId || '')
    if (commentId) return `id:${String(awemeId || '')}:${commentId}`
    return 'hash:' + crypto.createHash('sha256').update([
      String(awemeId || ''), String(row && row.profileUrl || ''), String(row && row.douyinId || ''),
      String(row && row.commentTime || ''), String(row && row.rawText || ''),
    ].join('|')).digest('hex')
  }

  isCommentProcessed(commentKey) {
    return !!this.stateDb.prepare('SELECT 1 FROM processed_comments WHERE comment_key = ?').get(String(commentKey || ''))
  }

  markCommentsProcessed(rows, awemeId) {
    if (!Array.isArray(rows) || !rows.length) return
    const insert = this.stateDb.prepare(`INSERT INTO processed_comments
      (comment_key, comment_id, aweme_id, comment_time, profile_url, processed_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(comment_key) DO NOTHING`)
    const now = new Date().toISOString()
    this.stateDb.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        insert.run(this.commentKey(row, awemeId), String(row.commentId || ''), String(awemeId || ''),
          Math.max(0, Number(row.commentTime) || 0), String(row.profileUrl || ''), now)
      }
      this.stateDb.exec('COMMIT')
    } catch (error) {
      try { this.stateDb.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
  }

  queueEngagementCandidates(rows, awemeId) {
    if (!Array.isArray(rows) || !rows.length) return 0
    const insert = this.stateDb.prepare(`INSERT INTO engagement_candidates
      (candidate_key, aweme_id, comment_id, industry, author_name, profile_url, source_url,
        comment_text, intent_score, suggested_reply, comment_time, freshness_tier, status, detected_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(candidate_key) DO UPDATE SET
        industry = excluded.industry, author_name = excluded.author_name,
        profile_url = excluded.profile_url, source_url = excluded.source_url,
        comment_text = excluded.comment_text, intent_score = MAX(engagement_candidates.intent_score, excluded.intent_score),
        suggested_reply = excluded.suggested_reply,
        comment_time = MAX(engagement_candidates.comment_time, excluded.comment_time),
        freshness_tier = CASE WHEN excluded.comment_time >= engagement_candidates.comment_time
          THEN excluded.freshness_tier ELSE engagement_candidates.freshness_tier END,
        updated_at = excluded.updated_at`)
    const now = new Date().toISOString()
    const nowMs = Date.now()
    let queued = 0
    this.stateDb.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const score = engagementIntentScore(row)
        if (score < 70) continue
        const commentTime = normalizeUnixSeconds(row.commentTime)
        const freshnessTier = commentFreshness(commentTime, nowMs)
        if (freshnessTier === 'stale') continue
        const resolvedAwemeId = String(row.awemeId || awemeId || '')
        const key = this.commentKey(row, resolvedAwemeId)
        const before = this.stateDb.prepare('SELECT 1 FROM engagement_candidates WHERE candidate_key = ?').get(key)
        insert.run(key, resolvedAwemeId, String(row.commentId || ''), String(row.industry || 'unknown'),
          String(row.accountName || '抖音用户').slice(0, 120), String(row.profileUrl || ''), String(row.sourceUrl || ''),
          String(row.rawText || '').slice(0, 2000), score, suggestedEngagementReply(row).slice(0, 500),
          commentTime, freshnessTier, now, now)
        if (!before) queued++
      }
      this.stateDb.exec('COMMIT')
      return queued
    } catch (error) {
      try { this.stateDb.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
  }

  backfillEngagementCandidatesFromLeads(limit = 1000) {
    if (!this.leadRadar || !this.leadRadar.db || typeof this.leadRadar.decryptText !== 'function') return 0
    const leadColumns = new Set(this.leadRadar.db.prepare('PRAGMA table_info(leads)').all().map((item) => item.name))
    const eventColumn = leadColumns.has('source_event_time') ? 'source_event_time' : '0 AS source_event_time'
    const rows = this.leadRadar.db.prepare(`SELECT id, industry, account_name, profile_url, source_url, source_text, ${eventColumn}
      FROM leads WHERE source_type = 'comment' AND opt_out = 0 ORDER BY updated_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(5000, Number(limit) || 1000)))
    const candidates = []
    for (const row of rows) {
      let rawText = ''
      try { rawText = this.leadRadar.decryptText(row.source_text) } catch (error) { continue }
      const sourceUrl = String(row.source_url || '')
      const awemeMatch = sourceUrl.match(/\/video\/([0-9]+)/)
      candidates.push({
        commentId: '',
        industry: row.industry,
        accountName: row.account_name,
        profileUrl: row.profile_url,
        sourceUrl,
        rawText,
        commentTime: Math.max(0, Number(row.source_event_time) || 0),
        leadId: Number(row.id),
        awemeId: awemeMatch ? awemeMatch[1] : '',
      })
    }
    return this.queueEngagementCandidates(candidates, '')
  }

  engagementSummary() {
    this.archiveStaleEngagementCandidates()
    const row = this.stateDb.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'pending' AND prepared_at <> '' THEN 1 ELSE 0 END) AS prepared,
      SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) AS contacted,
      SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
      SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived
      FROM engagement_candidates`).get()
    return {
      total: Number(row.total) || 0,
      pending: Number(row.pending) || 0,
      prepared: Number(row.prepared) || 0,
      contacted: Number(row.contacted) || 0,
      dismissed: Number(row.dismissed) || 0,
      archived: Number(row.archived) || 0,
    }
  }

  listEngagementCandidates(filters = {}) {
    this.refreshEngagementFreshness()
    this.archiveStaleEngagementCandidates()
    const allowed = new Set(['pending', 'contacted', 'dismissed', 'archived'])
    const status = allowed.has(String(filters.status || '')) ? String(filters.status) : 'pending'
    const limit = Math.max(1, Math.min(100, Number(filters.limit) || 20))
    return {
      list: this.stateDb.prepare(`SELECT * FROM engagement_candidates WHERE status = ?
        ORDER BY CASE freshness_tier WHEN 'hot_7d' THEN 0 WHEN 'recent_30d' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END,
          comment_time DESC, intent_score DESC, detected_at DESC LIMIT ?`).all(status, limit),
      summary: this.engagementSummary(),
      policy: {
        mode: 'review_only',
        automaticThirdPartyInteraction: false,
        workflow: 'copy_and_open',
        reason: '单条确认后复制建议回复并打开原视频；不使用网页自动化批量关注或评论',
      },
    }
  }

  updateEngagementCandidate(payload = {}) {
    const id = Number(payload.id)
    const status = String(payload.status || '')
    if (!Number.isInteger(id) || id <= 0) throw new Error('互动候选编号无效')
    if (!['pending', 'contacted', 'dismissed', 'archived'].includes(status)) throw new Error('互动候选状态无效')
    const result = this.stateDb.prepare('UPDATE engagement_candidates SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id)
    if (!Number(result.changes)) throw new Error('互动候选不存在')
    return this.stateDb.prepare('SELECT * FROM engagement_candidates WHERE id = ?').get(id)
  }

  refreshEngagementFreshness(nowMs = Date.now()) {
    const rows = this.stateDb.prepare('SELECT id, comment_time, freshness_tier FROM engagement_candidates').all()
    const update = this.stateDb.prepare('UPDATE engagement_candidates SET freshness_tier = ? WHERE id = ?')
    this.stateDb.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const tier = commentFreshness(row.comment_time, nowMs)
        if (tier !== row.freshness_tier) update.run(tier, row.id)
      }
      this.stateDb.exec('COMMIT')
    } catch (error) {
      try { this.stateDb.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
  }

  archiveStaleEngagementCandidates(nowMs = Date.now()) {
    const cutoff = Math.floor((Number(nowMs) - COMMENT_REVIEW_MAX_AGE_DAYS * 86400000) / 1000)
    const result = this.stateDb.prepare(`UPDATE engagement_candidates
      SET status = 'archived',
        freshness_tier = CASE WHEN comment_time > 0 THEN 'stale' ELSE 'unknown' END,
        updated_at = ?
      WHERE status = 'pending' AND (comment_time = 0 OR comment_time < ?)`)
      .run(new Date(Number(nowMs)).toISOString(), cutoff)
    return Number(result.changes) || 0
  }

  prepareEngagementReply(payload = {}) {
    const id = Number(payload.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('互动候选编号无效')
    if (payload.confirmed !== true) throw new Error('请先逐条确认本次回复准备操作')
    this.refreshEngagementFreshness()
    this.archiveStaleEngagementCandidates()
    const row = this.stateDb.prepare('SELECT * FROM engagement_candidates WHERE id = ?').get(id)
    if (!row) throw new Error('互动候选不存在')
    if (row.status !== 'pending') throw new Error('该候选当前不在待审核状态')
    if (!row.comment_time || row.freshness_tier === 'unknown') throw new Error('评论时间未知，不建议主动互动')
    if (row.freshness_tier === 'stale') throw new Error('评论已超过30天，已退出互动队列')
    const now = new Date().toISOString()
    this.stateDb.exec('BEGIN IMMEDIATE')
    try {
      this.stateDb.prepare(`UPDATE engagement_candidates SET prepared_at = ?, prepare_count = prepare_count + 1,
        updated_at = ? WHERE id = ?`).run(now, now, id)
      this.stateDb.prepare(`INSERT INTO engagement_action_logs
        (candidate_id, action_type, mode, status, reply_text, reason, created_at)
        VALUES (?, 'reply', 'dry_run', 'prepared', ?, '人工单条确认；仅复制并打开原视频，未自动发送', ?)`)
        .run(id, String(row.suggested_reply || '').slice(0, 500), now)
      this.stateDb.exec('COMMIT')
    } catch (error) {
      try { this.stateDb.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
    return {
      id,
      reply: String(row.suggested_reply || ''),
      sourceUrl: String(row.source_url || ''),
      mode: 'dry_run',
      sent: false,
      message: '建议回复已准备；系统不会自动提交，请在打开的原视频中人工确认发送',
    }
  }

  listEngagementActionLogs(payload = {}) {
    const candidateId = Math.max(0, Number(payload.candidateId) || 0)
    const limit = Math.max(1, Math.min(100, Number(payload.limit) || 20))
    const list = candidateId
      ? this.stateDb.prepare('SELECT * FROM engagement_action_logs WHERE candidate_id = ? ORDER BY id DESC LIMIT ?').all(candidateId, limit)
      : this.stateDb.prepare('SELECT * FROM engagement_action_logs ORDER BY id DESC LIMIT ?').all(limit)
    return { list }
  }

  isProfileRecentlyProcessed(profileUrl, maxAgeDays = 14, profileRole = 'supplier') {
    const row = this.stateDb.prepare(`SELECT processed_at FROM processed_profile_roles
      WHERE profile_url = ? AND profile_role = ?`).get(String(profileUrl), String(profileRole || 'supplier'))
    if (!row || !row.processed_at) return false
    return Date.now() - Date.parse(row.processed_at) < maxAgeDays * 86400000
  }

  markProfileProcessed(profileUrl, query, industry, profileRole = 'supplier') {
    const processedAt = new Date().toISOString()
    const role = String(profileRole || 'supplier')
    this.stateDb.prepare(`INSERT INTO processed_profile_roles (profile_url, profile_role, industry, query, processed_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_url, profile_role) DO UPDATE SET
        industry = excluded.industry, query = excluded.query, processed_at = excluded.processed_at`)
      .run(String(profileUrl), role, String(industry || 'unknown'), String(query || '').slice(0, 200), processedAt)
    if (role === 'supplier') {
      this.stateDb.prepare('INSERT OR REPLACE INTO processed_profiles (profile_url, industry, query, processed_at) VALUES (?, ?, ?, ?)')
        .run(String(profileUrl), String(industry || 'unknown'), String(query || '').slice(0, 200), processedAt)
    }
    this.countsCache = null
  }

  async runNow(payload = {}) {
    if (this.running) throw new Error('抖音公开线索采集正在运行')
    if (this.isPublishing()) throw new Error('抖音作品正在发布，采集已安全排队，避免同一时间操作账号')
    if (!isWithinActiveHours(this.now())) throw new Error('当前为抖音安全暂停时段（22:30—次日08:30），请在白天运行')
    const activityToken = this.acquireActivity()
    if (!activityToken) throw new Error('抖音账号正在执行其他任务，采集已安全排队')
    this.running = true
    try {
      return await this.runReserved(payload)
    } finally {
      this.running = false
      this.releaseActivity(activityToken)
    }
  }

  async runReserved(payload = {}) {
    const triggerType = String(payload.triggerType || 'manual')
    const mode = ['profiles', 'comments'].includes(payload.mode) ? payload.mode : 'all'
    this.lastAttemptAt = Date.now()
    const account = this.findAccount(payload)
    if (!account) {
      const pool = this.getAccountPoolStatus()
      const message = pool.total ? '当前所有抖音账号均在冷却、风控或登录失效状态，请查看账号池提示' : '未找到可用的抖音账号，请先添加并登录'
      this.setAlert('login_expired', message, null)
      throw new CollectionRiskError(message, 'login_expired')
    }
    if (account.credentialError || account.isLogin === false || Number(account.status) === 0) {
      const message = '抖音账号登录状态已失效，请重新登录'
      this.setAlert('login_expired', message, account)
      throw new CollectionRiskError(message, 'login_expired')
    }
    if (this.checkAccount) {
      const check = await this.checkAccount(account, { activityHeld: true })
      if (!check || !check.ok) {
        const message = String(check && check.message || '抖音登录凭证已失效，请重新登录')
        const kind = String(check && check.kind || 'login_expired')
        this.setAlert(kind, message, account)
        throw new CollectionRiskError(message, kind)
      }
      // 只有真实接口验证在线才解除告警；网络 unknown 不误判为掉线，也不提前解除旧告警。
      const activeAlert = this.getAlert()
      if (activeAlert.active && activeAlert.kind === 'login_expired'
        && (check.verified || check.state === 'online' || check.login === true)) this.clearAlert()
    }
    this.markAccountSuccess(account, false)
    this.markAccountUsed(account)
    const profileLimit = Math.max(1, Math.min(30, Number(payload.profileLimit) || 20))
    const videoLimit = Math.max(1, Math.min(10, Number(payload.videoLimit) || 10))
    const profileQueryLimit = mode === 'comments' ? 0 : Math.max(1, Math.min(PROFILE_QUERIES.length, Number(payload.profileQueryLimit || payload.queryLimit) || PROFILE_QUERIES.length))
    const commentQueryLimit = mode === 'profiles' ? 0 : Math.max(1, Math.min(COMMENT_QUERIES.length, Number(payload.commentQueryLimit || payload.queryLimit) || COMMENT_QUERIES.length))
    const targetProfiles = Math.max(1, Math.min(CONTINUOUS_TARGET, Number(payload.targetProfiles) || CONTINUOUS_TARGET))
    const targetProfileDetails = Math.max(1, Math.min(CONTINUOUS_TARGET, Number(payload.targetProfileDetails) || CONTINUOUS_TARGET))
    const targetComments = Math.max(1, Math.min(CONTINUOUS_TARGET, Number(payload.targetComments) || CONTINUOUS_TARGET))
    const commentProfileLimit = Math.max(0, Math.min(30, Number(payload.commentProfileLimit) || MAX_COMMENT_PROFILE_ENRICH_PER_RUN))
    this.targets = { targetProfiles, targetProfileDetails, targetComments }
    const startedAt = new Date().toISOString()
    // 目标仅约束本轮工作量，不再与数据库累计总量比较；历史超过一万条也会继续滚动采集。
    const baselineCounts = this.databaseCounts()
    const runCounts = () => subtractCollectorCounts(this.databaseCounts(), baselineCounts)
    const deadline = Date.now() + (mode === 'comments' ? MAX_COMMENT_RUN_DURATION_MS : MAX_RUN_DURATION_MS)
    const shouldStopSafely = () => Date.now() >= deadline || !isWithinActiveHours(new Date())
    const stats = { mode, profileQueriesRun: 0, profilesSeen: 0, profilesOpened: 0, profileContactsAdded: 0,
      videosScanned: 0, videosRevisited: 0, commentsSeen: 0, intentComments: 0, commentProfilesOpened: 0,
      commentContactsAdded: 0, engagementQueued: 0, imported: 0, duplicates: 0, errors: 0, stoppedBySchedule: false }
    if (mode !== 'comments') this.nextProfileRunAt = computeNextRunAt(Date.now(), this.random)
    if (mode !== 'profiles') this.nextCommentRunAt = computeNextCommentRunAt(Date.now(), this.random)
    this.nextRunAt = Math.min(this.nextProfileRunAt, this.nextCommentRunAt)
    const browserSession = new RotatingCollectorWindow({
      BrowserWindow: this.BrowserWindow,
      partition: account.partition,
      maxNavigations: MAX_NAVIGATIONS_PER_COLLECTOR_WINDOW,
      onWindowChange: (win) => { this.activeWindow = win },
    })
    try {
      this.progress = { stage: 'preparing', message: '初始化抖音只读采集会话', current: 0, total: 1 }
      await browserSession.create()
      const allProfileQueries = interleaveQueries(PROFILE_QUERIES)
      const allCommentQueries = interleaveQueries(COMMENT_QUERIES)
      const profileQueries = rotateQueries(allProfileQueries, this.getStateNumber('profile_query_cursor')).slice(0, profileQueryLimit)
      const commentQueries = rotateQueries(allCommentQueries, this.getStateNumber('comment_query_cursor')).slice(0, commentQueryLimit)
      const total = profileQueries.length + commentQueries.length
      let current = 0
      for (const item of profileQueries) {
        if (shouldStopSafely()) { stats.stoppedBySchedule = true; break }
        const counts = runCounts()
        if (this.profileTargetReached(counts, targetProfiles, targetProfileDetails)) break
        const perIndustryTarget = Math.max(1, Math.floor(targetProfiles / INDUSTRIES.length))
        const perIndustryDetailTarget = Math.max(1, Math.floor(targetProfileDetails / INDUSTRIES.length))
          if (counts.profileDetailsByIndustry[item.industry] >= perIndustryDetailTarget
            && (counts.profileContacts >= targetProfiles
              || counts.profileContactsByIndustry[item.industry] >= perIndustryTarget)) {
          current++
          this.advanceQueryCursor('profile_query_cursor', 1, allProfileQueries.length)
          continue
        }
        this.progress = { stage: 'profiles', message: `搜索公开账号：${item.query}`, current, total }
        try {
          const searchContext = await browserSession.nextNavigation()
          const rows = await this.collectProfileCards(searchContext.webContents, item.query, item.industry, profileLimit)
          this.markAccountSuccess(account, true)
          stats.profileQueriesRun++
          stats.profilesSeen += rows.length
          for (const row of rows) {
            if (shouldStopSafely()) { stats.stoppedBySchedule = true; break }
            const liveCounts = runCounts()
            if (this.profileTargetReached(liveCounts, targetProfiles, targetProfileDetails)
                || (liveCounts.profileDetailsByIndustry[item.industry] >= perIndustryDetailTarget
                  && (liveCounts.profileContacts >= targetProfiles
                    || liveCounts.profileContactsByIndustry[item.industry] >= perIndustryTarget))) break
            if (this.isProfileRecentlyProcessed(row.profileUrl)) continue
            this.progress = { stage: 'profile_details', message: `读取公开主页简介：${row.accountName || item.query}`, current, total }
            let enriched = row
            let detailRead = false
            try {
              stats.profilesOpened++
              const profileContext = await browserSession.nextNavigation()
              enriched = await this.collectPublicProfileDetail(profileContext.webContents, row)
              detailRead = true
            } catch (error) {
              if (error instanceof CollectionRiskError) throw error
              stats.errors++
            }
            if (detailRead) this.markProfileProcessed(row.profileUrl, item.query, item.industry)
            if (detailRead && hasPublicContact(enriched)) {
              const saved = this.importRows([enriched])
              stats.imported += saved.imported
              stats.duplicates += saved.duplicates
              stats.profileContactsAdded += saved.contacts
            }
            await sleep(2500)
          }
        } catch (error) {
          if (error instanceof CollectionRiskError) throw error
          stats.errors++
        }
        current++
        this.advanceQueryCursor('profile_query_cursor', 1, allProfileQueries.length)
        await sleep(5000)
      }
      for (const item of commentQueries) {
        if (shouldStopSafely()) { stats.stoppedBySchedule = true; break }
        const counts = runCounts()
        if (this.commentTargetReached(counts, targetComments)) break
        const perIndustryTarget = Math.max(1, Math.floor(targetComments / INDUSTRIES.length))
        if (counts.commentsByIndustry[item.industry] >= perIndustryTarget) {
          current++
          this.advanceQueryCursor('comment_query_cursor', 1, allCommentQueries.length)
          continue
        }
        this.progress = { stage: 'comments', message: `读取需求评论：${item.query}`, current, total }
        try {
          const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(item.query)}`
          const searchContext = await browserSession.nextNavigation()
          const searchData = await searchContext.capture.navigateForJson(searchUrl, '/aweme/v1/web/general/search/single/')
          this.markAccountSuccess(account, true)
          const discoveredVideos = extractAwemes(searchData.data, videoLimit).filter((video) => this.isVideoDue(video.aweme_id))
          const monitoredVideos = this.getDueMonitoredVideos(item.industry, videoLimit)
          // 固定保留一部分名额给历史监控池，旧视频即使掉出当前搜索结果也能继续发现新评论。
          const videos = mergeVideoCandidates(monitoredVideos, discoveredVideos, videoLimit)
          for (const video of videos) {
            if (shouldStopSafely()) { stats.stoppedBySchedule = true; break }
            const liveCounts = runCounts()
            if (this.commentTargetReached(liveCounts, targetComments)
              || liveCounts.commentsByIndustry[item.industry] >= perIndustryTarget) break
            const sourceUrl = `https://www.douyin.com/video/${video.aweme_id}`
            const previousScan = this.getVideoScanState(video.aweme_id)
            let processed = false
            let latestSeenCommentTime = Number(previousScan && previousScan.last_comment_time) || 0
            const minCommentTime = commentWatermarkCutoff(latestSeenCommentTime, Date.now())
            try {
              const videoContext = await browserSession.nextNavigation()
              const commentPages = await videoContext.capture.navigateAndCollectJson(sourceUrl, '/aweme/v1/web/comment/list/', { timeoutMs: 12000, scrolls: 5 })
              stats.videosScanned++
              if (previousScan) stats.videosRevisited++
              stats.commentsSeen += commentPages.reduce((sum, comments) => sum + (Array.isArray(comments.comments) ? comments.comments.length : 0), 0)
              latestSeenCommentTime = Math.max(latestSeenCommentTime, latestCommentTime(commentPages))
              const rowMap = new Map()
              for (const comments of commentPages) {
                for (const row of extractIntentComments(comments, {
                  industry: item.industry,
                  sourceUrl,
                  max: 100,
                  minCommentTime,
                  requireCommentTime: true,
                })) {
                  const commentKey = this.commentKey(row, video.aweme_id)
                  if (!this.isCommentProcessed(commentKey)) rowMap.set(commentKey, row)
                }
              }
              const rows = [...rowMap.values()]
              stats.intentComments += rows.length
              const enrichedRows = await this.enrichIntentCommentProfiles(null, rows, {
                stats, profileLimit: commentProfileLimit, shouldStopSafely, account,
                query: item.query, industry: item.industry, current, total,
                beforeProfileNavigation: async () => (await browserSession.nextNavigation()).webContents,
              })
              stats.engagementQueued += this.queueEngagementCandidates(enrichedRows, video.aweme_id)
              const saved = this.importRows(enrichedRows)
              this.markCommentsProcessed(enrichedRows, video.aweme_id)
              stats.imported += saved.imported
              stats.duplicates += saved.duplicates
              processed = true
            } catch (error) {
              if (error instanceof CollectionRiskError) throw error
              stats.errors++
            }
            if (processed) this.markVideoProcessed(video.aweme_id, item.query, {
              industry: item.industry,
              lastCommentTime: latestSeenCommentTime,
            })
            await sleep(1800)
          }
        } catch (error) {
          if (error instanceof CollectionRiskError) throw error
          stats.errors++
        }
        current++
        this.advanceQueryCursor('comment_query_cursor', 1, allCommentQueries.length)
        await sleep(3500)
      }
      const counts = this.databaseCounts()
      const added = subtractCollectorCounts(counts, baselineCounts)
      const doneMessage = `本轮新增核验主页 ${added.profileDetails}，主页联系方式 ${added.profileContacts}，需求评论 ${added.comments}；累计数据继续滚动采集，不设永久总量停止线`
      this.progress = { stage: 'done', message: stats.stoppedBySchedule ? `${doneMessage}；本轮已按安全时段/75分钟上限暂停` : doneMessage, current: total, total }
      this.lastRun = { status: 'success', startedAt, finishedAt: new Date().toISOString(), ...stats, ...counts,
        runCounts: added, targetScope: 'per_run', targetProfiles, targetProfileDetails, targetComments }
      return { success: true, ...stats, ...counts, runCounts: added, targetScope: 'per_run', targetProfiles, targetProfileDetails, targetComments }
    } catch (error) {
      if (error instanceof CollectionRiskError) this.setAlert(error.kind, error.message, account)
      this.progress = { stage: 'error', message: String(error && error.message || error), current: 0, total: 0 }
      this.lastRun = { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: this.progress.message, ...stats }
      throw error
    } finally {
      browserSession.close()
    }
  }

  start() {
    if (this.timer) return
    const tick = async () => {
      if (this.running || this.isPublishing()) return
      await this.checkAlertRecovery()
      if (this.running) return
      if (!isWithinActiveHours(new Date())) {
        if (this.nextCommentRunAt <= Date.now()) this.nextCommentRunAt = nextActiveStart(Date.now(), this.random)
        if (this.nextProfileRunAt <= Date.now()) this.nextProfileRunAt = nextActiveStart(Date.now(), this.random)
        this.nextRunAt = Math.min(this.nextCommentRunAt, this.nextProfileRunAt)
        return
      }
      if (Date.now() < this.nextRunAt) return
      if (!this.findAccount({})) return
      const mode = Date.now() >= this.nextCommentRunAt ? 'comments' : 'profiles'
      this.runNow({
        triggerType: 'auto',
        mode,
        profileQueryLimit: PROFILE_QUERIES.length,
        commentQueryLimit: COMMENT_QUERIES.length,
        profileLimit: 20,
        videoLimit: 10,
        targetProfiles: CONTINUOUS_TARGET,
        targetProfileDetails: CONTINUOUS_TARGET,
        targetComments: CONTINUOUS_TARGET,
      }).catch(() => {})
    }
    this.timer = setInterval(() => { tick().catch(() => {}) }, 60000)
    this.startTimeout = setTimeout(() => {
      this.startTimeout = null
      tick().catch(() => {})
    }, 15000)
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.startTimeout) clearTimeout(this.startTimeout)
    this.startTimeout = null
    try { if (this.activeWindow && !this.activeWindow.isDestroyed()) this.activeWindow.destroy() } catch (error) {}
    this.activeWindow = null
    try { this.stateDb.close() } catch (error) {}
  }
}

module.exports = {
  DouyinPublicCollector,
  PROFILE_QUERIES,
  COMMENT_QUERIES,
  INDUSTRIES,
  CONTINUOUS_TARGET,
  VIDEO_REVISIT_INTERVAL_MS,
  MAX_COMMENT_PROFILE_ENRICH_PER_RUN,
  ACTIVE_START_MINUTES,
  ACTIVE_END_MINUTES,
  MAX_RUN_DURATION_MS,
  MAX_COMMENT_RUN_DURATION_MS,
  COMMENT_HOT_MAX_AGE_DAYS,
  COMMENT_REVIEW_MAX_AGE_DAYS,
  MAX_NAVIGATIONS_PER_COLLECTOR_WINDOW,
  NETWORK_TOTAL_BUFFER_BYTES,
  NETWORK_RESOURCE_BUFFER_BYTES,
  isWithinActiveHours,
  nextActiveStart,
  computeNextRunAt,
  computeNextCommentRunAt,
  interleaveQueries,
  rotateQueries,
  buildExpandedQueries,
  balancedTargetReached,
  CollectionRiskError,
  NetworkCapture,
  RotatingCollectorWindow,
  detectRiskText,
  detectAccountIssue,
  engagementIntentScore,
  suggestedEngagementReply,
  commentFreshness,
  commentWatermarkCutoff,
  extractAwemes,
  extractIntentComments,
  subtractCollectorCounts,
  latestCommentTime,
  mergeVideoCandidates,
  normalizeProfileCards,
  mergePublicProfileDetail,
  hasPublicContact,
  muteBackgroundCollectorWindow,
}
