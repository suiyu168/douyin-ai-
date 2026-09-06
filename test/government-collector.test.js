'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LeadRadar } = require('../app/server/lead-radar')
const { GovernmentCollector, CCGP_SOURCES, DEFAULT_ACTIVE_SOURCES, PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS, PUBLIC_ORGANIZATION_PROJECT_SOURCES, EARLY_STAGE_PROJECT_SOURCES, parseCcgpList, parseCcgpSearchList, parseGgzyHomeList, parseCcgpDetail, ccgpPageUrl, ccgpSearchUrl, isOpenOpportunityTitle, isEngineeringOpportunity, canonicalizeOfficialUrl, computeDetailRetryDelayMs, parseDateTimestamp, parseDeadlineTimestamp, classifyProjectFreshness } = require('../app/server/government-collector')
const { parseOfficialPlatformPage, discoverOfficialListPages, parseBeijingPromotionJson, parseGuangdongPromotionJson, parseGuangxiPromotionList } = require('../app/server/project-sources/official-platform-adapter')
const { DEFAULT_OPEN_WEB_QUERIES, validateSearxngEndpoint, safeResultUrl, parseBraveResponse, parseSearxngResponse, searchOpenWeb } = require('../app/server/project-sources/web-search-adapter')

const LOCAL_LIST = `<!doctype html><html><body><ul>
  <li><a href="./gkzb/202608/t20260827_10001.htm">郑州高新区标准厂房环氧地坪工程采购公告</a>
    <span>公开招标</span><span>发布时间： 2026-08-27 10:20</span><span>地域： 河南</span><span>采购人： 郑州高新区管委会</span></li>
  <li><a href="./qtgg/202608/t20260827_10002.htm">某学校地坪项目中标结果公告</a>
    <span>发布时间： 2026-08-27 10:10</span><span>地域： 北京</span><span>采购人： 某学校</span></li>
</ul></body></html>`

const CENTRAL_LIST = `<!doctype html><html><body><ul>
  <li><a href="./jzxcs/202608/t20260827_20001.htm">农产品冷库提升及配套设备竞争性磋商公告</a>
    <span>发布时间： 2026-08-27 09:20</span><span>地域： 山东</span><span>采购人： 某县农业农村局</span></li>
</ul></body></html>`

const FLOOR_DETAIL = `<!doctype html><html><head><meta name="ArticleTitle" content="郑州高新区标准厂房环氧地坪工程采购公告"><meta name="PubDate" content="2026-08-27"></head>
<body><div class="vF_detail_content"><h1>郑州高新区标准厂房环氧地坪工程采购公告</h1><p>项目编号：ZZGX-2026-001</p><p>建设地点：郑州市高新区科学大道100号。</p><p>建设内容为厂房环氧地坪施工，预算金额80万元。</p><p>投标截止时间：2026年9月5日 09:30。</p><p>采购人信息 名称：郑州高新区管委会</p><p>采购代理机构：河南示例招标有限公司。</p><p>项目联系人：张工；联系电话：0371-12345678；邮箱：project@example.com</p></div></body></html>`

const COLD_DETAIL = `<!doctype html><html><head><meta name="ArticleTitle" content="农产品冷库提升及配套设备竞争性磋商公告"></head>
<body><div class="vF_detail_content"><h1>农产品冷库提升及配套设备竞争性磋商公告</h1><p>建设果蔬保鲜冷库并安装制冷机组。</p><p>采购单位：某县农业农村局，项目联系电话 13800138000。</p></div></body></html>`

const SEARCH_LIST = `<!doctype html><div class="vT-srch-result-list-bid"><ul><li>
  <a href="http://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260827_40001.htm">产业园净化车间改造公开招标公告</a>
  <span>2026.08.27 | 河南省 | 采购人：某产业园 | 公开招标公告</span>
</li></ul></div>`

function mockResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => body }
}

