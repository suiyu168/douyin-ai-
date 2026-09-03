'use strict'

const PROVIDERS = Object.freeze({
  off: { id: 'off', name: '未启用', requiresApiKey: false },
  brave: { id: 'brave', name: 'Brave Search API', requiresApiKey: true },
  searxng: { id: 'searxng', name: 'SearXNG', requiresApiKey: false },
})

const INDUSTRY_QUERY_GROUPS = Object.freeze([
  ['地坪', '环氧地坪', '自流平', '金刚砂地坪', '固化地坪', '地面改造'],
  ['冷库', '冷链', '冷藏库', '冷冻库', '保鲜库', '制冷工程'],
  ['膜结构', '张拉膜', '膜结构车棚', '景观膜', '污水池加盖'],
  ['推拉棚', '伸缩棚', '活动棚', '移动雨棚', '装卸棚', '仓储篷房'],
  ['无尘车间', '净化车间', '洁净室', '洁净厂房', '实验室净化', 'GMP车间'],
])

const PROJECT_INTENT_GROUPS = Object.freeze([
  ['招标', '采购', '询价', '征集'],
  ['建设项目', '改造工程', '施工项目', '工程承包'],
  ['采购意向', '资格预审', '竞争性磋商', '公开招标'],
  ['项目备案', '项目核准', '环评公示', '施工许可'],
  ['拟建项目', '投资推介', '招商项目', '机会清单'],
  ['扩建', '新建', '技改', '提升改造', '配套工程'],
])

const REGION_QUERY_GROUPS = Object.freeze([
  [],
  ['河南', '山东', '河北'],
  ['江苏', '浙江', '安徽'],
  ['广东', '广西', '海南'],
  ['湖北', '湖南', '江西'],
  ['四川', '重庆', '贵州', '云南'],
  ['陕西', '山西', '甘肃', '宁夏', '青海'],
  ['辽宁', '吉林', '黑龙江', '内蒙古'],
  ['北京', '天津', '上海'],
  ['福建', '厦门'],
  ['新疆', '西藏'],
])

function queryGroup(terms) {
  return `(${terms.join(' OR ')})`
}

const DEFAULT_OPEN_WEB_QUERIES = Object.freeze(INDUSTRY_QUERY_GROUPS.flatMap((industryTerms) =>
  PROJECT_INTENT_GROUPS.flatMap((intentTerms) => REGION_QUERY_GROUPS.map((regionTerms) =>
    [queryGroup(industryTerms), queryGroup(intentTerms), regionTerms.length ? queryGroup(regionTerms) : ''].filter(Boolean).join(' ')))))

const REGION_RE = /(北京|上海|天津|重庆|河北|河南|山东|山西|陕西|江苏|浙江|安徽|福建|江西|湖北|湖南|广东|广西|海南|四川|贵州|云南|辽宁|吉林|黑龙江|内蒙古|甘肃|青海|宁夏|新疆|西藏|郑州|济南|青岛|南京|苏州|杭州|宁波|合肥|福州|厦门|南昌|武汉|长沙|广州|深圳|佛山|东莞|成都|昆明|西安|太原|石家庄|沈阳|长春|哈尔滨|乌鲁木齐)/
const STAGE_RULES = [
  { stage: 'approval', terms: ['施工许可', '项目备案', '项目核准', '环评公示', '环境影响评价', '拟审批'] },
  { stage: 'promotion', terms: ['投资推介', '招商项目', '机会清单', '拟建项目', '建设计划'] },
  { stage: 'prequalification', terms: ['资格预审', '征集公告', '采购意向'] },
]

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function providerInfo(provider) {
  return PROVIDERS[String(provider || '').toLowerCase()] || PROVIDERS.off
}

