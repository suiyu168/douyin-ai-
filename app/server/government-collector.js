'use strict'

const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const cheerio = require('cheerio')
const { inferIndustry } = require('./lead-radar')
const {
  PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS,
  PUBLIC_ORGANIZATION_PROJECT_SOURCES,
  EARLY_STAGE_PROJECT_SOURCES,
  MANUAL_ONLY_PROJECT_SOURCES,
  VERIFIED_PROJECT_HOSTS,
} = require('./project-sources/catalog')
const {
  parseOfficialPlatformPage,
  discoverOfficialListPages,
  parseBeijingPromotionJson,
  parseGuangdongPromotionJson,
  parseGuangxiPromotionList,
} = require('./project-sources/official-platform-adapter')
const {
  DEFAULT_OPEN_WEB_QUERIES,
  providerInfo,
  validateSearxngEndpoint,
  searchOpenWeb,
} = require('./project-sources/web-search-adapter')

const CCGP_SOURCES = [
  { id: 'ccgp-local', name: '中国政府采购网·地方公告', baseUrl: 'https://www.ccgp.gov.cn/cggg/dfgg/' },
  { id: 'ccgp-central', name: '中国政府采购网·中央公告', baseUrl: 'https://www.ccgp.gov.cn/cggg/zygg/' },
]

const OPEN_NOTICE_CATEGORIES = [
  { id: 'gkzb', name: '公开招标' },
  { id: 'jzxcs', name: '竞争性磋商' },
  { id: 'jzxtpgg', name: '竞争性谈判' },
  { id: 'xjgg', name: '询价公告' },
  { id: 'zgysgg', name: '资格预审' },
  { id: 'dylygg', name: '单一来源公告和公示' },
]

const CCGP_CATEGORY_SOURCES = ['dfgg', 'zygg'].flatMap((scope) => OPEN_NOTICE_CATEGORIES.map((category) => ({
  id: `ccgp-${scope}-${category.id}`,
  name: `中国政府采购网·${scope === 'dfgg' ? '地方' : '中央'}·${category.name}`,
  baseUrl: `https://www.ccgp.gov.cn/cggg/${scope}/${category.id}/`,
})))

const CCGP_SEARCH_TERMS = [...new Set([
  '地坪', '环氧地坪', '固化地坪', '耐磨地坪', '防静电地坪', '厂房地面改造', '停车场地坪',
  '环氧自流平', '金刚砂地坪', '密封固化剂地坪', '聚氨酯砂浆地坪', '水磨石地坪', '防腐地坪',
  '地下车库地坪', '车间地面翻新', 'PVC地板', '塑胶跑道',
  '冷库', '冷链', '冷藏库', '冷冻库', '保鲜库', '气调库', '制冷工程',
  '冷链物流园', '冷链仓储', '农产品冷链', '生鲜冷链', '预制菜冷链', '中央厨房冷库',
  '医药冷库', '疫苗冷库', '低温仓库', '速冻库', '冷库改造', '制冷机组',
  '膜结构', '张拉膜', '车棚', '雨棚', '污水池加盖', '推拉棚', '伸缩棚', '活动棚',
  '膜结构车棚', '充电桩车棚', '体育场看台棚', '景观膜结构', '钢结构雨棚', '仓储篷房',
  '物流装卸棚', '移动雨棚', '电动伸缩棚',
  '无尘车间', '净化车间', '洁净室', '洁净厂房', 'GMP车间', '实验室净化', '手术室净化',
  '洁净实验室', '医药净化', '电子洁净厂房', '食品净化车间', '动物实验室', 'PCR实验室',
  '层流病房', '净化空调', '通风净化', '洁净工程',
  '标准厂房改造', '产业园厂房', '食品厂改造', '医药厂改造', '电子厂改造', '实验室建设',
])]
const CCGP_SEARCH_SOURCES = CCGP_SEARCH_TERMS.map((keyword) => ({
  id: `ccgp-search-${keyword}`,
  name: `中国政府采购网·关键词·${keyword}`,
  baseUrl: 'https://search.ccgp.gov.cn/bxsearch',
  type: 'search',
  keyword,
  maxPages: 2,
}))

const GGZY_HOME_SOURCE = {
  id: 'ggzy-national-latest',
  name: '全国公共资源交易平台·最新交易公告',
  baseUrl: 'https://www.ggzy.gov.cn/',
  type: 'ggzy-home',
  maxPages: 1,
}

const DEFAULT_ACTIVE_SOURCES = [
  // 招标前和企业公开项目源优先首检，避免被大批历史关键词回扫排在十几分钟之后。
  ...EARLY_STAGE_PROJECT_SOURCES,
  ...PUBLIC_ORGANIZATION_PROJECT_SOURCES,
  ...CCGP_CATEGORY_SOURCES,
  GGZY_HOME_SOURCE,
  ...PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS,
  ...CCGP_SEARCH_SOURCES,
]

const SOURCE_REGISTRY = [
  ...CCGP_SEARCH_SOURCES.map((source) => ({ ...source, status: 'active', compliance: '官方公开采购搜索；低频读取公告正文及其中公开联系方式' })),
  ...CCGP_CATEGORY_SOURCES.map((source) => ({ ...source, status: 'active', compliance: '官方公开采购公告；低频读取公告正文及其中公开联系方式' })),
  { ...GGZY_HOME_SOURCE, status: 'active', compliance: '国家发展改革委指导的全国平台公开首页；仅低频读取最新交易公告及公开正文' },
  ...PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS.map((source) => ({ ...source, status: 'active', compliance: '全国公共资源交易平台公布的省级官方入口；低频发现并读取公开工程公告栏目' })),
  ...PUBLIC_ORGANIZATION_PROJECT_SOURCES.map((source) => ({ ...source, status: 'active', compliance: '建设单位、央国企或招标机构公开采购栏目；无需登录，低频读取公开公告正文' })),
  ...EARLY_STAGE_PROJECT_SOURCES.map((source) => ({ ...source, status: 'active', compliance: '政府投资项目平台公开的项目推介数据；无需登录和验证码，低频增量读取' })),
  ...MANUAL_ONLY_PROJECT_SOURCES,
  { id: 'cebpubservice', name: '中国招标投标公共服务平台', baseUrl: 'https://www.cebpubservice.com/', status: 'blocked', compliance: 'robots.txt 明确禁止自动抓取，系统保持停用' },
]

const DISCOVERY_TERMS = [
  '地坪', '环氧', '自流平', '金刚砂', '聚氨酯', '固化剂', '耐磨地面', '水磨石', 'PVC地板', '塑胶场地',
  '防静电地面', '防腐地坪', '厂房改造', '地面改造', '停车场改造', '地下车库',
  '冷库', '冷链', '冷藏', '冷冻', '保鲜库', '恒温库', '气调库', '低温仓', '速冻库', '仓储保鲜',
  '农产品冷链', '生鲜冷链', '预制菜冷链', '中央厨房', '医药冷库', '制冷设备', '制冷机组',
  '膜结构', '张拉膜', '景观膜', '车棚', '雨棚', '污水池加盖', '看台棚', '充电桩车棚',
  '推拉棚', '伸缩棚', '活动棚', '装卸棚', '移动雨棚', '仓储篷房',
  '无尘', '净化车间', '洁净', '洁净室', '洁净厂房', '实验室改造', 'PCR实验室', '动物实验室',
  '手术室净化', '层流病房', '净化空调', '通风净化', 'GMP',
]

const CLOSED_NOTICE_TERMS = ['中标', '成交', '结果公告', '废标', '终止公告', '合同公告', '验收公告', '更正公告', '流标']
const ENGINEERING_TERMS = [
  '工程', '施工', '建设', '改造', '装修', '装饰', '安装', '修缮', '维修', '维护', '扩建', '新建', 'EPC', '总承包',
  '基础设施', '厂房', '车间', '仓库', '园区', '产业基地', '场馆', '停车场', '物流园', '冷链', '冷库',
  '地坪', '净化', '洁净', '膜结构', '雨棚', '实验室', '医院', '学校', '施工许可', '立项', '备案', '核准',
]
const NON_ENGINEERING_PRODUCT_TERMS = ['清洁剂', '清洗剂', '清洁用品', '保洁用品', '办公用品', '文具', '打印耗材', '生活用品', '劳保用品']
const STRONG_ENGINEERING_CONTEXT = ['工程', '施工', '建设', '改造', '装修', '装饰', '安装', '修缮', '维修', '扩建', '新建', 'EPC', '总承包', '基础设施']

const DEFAULT_REGIONS = ['河南', '山东', '江苏', '浙江', '安徽', '湖北', '湖南', '广东', '河北', '四川', '陕西']
const USER_AGENT = 'DouyinAuto-LeadRadar/1.0 (local public procurement notice reader)'
const MAX_DETAIL_ATTEMPTS = 5
const DETAIL_RETRY_BASE_MS = 30 * 60 * 1000
const DETAIL_RETRY_MAX_MS = 24 * 60 * 60 * 1000
const EXHAUSTED_DETAIL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function computeDetailRetryDelayMs(attempt, baseMs = DETAIL_RETRY_BASE_MS, maxMs = DETAIL_RETRY_MAX_MS) {
  const retryIndex = Math.max(0, Number(attempt) - 1)
  return Math.min(Math.max(1, Number(maxMs) || DETAIL_RETRY_MAX_MS),
    Math.max(1, Number(baseMs) || DETAIL_RETRY_BASE_MS) * (2 ** retryIndex))
}

function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
}

function parseDateTimestamp(value, options = {}) {
  const text = cleanText(value).replace(/\s+/g, ' ')
  const fullMatch = text.match(/(20[0-9]{2})\s*(?:年|[-/.])\s*([0-9]{1,2})\s*(?:月|[-/.])\s*([0-9]{1,2})\s*日?/)
  const monthMatch = fullMatch ? null : text.match(/(20[0-9]{2})\s*(?:年|[-/.])\s*([0-9]{1,2})\s*月?/)
  const match = fullMatch || monthMatch
  if (!match) return 0
  const year = Number(match[1])
  const month = Number(match[2])
  const hasDay = !!fullMatch
  const day = hasDay ? Number(match[3]) : (options.endOfDay ? new Date(year, month, 0).getDate() : 1)
  const tail = hasDay ? text.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 40) : ''
  const timeMatch = hasDay ? tail.match(/^[\sT]*(上午|下午)?\s*([0-9]{1,2})\s*(?:[:：时点])\s*([0-9]{1,2})?\s*分?/) : null
  let hour = timeMatch ? Number(timeMatch[2]) : (options.endOfDay ? 23 : 0)
  const minute = timeMatch && timeMatch[3] ? Number(timeMatch[3]) : (options.endOfDay && !timeMatch ? 59 : 0)
  if (timeMatch && timeMatch[1] === '下午' && hour < 12) hour += 12
  if (timeMatch && timeMatch[1] === '上午' && hour === 12) hour = 0
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return 0
  const date = new Date(year, month - 1, day, hour, minute, options.endOfDay && !timeMatch ? 59 : 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return 0
  return Math.floor(date.getTime() / 1000)
}