test('解析中国政府采购网列表和正文', () => {
  const list = parseCcgpList(LOCAL_LIST, 'https://www.ccgp.gov.cn/cggg/dfgg/')
  assert.equal(list.length, 2)
  assert.equal(list[0].region, '河南')
  assert.equal(list[0].buyer, '郑州高新区管委会')
  assert.equal(list[0].url, 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260827_10001.htm')
  const detail = parseCcgpDetail(FLOOR_DETAIL, list[0])
  assert.match(detail.body, /环氧地坪施工/)
  assert.equal(detail.title, '郑州高新区标准厂房环氧地坪工程采购公告')
  assert.equal(detail.budget, '80万元')
  assert.equal(detail.deadline, '2026年9月5日 09:30')
  assert.equal(detail.projectCode, 'ZZGX-2026-001')
  assert.equal(detail.projectAddress, '郑州市高新区科学大道100号')
  assert.equal(detail.agency, '河南示例招标有限公司')
  assert.equal(detail.contactName, '张工')
  assert.equal(detail.contactPhone, '0371-12345678')
  assert.equal(detail.contactEmail, 'project@example.com')
  assert.equal(ccgpPageUrl('https://www.ccgp.gov.cn/cggg/dfgg/', 2), 'https://www.ccgp.gov.cn/cggg/dfgg/index_2.htm')
  assert.equal(isOpenOpportunityTitle('产业园改造项目竞争性磋商公告'), true)
  assert.equal(isOpenOpportunityTitle('产业园改造项目中标结果公告'), false)
})

test('规范解析项目日期并按截止时间和阶段分层', () => {
  const now = Date.parse('2026-08-29T12:00:00+08:00')
  assert.equal(parseDateTimestamp('发布时间：2026年8月29日'), Math.floor(Date.parse('2026-08-29T00:00:00+08:00') / 1000))
  assert.equal(parseDateTimestamp('2026-08-29T09:30:00+08:00'), Math.floor(Date.parse('2026-08-29T09:30:00+08:00') / 1000))
  assert.equal(parseDateTimestamp('推介时间：2026年8月'), Math.floor(Date.parse('2026-08-01T00:00:00+08:00') / 1000))
  assert.equal(parseDeadlineTimestamp('投标截止：2026年9月5日09点30分'), Math.floor(Date.parse('2026-09-05T09:30:00+08:00') / 1000))
  assert.equal(classifyProjectFreshness({ publishedAt: '2026-08-20', deadline: '2026-09-02 09:30', projectStage: 'tender' }, now).opportunityStatus, 'deadline_soon')
  assert.equal(classifyProjectFreshness({ publishedAt: '2026-06-01', projectStage: 'tender' }, now).opportunityStatus, 'stale')
  assert.equal(classifyProjectFreshness({ publishedAt: '2026-04-01', projectStage: 'approval' }, now).opportunityStatus, 'active')
  assert.equal(classifyProjectFreshness({ publishedAt: '2026-01-01', projectStage: 'promotion' }, now).opportunityStatus, 'stale')
  assert.equal(classifyProjectFreshness({ publishedAt: '2026-08-20', deadline: '2026-08-28 18:00', projectStage: 'tender' }, now).opportunityStatus, 'deadline_passed')
})

test('解析官方关键词搜索结果并强制详情使用 HTTPS', () => {
  const rows = parseCcgpSearchList(SEARCH_LIST)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].url, 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260827_40001.htm')
  assert.equal(rows[0].publishedAt, '2026-08-27')
  assert.equal(rows[0].region, '河南省')
  assert.match(rows[0].buyer, /某产业园/)
  const url = new URL(ccgpSearchUrl('净化车间', 2, new Date('2026-08-28T00:00:00Z')))
  assert.equal(url.hostname, 'search.ccgp.gov.cn')
  assert.equal(url.searchParams.get('page_index'), '2')
  assert.equal(url.searchParams.get('kw'), '净化车间')
})

test('扩展后的关键词搜索来源低频读取且覆盖主要工程类目', () => {
  const { CCGP_SEARCH_SOURCES } = require('../app/server/government-collector')
  assert.ok(CCGP_SEARCH_SOURCES.length >= 25)
  assert.ok(CCGP_SEARCH_SOURCES.every((source) => source.type === 'search' && source.maxPages === 2))
})

test('解析全国公共资源交易平台公开首页工程公告', () => {
  const html = '<ul><li><a href="/information/deal/html/a/410000/0101/20260829/demo.html">产业园厂房净化车间改造工程招标公告</a><span>2026-08-29</span></li></ul>'
  const rows = parseGgzyHomeList(html)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].publishedAt, '2026-08-29')
  assert.match(rows[0].url, /^https:\/\/www\.ggzy\.gov\.cn\/information\/deal\/html\/a\//)
  assert.equal(isEngineeringOpportunity(rows[0].title), true)
  assert.equal(isEngineeringOpportunity('办公用品采购公告'), false)
  assert.equal(isEngineeringOpportunity('地坪清洁剂采购公告'), false)
  assert.equal(isEngineeringOpportunity('厂房地坪施工工程招标公告'), true)
})

test('全国省级官方源完整注册并能自动发现公告栏目', () => {
  assert.equal(PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS.length, 32)
  assert.ok(DEFAULT_ACTIVE_SOURCES.length >= 100)
  assert.ok(PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS.every((source) => source.type === 'province-home' && source.allowedHosts.length === 1))
  const source = PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS.find((item) => item.region === '河南')
  const html = `<!doctype html><nav><a href="/jyxx/gcjs/">工程建设</a></nav><ul>
    <li><a href="/jyxx/gcjs/demo.html">产业园标准厂房扩建工程招标公告</a><span>2026-08-29</span></li>
    <li><a href="https://example.com/bad.html">外站工程公告</a></li></ul>`
  const routes = discoverOfficialListPages(html, source)
  const notices = parseOfficialPlatformPage(html, source)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].url, new URL('/jyxx/gcjs/', source.baseUrl).href)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].region, '河南')
  assert.match(notices[0].url, /demo\.html$/)
  const seeded = PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS.filter((item) => item.seedUrls.length)
  assert.ok(seeded.length >= 5)
  assert.ok(seeded.every((item) => item.seedUrls.every((seed) => new URL(seed.url).hostname === item.allowedHosts[0])))
})