function validateSearxngEndpoint(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch (error) { throw new Error('SearXNG 地址无效') }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('SearXNG 只允许 HTTPS，或本机 localhost/127.0.0.1 HTTP 地址')
  }
  if (url.username || url.password) throw new Error('SearXNG 地址不能包含账号密码')
  url.hash = ''
  url.search = ''
  if (!/\/search\/?$/i.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`
  return url.href
}

function safeResultUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1'
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(host)) return ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|spm|from|source|src|timestamp|_t|track(?:ing)?_?id)$/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.href
  } catch (error) { return '' }
}

function normalizePublishedAt(value, nowMs = Date.now()) {
  const text = cleanText(value)
  if (!text) return ''
  const absolute = text.match(/(20[0-9]{2})[-/.年]([0-9]{1,2})[-/.月]([0-9]{1,2})/)
  if (absolute) return `${absolute[1]}-${String(absolute[2]).padStart(2, '0')}-${String(absolute[3]).padStart(2, '0')}`
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  const relative = text.match(/([0-9]{1,3})\s*(minute|hour|day|week|month)s?\s+ago/i)
  if (!relative) return ''
  const units = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 }
  return new Date(Number(nowMs) - Number(relative[1]) * units[relative[2].toLowerCase()]).toISOString().slice(0, 10)
}

function inferProjectStage(text) {
  const compact = cleanText(text)
  const matched = STAGE_RULES.find((rule) => rule.terms.some((term) => compact.includes(term)))
  return matched ? matched.stage : 'tender'
}

function normalizeResult(row, provider, nowMs = Date.now()) {
  const title = cleanText(row && (row.title || row.name))
  const url = safeResultUrl(row && (row.url || row.link))
  if (!title || title.length < 4 || !url) return null
  const snippet = cleanText(row && (row.description || row.content || row.snippet || row.text)).slice(0, 3000)
  const publishedAt = normalizePublishedAt(row && (row.page_age || row.age || row.publishedDate || row.published_at), nowMs)
  const combined = `${title} ${snippet}`
  const regionMatch = combined.match(REGION_RE)
  const host = new URL(url).hostname
  return {
    title: title.slice(0, 500),
    url,
    publishedAt,
    region: regionMatch ? regionMatch[1] : '',
    buyer: '',
    listText: combined.slice(0, 3500),
    detailText: [`通用网页搜索公开摘要`, `搜索提供方：${providerInfo(provider).name}`, `来源域名：${host}`,
      `标题：${title}`, publishedAt && `搜索结果日期：${publishedAt}`, snippet && `摘要：${snippet}`].filter(Boolean).join('\n'),
    projectStage: inferProjectStage(combined),
  }
}

function parseBraveResponse(payload, nowMs = Date.now()) {
  const rows = payload && payload.web && Array.isArray(payload.web.results) ? payload.web.results : []
  return rows.map((row) => normalizeResult(row, 'brave', nowMs)).filter(Boolean)
}

function parseSearxngResponse(payload, nowMs = Date.now()) {
  const rows = payload && Array.isArray(payload.results) ? payload.results : []
  return rows.map((row) => normalizeResult(row, 'searxng', nowMs)).filter(Boolean)
}

async function readJsonResponse(response) {
  if (!response || !response.ok) throw new Error(`HTTP ${response && response.status || 0}`)
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length') || 0)
  if (declared > 2 * 1024 * 1024) throw new Error('搜索响应超过 2MB，已停止读取')
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) throw new Error('搜索响应超过 2MB，已停止读取')
  try { return JSON.parse(text) } catch (error) { throw new Error('搜索服务没有返回有效 JSON') }
}

async function fetchSearchQuery(options, query) {
  const provider = providerInfo(options.provider)
  const count = Math.max(1, Math.min(20, Number(options.resultsPerQuery) || 10))
  let url
  const headers = { Accept: 'application/json' }
  if (provider.id === 'brave') {
    if (!String(options.apiKey || '').trim()) throw new Error('Brave Search API 尚未配置密钥')
    url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(count))
    url.searchParams.set('country', 'CN')
    url.searchParams.set('search_lang', 'zh-hans')
    url.searchParams.set('freshness', 'pm')
    url.searchParams.set('safesearch', 'moderate')
    headers['X-Subscription-Token'] = String(options.apiKey).trim()
  } else if (provider.id === 'searxng') {
    url = new URL(validateSearxngEndpoint(options.endpoint))
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('language', 'zh-CN')
    url.searchParams.set('time_range', 'month')
    url.searchParams.set('safesearch', '1')
  } else {
    throw new Error('通用网页搜索尚未启用')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  try {
    const response = await options.fetchImpl(url.href, { method: 'GET', redirect: 'follow', signal: controller.signal, headers })
    const finalUrl = new URL(response.url || url.href)
    if (finalUrl.origin !== url.origin) throw new Error('搜索服务跳转到其他站点，已停止读取')
    const payload = await readJsonResponse(response)
    return provider.id === 'brave' ? parseBraveResponse(payload, options.nowMs) : parseSearxngResponse(payload, options.nowMs)
  } finally {
    clearTimeout(timer)
  }
}

async function searchOpenWeb(options = {}) {
  if (typeof options.fetchImpl !== 'function') throw new Error('通用网页搜索缺少网络实现')
  const queries = (Array.isArray(options.queries) && options.queries.length ? options.queries : DEFAULT_OPEN_WEB_QUERIES)
    .map(cleanText).filter(Boolean).slice(0, Math.max(1, Math.min(20, Number(options.queryLimit) || 6)))
  const seen = new Set()
  const results = []
  const errors = []
  let scanned = 0
  for (const query of queries) {
    try {
      const rows = await fetchSearchQuery(options, query)
      scanned += rows.length
      for (const row of rows) {
        if (seen.has(row.url)) continue
        seen.add(row.url)
        results.push(row)
      }
    } catch (error) {
      errors.push({ query, message: String(error && error.message || error).slice(0, 300) })
    }
    if (options.requestDelayMs) await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(options.requestDelayMs))))
  }
  if (errors.length === queries.length) throw new Error(errors[0] && errors[0].message || '通用网页搜索全部失败')
  return { queryCount: queries.length, scanned, results, errors }
}

module.exports = {
  PROVIDERS,
  INDUSTRY_QUERY_GROUPS,
  PROJECT_INTENT_GROUPS,
  REGION_QUERY_GROUPS,
  DEFAULT_OPEN_WEB_QUERIES,
  providerInfo,
  validateSearxngEndpoint,
  safeResultUrl,
  normalizePublishedAt,
  normalizeResult,
  parseBraveResponse,
  parseSearxngResponse,
  fetchSearchQuery,
  searchOpenWeb,
}