function parseDeadlineTimestamp(value) {
  return parseDateTimestamp(value, { endOfDay: true })
}

function projectFreshnessBucket(publishedAtTs, nowMs = Date.now()) {
  const seconds = Math.max(0, Number(publishedAtTs) || 0)
  if (!seconds) return 'unknown'
  const ageDays = Math.max(0, (Number(nowMs) - seconds * 1000) / DAY_MS)
  if (ageDays <= 30) return '0_30'
  if (ageDays <= 60) return '31_60'
  if (ageDays <= 90) return '61_90'
  if (ageDays <= 180) return '91_180'
  return 'over_180'
}

function projectStageWindowDays(stage) {
  const normalized = String(stage || 'tender').toLowerCase()
  if (['approval', 'promotion', 'filing', 'environment', 'permit'].includes(normalized)) return 180
  if (['plan', 'tender_plan', 'prequalification'].includes(normalized)) return 90
  return 60
}

function classifyProjectFreshness(project = {}, nowMs = Date.now()) {
  const publishedAtTs = Math.max(0, Number(project.publishedAtTs) || parseDateTimestamp(project.publishedAt))
  const deadlineAtTs = Math.max(0, Number(project.deadlineAtTs) || parseDeadlineTimestamp(project.deadline))
  const freshnessBucket = projectFreshnessBucket(publishedAtTs, nowMs)
  const deadlineDistanceMs = deadlineAtTs ? deadlineAtTs * 1000 - Number(nowMs) : 0
  if (deadlineAtTs && deadlineDistanceMs < 0) {
    return { publishedAtTs, deadlineAtTs, freshnessBucket, opportunityStatus: 'deadline_passed', freshnessScore: 0, actionable: false }
  }
  if (deadlineAtTs && deadlineDistanceMs <= 7 * DAY_MS) {
    return { publishedAtTs, deadlineAtTs, freshnessBucket, opportunityStatus: 'deadline_soon', freshnessScore: 100, actionable: true }
  }
  const baseScores = { '0_30': 90, '31_60': 75, '61_90': 60, '91_180': 40, over_180: 10, unknown: 20 }
  if (deadlineAtTs) {
    return { publishedAtTs, deadlineAtTs, freshnessBucket, opportunityStatus: 'active',
      freshnessScore: Math.max(85, baseScores[freshnessBucket] || 20), actionable: true }
  }
  if (!publishedAtTs) {
    return { publishedAtTs: 0, deadlineAtTs: 0, freshnessBucket: 'unknown', opportunityStatus: 'unknown', freshnessScore: 20, actionable: true }
  }
  const ageDays = Math.max(0, (Number(nowMs) - publishedAtTs * 1000) / DAY_MS)
  const stale = ageDays > projectStageWindowDays(project.projectStage)
  return {
    publishedAtTs,
    deadlineAtTs: 0,
    freshnessBucket,
    opportunityStatus: stale ? 'stale' : 'active',
    freshnessScore: stale ? Math.min(10, baseScores[freshnessBucket] || 10) : (baseScores[freshnessBucket] || 20),
    actionable: !stale,
  }
}

function canonicalizeOfficialUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|spm|from|source|src|timestamp|_t|track(?:ing)?_?id)$/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.href
  } catch (error) {
    return String(value || '').trim()
  }
}

function ccgpPageUrl(baseUrl, page) {
  return new URL(page > 0 ? `index_${page}.htm` : 'index.htm', baseUrl).href
}

function ccgpSearchUrl(keyword, page, now = new Date()) {
  const end = new Date(now)
  const start = new Date(end.getTime() - 180 * 86400000)
  const date = (value) => `${value.getFullYear()}:${String(value.getMonth() + 1).padStart(2, '0')}:${String(value.getDate()).padStart(2, '0')}`
  const params = new URLSearchParams({
    searchtype: '1', page_index: String(Math.max(1, Number(page) || 1)), bidSort: '0',
    buyerName: '', projectId: '', pinMu: '0', bidType: '0', dbselect: 'bidx',
    kw: String(keyword || ''), start_time: date(start), end_time: date(end), timeType: '6',
    displayZone: '', zoneId: '', pppStatus: '0', agentName: '',
  })
  return `https://search.ccgp.gov.cn/bxsearch?${params}`
}

function parseCcgpList(html, baseUrl) {
  const $ = cheerio.load(String(html || ''))
  const items = []
  const seen = new Set()
  $('li').each((index, element) => {
    const row = $(element)
    const anchor = row.find('a[href]').filter((i, item) => /(?:^\.\/|\/cggg\/).+\.htm(?:$|\?)/i.test($(item).attr('href') || '')).first()
    if (!anchor.length) return
    let url
    try { url = new URL(anchor.attr('href'), baseUrl).href } catch (error) { return }
    if (!/^https:\/\/www\.ccgp\.gov\.cn\/cggg\//i.test(url) || seen.has(url)) return
    const text = cleanText(row.text())
    const published = text.match(/发布时间[:：]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}(?:\s+[0-9]{2}:[0-9]{2})?)/)
    const region = text.match(/地域[:：]\s*(.+?)(?=采购人[:：]|$)/)
    const buyer = text.match(/采购人[:：]\s*(.+)$/)
    seen.add(url)
    items.push({
      title: cleanText(anchor.attr('title') || anchor.text()),
      url,
      publishedAt: published ? published[1] : '',
      region: region ? region[1].slice(0, 30) : '',
      buyer: buyer ? cleanText(buyer[1]).slice(0, 160) : '',
      listText: text.slice(0, 1000),
    })
  })
  return items
}