test('企业和建设单位公开采购源完整注册并复用同域公告解析器', () => {
  assert.equal(PUBLIC_ORGANIZATION_PROJECT_SOURCES.length, 6)
  assert.ok(PUBLIC_ORGANIZATION_PROJECT_SOURCES.every((source) => source.type === 'organization-home'))
  assert.ok(PUBLIC_ORGANIZATION_PROJECT_SOURCES.every((source) => new URL(source.baseUrl).protocol === 'https:'))
  assert.ok(PUBLIC_ORGANIZATION_PROJECT_SOURCES.every((source) => source.seedUrls.every((seed) => source.allowedHosts.includes(new URL(seed.url).hostname))))
  assert.ok(PUBLIC_ORGANIZATION_PROJECT_SOURCES.every((source) => DEFAULT_ACTIVE_SOURCES.some((active) => active.id === source.id)))
  const source = PUBLIC_ORGANIZATION_PROJECT_SOURCES.find((item) => item.id === 'public-web-sdic')
  const html = `<ul><li><a href="/cgxx/ggList/detail/demo.html">产业园无尘车间净化改造工程公开招标公告</a><span>2026-08-29</span></li></ul>`
  const notices = parseOfficialPlatformPage(html, source)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].publishedAt, '2026-08-29')
  assert.equal(new URL(notices[0].url).hostname, 'www.sdicc.com.cn')
  const sdicRows = parseOfficialPlatformPage(`<table><tr onclick="urlChange('ed5dda00-d14a-4517-8dee-99e96e14987e','c174e660-b625-47ef-aba5-9fd64485874d')">
    <td>1</td><td>厂房地坪改造工程公开招标公告</td><td>工程</td><td>2026-08-29</td></tr></table>`, source)
  assert.equal(sdicRows.length, 1)
  assert.equal(new URL(sdicRows[0].url).searchParams.get('ggGuid'), 'ed5dda00-d14a-4517-8dee-99e96e14987e')
  assert.equal(sdicRows[0].publishedAt, '2026-08-29')
  const nestedSource = PUBLIC_ORGANIZATION_PROJECT_SOURCES.find((item) => item.id === 'public-web-chinasalt')
  const nestedBase = nestedSource.seedUrls.find((seed) => /001001/.test(seed.url)).url
  const nested = parseOfficialPlatformPage('<a href="./20260829/demo.html">厂房冷库改造工程招标公告</a>', { ...nestedSource, baseUrl: nestedBase })
  assert.equal(nested[0].url, 'https://ecp.chinasalt.com.cn/zbcg/001001/20260829/demo.html')
})

test('通用搜索适配器规范化 Brave 和 SearXNG 结果并拒绝内网链接', async () => {
  assert.equal(DEFAULT_OPEN_WEB_QUERIES.length, 330)
  assert.equal(new Set(DEFAULT_OPEN_WEB_QUERIES).size, 330)
  const brave = parseBraveResponse({ web: { results: [{
    title: '郑州产业园环氧地坪改造工程招标公告',
    url: 'https://projects.example.com/tender/1?utm_source=search',
    description: '河南郑州标准厂房地坪施工，项目正在采购。',
    page_age: '2026-08-29T08:00:00+08:00',
  }] } }, Date.parse('2026-08-29T12:00:00+08:00'))
  assert.equal(brave.length, 1)
  assert.equal(brave[0].publishedAt, '2026-08-29')
  assert.equal(brave[0].region, '郑州')
  assert.equal(brave[0].url, 'https://projects.example.com/tender/1')
  assert.equal(safeResultUrl('http://127.0.0.1/admin'), '')
  assert.equal(safeResultUrl('https://192.168.1.10/private'), '')

  const searx = parseSearxngResponse({ results: [{
    title: '冷链物流园冷库建设项目采购公告',
    url: 'https://news.example.cn/project/2',
    content: '冷库与制冷工程施工单位采购',
    publishedDate: '2026-08-28',
  }] })
  assert.equal(searx.length, 1)
  assert.equal(searx[0].publishedAt, '2026-08-28')
  assert.equal(validateSearxngEndpoint('https://search.example.com/'), 'https://search.example.com/search')
  assert.equal(validateSearxngEndpoint('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/search')
  assert.throws(() => validateSearxngEndpoint('http://search.example.com/'), /只允许 HTTPS/)

  const requests = []
  const result = await searchOpenWeb({
    provider: 'brave', apiKey: 'test-secret', queries: ['地坪 工程 招标'], queryLimit: 1,
    resultsPerQuery: 10, requestDelayMs: 0,
    fetchImpl: async (url, options) => {
      requests.push({ url, token: options.headers['X-Subscription-Token'] })
      return mockResponse(JSON.stringify({ web: { results: [{
        title: '厂房地坪施工项目招标公告', url: 'https://public.example.cn/project/3',
        description: '公开项目摘要', age: '1 day ago',
      }] } }))
    },
  })
  assert.equal(result.results.length, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].token, 'test-secret')
  assert.match(requests[0].url, /freshness=pm/)
})

test('通用搜索结果只用摘要入库，不会自动访问任意结果网址', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-open-web-search-'))
  const radar = new LeadRadar({ dataDir })
  const requestedHosts = []
  const collector = new GovernmentCollector({
    leadRadar: radar, dataDir, requestDelayMs: 0,
    now: () => Date.parse('2026-08-29T12:00:00+08:00'),
    sources: [{ id: 'ggzy-test-empty', name: '公开平台空页', baseUrl: 'https://www.ggzy.gov.cn/', type: 'ggzy-home', maxPages: 1 }],
    fetchImpl: async (url) => {
      requestedHosts.push(new URL(url).hostname)
      if (new URL(url).hostname === 'api.search.brave.com') {
        return mockResponse(JSON.stringify({ web: { results: [{
          title: '郑州产业园环氧地坪改造工程招标公告',
          url: 'https://untrusted-result.example/project/1',
          description: '河南郑州厂房地坪施工，采购单位公开征集施工方，联系电话 13800138000。',
          page_age: '2026-08-29T08:00:00+08:00',
        }] } }))
      }
      return mockResponse('<html><body>暂无公告</body></html>')
    },
  })
  collector.updateSettings({
    pagesPerRun: 1, scanMode: 'broad', webSearchProvider: 'brave',
    webSearchApiKey: 'local-test-key', webSearchQueriesPerRun: 1, webSearchResultsPerQuery: 10,
  })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const publicSettings = collector.getSettings()
  assert.equal(publicSettings.webSearchConfigured, true)
  assert.equal(Object.hasOwn(publicSettings, 'webSearchApiKey'), false)
  const storedSettings = collector.db.prepare('SELECT web_search_api_key FROM collector_settings WHERE id = 1').get()
  assert.notEqual(storedSettings.web_search_api_key, 'local-test-key')
  assert.match(storedSettings.web_search_api_key, /^test:/)
  collector.updateSettings({ webSearchProvider: 'brave', webSearchApiKey: '' })
  assert.equal(collector.db.prepare('SELECT web_search_api_key FROM collector_settings WHERE id = 1').get().web_search_api_key,
    storedSettings.web_search_api_key)
  const probe = await collector.testWebSearch()
  assert.equal(probe.success, true)
  assert.equal(probe.matched, 1)
  assert.equal(collector.getSettings().webSearchQueryCursor, 0)
  collector.saveDiscoveredCandidates([{
    sourceId: 'open-web-search', sourceName: '通用网页搜索', title: '冷库改造工程招标公告',
    url: 'https://never-fetch.example/project/missing-snapshot', publishedAt: '2026-08-29',
    projectStage: 'tender', detailText: '',
  }])
  const run = await collector.runNow()
  assert.equal(run.imported, 1)
  assert.equal(collector.getSettings().webSearchQueryCursor, 1)
  assert.equal(requestedHosts.includes('untrusted-result.example'), false)
  assert.deepEqual(new Set(requestedHosts), new Set(['api.search.brave.com', 'www.ggzy.gov.cn']))
  const guarded = collector.db.prepare('SELECT status, error FROM collector_items WHERE url = ?')
    .get('https://never-fetch.example/project/missing-snapshot')
  assert.equal(guarded.status, 'error')
  assert.match(guarded.error, /禁止自动访问陌生结果网址/)
  const lead = radar.list({ limit: 10 }).list[0]
  assert.equal(lead.source_type, 'web_project')
  assert.equal(lead.contact, '13800138000')
})

test('无需验证码的官方投资推介源生成可持久化早期项目快照', () => {
  assert.equal(EARLY_STAGE_PROJECT_SOURCES.length, 3)
  const beijing = EARLY_STAGE_PROJECT_SOURCES.find((source) => source.type === 'beijing-promotion-api')
  const beijingRows = parseBeijingPromotionJson(JSON.stringify({ page: { list: [{
    PROJECT_NAME: '经开区洁净厂房提升项目', PROJECT_CODE: 'BJ-001', NATION_PROJECT_CODE: '2608-110000-04-01-000001',
    SITE_BELONGING: '经开区', INDUSTRY: '高技术', ITEM_PROGRESS: '前期', TOTAL_INVSTMT: '12000',
    INSTRUCTION: '建设电子洁净厂房和无尘车间', CONTACT: '张工', XMLXRDH: '13800138000', PROMOTION_TIME: '2026年8月',
  }] } }), beijing)
  assert.equal(beijingRows.length, 1)
  assert.equal(beijingRows[0].projectStage, 'promotion')
  assert.match(beijingRows[0].detailText, /13800138000/)
  assert.equal(new URL(beijingRows[0].url).searchParams.get('projectCode'), '2608-110000-04-01-000001')

  const guangdong = EARLY_STAGE_PROJECT_SOURCES.find((source) => source.type === 'guangdong-promotion-api')
  const guangdongRows = parseGuangdongPromotionJson(JSON.stringify({ data: { list: [{
    projectName: '冷链物流园建设项目', projectCode: 'GD-001', projectId: 'project-1', admdivName: '佛山市',
    theIndustryName: '仓储物流', totalMoney: 8000, contactName: '李工', promotionTime: '2026/08/20 10:00:00',
  }] } }), guangdong)
  assert.equal(guangdongRows.length, 1)
  assert.match(guangdongRows[0].detailText, /8000万元/)

  const guangxi = EARLY_STAGE_PROJECT_SOURCES.find((source) => source.type === 'guangxi-promotion-list')
  const guangxiRows = parseGuangxiPromotionList(`<table><tr><td>2026-08-20</td><td>产业园标准厂房改造项目</td>
    <td>GX-001</td><td>备案</td><td>城建</td><td>6000.0000</td><td><input value="详情"></td></tr></table>`, guangxi)
  assert.equal(guangxiRows.length, 1)
  assert.equal(guangxiRows[0].projectCode, 'GX-001')
  assert.match(guangxiRows[0].detailText, /民间资本推介/)
})