function parseCcgpSearchList(html) {
  const $ = cheerio.load(String(html || ''))
  const items = []
  const seen = new Set()
  $('.vT-srch-result-list-bid li').each((index, element) => {
    const row = $(element)
    const anchor = row.find('a[href]').first()
    if (!anchor.length) return
    let parsed
    try { parsed = new URL(anchor.attr('href'), 'https://www.ccgp.gov.cn/') } catch (error) { return }
    if (parsed.hostname !== 'www.ccgp.gov.cn' || !/^\/cggg\//i.test(parsed.pathname)) return
    parsed.protocol = 'https:'
    const url = parsed.href
    if (seen.has(url)) return
    const text = cleanText(row.text())
    const published = text.match(/([0-9]{4}[.\-][0-9]{2}[.\-][0-9]{2})/)
    const buyer = text.match(/采购人[:：]\s*([^|\n]{2,160})/)
    const parts = text.split('|').map(cleanText).filter(Boolean)
    const region = parts.find((part) => /(?:省|市|自治区|特别行政区)$/.test(part) && part.length <= 30) || ''
    seen.add(url)
    items.push({
      title: cleanText(anchor.attr('title') || anchor.text()),
      url,
      publishedAt: published ? published[1].replace(/\./g, '-') : '',
      region,
      buyer: buyer ? cleanText(buyer[1]).slice(0, 160) : '',
      listText: text.slice(0, 1000),
    })
  })
  return items
}

function parseGgzyHomeList(html) {
  const $ = cheerio.load(String(html || ''))
  const items = []
  const seen = new Set()
  $('a[href*="/information/deal/html/a/"]').each((index, element) => {
    const anchor = $(element)
    let url
    try { url = new URL(anchor.attr('href'), 'https://www.ggzy.gov.cn/').href } catch (error) { return }
    if (!/^https:\/\/www\.ggzy\.gov\.cn\/information\/deal\/html\/a\//i.test(url) || seen.has(url)) return
    const title = cleanText(anchor.attr('title') || anchor.text())
    if (!title || title.length < 4) return
    const rowText = cleanText(anchor.closest('li,div,tr').text())
    const published = rowText.match(/(20[0-9]{2}-[0-9]{2}-[0-9]{2})/) || url.match(/\/(20[0-9]{6})\//)
    const publishedAt = published
      ? (published[1].includes('-') ? published[1] : `${published[1].slice(0, 4)}-${published[1].slice(4, 6)}-${published[1].slice(6, 8)}`)
      : ''
    seen.add(url)
    items.push({ title, url, publishedAt, region: '', buyer: '', listText: rowText.slice(0, 1000) })
  })
  return items
}

function parseCcgpDetail(html, fallback = {}) {
  const $ = cheerio.load(String(html || ''))
  $('script,style,noscript,nav,header,footer').remove()
  const meta = (name) => cleanText($(`meta[name="${name}"]`).attr('content') || '')
  const title = cleanText(meta('ArticleTitle') || $('h1').first().text() || fallback.title || $('title').text())
  const contentNode = $('.vF_detail_content, .vT_detail_main, #content, .content').filter((i, item) => cleanText($(item).text()).length > 100).first()
  const body = cleanText((contentNode.length ? contentNode : $('body')).text()).slice(0, 120000)
  const buyerMatch = body.match(/(?:采购人信息[\s\S]{0,100}名称|采购单位)[:：]?\s*([^\n；;]{2,160})/)
  const budgetMatch = body.match(/(?:预算金额|项目预算|采购预算|预算价|最高限价)\s*[:：]?\s*([0-9][0-9,，.]*\s*(?:亿元|万元|元))/)
  const deadlineMatch = body.match(/(?:提交投标文件截止时间|投标截止时间|响应文件提交截止时间|响应文件开启时间|开标时间)\s*[:：]?\s*([^\n；;。]{4,100})/)
  const projectCodeMatch = body.match(/(?:采购项目编号|项目编号)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9._\-\/（）()]{2,99})/)
  return enrichProjectDetail({
    title,
    body,
    publishedAt: meta('PubDate') || fallback.publishedAt || '',
    region: fallback.region || '',
    buyer: cleanText((buyerMatch ? buyerMatch[1] : '') || fallback.buyer).slice(0, 160),
    budget: budgetMatch ? cleanText(budgetMatch[1]).slice(0, 80) : '',
    deadline: deadlineMatch ? cleanText(deadlineMatch[1]).slice(0, 100) : '',
    projectCode: projectCodeMatch ? cleanText(projectCodeMatch[1]).slice(0, 100) : '',
  }, fallback)
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function labeledValue(text, labels, maxLength = 200) {
  const names = labels.map(escapeRegExp).join('|')
  const match = cleanText(text).match(new RegExp(`(?:${names})\\s*[:：]?\\s*([^\\n；;。]{2,${Math.max(2, maxLength)}})`, 'i'))
  if (!match) return ''
  return cleanText(match[1]).replace(/^(?:名称|信息)\s*[:：]?\s*/, '').slice(0, maxLength)
}

function enrichProjectDetail(detail = {}, fallback = {}) {
  const body = cleanText(detail.body || fallback.body || fallback.snapshotText || '').slice(0, 120000)
  const projectAddress = detail.projectAddress || fallback.projectAddress || labeledValue(body,
    ['项目地址', '项目地点', '建设地点', '实施地点', '施工地点', '交货地点', '服务地点'], 240)
  const agency = detail.agency || fallback.agency || labeledValue(body,
    ['采购代理机构名称', '招标代理机构名称', '采购代理机构', '招标代理机构', '代理机构'], 200)
  const contactName = detail.contactName || fallback.contactName || labeledValue(body,
    ['项目联系人', '采购人联系人', '招标人联系人', '联系人'], 80)
  const phoneContext = labeledValue(body,
    ['项目联系电话', '联系人电话', '联系电话', '联系方式', '手机', '电话'], 100)
  const phoneSource = [detail.contactPhone, fallback.contactPhone, phoneContext, body].filter(Boolean).join('\n')
  const phones = [...new Set((phoneSource.match(/(?<!\d)(?:\+?86[-\s]?)?(?:1[3-9]\d{9}|0\d{2,3}[-－\s]?\d{7,8})(?:[-－转\s]?\d{1,6})?(?!\d)/g) || [])
    .map((value) => cleanText(value)).filter(Boolean))].slice(0, 5)
  const emailSource = [detail.contactEmail, fallback.contactEmail, body].filter(Boolean).join('\n')
  const emails = [...new Set(emailSource.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [])].slice(0, 5)
  return {
    ...detail,
    body,
    projectAddress: cleanText(projectAddress).slice(0, 240),
    agency: cleanText(agency).slice(0, 200),
    contactName: cleanText(contactName).slice(0, 80),
    contactPhone: phones.join('；'),
    contactEmail: emails.join('；'),
  }
}

function isRelevantTitle(title) {
  const compact = cleanText(title).replace(/\s+/g, '').toLowerCase()
  return DISCOVERY_TERMS.some((term) => compact.includes(term.toLowerCase()))
}

function isOpenOpportunityTitle(title) {
  const compact = cleanText(title).replace(/\s+/g, '')
  return compact.length >= 4 && !CLOSED_NOTICE_TERMS.some((term) => compact.includes(term))
}

function isEngineeringOpportunity(text) {
  const compact = cleanText(text).replace(/\s+/g, '').toLowerCase()
  const hasStrongContext = STRONG_ENGINEERING_CONTEXT.some((term) => compact.includes(term.toLowerCase()))
  const looksLikeProductOnly = NON_ENGINEERING_PRODUCT_TERMS.some((term) => compact.includes(term.toLowerCase()))
  if (looksLikeProductOnly && !hasStrongContext) return false
  return hasStrongContext || ENGINEERING_TERMS.some((term) => compact.includes(term.toLowerCase())) && !looksLikeProductOnly
}

function isNonEngineeringProduct(text) {
  const compact = cleanText(text).replace(/\s+/g, '').toLowerCase()
  return NON_ENGINEERING_PRODUCT_TERMS.some((term) => compact.includes(term.toLowerCase()))
    && !STRONG_ENGINEERING_CONTEXT.some((term) => compact.includes(term.toLowerCase()))
}

class GovernmentCollector {
  constructor(options = {}) {
    if (!options.leadRadar) throw new Error('GovernmentCollector 需要 LeadRadar 实例')
    this.leadRadar = options.leadRadar
    this.dataDir = path.resolve(options.dataDir || this.leadRadar.dataDir)
    this.dbPath = path.join(this.dataDir, 'government-collector.sqlite')
    this.db = new DatabaseSync(this.dbPath)
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.requestDelayMs = options.requestDelayMs == null ? 900 : Math.max(0, Number(options.requestDelayMs))
    this.maxDetailsPerRun = Math.max(1, Number(options.maxDetailsPerRun) || 80)
    this.maxDetailAttempts = Math.max(1, Number(options.maxDetailAttempts) || MAX_DETAIL_ATTEMPTS)
    this.detailRetryBaseMs = Math.max(1, Number(options.detailRetryBaseMs) || DETAIL_RETRY_BASE_MS)
    this.detailRetryMaxMs = Math.max(this.detailRetryBaseMs, Number(options.detailRetryMaxMs) || DETAIL_RETRY_MAX_MS)
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.sources = Array.isArray(options.sources) && options.sources.length ? options.sources : DEFAULT_ACTIVE_SOURCES
    this.running = false
    this.progress = { stage: 'idle', current: 0, total: 0, message: '等待运行' }
    this.timer = null
    this.startTimeout = null
    this.initSchema()
  }

  initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS collector_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        interval_hours INTEGER NOT NULL DEFAULT 6,
        pages_per_run INTEGER NOT NULL DEFAULT 5,
        focus_regions TEXT NOT NULL DEFAULT '[]',
        scan_mode TEXT NOT NULL DEFAULT 'broad',
        web_search_provider TEXT NOT NULL DEFAULT 'off',
        web_search_endpoint TEXT NOT NULL DEFAULT '',
        web_search_api_key TEXT NOT NULL DEFAULT '',
        web_search_queries_per_run INTEGER NOT NULL DEFAULT 6,
        web_search_results_per_query INTEGER NOT NULL DEFAULT 10,
        web_search_query_cursor INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collector_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        pages_scanned INTEGER NOT NULL DEFAULT 0,
        notices_scanned INTEGER NOT NULL DEFAULT 0,
        candidates INTEGER NOT NULL DEFAULT 0,
        imported INTEGER NOT NULL DEFAULT 0,
        duplicates INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS collector_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        region TEXT NOT NULL DEFAULT '',
        buyer TEXT NOT NULL DEFAULT '',
        published_at TEXT NOT NULL DEFAULT '',
        published_at_ts INTEGER NOT NULL DEFAULT 0,
        industry TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'discovered',
        imported_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        source_name TEXT NOT NULL DEFAULT '',
        budget TEXT NOT NULL DEFAULT '',
        deadline TEXT NOT NULL DEFAULT '',
        deadline_at_ts INTEGER NOT NULL DEFAULT 0,
        project_code TEXT NOT NULL DEFAULT '',
        project_stage TEXT NOT NULL DEFAULT 'tender',
        freshness_bucket TEXT NOT NULL DEFAULT 'unknown',
        opportunity_status TEXT NOT NULL DEFAULT 'unknown',
        freshness_score INTEGER NOT NULL DEFAULT 0,
        snapshot_text TEXT NOT NULL DEFAULT '',
        project_address TEXT NOT NULL DEFAULT '',
        agency TEXT NOT NULL DEFAULT '',
        contact_name TEXT NOT NULL DEFAULT '',
        contact_phone TEXT NOT NULL DEFAULT '',
        contact_email TEXT NOT NULL DEFAULT '',
        detail_attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT NOT NULL DEFAULT '',
        last_attempt_at TEXT NOT NULL DEFAULT '',
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_collector_items_status ON collector_items(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collector_items_industry ON collector_items(industry, updated_at DESC);
      CREATE TABLE IF NOT EXISTS source_health (
        source_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'unknown',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_items INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT NOT NULL DEFAULT '',
        last_success_at TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS source_routes (
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        last_verified_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, url)
      );
      CREATE TABLE IF NOT EXISTS source_route_health (
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_items INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT NOT NULL DEFAULT '',
        last_success_at TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, url)
      );
      CREATE INDEX IF NOT EXISTS idx_source_route_health_status ON source_route_health(status, last_checked_at DESC);
      CREATE TABLE IF NOT EXISTS source_scan_state (
        source_id TEXT PRIMARY KEY,
        backfill_cursor INTEGER NOT NULL DEFAULT 1,
        last_published_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      );
    `)
    this.ensureColumn('collector_settings', 'scan_mode', "TEXT NOT NULL DEFAULT 'broad'")
    this.ensureColumn('collector_settings', 'web_search_provider', "TEXT NOT NULL DEFAULT 'off'")
    this.ensureColumn('collector_settings', 'web_search_endpoint', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_settings', 'web_search_api_key', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_settings', 'web_search_queries_per_run', 'INTEGER NOT NULL DEFAULT 6')
    this.ensureColumn('collector_settings', 'web_search_results_per_query', 'INTEGER NOT NULL DEFAULT 10')
    this.ensureColumn('collector_settings', 'web_search_query_cursor', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('collector_items', 'source_name', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'budget', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'deadline', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'project_code', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'project_stage', "TEXT NOT NULL DEFAULT 'tender'")
    this.ensureColumn('collector_items', 'snapshot_text', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'project_address', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'agency', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'contact_name', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'contact_phone', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'contact_email', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'detail_attempts', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('collector_items', 'next_retry_at', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'last_attempt_at', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('collector_items', 'published_at_ts', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('collector_items', 'deadline_at_ts', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('collector_items', 'freshness_bucket', "TEXT NOT NULL DEFAULT 'unknown'")
    this.ensureColumn('collector_items', 'opportunity_status', "TEXT NOT NULL DEFAULT 'unknown'")
    this.ensureColumn('collector_items', 'freshness_score', 'INTEGER NOT NULL DEFAULT 0')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_collector_items_retry ON collector_items(status, next_retry_at, detail_attempts)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_collector_items_freshness ON collector_items(opportunity_status, freshness_score DESC, published_at_ts DESC)')
    // 电脑休眠、进程退出或升级时，上一轮可能来不及写结束状态；保留条目断点并明确标记中断。
    const interrupted = this.db.prepare(`UPDATE collector_runs SET status = 'failed', errors = errors + 1,
      message = CASE WHEN message = '' THEN '上次采集因程序退出而中断，已从已保存条目继续'
        ELSE '上次采集因程序退出而中断，已从已保存条目继续；中断位置：' || message END,
      finished_at = ? WHERE status = 'running'`).run(new Date().toISOString())
    this.resumeInterrupted = Number(interrupted.changes) > 0
    this.db.prepare(`INSERT OR IGNORE INTO collector_settings
      (id, enabled, interval_hours, pages_per_run, focus_regions, updated_at) VALUES (1, 1, 6, 5, ?, ?)`)
      .run(JSON.stringify(DEFAULT_REGIONS), new Date().toISOString())
    // 全库时效重算由每轮 runNow 开始时执行。启动阶段重复扫描会阻塞 Electron
    // 主线程，并且采集开始时还会再做一次，因此这里不做无效的第二遍扫描。
  }

  ensureColumn(table, column, definition) {
    const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name))
    if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  reclassifyExistingItems(nowMs = this.now()) {
    const rows = this.db.prepare(`SELECT id, published_at, deadline, project_stage, published_at_ts,
      deadline_at_ts, freshness_bucket, opportunity_status, freshness_score, status FROM collector_items`).all()
    const update = this.db.prepare(`UPDATE collector_items SET published_at_ts = ?, deadline_at_ts = ?,
      freshness_bucket = ?, opportunity_status = ?, freshness_score = ?,
      status = CASE
        WHEN status = 'discovered' AND ? IN ('stale', 'deadline_passed') THEN 'archived'
        WHEN status = 'archived' AND ? IN ('active', 'deadline_soon', 'unknown') THEN 'discovered'
        ELSE status END
      WHERE id = ?`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const freshness = classifyProjectFreshness({
          publishedAt: row.published_at,
          publishedAtTs: row.published_at_ts,
          deadline: row.deadline,
          deadlineAtTs: row.deadline_at_ts,
          projectStage: row.project_stage,
        }, nowMs)
        update.run(freshness.publishedAtTs, freshness.deadlineAtTs, freshness.freshnessBucket,
          freshness.opportunityStatus, freshness.freshnessScore, freshness.opportunityStatus,
          freshness.opportunityStatus, row.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
  }

  syncLeadFreshnessFromItems() {
    if (!this.leadRadar || !this.leadRadar.db) return 0
    const leadColumns = new Set(this.leadRadar.db.prepare('PRAGMA table_info(leads)').all().map((item) => item.name))
    if (!leadColumns.has('source_event_time') || !leadColumns.has('opportunity_status')) return 0
    const rows = this.db.prepare(`SELECT url, published_at_ts, deadline_at_ts, project_stage,
      opportunity_status, freshness_bucket, freshness_score FROM collector_items`).all()
    const updateLead = this.leadRadar.db.prepare(`UPDATE leads SET source_event_time = ?, project_deadline_time = ?,
      project_stage = ?, opportunity_status = ?, freshness_bucket = ?, freshness_score = ? WHERE source_url = ?
      AND NOT (source_event_time IS ? AND project_deadline_time IS ? AND project_stage IS ?
        AND opportunity_status IS ? AND freshness_bucket IS ? AND freshness_score IS ?)`)
    const sourceColumns = new Set(this.leadRadar.db.prepare('PRAGMA table_info(lead_sources)').all().map((item) => item.name))
    const updateSource = sourceColumns.has('source_event_time')
      ? this.leadRadar.db.prepare(`UPDATE lead_sources SET source_event_time = ?, project_deadline_time = ?,
        project_stage = ?, opportunity_status = ?, freshness_bucket = ?, freshness_score = ? WHERE source_url = ?
        AND NOT (source_event_time IS ? AND project_deadline_time IS ? AND project_stage IS ?
          AND opportunity_status IS ? AND freshness_bucket IS ? AND freshness_score IS ?)`)
      : null
    let changed = 0
    this.leadRadar.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const values = [row.published_at_ts, row.deadline_at_ts, row.project_stage, row.opportunity_status,
          row.freshness_bucket, row.freshness_score, row.url]
        const comparison = values.slice(0, 6)
        changed += Number(updateLead.run(...values, ...comparison).changes) || 0
        if (updateSource) updateSource.run(...values, ...comparison)
      }
      this.leadRadar.db.exec('COMMIT')
    } catch (error) {
      try { this.leadRadar.db.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
    return changed
  }

  updateRunProgress(runId, stats, message) {
    this.db.prepare(`UPDATE collector_runs SET pages_scanned = ?, notices_scanned = ?,
      candidates = ?, imported = ?, duplicates = ?, errors = ?, message = ? WHERE id = ?`)
      .run(stats.pages, stats.scanned, stats.candidates, stats.imported, stats.duplicates,
        stats.errors, String(message || '').slice(0, 1000), runId)
  }

  getSettings() {
    const row = this.db.prepare('SELECT * FROM collector_settings WHERE id = 1').get()
    let regions = DEFAULT_REGIONS
    try { regions = JSON.parse(row.focus_regions) } catch (error) {}
    const webSearchProvider = providerInfo(process.env.VCAT_WEB_SEARCH_PROVIDER || row.web_search_provider).id
    const webSearchEndpoint = String(process.env.VCAT_WEB_SEARCH_ENDPOINT || row.web_search_endpoint || '').trim()
    const hasStoredKey = !!String(process.env.VCAT_WEB_SEARCH_API_KEY || row.web_search_api_key || '').trim()
    let webSearchConfigured = false
    if (webSearchProvider === 'brave') webSearchConfigured = hasStoredKey
    if (webSearchProvider === 'searxng' && webSearchEndpoint) {
      try {
        validateSearxngEndpoint(webSearchEndpoint)
        webSearchConfigured = true
      } catch (error) {}
    }
    return {
      enabled: !!row.enabled,
      intervalHours: row.interval_hours,
      pagesPerRun: row.pages_per_run,
      focusRegions: regions,
      scanMode: row.scan_mode || 'broad',
      webSearchProvider,
      webSearchEndpoint,
      webSearchConfigured,
      webSearchApiKeyConfigured: hasStoredKey,
      webSearchQueriesPerRun: Math.max(1, Math.min(20, Number(row.web_search_queries_per_run) || 6)),
      webSearchResultsPerQuery: Math.max(1, Math.min(20, Number(row.web_search_results_per_query) || 10)),
      webSearchQueryCursor: Math.max(0, Number(row.web_search_query_cursor) || 0) % DEFAULT_OPEN_WEB_QUERIES.length,
    }
  }

  getWebSearchRuntimeConfig() {
    const row = this.db.prepare('SELECT * FROM collector_settings WHERE id = 1').get()
    const settings = this.getSettings()
    let apiKey = String(process.env.VCAT_WEB_SEARCH_API_KEY || '').trim()
    if (settings.webSearchProvider === 'brave' && !apiKey && row.web_search_api_key) {
      apiKey = String(this.leadRadar.decryptText(row.web_search_api_key) || '').trim()
    }
    const queries = []
    for (let index = 0; index < settings.webSearchQueriesPerRun; index++) {
      queries.push(DEFAULT_OPEN_WEB_QUERIES[(settings.webSearchQueryCursor + index) % DEFAULT_OPEN_WEB_QUERIES.length])
    }
    return {
      provider: settings.webSearchProvider,
      providerName: providerInfo(settings.webSearchProvider).name,
      endpoint: settings.webSearchEndpoint,
      apiKey,
      configured: settings.webSearchConfigured,
      queryLimit: settings.webSearchQueriesPerRun,
      resultsPerQuery: settings.webSearchResultsPerQuery,
      queryCursor: settings.webSearchQueryCursor,
      queries,
    }
  }

  advanceWebSearchQueryCursor(count) {
    const current = this.getSettings().webSearchQueryCursor
    const next = (current + Math.max(1, Number(count) || 1)) % DEFAULT_OPEN_WEB_QUERIES.length
    this.db.prepare('UPDATE collector_settings SET web_search_query_cursor = ?, updated_at = ? WHERE id = 1')
      .run(next, new Date().toISOString())
    return next
  }

  updateSettings(payload = {}) {
    const current = this.getSettings()
    const row = this.db.prepare('SELECT * FROM collector_settings WHERE id = 1').get()
    const enabled = payload.enabled === undefined ? current.enabled : !!payload.enabled
    const intervalHours = Math.max(1, Math.min(168, Number(payload.intervalHours) || current.intervalHours))
    const pagesPerRun = Math.max(1, Math.min(25, Number(payload.pagesPerRun) || current.pagesPerRun))
    const focusRegions = Array.isArray(payload.focusRegions)
      ? payload.focusRegions.map((item) => String(item).trim().slice(0, 30)).filter(Boolean).slice(0, 34)
      : current.focusRegions
    const scanMode = payload.scanMode === 'focused' ? 'focused' : 'broad'
    const webSearchProvider = payload.webSearchProvider === undefined
      ? current.webSearchProvider : providerInfo(payload.webSearchProvider).id
    let webSearchEndpoint = payload.webSearchEndpoint === undefined
      ? current.webSearchEndpoint : String(payload.webSearchEndpoint || '').trim().slice(0, 500)
    if (webSearchProvider === 'searxng' && webSearchEndpoint) webSearchEndpoint = validateSearxngEndpoint(webSearchEndpoint)
    let encryptedApiKey = String(row.web_search_api_key || '')
    if (payload.clearWebSearchApiKey === true) encryptedApiKey = ''
    else if (typeof payload.webSearchApiKey === 'string' && payload.webSearchApiKey.trim()) {
      encryptedApiKey = this.leadRadar.encryptText(payload.webSearchApiKey.trim().slice(0, 500))
    }
    const webSearchQueriesPerRun = Math.max(1, Math.min(20,
      Number(payload.webSearchQueriesPerRun) || current.webSearchQueriesPerRun || 6))
    const webSearchResultsPerQuery = Math.max(1, Math.min(20,
      Number(payload.webSearchResultsPerQuery) || current.webSearchResultsPerQuery || 10))
    this.db.prepare(`UPDATE collector_settings SET enabled = ?, interval_hours = ?, pages_per_run = ?,
      focus_regions = ?, scan_mode = ?, web_search_provider = ?, web_search_endpoint = ?,
      web_search_api_key = ?, web_search_queries_per_run = ?, web_search_results_per_query = ?,
      updated_at = ? WHERE id = 1`)
      .run(enabled ? 1 : 0, intervalHours, pagesPerRun, JSON.stringify(focusRegions), scanMode,
        webSearchProvider, webSearchEndpoint, encryptedApiKey, webSearchQueriesPerRun,
        webSearchResultsPerQuery, new Date().toISOString())
    return this.getSettings()
  }

  getStatus() {
    const settings = this.getSettings()
    const lastRun = this.db.prepare('SELECT * FROM collector_runs ORDER BY id DESC LIMIT 1').get() || null
    const totals = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END) AS imported,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN opportunity_status IN ('active', 'deadline_soon') THEN 1 ELSE 0 END) AS actionable,
      SUM(CASE WHEN opportunity_status = 'deadline_soon' THEN 1 ELSE 0 END) AS deadline_soon,
      SUM(CASE WHEN opportunity_status = 'stale' THEN 1 ELSE 0 END) AS stale,
      SUM(CASE WHEN opportunity_status = 'deadline_passed' THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN opportunity_status = 'unknown' THEN 1 ELSE 0 END) AS date_unknown
      FROM collector_items`).get()
    const healthRows = this.db.prepare('SELECT * FROM source_health').all()
    const health = new Map(healthRows.map((row) => [row.source_id, row]))
    const routeHealthRows = this.db.prepare('SELECT * FROM source_route_health ORDER BY last_checked_at DESC').all()
    const routeHealth = new Map()
    for (const row of routeHealthRows) {
      const list = routeHealth.get(row.source_id) || []
      list.push(row)
      routeHealth.set(row.source_id, list)
    }
    const webSearchSource = {
      id: 'open-web-search',
      name: settings.webSearchProvider === 'off' ? '通用网页搜索' : `通用网页搜索·${providerInfo(settings.webSearchProvider).name}`,
      baseUrl: settings.webSearchEndpoint || (settings.webSearchProvider === 'brave' ? 'https://api.search.brave.com/' : ''),
      status: settings.webSearchConfigured ? 'active' : 'manual',
      compliance: settings.webSearchConfigured
        ? '使用已配置的搜索服务读取最近31天公开网页的标题和摘要；不自动抓取任意搜索结果详情'
        : '可选能力；配置 Brave Search API 或自建 SearXNG 后启用，不抓取搜索引擎结果页',
    }
    const sources = [...SOURCE_REGISTRY, webSearchSource].map((source) => {
      const routes = routeHealth.get(source.id) || []
      const routeSummary = routes.reduce((summary, row) => {
        summary[row.status] = (summary[row.status] || 0) + 1
        return summary
      }, { healthy: 0, empty: 0, error: 0, degraded: 0, unknown: 0 })
      return { ...source, health: health.get(source.id) || null, routeSummary, routeHealth: routes.slice(0, 10) }
    })
    const sourceHealth = sources.reduce((summary, source) => {
      if (source.status !== 'active') return summary
      const state = source.health && source.health.status || 'unknown'
      summary[state] = (summary[state] || 0) + 1
      return summary
    }, { healthy: 0, empty: 0, error: 0, degraded: 0, unknown: 0 })
    return {
      running: this.running,
      progress: { ...this.progress },
      settings,
      webSearch: {
        provider: settings.webSearchProvider,
        providerName: providerInfo(settings.webSearchProvider).name,
        configured: settings.webSearchConfigured,
        apiKeyConfigured: settings.webSearchApiKeyConfigured,
        endpoint: settings.webSearchEndpoint,
        queryLimit: settings.webSearchQueriesPerRun,
        resultsPerQuery: settings.webSearchResultsPerQuery,
        queryCatalogSize: DEFAULT_OPEN_WEB_QUERIES.length,
        queryCursor: settings.webSearchQueryCursor,
        resultPolicy: 'snippet_only',
      },
      lastRun,
      totals,
      sources,
      sourceHealth,
      activeSourceCount: this.sources.length + (settings.webSearchConfigured ? 1 : 0),
      sourceGroups: {
        procurementCategories: CCGP_CATEGORY_SOURCES.length,
        procurementKeywords: CCGP_SEARCH_SOURCES.length,
        publicResourcePlatforms: 1 + PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS.length,
        publicWebPlatforms: PUBLIC_ORGANIZATION_PROJECT_SOURCES.length,
        earlyStageProjects: EARLY_STAGE_PROJECT_SOURCES.length,
        webSearchProviders: settings.webSearchConfigured ? 1 : 0,
      },
    }
  }

  getSources() {
    return { list: this.getStatus().sources }
  }

  getSourceRoutes(source) {
    const saved = this.db.prepare('SELECT url, label FROM source_routes WHERE source_id = ? ORDER BY url').all(source.id)
    const unique = new Map([[source.baseUrl, { url: source.baseUrl, label: '首页' }]])
    for (const row of source.seedUrls || []) unique.set(row.url, row)
    for (const row of saved) unique.set(row.url, row)
    return [...unique.values()].slice(0, 7)
  }

  saveSourceRoutes(source, rows) {
    const now = new Date().toISOString()
    const insert = this.db.prepare(`INSERT INTO source_routes (source_id, url, label, last_verified_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(source_id, url) DO UPDATE SET label = excluded.label, last_verified_at = excluded.last_verified_at`)
    const unique = new Map([[source.baseUrl, { url: source.baseUrl, label: '首页' }]])
    for (const row of source.seedUrls || []) unique.set(row.url, row)
    for (const row of rows || []) unique.set(row.url, row)
    for (const row of [...unique.values()].slice(0, 7)) insert.run(source.id, row.url, String(row.label || '').slice(0, 120), now)
  }

  updateSourceHealth(sourceId, result = {}) {
    const now = new Date().toISOString()
    const current = this.db.prepare('SELECT consecutive_failures, last_success_at FROM source_health WHERE source_id = ?').get(sourceId)
    const success = !!result.success
    const failures = success ? 0 : Number(current && current.consecutive_failures || 0) + 1
    const partialError = success && !!result.error
    const status = partialError ? 'degraded'
      : success ? (Number(result.items) > 0 ? 'healthy' : 'empty') : failures >= 3 ? 'degraded' : 'error'
    this.db.prepare(`INSERT INTO source_health
      (source_id, status, consecutive_failures, last_items, last_checked_at, last_success_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET status = excluded.status, consecutive_failures = excluded.consecutive_failures,
        last_items = excluded.last_items, last_checked_at = excluded.last_checked_at,
        last_success_at = excluded.last_success_at, last_error = excluded.last_error`)
      .run(sourceId, status, failures, Number(result.items) || 0, now,
        success ? now : String(current && current.last_success_at || ''), partialError || !success ? String(result.error || '').slice(0, 500) : '')
  }

  updateRouteHealth(sourceId, url, result = {}) {
    const now = new Date().toISOString()
    const current = this.db.prepare(`SELECT consecutive_failures, last_success_at FROM source_route_health
      WHERE source_id = ? AND url = ?`).get(String(sourceId), String(url))
    const success = !!result.success
    const failures = success ? 0 : Number(current && current.consecutive_failures || 0) + 1
    const status = success ? (Number(result.items) > 0 ? 'healthy' : 'empty') : failures >= 3 ? 'degraded' : 'error'
    this.db.prepare(`INSERT INTO source_route_health
      (source_id, url, status, consecutive_failures, last_items, last_checked_at, last_success_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, url) DO UPDATE SET status = excluded.status,
        consecutive_failures = excluded.consecutive_failures, last_items = excluded.last_items,
        last_checked_at = excluded.last_checked_at, last_success_at = excluded.last_success_at,
        last_error = excluded.last_error`)
      .run(String(sourceId), String(url), status, failures, Number(result.items) || 0, now,
        success ? now : String(current && current.last_success_at || ''), success ? '' : String(result.error || '').slice(0, 500))
  }

  getSourceBackoff(sourceId, now = Date.now()) {
    const health = this.db.prepare('SELECT status, consecutive_failures, last_checked_at FROM source_health WHERE source_id = ?').get(sourceId)
    if (!health || !health.last_checked_at) return null
    const checkedAt = Date.parse(health.last_checked_at)
    if (!Number.isFinite(checkedAt)) return null
    const delayMs = health.status === 'degraded' && Number(health.consecutive_failures) >= 3 ? 24 * 60 * 60 * 1000
      : health.status === 'error' ? 2 * 60 * 60 * 1000
        : health.status === 'empty' ? 12 * 60 * 60 * 1000 : 0
    if (!delayMs || checkedAt + delayMs <= now) return null
    return { status: health.status, retryAt: new Date(checkedAt + delayMs).toISOString() }
  }

  getSourceBackfillCursor(sourceId) {
    const row = this.db.prepare('SELECT backfill_cursor FROM source_scan_state WHERE source_id = ?').get(String(sourceId))
    return Math.max(1, Number(row && row.backfill_cursor) || 1)
  }

  setSourceBackfillCursor(sourceId, cursor) {
    this.db.prepare(`INSERT INTO source_scan_state (source_id, backfill_cursor, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET backfill_cursor = excluded.backfill_cursor,
        updated_at = excluded.updated_at`)
      .run(String(sourceId), Math.max(1, Number(cursor) || 1), new Date().toISOString())
  }

  buildPagePlan(source, budget) {
    const count = Math.max(1, Number(budget) || 1)
    if (['search', 'beijing-promotion-api', 'guangxi-promotion-list'].includes(source.type)) {
      const maxBackfillPage = Math.max(10, Number(source.maxBackfillPages) || 200)
      const cursor = Math.min(maxBackfillPage, Math.max(2, this.getSourceBackfillCursor(source.id)))
      const pages = [1]
      for (let index = 0; index < count - 1; index++) pages.push(2 + ((cursor - 2 + index) % (maxBackfillPage - 1)))
      const nextCursor = 2 + ((cursor - 2 + Math.max(1, count - 1)) % (maxBackfillPage - 1))
      return { pages: [...new Set(pages)], nextCursor }
    }
    if (['ggzy-home', 'guangdong-promotion-api'].includes(source.type)) return [0]
    const maxBackfillPage = Math.max(10, Number(source.maxBackfillPages) || 200)
    const cursor = Math.min(maxBackfillPage, this.getSourceBackfillCursor(source.id))
    const pages = [0]
    for (let index = 0; index < count - 1; index++) {
      pages.push(1 + ((cursor - 1 + index) % maxBackfillPage))
    }
    const nextCursor = 1 + ((cursor - 1 + Math.max(1, count - 1)) % maxBackfillPage)
    return { pages: [...new Set(pages)], nextCursor }
  }

  saveDiscoveredCandidates(candidates) {
    const nowMs = this.now()
    const now = new Date(nowMs).toISOString()
    const exhaustedCutoff = new Date(nowMs - EXHAUSTED_DETAIL_RECHECK_MS).toISOString()
    const resetExhausted = this.db.prepare(`UPDATE collector_items SET status = 'discovered', detail_attempts = 0,
      next_retry_at = '', last_attempt_at = '', error = '', updated_at = ?
      WHERE url = ? AND status = 'error' AND detail_attempts >= ? AND updated_at <= ?`)
    const insert = this.db.prepare(`INSERT INTO collector_items
      (source_id, source_name, title, url, region, buyer, published_at, published_at_ts, budget, deadline,
        deadline_at_ts, project_code, project_stage, snapshot_text, freshness_bucket, opportunity_status,
        freshness_score, status, discovered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET title = excluded.title, region = excluded.region,
      source_name = excluded.source_name, buyer = excluded.buyer, published_at = excluded.published_at,
        published_at_ts = excluded.published_at_ts,
        budget = CASE WHEN excluded.budget <> '' THEN excluded.budget ELSE collector_items.budget END,
        deadline = CASE WHEN excluded.deadline <> '' THEN excluded.deadline ELSE collector_items.deadline END,
        deadline_at_ts = CASE WHEN excluded.deadline_at_ts > 0 THEN excluded.deadline_at_ts ELSE collector_items.deadline_at_ts END,
        project_code = CASE WHEN excluded.project_code <> '' THEN excluded.project_code ELSE collector_items.project_code END,
        project_stage = CASE WHEN excluded.project_stage <> '' THEN excluded.project_stage ELSE collector_items.project_stage END,
        snapshot_text = CASE WHEN excluded.snapshot_text <> '' THEN excluded.snapshot_text ELSE collector_items.snapshot_text END,
        freshness_bucket = excluded.freshness_bucket,
        opportunity_status = excluded.opportunity_status,
        freshness_score = excluded.freshness_score,
        status = CASE
          WHEN collector_items.status = 'archived' AND excluded.opportunity_status IN ('active', 'deadline_soon', 'unknown') THEN 'discovered'
          WHEN collector_items.status = 'discovered' AND excluded.opportunity_status IN ('stale', 'deadline_passed') THEN 'archived'
          ELSE collector_items.status END,
        updated_at = CASE WHEN collector_items.status = 'discovered'
          OR (collector_items.status = 'error' AND collector_items.detail_attempts < ${this.maxDetailAttempts})
          THEN excluded.updated_at ELSE collector_items.updated_at END`)
    const exists = this.db.prepare('SELECT 1 FROM collector_items WHERE url = ?')
    let inserted = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const notice of candidates) {
        if (!exists.get(notice.url)) inserted++
        resetExhausted.run(now, notice.url, this.maxDetailAttempts, exhaustedCutoff)
        const freshness = classifyProjectFreshness({
          publishedAt: notice.publishedAt,
          deadline: notice.deadline,
          projectStage: notice.projectStage || 'tender',
        }, nowMs)
        const status = freshness.actionable ? 'discovered' : 'archived'
        insert.run(notice.sourceId, notice.sourceName, notice.title, notice.url,
          notice.region || '', notice.buyer || '', notice.publishedAt || '', freshness.publishedAtTs,
          notice.budget || '', notice.deadline || '', freshness.deadlineAtTs, notice.projectCode || '',
          notice.projectStage || 'tender', notice.detailText || '', freshness.freshnessBucket,
          freshness.opportunityStatus, freshness.freshnessScore, status, now, now)
      }
      this.db.exec('COMMIT')
      return inserted
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
  }

  listRuns(limit = 20) {
    return { list: this.db.prepare('SELECT * FROM collector_runs ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(100, Number(limit) || 20))) }
  }

  listItems(filters = {}) {
    const where = []
    const params = {}
    if (filters.status) { where.push('status = $status'); params.$status = String(filters.status) }
    if (filters.industry) { where.push('industry = $industry'); params.$industry = String(filters.industry) }
    if (filters.includeHistory === false) where.push("opportunity_status NOT IN ('stale', 'deadline_passed')")
    if (filters.opportunityStatus) {
      where.push('opportunity_status = $opportunityStatus')
      params.$opportunityStatus = String(filters.opportunityStatus)
    }
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50))
    params.$limit = limit
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
    return { list: this.db.prepare(`SELECT * FROM collector_items${clause}
      ORDER BY CASE opportunity_status WHEN 'deadline_soon' THEN 0 WHEN 'active' THEN 1 WHEN 'unknown' THEN 2 WHEN 'stale' THEN 3 ELSE 4 END,
        freshness_score DESC, published_at_ts DESC, updated_at DESC LIMIT $limit`).all(params) }
  }

  async fetchText(url, requestOptions = {}) {
    const parsed = new URL(url)
    const allowedHosts = new Set(['www.ccgp.gov.cn', 'search.ccgp.gov.cn', 'www.ggzy.gov.cn', ...VERIFIED_PROJECT_HOSTS])
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) throw new Error('采集器只允许访问已核验的公开 HTTPS 公告页面')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    try {
      const response = await this.fetchImpl(parsed.href, {
        redirect: 'follow',
        signal: controller.signal,
        method: requestOptions.method || 'GET',
        body: requestOptions.body,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: requestOptions.accept || 'text/html,application/xhtml+xml,application/json',
          ...(requestOptions.headers || {}),
        },
      })
      const finalUrl = new URL(response.url || parsed.href)
      if (finalUrl.protocol !== 'https:' || !allowedHosts.has(finalUrl.hostname)) {
        throw new Error('页面跳转到白名单以外的地址，已停止读取')
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const declared = Number(response.headers && response.headers.get && response.headers.get('content-length') || 0)
      if (declared > 4 * 1024 * 1024) throw new Error('页面超过 4MB，已跳过')
      const text = await response.text()
      if (text.length > 4 * 1024 * 1024) throw new Error('页面超过 4MB，已跳过')
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  async processPendingDetailBatch(options = {}) {
    const limit = Math.max(0, Math.min(this.maxDetailsPerRun, Number(options.limit) || 0))
    if (!limit) return 0
    const stats = options.stats
    if (!stats || !Number.isFinite(Number(options.runId))) throw new Error('正文处理批次缺少运行上下文')
    const runId = Number(options.runId)
    const focus = new Set(Array.isArray(options.focusRegions) ? options.focusRegions : [])
    const retryCutoff = new Date(this.now()).toISOString()
    const pendingRows = this.db.prepare(`SELECT source_id, source_name, title, url, region, buyer, published_at,
      published_at_ts, budget, deadline, deadline_at_ts, project_code, project_stage, snapshot_text,
        project_address, agency, contact_name, contact_phone, contact_email,
        opportunity_status, freshness_score, status, detail_attempts, updated_at
      FROM collector_items
      WHERE (status = 'discovered'
        OR (status = 'error' AND detail_attempts < ? AND (next_retry_at = '' OR next_retry_at <= ?)))
        AND opportunity_status NOT IN ('stale', 'deadline_passed')
      ORDER BY CASE opportunity_status WHEN 'deadline_soon' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
        CASE WHEN status = 'discovered' THEN 0 ELSE 1 END, freshness_score DESC,
        published_at_ts DESC, updated_at DESC, discovered_at ASC
      LIMIT ?`).all(this.maxDetailAttempts, retryCutoff, Math.max(limit, limit * 3))
    const selected = pendingRows.map((row) => ({
      sourceId: row.source_id, sourceName: row.source_name, title: row.title, url: row.url,
      region: row.region, buyer: row.buyer, publishedAt: row.published_at,
      publishedAtTs: Number(row.published_at_ts) || 0,
      budget: row.budget, deadline: row.deadline, projectCode: row.project_code,
      deadlineAtTs: Number(row.deadline_at_ts) || 0,
      projectStage: row.project_stage || 'tender', snapshotText: row.snapshot_text || '',
      projectAddress: row.project_address || '', agency: row.agency || '', contactName: row.contact_name || '',
      contactPhone: row.contact_phone || '', contactEmail: row.contact_email || '',
      status: row.status, detailAttempts: Number(row.detail_attempts) || 0, updatedAt: row.updated_at,
    })).sort((a, b) => Number(isRelevantTitle(b.title)) - Number(isRelevantTitle(a.title))
      || Number(focus.has(b.region)) - Number(focus.has(a.region))
      || String(b.publishedAt).localeCompare(String(a.publishedAt))
      || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit)
    if (!selected.length) return 0
    const phase = String(options.phase || '读取相关公告正文并分类')
    this.progress = { stage: 'details', current: 0, total: selected.length, message: phase }
    this.updateRunProgress(runId, stats, phase)

    for (let index = 0; index < selected.length; index++) {
      const notice = selected[index]
      const existing = this.db.prepare('SELECT status, detail_attempts FROM collector_items WHERE url = ?').get(notice.url)
      if (existing && existing.status === 'imported') {
        stats.duplicates++
        this.progress = { stage: 'details', current: index + 1, total: selected.length, message: `已处理：${notice.title}` }
        continue
      }
      const now = new Date().toISOString()
      this.db.prepare(`INSERT INTO collector_items
        (source_id, source_name, title, url, region, buyer, published_at, budget, deadline,
          project_code, project_stage, snapshot_text, discovered_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET title = excluded.title, region = excluded.region,
        source_name = excluded.source_name, buyer = excluded.buyer, published_at = excluded.published_at,
        budget = excluded.budget, deadline = excluded.deadline, project_code = excluded.project_code,
        project_stage = excluded.project_stage, snapshot_text = excluded.snapshot_text, updated_at = excluded.updated_at`)
        .run(notice.sourceId, notice.sourceName, notice.title, notice.url, notice.region, notice.buyer,
          notice.publishedAt, notice.budget || '', notice.deadline || '', notice.projectCode || '',
          notice.projectStage || 'tender', notice.snapshotText || '', now, now)
      const detailAttempt = Number(existing && existing.detail_attempts || notice.detailAttempts || 0) + 1
      const attemptedAt = new Date(this.now()).toISOString()
      this.db.prepare(`UPDATE collector_items SET detail_attempts = ?, last_attempt_at = ?,
        next_retry_at = '', updated_at = ? WHERE url = ?`).run(detailAttempt, attemptedAt, attemptedAt, notice.url)
      if (existing && existing.status === 'error') stats.retried++
      try {
        let detail
        if (notice.sourceId === 'open-web-search' && !notice.snapshotText) {
          throw new Error('通用搜索结果缺少公开摘要，已禁止自动访问陌生结果网址')
        }
        if (notice.snapshotText) {
          detail = enrichProjectDetail({
            title: notice.title,
            body: notice.snapshotText,
            publishedAt: notice.publishedAt || '',
            region: notice.region || '',
            buyer: notice.buyer || '',
            budget: notice.budget || '',
            deadline: notice.deadline || '',
            projectCode: notice.projectCode || '',
          }, notice)
        } else {
          const html = await this.fetchText(notice.url)
          detail = parseCcgpDetail(html, notice)
        }
        const combined = [detail.title, `来源：${notice.sourceName}`, `地区：${detail.region}`, `采购人/招标人：${detail.buyer}`,
          detail.agency && `代理机构：${detail.agency}`, detail.projectAddress && `项目地址：${detail.projectAddress}`,
          detail.contactName && `联系人：${detail.contactName}`, detail.contactPhone && `联系电话：${detail.contactPhone}`,
          detail.contactEmail && `联系邮箱：${detail.contactEmail}`,
          `项目阶段：${notice.projectStage || 'tender'}`,
          `发布时间：${detail.publishedAt}`, detail.deadline && `投标/响应截止：${detail.deadline}`,
          detail.budget && `预算/最高限价：${detail.budget}`, detail.projectCode && `项目编号：${detail.projectCode}`,
          detail.body].filter(Boolean).join('\n')
        const industry = inferIndustry(combined)
        const freshness = classifyProjectFreshness({
          publishedAt: detail.publishedAt,
          deadline: detail.deadline,
          projectStage: notice.projectStage || 'tender',
        }, this.now())
        if (!isNonEngineeringProduct(combined) && (industry !== 'unknown' || isEngineeringOpportunity(combined))) {
          const sourceType = ['approval', 'promotion'].includes(notice.projectStage) ? 'approval'
            : String(notice.sourceId).startsWith('public-web-') || notice.sourceId === 'open-web-search' ? 'web_project'
              : notice.sourceId === GGZY_HOME_SOURCE.id || String(notice.sourceId).startsWith('province-') ? 'public_resource' : 'procurement'
          let imported = 0
          let duplicates = 0
          if (freshness.actionable) {
            const result = this.leadRadar.importText({
              platform: sourceType === 'public_resource' ? 'ggzy'
                : sourceType === 'approval' ? 'gov_projects' : sourceType === 'web_project' ? 'public_web' : 'ccgp', sourceType, industry,
              accountName: detail.buyer || detail.title, region: detail.region,
              sourceUrl: notice.url, rawText: combined, sourceEventTime: freshness.publishedAtTs,
              projectPublishedAtTs: freshness.publishedAtTs, projectDeadlineAtTs: freshness.deadlineAtTs,
              projectStage: notice.projectStage || 'tender', opportunityStatus: freshness.opportunityStatus,
              freshnessBucket: freshness.freshnessBucket, freshnessScore: freshness.freshnessScore,
            })
            imported = result.imported
            duplicates = result.duplicates
            stats.imported += imported
            stats.duplicates += duplicates
          } else {
            stats.archived++
          }
          this.db.prepare(`UPDATE collector_items SET title = ?, buyer = ?, published_at = ?, published_at_ts = ?, industry = ?,
            budget = ?, deadline = ?, deadline_at_ts = ?, project_code = ?, project_stage = ?, freshness_bucket = ?,
            opportunity_status = ?, freshness_score = ?, status = ?, imported_count = ?, duplicate_count = ?,
            snapshot_text = ?, project_address = ?, agency = ?, contact_name = ?, contact_phone = ?, contact_email = ?,
            error = '', next_retry_at = '', updated_at = ? WHERE url = ?`)
            .run(detail.title, detail.buyer, detail.publishedAt, freshness.publishedAtTs, industry, detail.budget, detail.deadline,
              freshness.deadlineAtTs, detail.projectCode, notice.projectStage || 'tender', freshness.freshnessBucket,
              freshness.opportunityStatus, freshness.freshnessScore, freshness.actionable ? 'imported' : 'archived',
              imported, duplicates, detail.body, detail.projectAddress || '', detail.agency || '', detail.contactName || '',
              detail.contactPhone || '', detail.contactEmail || '', new Date().toISOString(), notice.url)
        } else {
          this.db.prepare("UPDATE collector_items SET industry = 'unknown', status = 'filtered', error = '', next_retry_at = '', updated_at = ? WHERE url = ?")
            .run(new Date(this.now()).toISOString(), notice.url)
        }
      } catch (error) {
        stats.errors++
        const failedAt = new Date(this.now()).toISOString()
        const canRetry = detailAttempt < this.maxDetailAttempts
        const nextRetryAt = canRetry
          ? new Date(this.now() + computeDetailRetryDelayMs(detailAttempt, this.detailRetryBaseMs, this.detailRetryMaxMs)).toISOString()
          : ''
        if (canRetry) stats.retryScheduled++
        else stats.retriesExhausted++
        this.db.prepare("UPDATE collector_items SET status = 'error', error = ?, next_retry_at = ?, updated_at = ? WHERE url = ?")
          .run(String(error && error.message || error).slice(0, 500), nextRetryAt, failedAt, notice.url)
      }
      this.progress = { stage: 'details', current: index + 1, total: selected.length, message: notice.title }
      this.updateRunProgress(runId, stats, this.progress.message)
      if (this.requestDelayMs) await sleep(this.requestDelayMs)
    }
    return selected.length
  }

  async runNow(options = {}) {
    if (this.running) throw new Error('公开项目采集器正在运行')
    this.running = true
    const triggerType = options.triggerType === 'schedule' ? 'schedule' : 'manual'
    const startedAt = new Date().toISOString()
    const run = this.db.prepare(`INSERT INTO collector_runs (trigger_type, status, started_at)
      VALUES (?, 'running', ?)`).run(triggerType, startedAt)
    const runId = Number(run.lastInsertRowid)
    const stats = { pages: 0, scanned: 0, candidates: 0, imported: 0, duplicates: 0, archived: 0, errors: 0,
      retried: 0, retryScheduled: 0, retriesExhausted: 0 }
    try {
      this.reclassifyExistingItems()
      this.syncLeadFreshnessFromItems()
      const settings = this.getSettings()
      const webSearchConfig = this.getWebSearchRuntimeConfig()
      const candidates = []
      const candidateUrls = new Set()
      const flushCandidates = () => {
        if (!candidates.length) return 0
        const inserted = this.saveDiscoveredCandidates(candidates)
        candidates.length = 0
        stats.candidates += inserted
        return inserted
      }
      const pageCounts = this.sources.map((source) => Math.min(settings.pagesPerRun, Number(source.maxPages) || settings.pagesPerRun))
      const totalPages = pageCounts.reduce((sum, count, index) => {
        const source = this.sources[index]
        const knownRoutes = ['province-home', 'organization-home'].includes(source.type)
          ? Math.min(6, this.getSourceRoutes(source).length - 1) : 0
        return sum + count + knownRoutes
      }, webSearchConfig.configured ? webSearchConfig.queryLimit : 0)
      let attemptedPages = 0
      this.progress = { stage: 'lists', current: 0, total: totalPages, message: '读取全网公开工程项目信息' }

      const acceptNotices = (source, notices) => {
        stats.scanned += notices.length
        for (const notice of notices) {
          const eligible = isOpenOpportunityTitle(notice.title) && !isNonEngineeringProduct(`${notice.title} ${notice.listText || ''}`)
            && (isRelevantTitle(notice.title) || settings.scanMode === 'broad' && isEngineeringOpportunity(`${notice.title} ${notice.listText || ''}`))
          const canonicalUrl = canonicalizeOfficialUrl(notice.url)
          if (!eligible || !canonicalUrl || candidateUrls.has(canonicalUrl)) continue
          candidateUrls.add(canonicalUrl)
          candidates.push({ ...notice, url: canonicalUrl, sourceId: source.id, sourceName: source.name })
        }
      }

      const readListPage = async (source, pageUrl, parser, requestOptions = {}) => {
        attemptedPages++
        try {
          const html = await this.fetchText(pageUrl, requestOptions)
          const notices = parser(html)
          this.updateRouteHealth(source.id, pageUrl, { success: true, items: notices.length })
          stats.pages++
          acceptNotices(source, notices)
          this.progress = { stage: 'lists', current: attemptedPages, total: totalPages, message: `${source.name} · ${new URL(pageUrl).pathname}` }
          this.updateRunProgress(runId, stats, this.progress.message)
          return { html, notices }
        } catch (error) {
          this.updateRouteHealth(source.id, pageUrl, { success: false, error: String(error && error.message || error) })
          throw error
        } finally {
          if (this.requestDelayMs) await sleep(this.requestDelayMs)
        }
      }

      let detailBudgetRemaining = this.maxDetailsPerRun
      const processDetails = async (requested, phase) => {
        flushCandidates()
        const limit = Math.min(detailBudgetRemaining, Math.max(0, Number(requested) || 0))
        if (!limit) return 0
        const processed = await this.processPendingDetailBatch({
          limit,
          phase,
          focusRegions: settings.focusRegions,
          stats,
          runId,
        })
        detailBudgetRemaining = Math.max(0, detailBudgetRemaining - processed)
        return processed
      }

      // 长任务先把已发现的高优先级项目变成可用线索，避免数千页列表全部扫完前一直显示“新增 0”。
      // 同时给本轮新发现的项目保留至少 75% 的明细预算，小配额运行也不会被历史积压一次吃完。
      const initialDetailQuota = Math.min(80, Math.max(1, Math.floor(this.maxDetailsPerRun * 0.25)))
      await processDetails(Math.min(initialDetailQuota, detailBudgetRemaining), '优先处理已发现的近期工程项目')
      this.progress = { stage: 'lists', current: attemptedPages, total: totalPages, message: '继续读取全网公开工程项目信息' }
      this.updateRunProgress(runId, stats, this.progress.message)

      if (webSearchConfig.configured) {
        const source = {
          id: 'open-web-search',
          name: `通用网页搜索·${webSearchConfig.providerName}`,
        }
        try {
          this.progress = { stage: 'lists', current: attemptedPages, total: totalPages,
            message: `${source.name} · 检索最近31天公开网页` }
          this.updateRunProgress(runId, stats, this.progress.message)
          const searchResult = await searchOpenWeb({
            ...webSearchConfig,
            fetchImpl: this.fetchImpl,
            queries: webSearchConfig.queries,
            nowMs: this.now(),
            requestDelayMs: this.requestDelayMs,
          })
          attemptedPages += searchResult.queryCount
          stats.pages += searchResult.queryCount
          stats.errors += searchResult.errors.length
          acceptNotices(source, searchResult.results)
          const partialError = searchResult.errors.map((item) => item.message).join('；').slice(0, 500)
          this.updateSourceHealth(source.id, { success: true, items: searchResult.results.length, error: partialError })
          this.advanceWebSearchQueryCursor(searchResult.queryCount)
          flushCandidates()
          await processDetails(20, `及时处理 ${source.name} 新发现项目`)
          this.progress = { stage: 'lists', current: attemptedPages, total: totalPages,
            message: `${source.name} · 发现 ${searchResult.results.length} 条公开网页结果` }
          this.updateRunProgress(runId, stats, this.progress.message)
        } catch (error) {
          attemptedPages += webSearchConfig.queryLimit
          stats.errors++
          this.updateSourceHealth(source.id, { success: false, items: 0, error: String(error && error.message || error) })
          this.advanceWebSearchQueryCursor(webSearchConfig.queryLimit)
          this.progress = { stage: 'lists', current: attemptedPages, total: totalPages,
            message: `${source.name} · 暂时不可用，已继续其他公开来源` }
          this.updateRunProgress(runId, stats, this.progress.message)
        }
      }

      for (let sourceIndex = 0; sourceIndex < this.sources.length; sourceIndex++) {
        const source = this.sources[sourceIndex]
        const pagesForSource = pageCounts[sourceIndex]
        let sourceItems = 0
        let sourceSuccess = false
        let sourceError = ''
        if (['province-home', 'organization-home'].includes(source.type)) {
          const backoff = this.getSourceBackoff(source.id)
          if (backoff) {
            attemptedPages += 1 + Math.min(6, this.getSourceRoutes(source).length - 1)
            this.progress = { stage: 'lists', current: attemptedPages, total: totalPages,
              message: `${source.name} · ${backoff.status === 'degraded' ? '降级保护' : '短暂退避'}，${new Date(backoff.retryAt).toLocaleString('zh-CN')}后复检` }
            this.updateRunProgress(runId, stats, this.progress.message)
            continue
          }
          try {
            const home = await readListPage(source, source.baseUrl, (html) => parseOfficialPlatformPage(html, source))
            sourceSuccess = true
            sourceItems += home.notices.length
            this.saveSourceRoutes(source, discoverOfficialListPages(home.html, source))
          } catch (error) {
            stats.errors++
            sourceError = String(error && error.message || error)
          }
          // 首页被临时拦截时仍读取已核验的同域公告栏目，避免一个入口故障拖垮整个来源。
          const routes = this.getSourceRoutes(source).filter((row) => row.url !== source.baseUrl).slice(0, 6)
          for (const route of routes) {
            try {
              const page = await readListPage(source, route.url,
                (html) => parseOfficialPlatformPage(html, { ...source, baseUrl: route.url }))
              sourceSuccess = true
              sourceItems += page.notices.length
            } catch (error) {
              stats.errors++
              sourceError = String(error && error.message || error)
            }
          }
          this.updateSourceHealth(source.id, { success: sourceSuccess, items: sourceItems, error: sourceError })
          // 每完成一个官方来源就落盘，长任务中断时不会丢掉此前来源的新候选。
          flushCandidates()
          await processDetails(10, `及时处理 ${source.name} 新发现项目`)
          continue
        }
        const pagePlan = this.buildPagePlan(source, pagesForSource)
        const pages = Array.isArray(pagePlan) ? pagePlan : pagePlan.pages
        let reachedHistoryEnd = false
        for (const page of pages) {
          let pageUrl = ''
          try {
            let parser
            let requestOptions = {}
            if (source.type === 'search') {
              pageUrl = ccgpSearchUrl(source.keyword, page)
              parser = parseCcgpSearchList
            } else if (source.type === 'ggzy-home') {
              pageUrl = source.baseUrl
              parser = parseGgzyHomeList
            } else if (source.type === 'beijing-promotion-api') {
              pageUrl = `${source.baseUrl}?pageIndex=${Math.max(1, Number(page) || 1)}`
              parser = (text) => parseBeijingPromotionJson(text, source)
              requestOptions = {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body: new URLSearchParams({
                  pageSize: '10',
                  pageIndex: String(Math.max(1, Number(page) || 1)),
                  recommendType: 'unfinished',
                }).toString(),
              }
            } else if (source.type === 'guangdong-promotion-api') {
              pageUrl = source.baseUrl
              parser = (text) => parseGuangdongPromotionJson(text, source)
            } else if (source.type === 'guangxi-promotion-list') {
              const url = new URL(source.baseUrl)
              url.searchParams.set('pageNo', String(Math.max(1, Number(page) || 1)))
              pageUrl = url.href
              parser = (html) => parseGuangxiPromotionList(html, source)
            } else {
              pageUrl = ccgpPageUrl(source.baseUrl, page)
              parser = (html) => parseCcgpList(html, source.baseUrl)
            }
            const result = await readListPage(source, pageUrl, parser, requestOptions)
            sourceSuccess = true
            sourceItems += result.notices.length
          } catch (error) {
            const errorMessage = String(error && error.message || error)
            const isCcgpHistoryEnd = !source.type
              && /^https:\/\/www\.ccgp\.gov\.cn\/cggg\//i.test(String(source.baseUrl || ''))
              && Number(page) > 0
              && /^HTTP 404\b/i.test(errorMessage)
            if (isCcgpHistoryEnd) {
              // 中国政府采购网各公告栏目的历史页数不同。首个 404 表示已回扫到栏目尾部，
              // 不应继续请求后续不存在的页面，也不应把正常的分页终点算作来源故障。
              if (pageUrl) this.updateRouteHealth(source.id, pageUrl, { success: true, items: 0 })
              reachedHistoryEnd = true
              break
            }
            stats.errors++
            sourceError = errorMessage
          }
        }
        if (!Array.isArray(pagePlan)) {
          if (reachedHistoryEnd) this.setSourceBackfillCursor(source.id, 1)
          else if (sourceSuccess && !sourceError) this.setSourceBackfillCursor(source.id, pagePlan.nextCursor)
        }
        this.updateSourceHealth(source.id, { success: sourceSuccess, items: sourceItems, error: sourceError })
        flushCandidates()
        if ((sourceIndex + 1) % 8 === 0) {
          await processDetails(20, '分批处理刚发现的近期工程项目')
        }
      }

      // 防御性冲刷并用剩余预算处理本轮最后一批，保证列表扫描与正文入库交替推进。
      flushCandidates()
      await processDetails(detailBudgetRemaining, '处理本轮剩余的近期工程项目')

      const message = `扫描 ${stats.scanned} 条公告，发现 ${stats.candidates} 条候选，新增 ${stats.imported} 条有效线索，归档 ${stats.archived} 条过期/历史项目，待重试 ${stats.retryScheduled} 条`
      this.db.prepare(`UPDATE collector_runs SET status = 'success', pages_scanned = ?, notices_scanned = ?,
        candidates = ?, imported = ?, duplicates = ?, errors = ?, message = ?, finished_at = ? WHERE id = ?`)
        .run(stats.pages, stats.scanned, stats.candidates, stats.imported, stats.duplicates, stats.errors, message, new Date().toISOString(), runId)
      this.progress = { stage: 'done', current: stats.candidates, total: stats.candidates, message }
      return { success: true, ...stats, message }
    } catch (error) {
      const message = String(error && error.message || error).slice(0, 1000)
      this.db.prepare("UPDATE collector_runs SET status = 'failed', errors = errors + 1, message = ?, finished_at = ? WHERE id = ?")
        .run(message, new Date().toISOString(), runId)
      this.progress = { stage: 'error', current: 0, total: 0, message }
      throw error
    } finally {
      this.running = false
    }
  }

  async testWebSearch() {
    const config = this.getWebSearchRuntimeConfig()
    if (!config.configured) {
      throw new Error(config.provider === 'brave'
        ? '请先保存 Brave Search API 密钥'
        : config.provider === 'searxng' ? '请先保存可访问的 SearXNG 地址' : '请先选择通用网页搜索服务')
    }
    const result = await searchOpenWeb({
      ...config,
      fetchImpl: this.fetchImpl,
      queries: config.queries.slice(0, 1),
      queryLimit: 1,
      resultsPerQuery: Math.min(5, config.resultsPerQuery),
      nowMs: this.now(),
      requestDelayMs: 0,
    })
    return {
      success: true,
      provider: config.provider,
      providerName: config.providerName,
      scanned: result.scanned,
      matched: result.results.length,
      samples: result.results.slice(0, 3).map((item) => ({ title: item.title, url: item.url, publishedAt: item.publishedAt })),
    }
  }

  start() {
    if (this.timer || process.env.VCAT_DISABLE_GOV_COLLECTOR === '1') return
    const tick = async () => {
      const settings = this.getSettings()
      if (!settings.enabled || this.running) return
      const last = this.db.prepare("SELECT finished_at FROM collector_runs WHERE status IN ('success', 'failed') ORDER BY id DESC LIMIT 1").get()
      const elapsed = last && last.finished_at ? Date.now() - Date.parse(last.finished_at) : Infinity
      const checkedIds = new Set(this.db.prepare('SELECT source_id FROM source_health').all().map((row) => row.source_id))
      const hasNewSources = this.sources.some((source) => !checkedIds.has(source.id))
      // 升级后新增官方源无需等待旧周期结束，启动后自动完成首检。
      if (this.resumeInterrupted || hasNewSources || elapsed >= settings.intervalHours * 3600000) {
        this.resumeInterrupted = false
        this.runNow({ triggerType: 'schedule' }).catch(() => {})
      }
    }
    this.timer = setInterval(tick, 60000)
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
    try { this.db.close() } catch (error) {}
  }
}

module.exports = {
  GovernmentCollector,
  CCGP_SOURCES,
  CCGP_CATEGORY_SOURCES,
  CCGP_SEARCH_SOURCES,
  GGZY_HOME_SOURCE,
  DEFAULT_ACTIVE_SOURCES,
  PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS,
  PUBLIC_ORGANIZATION_PROJECT_SOURCES,
  EARLY_STAGE_PROJECT_SOURCES,
  SOURCE_REGISTRY,
  DISCOVERY_TERMS,
  ENGINEERING_TERMS,
  NON_ENGINEERING_PRODUCT_TERMS,
  canonicalizeOfficialUrl,
  parseCcgpList,
  parseCcgpSearchList,
  parseGgzyHomeList,
  parseCcgpDetail,
  enrichProjectDetail,
  isRelevantTitle,
  isOpenOpportunityTitle,
  isEngineeringOpportunity,
  isNonEngineeringProduct,
  parseDateTimestamp,
  parseDeadlineTimestamp,
  projectFreshnessBucket,
  projectStageWindowDays,
  classifyProjectFreshness,
  ccgpPageUrl,
  ccgpSearchUrl,
  computeDetailRetryDelayMs,
  MAX_DETAIL_ATTEMPTS,
}