test('早期项目公开接口快照无需二次详情请求即可入库', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-early-project-'))
  const radar = new LeadRadar({ dataDir })
  const source = EARLY_STAGE_PROJECT_SOURCES.find((item) => item.type === 'beijing-promotion-api')
  let requests = 0
  const body = JSON.stringify({ page: { list: [{
    PROJECT_NAME: '经开区电子洁净厂房提升项目', PROJECT_CODE: 'BJ-002', NATION_PROJECT_CODE: '2608-110000-04-01-000002',
    SITE_BELONGING: '经开区', INDUSTRY: '高技术', ITEM_PROGRESS: '前期', TOTAL_INVSTMT: '15000',
    INSTRUCTION: '新建电子洁净厂房、净化空调和无尘车间', CONTACT: '王工', XMLXRDH: '13800138001', PROMOTION_TIME: '2026年8月',
  }] } })
  const collector = new GovernmentCollector({
    leadRadar: radar, dataDir, requestDelayMs: 0, sources: [source],
    fetchImpl: async (url, options) => {
      requests++
      assert.equal(options.method, 'POST')
      assert.match(String(options.body), /recommendType=unfinished/)
      return mockResponse(body)
    },
  })
  collector.updateSettings({ pagesPerRun: 1, scanMode: 'broad' })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const result = await collector.runNow()
  assert.equal(requests, 1)
  assert.equal(result.imported, 1)
  const item = collector.listItems().list[0]
  assert.equal(item.project_stage, 'promotion')
  assert.match(item.snapshot_text, /13800138001/)
  assert.equal(radar.list({ limit: 10 }).list[0].source_type, 'approval')
})

test('长列表扫描开始前优先把已发现项目增量入库', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-detail-first-'))
  const radar = new LeadRadar({ dataDir })
  let importedBeforeListFetch = false
  const collector = new GovernmentCollector({
    leadRadar: radar, dataDir, requestDelayMs: 0, maxDetailsPerRun: 10,
    now: () => Date.parse('2026-08-29T12:00:00+08:00'),
    sources: [{ id: 'ggzy-empty-after-backlog', name: '空列表', baseUrl: 'https://www.ggzy.gov.cn/', type: 'ggzy-home', maxPages: 1 }],
    fetchImpl: async () => {
      importedBeforeListFetch = radar.list({ limit: 10 }).list.some((item) => /冷库改造/.test(item.account_name))
      return mockResponse('<html><body>暂无项目</body></html>')
    },
  })
  collector.saveDiscoveredCandidates([{
    sourceId: 'early-backlog', sourceName: '已发现公开项目', title: '产业园冷库改造工程采购公告',
    url: 'https://example.com/public-project/backlog-1', publishedAt: '2026-08-29', projectStage: 'tender',
    detailText: '产业园冷库改造工程，建设保鲜库并安装制冷机组。项目联系电话 13800138000。',
  }])
  collector.updateSettings({ pagesPerRun: 1, scanMode: 'broad' })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const result = await collector.runNow()
  assert.equal(importedBeforeListFetch, true)
  assert.equal(result.imported, 1)
  assert.equal(radar.list({ limit: 10 }).list[0].contact, '13800138000')
})

test('省级源连续失败后退避，健康源保持正常轮询', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-backoff-'))
  const radar = new LeadRadar({ dataDir })
  const collector = new GovernmentCollector({ leadRadar: radar, dataDir, requestDelayMs: 0, sources: [] })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  collector.updateSourceHealth('province-demo', { success: false, error: 'HTTP 503' })
  assert.equal(collector.getSourceBackoff('province-demo').status, 'error')
  collector.updateSourceHealth('province-demo', { success: false, error: 'HTTP 503' })
  collector.updateSourceHealth('province-demo', { success: false, error: 'HTTP 503' })
  assert.equal(collector.getSourceBackoff('province-demo').status, 'degraded')
  collector.updateSourceHealth('province-demo', { success: true, items: 2 })
  assert.equal(collector.getSourceBackoff('province-demo'), null)
})

test('同一省份部分路由失败会显示降级但不阻塞健康路由', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-route-health-'))
  const radar = new LeadRadar({ dataDir })
  const collector = new GovernmentCollector({ leadRadar: radar, dataDir, requestDelayMs: 0, sources: [] })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  collector.updateRouteHealth('province-demo', 'https://example.gov.cn/home', { success: true, items: 2 })
  collector.updateRouteHealth('province-demo', 'https://example.gov.cn/broken', { success: false, error: 'HTTP 503' })
  collector.updateSourceHealth('province-demo', { success: true, items: 2, error: 'HTTP 503' })
  const source = collector.db.prepare('SELECT status, consecutive_failures, last_error FROM source_health WHERE source_id = ?').get('province-demo')
  assert.equal(source.status, 'degraded')
  assert.equal(source.consecutive_failures, 0)
  assert.match(source.last_error, /503/)
  assert.equal(collector.getSourceBackoff('province-demo'), null)
  const routes = collector.db.prepare('SELECT status FROM source_route_health WHERE source_id = ? ORDER BY url').all('province-demo')
  assert.deepEqual(new Set(routes.map((row) => row.status)), new Set(['healthy', 'error']))
})

test('官方公告 URL 去除跟踪参数且分类页按游标滚动回扫历史', (t) => {
  assert.equal(canonicalizeOfficialUrl('https://www.ccgp.gov.cn/a?id=7&utm_source=x&from=list#top'), 'https://www.ccgp.gov.cn/a?id=7')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-cursor-'))
  const radar = new LeadRadar({ dataDir })
  const collector = new GovernmentCollector({ leadRadar: radar, dataDir, requestDelayMs: 0, sources: CCGP_SOURCES })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const source = CCGP_SOURCES[0]
  const first = collector.buildPagePlan(source, 3)
  assert.deepEqual(first.pages, [0, 1, 2])
  collector.setSourceBackfillCursor(source.id, first.nextCursor)
  assert.deepEqual(collector.buildPagePlan(source, 3).pages, [0, 3, 4])
})

test('政府采购栏目历史页遇到 404 后立即停止并重置回扫游标', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-cursor-end-'))
  const radar = new LeadRadar({ dataDir })
  const source = CCGP_SOURCES[0]
  const requested = []
  const collector = new GovernmentCollector({
    leadRadar: radar,
    dataDir,
    requestDelayMs: 0,
    sources: [source],
    fetchImpl: async (url) => {
      requested.push(url)
      if (url.endsWith('/index.htm')) return mockResponse('<html><body><ul></ul></body></html>')
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    },
  })
  collector.updateSettings({ pagesPerRun: 3 })
  collector.setSourceBackfillCursor(source.id, 25)
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const result = await collector.runNow()
  assert.equal(result.errors, 0)
  assert.equal(requested.length, 2)
  assert.match(requested[1], /index_25\.htm$/)
  assert.equal(collector.getSourceBackfillCursor(source.id), 1)
  const endpoint = collector.db.prepare('SELECT status, last_error FROM source_route_health WHERE source_id = ? AND url = ?')
    .get(source.id, requested[1])
  assert.equal(endpoint.status, 'empty')
  assert.equal(endpoint.last_error, '')
})

test('关键词搜索每轮固定读取第一页并轮转历史页', (t) => {
  const { CCGP_SEARCH_SOURCES } = require('../app/server/government-collector')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-search-cursor-'))
  const radar = new LeadRadar({ dataDir })
  const source = CCGP_SEARCH_SOURCES[0]
  const collector = new GovernmentCollector({ leadRadar: radar, dataDir, requestDelayMs: 0, sources: [source] })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const first = collector.buildPagePlan(source, 2)
  assert.deepEqual(first.pages, [1, 2])
  collector.setSourceBackfillCursor(source.id, first.nextCursor)
  assert.deepEqual(collector.buildPagePlan(source, 2).pages, [1, 3])
  assert.equal(new URL(ccgpSearchUrl(source.keyword, first.pages[0])).searchParams.get('page_index'), '1')
})

test('低频扫描公开公告并自动分类入库', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-collector-'))
  const radar = new LeadRadar({ dataDir })
  const bodies = new Map([
    ['https://www.ccgp.gov.cn/cggg/dfgg/index.htm', LOCAL_LIST],
    ['https://www.ccgp.gov.cn/cggg/zygg/index.htm', CENTRAL_LIST],
    ['https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260827_10001.htm', FLOOR_DETAIL],
    ['https://www.ccgp.gov.cn/cggg/zygg/jzxcs/202608/t20260827_20001.htm', COLD_DETAIL],
  ])
  const collector = new GovernmentCollector({
    leadRadar: radar,
    dataDir,
    requestDelayMs: 0,
    sources: CCGP_SOURCES,
    now: () => Date.parse('2026-08-29T12:00:00+08:00'),
    fetchImpl: async (url) => {
      if (!bodies.has(url)) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
      return mockResponse(bodies.get(url))
    },
  })
  collector.updateSettings({ pagesPerRun: 1, intervalHours: 12, focusRegions: ['河南', '山东'], scanMode: 'focused' })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const first = await collector.runNow()
  assert.equal(first.pages, 2)
  assert.equal(first.scanned, 3)
  assert.equal(first.candidates, 2)
  assert.equal(first.imported, 2)
  assert.equal(radar.getOverview().total, 2)
  assert.equal(radar.list({ industry: 'flooring' }).total, 1)
  assert.equal(radar.list({ industry: 'cold_storage' }).total, 1)
  assert.equal(collector.listItems({ status: 'imported' }).list.length, 2)

  const second = await collector.runNow()
  assert.equal(second.imported, 0)
  assert.equal(second.candidates, 0)
  assert.equal(second.duplicates, 0)
  assert.equal(collector.listRuns().list.length, 2)
})

test('长任务在后续来源中断时已完成来源的候选仍已增量落盘', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-source-checkpoint-'))
  const radar = new LeadRadar({ dataDir })
  const collector = new GovernmentCollector({
    leadRadar: radar,
    dataDir,
    requestDelayMs: 0,
    sources: CCGP_SOURCES,
    fetchImpl: async (url) => {
      if (url === 'https://www.ccgp.gov.cn/cggg/dfgg/index.htm') return mockResponse(LOCAL_LIST)
      if (url === 'https://www.ccgp.gov.cn/cggg/zygg/index.htm') return mockResponse('<ul></ul>')
      throw new Error('unexpected request')
    },
  })
  collector.updateSettings({ pagesPerRun: 1 })
  const updateHealth = collector.updateSourceHealth.bind(collector)
  collector.updateSourceHealth = (sourceId, result) => {
    if (sourceId === 'ccgp-central') throw new Error('模拟后续来源中断')
    return updateHealth(sourceId, result)
  }
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  await assert.rejects(collector.runNow(), /模拟后续来源中断/)
  const stored = collector.db.prepare('SELECT status, title FROM collector_items ORDER BY id LIMIT 1').get()
  assert.equal(stored.status, 'discovered')
  assert.match(stored.title, /环氧地坪工程/)
})

test('正文预算不足时先持久化全部候选并在后续轮次继续消费', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-backlog-'))
  const radar = new LeadRadar({ dataDir })
  const source = CCGP_SOURCES[0]
  const urls = [1, 2, 3].map((id) => `https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260829_${id}.htm`)
  const listHtml = `<ul>${urls.map((url, index) => `<li><a href="${url}">厂房环氧地坪施工项目${index + 1}采购公告</a><span>发布时间： 2026-08-${29 - index} 10:00</span><span>地域： 河南</span><span>采购人： 测试单位${index + 1}</span></li>`).join('')}</ul>`
  const bodies = new Map([[source.baseUrl + 'index.htm', listHtml]])
  urls.forEach((url, index) => bodies.set(url, `<div class="vF_detail_content"><h1>厂房环氧地坪施工项目${index + 1}</h1><p>环氧地坪工程施工，联系人 1380013800${index}</p></div>`))
  const collector = new GovernmentCollector({
    leadRadar: radar,
    dataDir,
    requestDelayMs: 0,
    maxDetailsPerRun: 1,
    sources: [source],
    fetchImpl: async (url) => bodies.has(url) ? mockResponse(bodies.get(url)) : { ok: false, status: 404, headers: { get: () => null }, text: async () => '' },
  })
  collector.updateSettings({ pagesPerRun: 1, scanMode: 'focused' })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const first = await collector.runNow()
  assert.equal(first.candidates, 3)
  assert.equal(first.imported, 1)
  assert.equal(collector.listItems({ status: 'discovered' }).list.length, 2)
  const second = await collector.runNow()
  assert.equal(second.candidates, 0)
  assert.equal(second.imported, 1)
  assert.equal(collector.listItems({ status: 'discovered' }).list.length, 1)
})

test('公告正文临时失败会持久退避并在到期后恢复入库', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-detail-retry-'))
  const radar = new LeadRadar({ dataDir })
  const source = CCGP_SOURCES[0]
  const detailUrl = 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260829_retry.htm'
  const listHtml = `<ul><li><a href="${detailUrl}">产业园环氧地坪施工工程采购公告</a><span>发布时间： 2026-08-29</span><span>地域： 河南</span></li></ul>`
  let detailCalls = 0
  let currentNow = Date.parse('2026-08-29T01:00:00.000Z')
  const collector = new GovernmentCollector({
    leadRadar: radar, dataDir, requestDelayMs: 0, sources: [source], now: () => currentNow,
    detailRetryBaseMs: 30 * 60 * 1000,
    fetchImpl: async (url) => {
      if (url === source.baseUrl + 'index.htm') return mockResponse(listHtml)
      if (url === detailUrl) {
        detailCalls++
        if (detailCalls === 1) return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }
        return mockResponse('<div class="vF_detail_content"><h1>产业园环氧地坪施工工程</h1><p>环氧地坪施工，联系人13800138000</p></div>')
      }
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    },
  })
  collector.updateSettings({ pagesPerRun: 1, scanMode: 'broad' })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  await collector.runNow()
  let item = collector.listItems().list[0]
  assert.equal(item.status, 'error')
  assert.equal(item.detail_attempts, 1)
  assert.ok(item.next_retry_at)
  await collector.runNow()
  assert.equal(detailCalls, 1)
  currentNow += 31 * 60 * 1000
  await collector.runNow()
  item = collector.listItems().list[0]
  assert.equal(detailCalls, 2)
  assert.equal(item.status, 'imported')
  assert.equal(item.detail_attempts, 2)
  assert.equal(item.next_retry_at, '')
})

test('公告详情达到重试上限后停止频繁请求', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-detail-max-retry-'))
  const radar = new LeadRadar({ dataDir })
  const source = CCGP_SOURCES[0]
  const detailUrl = 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260829_retry_max.htm'
  const listHtml = `<ul><li><a href="${detailUrl}">标准厂房冷库改造工程采购公告</a><span>发布时间： 2026-08-29</span><span>地域： 山东</span></li></ul>`
  let detailCalls = 0
  let currentNow = Date.parse('2026-08-29T01:00:00.000Z')
  const collector = new GovernmentCollector({
    leadRadar: radar, dataDir, requestDelayMs: 0, sources: [source], now: () => currentNow,
    maxDetailAttempts: 2, detailRetryBaseMs: 1000,
    fetchImpl: async (url) => {
      if (url === source.baseUrl + 'index.htm') return mockResponse(listHtml)
      if (url === detailUrl) {
        detailCalls++
        return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }
      }
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    },
  })
  collector.updateSettings({ pagesPerRun: 1, scanMode: 'broad' })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  await collector.runNow()
  currentNow += 2000
  await collector.runNow()
  let item = collector.listItems().list[0]
  assert.equal(item.detail_attempts, 2)
  assert.equal(item.next_retry_at, '')
  currentNow += 24 * 60 * 60 * 1000
  await collector.runNow()
  assert.equal(detailCalls, 2)
  currentNow += 7 * 24 * 60 * 60 * 1000
  await collector.runNow()
  item = collector.listItems().list[0]
  assert.equal(detailCalls, 3)
  assert.equal(item.detail_attempts, 1)
})

test('详情重试使用有限指数退避', () => {
  assert.equal(computeDetailRetryDelayMs(1, 1000, 10000), 1000)
  assert.equal(computeDetailRetryDelayMs(2, 1000, 10000), 2000)
  assert.equal(computeDetailRetryDelayMs(5, 1000, 10000), 10000)
})

test('广泛模式读取通用项目标题并写入本地线索库', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-broad-'))
  const radar = new LeadRadar({ dataDir })
  const genericUrl = 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260827_30001.htm'
  const genericList = `<!doctype html><ul><li><a href="${genericUrl}">产业园基础设施提升项目竞争性磋商公告</a><span>发布时间： 2026-08-27 11:00</span><span>地域： 河南</span><span>采购人： 某产业园</span></li></ul>`
  const genericDetail = '<div class="vF_detail_content"><h1>产业园基础设施提升项目</h1><p>建设内容包括洁净车间及无尘净化工程，联系人13800138000，电话0371-12345678。</p></div>'
  const collector = new GovernmentCollector({
    leadRadar: radar,
    dataDir,
    requestDelayMs: 0,
    sources: CCGP_SOURCES,
    fetchImpl: async (url) => {
      if (url === 'https://www.ccgp.gov.cn/cggg/dfgg/index.htm') return mockResponse(genericList)
      if (url === 'https://www.ccgp.gov.cn/cggg/zygg/index.htm') return mockResponse('<ul></ul>')
      if (url === genericUrl) return mockResponse(genericDetail)
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    },
  })
  collector.updateSettings({ pagesPerRun: 1, scanMode: 'broad' })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const result = await collector.runNow()
  assert.equal(result.candidates, 1)
  assert.equal(result.imported, 2)
  assert.equal(radar.list({ industry: 'cleanroom' }).total, 2)
  assert.equal(collector.listItems().list[0].industry, 'cleanroom')
})

test('工程公告即使没有联系方式也保留完整项目信息', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-no-contact-'))
  const radar = new LeadRadar({ dataDir })
  const projectUrl = 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202608/t20260829_50001.htm'
  const list = `<!doctype html><ul><li><a href="${projectUrl}">产业园标准厂房扩建工程招标公告</a><span>发布时间： 2026-08-29 09:00</span><span>地域： 河南</span><span>采购人： 某产业园</span></li></ul>`
  const detail = '<div class="vF_detail_content"><h1>产业园标准厂房扩建工程招标公告</h1><p>本项目建设两栋标准厂房，采用工程总承包模式，预算金额3000万元。</p></div>'
  const collector = new GovernmentCollector({
    leadRadar: radar,
    dataDir,
    requestDelayMs: 0,
    sources: CCGP_SOURCES,
    fetchImpl: async (url) => {
      if (url === 'https://www.ccgp.gov.cn/cggg/dfgg/index.htm') return mockResponse(list)
      if (url === 'https://www.ccgp.gov.cn/cggg/zygg/index.htm') return mockResponse('<ul></ul>')
      if (url === projectUrl) return mockResponse(detail)
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    },
  })
  collector.updateSettings({ pagesPerRun: 1, scanMode: 'broad' })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const result = await collector.runNow()
  assert.equal(result.imported, 1)
  const lead = radar.list({ limit: 10 }).list[0]
  assert.equal(lead.industry, 'unknown')
  assert.equal(lead.contact_masked, '')
  const stored = radar.get(lead.id, true)
  assert.match(radar.decryptText(stored.source_text), /产业园标准厂房扩建工程/)
})

test('重新启动时标记上次中断运行并保留增量断点', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-resume-'))
  const radar = new LeadRadar({ dataDir })
  const first = new GovernmentCollector({ leadRadar: radar, dataDir, requestDelayMs: 0 })
  first.db.prepare("INSERT INTO collector_runs (trigger_type, status, started_at) VALUES ('manual', 'running', ?)").run(new Date().toISOString())
  first.close()

  const second = new GovernmentCollector({ leadRadar: radar, dataDir, requestDelayMs: 0 })
  t.after(() => {
    second.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const row = second.db.prepare('SELECT status, errors, message, finished_at FROM collector_runs ORDER BY id DESC LIMIT 1').get()
  assert.equal(row.status, 'failed')
  assert.equal(row.errors, 1)
  assert.match(row.message, /程序退出而中断/)
  assert.ok(row.finished_at)
  assert.equal(second.resumeInterrupted, true)
})

test('拒绝中国政府采购网跳转到白名单外的页面', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-gov-redirect-'))
  const radar = new LeadRadar({ dataDir })
  const collector = new GovernmentCollector({
    leadRadar: radar,
    dataDir,
    requestDelayMs: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://example.com/redirected',
      headers: { get: () => null },
      text: async () => '<html></html>',
    }),
  })
  t.after(() => {
    collector.close()
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  await assert.rejects(
    collector.fetchText('https://www.ccgp.gov.cn/cggg/dfgg/index.htm'),
    /白名单以外/
  )
})
