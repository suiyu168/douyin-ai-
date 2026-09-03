'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const INDUSTRIES = [
  {
    id: 'flooring',
    name: '地坪工程',
    keywords: ['环氧地坪', '固化地坪', '耐磨地坪', '金刚砂地坪', '聚氨酯地坪', '停车场地坪', '厂房地坪', '地坪翻新', '地坪施工'],
    demand: ['地面起砂', '求报价', '找施工队', '包工包料', '多少钱一平方', '需要做地坪'],
  },
  {
    id: 'cold_storage',
    name: '冷库工程',
    keywords: ['冷库', '冷库安装', '冷库设计', '冷库维修', '冷库建设', '保鲜库', '速冻库', '医药冷库', '果蔬冷库', '气调库', '冷藏库', '冷冻库', '恒温库', '冷链仓储', '冷链物流', '仓储保鲜', '制冷机组'],
    demand: ['建一个冷库', '冷库多少钱', '找冷库安装', '冷库不制冷', '需要维修', '求冷库厂家'],
  },
  {
    id: 'membrane',
    name: '膜结构工程',
    keywords: ['膜结构', '张拉膜', '景观膜', '膜结构停车棚', '充电桩车棚', '体育看台棚', '污水池加盖', '膜结构厂家'],
    demand: ['停车场加棚', '求膜结构厂家', '需要做车棚', '污水池加盖', '发尺寸询价', '求方案'],
  },
  {
    id: 'retractable_shed',
    name: '推拉棚/伸缩棚',
    keywords: ['推拉棚', '移动推拉棚', '伸缩棚', '活动雨棚', '移动仓库棚', '厂房推拉棚', '物流装卸棚', '电动推拉棚'],
    demand: ['厂房门口搭棚', '装卸区遮雨', '求推拉棚厂家', '报尺寸询价', '更换篷布', '旧棚维修'],
  },
  {
    id: 'cleanroom',
    name: '无尘车间/净化工程',
    keywords: ['无尘车间', '净化车间', '洁净厂房', '洁净室', '净化工程', '无菌车间', 'GMP车间', '食品净化车间', '实验室净化'],
    demand: ['建无尘车间', '厂房净化改造', '找净化工程公司', '需要通过GMP', '求预算', '几级洁净度'],
  },
]

const STATUS_LABELS = {
  new: '待审核',
  reviewed: '已审核',
  assigned: '已分配',
  following: '跟进中',
  converted: '已成交',
  rejected: '无效线索',
  opt_out: '拒绝联系',
}

const SOURCE_TYPES = {
  profile: '抖音主页', video: '抖音视频', comment: '抖音评论', live: '抖音直播',
  procurement: '政府采购', public_resource: '公共资源交易', web_project: '全网公开项目', approval: '立项/环评公示',
  subsidy: '农业冷链公示', map: '地图企业', ocr: '图片 OCR', manual: '手动整理',
}

const DISCOVERY_SOURCES = [
  { id: 'ccgp', name: '中国政府采购网', sourceType: 'procurement', official: true },
  { id: 'ggzy', name: '全国公共资源交易平台', sourceType: 'public_resource', official: true },
  { id: 'gov_projects', name: '政府立项/环评/补贴公示', sourceType: 'approval', official: true },
  { id: 'amap', name: '高德地图企业', sourceType: 'map', official: true },
  { id: 'douyin', name: '抖音公开搜索', sourceType: 'video', official: true },
]

const BUSINESS_TERMS = ['厂家', '公司', '工程', '施工', '安装', '维修', '业务', '商务', '联系', '电话', '咨询', '报价', '微信同号', '合作', '承接', '主营']
const INTENT_TERMS = ['需要', '求', '找', '询价', '报价', '多少钱', '怎么联系', '哪里有', '施工队', '厂家', '准备做', '计划建', '改造', '维修']
const REGION_RE = /(北京|上海|天津|重庆|河北|河南|山东|山西|陕西|江苏|浙江|安徽|福建|江西|湖北|湖南|广东|广西|海南|四川|贵州|云南|辽宁|吉林|黑龙江|内蒙古|甘肃|青海|宁夏|新疆|西藏|香港|澳门|台湾|郑州|济南|青岛|南京|苏州|杭州|宁波|合肥|福州|厦门|南昌|武汉|长沙|广州|深圳|佛山|东莞|成都|昆明|西安|太原|石家庄|沈阳|长春|哈尔滨|乌鲁木齐)/

function defaultDataDir() {
  if (process.env.VCAT_LEAD_DATA_DIR) return path.resolve(process.env.VCAT_LEAD_DATA_DIR)
  if (process.platform === 'win32' && fs.existsSync('D:\\')) return 'D:\\小V猫数据\\商机雷达'
  return path.join(process.cwd(), 'data', 'lead-radar')
}

function fullWidthToHalfWidth(value) {
  return String(value || '').replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ')
}

function chineseDigitsToArabic(value) {
  const map = { 零: '0', 〇: '0', 一: '1', 幺: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' }
  return String(value || '').replace(/(?:[零〇一幺二两三四五六七八九][\s·.\-]*){7,}/g, (seq) => [...seq].map((char) => map[char] || '').join(''))
}

function normalizeContact(raw) {
  let digits = fullWidthToHalfWidth(raw).replace(/\D/g, '')
  if (digits.length === 13 && digits.startsWith('86')) digits = digits.slice(2)
  return digits
}

function contactType(digits) {
  if (/^1[3-9]\d{9}$/.test(digits)) return 'mobile'
  if (/^(400|800)\d{7}$/.test(digits)) return 'service'
  if (/^0\d{9,11}$/.test(digits)) return 'landline'
  return 'other'
}

function maskContact(digits) {
  if (!digits) return ''
  if (/^1\d{10}$/.test(digits)) return digits.slice(0, 3) + '****' + digits.slice(-4)
  if (digits.length >= 8) return digits.slice(0, 3) + '****' + digits.slice(-3)
  return '*'.repeat(Math.max(3, digits.length))
}

function maskSensitiveText(value) {
  // 先把全角数字和连续中文数字统一成半角数字，再识别并替换，避免 OCR 变形号码进入明文搜索索引。
  let masked = chineseDigitsToArabic(fullWidthToHalfWidth(value))
  for (const contact of extractContacts(masked)) {
    if (contact.raw) masked = masked.split(contact.raw).join(contact.masked)
    if (contact.normalized && contact.normalized !== contact.raw) masked = masked.split(contact.normalized).join(contact.masked)
  }
  return masked
}

function extractContacts(input) {
  const text = chineseDigitsToArabic(fullWidthToHalfWidth(input))
  const patterns = [
    /(?<!\d)(?:\+?86[\s-]?)?1[3-9](?:[\s-]?\d){9}(?!\d)/g,
    /(?<!\d)(?:400|800)[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g,
    /(?<!\d)0\d{2,3}[\s-]?\d{7,8}(?!\d)/g,
  ]
  const seen = new Set()
  const result = []
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const normalized = normalizeContact(match[0])
      if (!normalized || seen.has(normalized)) continue
      const before = text.slice(Math.max(0, match.index - 24), match.index)
      if (/(订单号|项目编号|合同编号|设备编号|快递单号|统一社会信用代码|编码)\s*[:：#]?\s*$/i.test(before)) continue
      const type = contactType(normalized)
      if (type === 'other') continue
      seen.add(normalized)
      const start = Math.max(0, match.index - 36)
      const end = Math.min(text.length, match.index + match[0].length + 36)
      const context = text.slice(start, end).replace(/\s+/g, ' ').trim()
      result.push({ raw: match[0], normalized, masked: maskContact(normalized), type, context })
    }
  }
  return result
}

function inferIndustry(text, preferred) {
  if (preferred && INDUSTRIES.some((item) => item.id === preferred)) return preferred
  const content = String(text || '').toLowerCase()
  const compact = content.replace(/\s+/g, '')
  let best = { id: '', score: 0 }
  for (const industry of INDUSTRIES) {
    const score = industry.keywords.reduce((total, keyword) => total + (content.includes(keyword.toLowerCase()) || compact.includes(keyword.toLowerCase()) ? 1 : 0), 0)
    if (score > best.score) best = { id: industry.id, score }
  }
  return best.id || 'unknown'
}

function inferRegion(text, preferred) {
  if (preferred) return String(preferred).trim().slice(0, 30)
  const match = String(text || '').match(REGION_RE)
  return match ? match[1] : ''
}

function scoreLead({ text, industry, contact, sourceType }) {
  const content = String(text || '')
  const compact = content.replace(/\s+/g, '')
  const industryData = INDUSTRIES.find((item) => item.id === industry)
  const hasTerm = (word) => content.includes(word) || compact.includes(word)
  const industryHits = industryData ? industryData.keywords.filter(hasTerm).length : 0
  const businessHits = BUSINESS_TERMS.filter(hasTerm).length
  const intentHits = INTENT_TERMS.filter(hasTerm).length
  let score = Math.min(30, industryHits * 10)
  if (industry && industry !== 'unknown') score = Math.max(score, 15)
  if (contact) score += 25
  score += Math.min(20, businessHits * 5)
  score += Math.min(20, intentHits * 5)
  if (sourceType === 'profile') score += 10
  else if (sourceType === 'video') score += 6
  else if (sourceType === 'comment') score += 3
  else if (sourceType === 'procurement' || sourceType === 'public_resource' || sourceType === 'web_project') score += 18
  else if (sourceType === 'approval' || sourceType === 'subsidy') score += 15
  else if (sourceType === 'map') score += 8
  else if (sourceType === 'ocr') score += 5
  return Math.min(100, score)
}

function dateForSearch(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, ':')
}

function buildDiscoveryPlan(payload = {}) {
  const industry = INDUSTRIES.find((item) => item.id === payload.industry) || INDUSTRIES[0]
  const region = String(payload.region || '').trim().slice(0, 30)
  const intent = payload.intent === 'supplier' ? 'supplier' : 'project'
  const selected = Array.isArray(payload.sources) && payload.sources.length ? payload.sources : DISCOVERY_SOURCES.map((item) => item.id)
  const wordPool = intent === 'supplier' ? industry.keywords.map((word) => word + ' 厂家') : industry.keywords.concat(industry.demand)
  // 每天轮换 3 个词，控制任务数量，同时逐步覆盖完整关键词库。
  const dayOffset = Math.floor(Date.now() / 86400000) % wordPool.length
  const words = Array.from({ length: Math.min(3, wordPool.length) }, (_, index) => wordPool[(dayOffset + index) % wordPool.length])
  const now = new Date()
  const start = new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000)
  const tasks = []
  for (const source of DISCOVERY_SOURCES.filter((item) => selected.includes(item.id))) {
    for (const word of words) {
      const query = [region, word, intent === 'project' && source.id === 'gov_projects' ? '立项 招标 环评 公示' : ''].filter(Boolean).join(' ').trim()
      let url = ''
      if (source.id === 'ccgp') {
        const params = new URLSearchParams({ searchtype: '1', page_index: '1', bidSort: '0', pinMu: '0', bidType: '0', dbselect: 'bidx', kw: query, start_time: dateForSearch(start), end_time: dateForSearch(now), timeType: '6', displayZone: '', zoneId: '', pppStatus: '0', agentName: '' })
        url = 'https://search.ccgp.gov.cn/bxsearch?' + params.toString()
      } else if (source.id === 'ggzy') {
        url = 'https://cn.bing.com/search?q=' + encodeURIComponent('site:ggzy.gov.cn ' + query)
      } else if (source.id === 'gov_projects') {
        url = 'https://cn.bing.com/search?q=' + encodeURIComponent('site:gov.cn ' + query)
      } else if (source.id === 'amap') {
        url = 'https://www.amap.com/search?query=' + encodeURIComponent(query)
      } else if (source.id === 'douyin') {
        url = 'https://www.douyin.com/search/' + encodeURIComponent(query)
      }
      tasks.push({ source_id: source.id, source_name: source.name, source_type: source.sourceType, query, url })
    }
  }
  return tasks.slice(0, 30)
}

function csvCell(value) {
  const text = String(value == null ? '' : value)
  return '"' + text.replace(/"/g, '""') + '"'
}

class LeadRadar {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir || defaultDataDir())
    fs.mkdirSync(this.dataDir, { recursive: true })
    this.dbPath = path.resolve(options.dbPath || path.join(this.dataDir, 'lead-radar.sqlite'))
    // 正式 Electron 进程传入 Windows DPAPI(safeStorage) 适配器。
    // 默认适配器只用于独立单元测试，避免测试依赖 Electron。
    this.encryptText = options.encryptText || ((value) => value ? 'test:' + Buffer.from(String(value), 'utf8').toString('base64') : '')
    this.decryptText = options.decryptText || ((value) => {
      const text = String(value || '')
      return text.startsWith('test:') ? Buffer.from(text.slice(5), 'base64').toString('utf8') : text
    })
    this.ocr = options.ocr || null
    this.ftsAvailable = false
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.initSchema()
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL DEFAULT 'douyin',
        industry TEXT NOT NULL DEFAULT 'unknown',
        account_name TEXT NOT NULL DEFAULT '',
        douyin_id TEXT NOT NULL DEFAULT '',
        profile_url TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT NOT NULL DEFAULT '',
        source_text TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        contact_raw TEXT NOT NULL DEFAULT '',
        contact_normalized TEXT NOT NULL DEFAULT '',
        contact_masked TEXT NOT NULL DEFAULT '',
        contact_type TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        public_business INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new',
        assignee TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        opt_out INTEGER NOT NULL DEFAULT 0,
        opt_out_at TEXT NOT NULL DEFAULT '',
        source_count INTEGER NOT NULL DEFAULT 1,
        source_event_time INTEGER NOT NULL DEFAULT 0,
        project_stage TEXT NOT NULL DEFAULT '',
        project_deadline_time INTEGER NOT NULL DEFAULT 0,
        opportunity_status TEXT NOT NULL DEFAULT '',
        freshness_bucket TEXT NOT NULL DEFAULT '',
        freshness_score INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_leads_industry ON leads(industry);
      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);
      CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads(contact_normalized);
      CREATE INDEX IF NOT EXISTS idx_leads_source_url ON leads(source_url);
      CREATE TABLE IF NOT EXISTS lead_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        industry TEXT NOT NULL DEFAULT 'unknown',
        account_name TEXT NOT NULL DEFAULT '',
        profile_url TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT NOT NULL DEFAULT '',
        source_text TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        source_event_time INTEGER NOT NULL DEFAULT 0,
        project_stage TEXT NOT NULL DEFAULT '',
        project_deadline_time INTEGER NOT NULL DEFAULT 0,
        opportunity_status TEXT NOT NULL DEFAULT '',
        freshness_bucket TEXT NOT NULL DEFAULT '',
        freshness_score INTEGER NOT NULL DEFAULT 0,
        observation_key TEXT NOT NULL UNIQUE,
        occurrences INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_lead_sources_lead ON lead_sources(lead_id, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lead_sources_type ON lead_sources(source_type, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lead_sources_source_url ON lead_sources(source_url);
      CREATE TABLE IF NOT EXISTS discovery_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        query TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discovery_tasks_status ON discovery_tasks(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS lead_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(lead_id) REFERENCES leads(id)
      );
      CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_id, created_at DESC);
    `)
    const columns = new Set(this.db.prepare('PRAGMA table_info(leads)').all().map((item) => item.name))
    const leadMigrations = {
      search_text: "TEXT NOT NULL DEFAULT ''",
      opt_out_at: "TEXT NOT NULL DEFAULT ''",
      source_event_time: 'INTEGER NOT NULL DEFAULT 0',
      project_stage: "TEXT NOT NULL DEFAULT ''",
      project_deadline_time: 'INTEGER NOT NULL DEFAULT 0',
      opportunity_status: "TEXT NOT NULL DEFAULT ''",
      freshness_bucket: "TEXT NOT NULL DEFAULT ''",
      freshness_score: 'INTEGER NOT NULL DEFAULT 0',
    }
    for (const [column, definition] of Object.entries(leadMigrations)) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE leads ADD COLUMN ${column} ${definition}`)
    }
    const sourceColumns = new Set(this.db.prepare('PRAGMA table_info(lead_sources)').all().map((item) => item.name))
    const sourceMigrations = {
      source_event_time: 'INTEGER NOT NULL DEFAULT 0',
      project_stage: "TEXT NOT NULL DEFAULT ''",
      project_deadline_time: 'INTEGER NOT NULL DEFAULT 0',
      opportunity_status: "TEXT NOT NULL DEFAULT ''",
      freshness_bucket: "TEXT NOT NULL DEFAULT ''",
      freshness_score: 'INTEGER NOT NULL DEFAULT 0',
    }
    for (const [column, definition] of Object.entries(sourceMigrations)) {
      if (!sourceColumns.has(column)) this.db.exec(`ALTER TABLE lead_sources ADD COLUMN ${column} ${definition}`)
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_leads_freshness ON leads(opportunity_status, freshness_score DESC, source_event_time DESC);
      CREATE INDEX IF NOT EXISTS idx_lead_sources_event_time ON lead_sources(source_type, source_event_time DESC);
    `)
    this.migrateSensitiveRows()
    this.backfillLeadSources()
    this.initSearchIndex()
  }

  backfillLeadSources() {
    const rows = this.db.prepare(`SELECT id, platform, industry, account_name, profile_url, region,
      source_type, source_url, source_text, search_text, evidence, source_event_time, project_stage,
      project_deadline_time, opportunity_status, freshness_bucket, freshness_score, source_count, created_at, updated_at
      FROM leads WHERE id NOT IN (SELECT DISTINCT lead_id FROM lead_sources)`).all()
    for (const row of rows) {
      this.recordObservation(row.id, row, row.created_at || row.updated_at || new Date().toISOString(), Math.max(1, Number(row.source_count) || 1))
    }
  }

  initSearchIndex() {
    try {
      const existingFts = this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'leads_fts'").get()
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_leads_industry_status_score ON leads(industry, status, score DESC);
        CREATE INDEX IF NOT EXISTS idx_leads_source_updated ON leads(source_type, updated_at DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS leads_fts USING fts5(
          account_name, douyin_id, region, search_text, evidence, notes,
          content='leads', content_rowid='id', tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS leads_fts_ai AFTER INSERT ON leads BEGIN
          INSERT INTO leads_fts(rowid, account_name, douyin_id, region, search_text, evidence, notes)
          VALUES (new.id, new.account_name, new.douyin_id, new.region, new.search_text, new.evidence, new.notes);
        END;
        CREATE TRIGGER IF NOT EXISTS leads_fts_ad AFTER DELETE ON leads BEGIN
          INSERT INTO leads_fts(leads_fts, rowid, account_name, douyin_id, region, search_text, evidence, notes)
          VALUES ('delete', old.id, old.account_name, old.douyin_id, old.region, old.search_text, old.evidence, old.notes);
        END;
        CREATE TRIGGER IF NOT EXISTS leads_fts_au AFTER UPDATE ON leads BEGIN
          INSERT INTO leads_fts(leads_fts, rowid, account_name, douyin_id, region, search_text, evidence, notes)
          VALUES ('delete', old.id, old.account_name, old.douyin_id, old.region, old.search_text, old.evidence, old.notes);
          INSERT INTO leads_fts(rowid, account_name, douyin_id, region, search_text, evidence, notes)
          VALUES (new.id, new.account_name, new.douyin_id, new.region, new.search_text, new.evidence, new.notes);
        END;
      `)
      // FTS 触发器会持续维护索引。约三亿字节的正式库如果每次启动都 rebuild，
      // Electron 主进程会被同步 SQLite 工作占住数分钟，表现为开机后窗口未响应。
      // 只在首次创建 FTS 表时做一次全量构建。
      if (!existingFts) this.db.exec("INSERT INTO leads_fts(leads_fts) VALUES ('rebuild')")
      this.ftsAvailable = true
    } catch (error) {
      this.ftsAvailable = false
    }
  }

  migrateSensitiveRows() {
    const rows = this.db.prepare(`SELECT id, contact_raw, contact_normalized, source_text, search_text, evidence
      FROM leads WHERE
        (contact_raw <> '' AND contact_raw NOT LIKE 'dpapi:%' AND contact_raw NOT LIKE 'test:%')
        OR (contact_normalized <> '' AND contact_normalized NOT LIKE 'dpapi:%' AND contact_normalized NOT LIKE 'test:%')
        OR (source_text <> '' AND source_text NOT LIKE 'dpapi:%' AND source_text NOT LIKE 'test:%')
        OR (source_text <> '' AND search_text = '')`).all()
    const update = this.db.prepare(`UPDATE leads SET contact_raw = ?, contact_normalized = ?, source_text = ?,
      search_text = ?, evidence = ?, updated_at = ? WHERE id = ?`)
    for (const row of rows) {
      const encrypted = (value) => /^(dpapi|test):/.test(String(value || ''))
      let sourcePlain = ''
      try { sourcePlain = encrypted(row.source_text) ? this.decryptText(row.source_text) : String(row.source_text || '') } catch (error) {}
      const contactRaw = row.contact_raw && !encrypted(row.contact_raw) ? this.encryptText(row.contact_raw) : row.contact_raw
      const contactNormalized = row.contact_normalized && !encrypted(row.contact_normalized) ? this.encryptText(row.contact_normalized) : row.contact_normalized
      const sourceText = row.source_text && !encrypted(row.source_text) ? this.encryptText(row.source_text) : row.source_text
      const searchText = String(row.search_text || '') || maskSensitiveText(sourcePlain).slice(0, 5000)
      const evidence = maskSensitiveText(row.evidence || '')
      if (contactRaw !== row.contact_raw || contactNormalized !== row.contact_normalized || sourceText !== row.source_text || searchText !== row.search_text || evidence !== row.evidence) {
        update.run(contactRaw || '', contactNormalized || '', sourceText || '', searchText, evidence, new Date().toISOString(), row.id)
      }
    }
  }

  getKeywords() {
    return { industries: INDUSTRIES, statuses: STATUS_LABELS, sourceTypes: SOURCE_TYPES, discoverySources: DISCOVERY_SOURCES }
  }

  getDataInfo() {
    return { dataDir: this.dataDir, dbPath: this.dbPath, ocr: this.ocr ? this.ocr.getInfo() : { available: false } }
  }

  getOverview() {
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status IN ('assigned', 'following') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted,
        SUM(CASE WHEN contact_normalized <> '' THEN 1 ELSE 0 END) AS with_contact,
        SUM(CASE WHEN source_type = 'profile' AND contact_normalized <> '' THEN 1 ELSE 0 END) AS profile_contacts
      FROM leads
    `).get()
    const byIndustry = this.db.prepare('SELECT industry, COUNT(*) AS count FROM leads GROUP BY industry ORDER BY count DESC').all()
    return { ...totals, byIndustry, dataDir: this.dataDir }
  }

  createDiscoveryPlan(payload = {}) {
    const tasks = buildDiscoveryPlan(payload)
    const insert = this.db.prepare(`INSERT OR IGNORE INTO discovery_tasks
      (source_id, source_name, source_type, query, url, status, dedupe_key, created_at, updated_at)
      VALUES ($source_id, $source_name, $source_type, $query, $url, 'pending', $dedupe_key, $created_at, $updated_at)`)
    let created = 0
    let refreshed = 0
    const now = new Date().toISOString()
    this.db.exec('BEGIN')
    try {
      for (const task of tasks) {
        const dedupe = crypto.createHash('sha256').update([task.source_id, task.query, task.url].join('|')).digest('hex')
        const result = insert.run({ ...Object.fromEntries(Object.entries(task).map(([key, value]) => ['$' + key, value])), $dedupe_key: dedupe, $created_at: now, $updated_at: now })
        if (result.changes) created++
        else {
          this.db.prepare("UPDATE discovery_tasks SET status = 'pending', updated_at = ? WHERE dedupe_key = ?").run(now, dedupe)
          refreshed++
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { success: true, created, refreshed, total: tasks.length, list: this.listDiscoveryTasks({ limit: 100 }).list }
  }

  listDiscoveryTasks(filters = {}) {
    const allowed = ['pending', 'opened', 'imported', 'skipped', 'error']
    const status = allowed.includes(filters.status) ? filters.status : ''
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100))
    const list = status
      ? this.db.prepare('SELECT * FROM discovery_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare("SELECT * FROM discovery_tasks WHERE status <> 'skipped' ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'opened' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?").all(limit)
    return { list }
  }

  updateDiscoveryTask(payload = {}) {
    const id = Number(payload.id)
    const status = String(payload.status || '')
    if (!id || !['pending', 'opened', 'imported', 'skipped', 'error'].includes(status)) throw new Error('无效的渠道任务状态')
    this.db.prepare('UPDATE discovery_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id)
    return this.db.prepare('SELECT * FROM discovery_tasks WHERE id = ?').get(id) || null
  }

  getEvents(payload = {}) {
    const leadId = Number(payload.id)
    if (!leadId) throw new Error('无效的线索编号')
    return { list: this.db.prepare('SELECT event_type, details, created_at FROM lead_events WHERE lead_id = ? ORDER BY created_at DESC LIMIT 100').all(leadId) }
  }

  getSources(payload = {}) {
    const leadId = Number(payload.id || payload.leadId)
    if (!leadId) throw new Error('无效的线索编号')
    const pageSize = Math.max(1, Math.min(200, Number(payload.pageSize) || 50))
    const page = Math.max(1, Number(payload.page) || 1)
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM lead_sources WHERE lead_id = ?').get(leadId).count) || 0
    const rows = this.db.prepare(`SELECT id, lead_id, platform, industry, account_name, profile_url, region,
      source_type, source_url, source_text, evidence, source_event_time, project_stage, project_deadline_time,
      opportunity_status, freshness_bucket, freshness_score, occurrences, first_seen_at, last_seen_at
      FROM lead_sources WHERE lead_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(leadId, pageSize, (page - 1) * pageSize)
    return { total, page, pageSize, list: rows.map((row) => ({
      ...row,
      source_text: row.source_text ? this.decryptText(row.source_text) : '',
    })) }
  }

  async recognizeImage(payload = {}) {
    if (!this.ocr) throw new Error('当前未配置本地 OCR')
    const result = await this.ocr.recognize(payload.path)
    return { ...result, contacts: extractContacts(result.text), industry: inferIndustry(result.text, payload.industry) }
  }

  list(filters = {}) {
    const where = []
    const params = {}
    if (filters.industry) { where.push('industry = $industry'); params.$industry = String(filters.industry) }
    if (filters.status) { where.push('status = $status'); params.$status = String(filters.status) }
    if (filters.sourceType && Object.prototype.hasOwnProperty.call(SOURCE_TYPES, String(filters.sourceType))) {
      where.push('source_type = $sourceType')
      params.$sourceType = String(filters.sourceType)
    }
    if (filters.contactOnly) where.push("contact_normalized <> ''")
    const freshness = String(filters.freshness || 'actionable')
    const projectTypes = "'procurement','public_resource','web_project','approval','subsidy'"
    if (freshness === 'actionable') {
      const commentCutoff = Math.floor((Date.now() - 30 * 86400000) / 1000)
      where.push(`(source_type NOT IN ('comment',${projectTypes})
        OR (source_type = 'comment' AND source_event_time >= $commentCutoff)
        OR (source_type IN (${projectTypes}) AND opportunity_status NOT IN ('stale', 'deadline_passed')))`)
      params.$commentCutoff = commentCutoff
    } else if (/^(30|60|90|180)$/.test(freshness)) {
      params.$eventCutoff = Math.floor((Date.now() - Number(freshness) * 86400000) / 1000)
      where.push(`(source_type NOT IN ('comment',${projectTypes}) OR source_event_time >= $eventCutoff)`)
    } else if (freshness === 'historical') {
      where.push(`source_type IN (${projectTypes}) AND opportunity_status IN ('stale', 'deadline_passed')`)
    }
    if (filters.keyword) {
      const keyword = String(filters.keyword).trim()
      const digits = fullWidthToHalfWidth(keyword).replace(/\D/g, '')
      if (digits.length >= 7) {
        where.push('dedupe_key = $contactKey')
        params.$contactKey = crypto.createHash('sha256').update('contact:' + digits).digest('hex')
      } else {
        const terms = keyword.split(/\s+/).map((term) => term.trim()).filter(Boolean)
        const ftsTerms = terms.filter((term) => [...term].length >= 3)
        const shortTerms = terms.filter((term) => [...term].length < 3)
        if (this.ftsAvailable && ftsTerms.length) {
          where.push('id IN (SELECT rowid FROM leads_fts WHERE leads_fts MATCH $ftsKeyword)')
          params.$ftsKeyword = ftsTerms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ')
        }
        for (let index = 0; index < shortTerms.length || !terms.length; index++) {
          const key = '$keyword' + index
          const term = shortTerms[index] || keyword
          where.push(`(account_name LIKE ${key} OR douyin_id LIKE ${key} OR region LIKE ${key} OR search_text LIKE ${key} OR evidence LIKE ${key} OR notes LIKE ${key} OR contact_masked LIKE ${key})`)
          params[key] = '%' + term + '%'
        }
      }
    }
    const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || 50))
    const page = Math.max(1, Number(filters.page) || 1)
    const countParams = { ...params }
    params.$limit = pageSize
    params.$offset = (page - 1) * pageSize
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM leads' + clause).get(countParams).count
    const rows = this.db.prepare(`SELECT id, platform, industry, account_name, douyin_id, profile_url, region,
      source_type, source_url, contact_normalized, contact_masked, contact_type,
      evidence, public_business, score, status, assignee, notes, opt_out, source_count, source_event_time,
      project_stage, project_deadline_time, opportunity_status, freshness_bucket, freshness_score, created_at, updated_at
      FROM leads${clause}
      ORDER BY CASE WHEN freshness_score > 0 THEN freshness_score ELSE score END DESC,
        source_event_time DESC, score DESC, updated_at DESC LIMIT $limit OFFSET $offset`).all(params)
    return { list: rows.map((row) => this.presentLead(row)), total, page, pageSize }
  }

  importText(payload = {}) {
    const rawText = String(payload.rawText || '').trim()
    if (!rawText) throw new Error('请输入公开资料或页面文字')
    const parts = rawText.split(/\n\s*\n|\n-{3,}\n|\n={3,}\n/).map((item) => item.trim()).filter(Boolean)
    const blocks = parts.length > 1 ? parts : [rawText]
    const imported = []
    let duplicates = 0
    for (const block of blocks.slice(0, 500)) {
      const contacts = extractContacts(block)
      const candidates = contacts.length ? contacts : [null]
      for (const contact of candidates) {
        const record = this.makeRecord({ ...payload, rawText: block }, contact)
        const result = this.upsert(record)
        if (result.duplicate) duplicates++
        else imported.push(result.lead)
      }
    }
    return { success: true, imported: imported.length, duplicates, list: imported }
  }

  makeRecord(payload, contact) {
    const text = String(payload.rawText || '')
    const industry = inferIndustry(text, payload.industry)
    const region = inferRegion(text, payload.region)
    const sourceType = SOURCE_TYPES[payload.sourceType] ? payload.sourceType : 'manual'
    const compactText = text.replace(/\s+/g, '')
    const businessHits = BUSINESS_TERMS.filter((word) => text.includes(word) || compactText.includes(word)).length
    // 主页公开不等于商务授权；只有号码附近/资料中出现明确商务语境才标记为公开商务联系方式。
    const publicBusiness = contact ? businessHits > 0 : false
    const score = scoreLead({ text, industry, contact, sourceType })
    const normalized = contact ? contact.normalized : ''
    const hashBase = normalized ? 'contact:' + normalized : [industry, payload.accountName || '', payload.sourceUrl || '', text.slice(0, 500)].join('|')
    return {
      platform: String(payload.platform || (['profile', 'video', 'comment', 'live'].includes(sourceType) ? 'douyin' : sourceType)).slice(0, 40),
      industry,
      account_name: String(payload.accountName || '').trim().slice(0, 120),
      douyin_id: String(payload.douyinId || '').trim().slice(0, 80),
      profile_url: String(payload.profileUrl || '').trim().slice(0, 1000),
      region,
      source_type: sourceType,
      source_url: String(payload.sourceUrl || '').trim().slice(0, 1000),
      source_text: this.encryptText(text.slice(0, 20000)),
      search_text: maskSensitiveText(text).slice(0, 5000),
      contact_raw: contact ? this.encryptText(contact.raw) : '',
      contact_normalized: normalized ? this.encryptText(normalized) : '',
      contact_masked: contact ? contact.masked : '',
      contact_type: contact ? contact.type : '',
      evidence: maskSensitiveText(contact ? contact.context.slice(0, 500) : text.slice(0, 500)),
      public_business: publicBusiness ? 1 : 0,
      score,
      source_event_time: Math.max(0, Number(payload.sourceEventTime || payload.commentTime || payload.projectPublishedAtTs) || 0),
      project_stage: String(payload.projectStage || '').slice(0, 40),
      project_deadline_time: Math.max(0, Number(payload.projectDeadlineAtTs) || 0),
      opportunity_status: String(payload.opportunityStatus || '').slice(0, 40),
      freshness_bucket: String(payload.freshnessBucket || '').slice(0, 40),
      freshness_score: Math.max(0, Math.min(100, Number(payload.freshnessScore) || 0)),
      dedupe_key: crypto.createHash('sha256').update(hashBase).digest('hex'),
    }
  }

  recordObservation(leadId, record, observedAt = new Date().toISOString(), occurrences = 1) {
    const observationKey = crypto.createHash('sha256').update([
      Number(leadId), record.source_type || '', record.source_url || '', record.profile_url || '',
      String(record.search_text || '').slice(0, 3000),
    ].join('|')).digest('hex')
    this.db.prepare(`INSERT INTO lead_sources
      (lead_id, platform, industry, account_name, profile_url, region, source_type, source_url,
        source_text, search_text, evidence, source_event_time, project_stage, project_deadline_time,
        opportunity_status, freshness_bucket, freshness_score, observation_key, occurrences, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observation_key) DO UPDATE SET
        occurrences = lead_sources.occurrences + excluded.occurrences,
        last_seen_at = excluded.last_seen_at,
        source_event_time = MAX(lead_sources.source_event_time, excluded.source_event_time),
        project_deadline_time = MAX(lead_sources.project_deadline_time, excluded.project_deadline_time),
        project_stage = CASE WHEN excluded.freshness_score >= lead_sources.freshness_score AND excluded.project_stage <> '' THEN excluded.project_stage ELSE lead_sources.project_stage END,
        opportunity_status = CASE WHEN excluded.freshness_score >= lead_sources.freshness_score AND excluded.opportunity_status <> '' THEN excluded.opportunity_status ELSE lead_sources.opportunity_status END,
        freshness_bucket = CASE WHEN excluded.freshness_score >= lead_sources.freshness_score AND excluded.freshness_bucket <> '' THEN excluded.freshness_bucket ELSE lead_sources.freshness_bucket END,
        freshness_score = MAX(lead_sources.freshness_score, excluded.freshness_score),
        source_text = CASE WHEN length(excluded.source_text) > length(lead_sources.source_text) THEN excluded.source_text ELSE lead_sources.source_text END,
        search_text = CASE WHEN length(excluded.search_text) > length(lead_sources.search_text) THEN excluded.search_text ELSE lead_sources.search_text END,
        evidence = CASE WHEN length(excluded.evidence) > length(lead_sources.evidence) THEN excluded.evidence ELSE lead_sources.evidence END`)
      .run(Number(leadId), String(record.platform || ''), String(record.industry || 'unknown'), String(record.account_name || ''),
        String(record.profile_url || ''), String(record.region || ''), String(record.source_type || 'manual'),
        String(record.source_url || ''), String(record.source_text || ''), String(record.search_text || ''),
        String(record.evidence || ''), Math.max(0, Number(record.source_event_time) || 0), String(record.project_stage || ''),
        Math.max(0, Number(record.project_deadline_time) || 0), String(record.opportunity_status || ''),
        String(record.freshness_bucket || ''), Math.max(0, Number(record.freshness_score) || 0),
        observationKey, Math.max(1, Number(occurrences) || 1), String(observedAt), String(observedAt))
  }

  upsert(record) {
    const now = new Date().toISOString()
    let leadId = 0
    let duplicate = false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT id, source_count FROM leads WHERE dedupe_key = ?').get(record.dedupe_key)
      if (existing) {
        this.db.prepare(`UPDATE leads SET source_count = source_count + 1, updated_at = ?,
          score = MAX(score, ?), evidence = CASE WHEN length(?) > length(evidence) THEN ? ELSE evidence END,
          search_text = CASE WHEN length(?) > length(search_text) THEN ? ELSE search_text END,
          source_url = CASE WHEN source_url = '' THEN ? ELSE source_url END,
          source_event_time = MAX(source_event_time, ?),
          project_deadline_time = MAX(project_deadline_time, ?),
          project_stage = CASE WHEN ? >= freshness_score AND ? <> '' THEN ? ELSE project_stage END,
          opportunity_status = CASE WHEN ? >= freshness_score AND ? <> '' THEN ? ELSE opportunity_status END,
          freshness_bucket = CASE WHEN ? >= freshness_score AND ? <> '' THEN ? ELSE freshness_bucket END,
          freshness_score = MAX(freshness_score, ?)
          WHERE id = ?`).run(now, record.score, record.evidence, record.evidence, record.search_text, record.search_text, record.source_url,
            record.source_event_time, record.project_deadline_time,
            record.freshness_score, record.project_stage, record.project_stage,
            record.freshness_score, record.opportunity_status, record.opportunity_status,
            record.freshness_score, record.freshness_bucket, record.freshness_bucket,
            record.freshness_score, existing.id)
        this.recordObservation(existing.id, record, now)
        leadId = Number(existing.id)
        duplicate = true
      } else {
        const columns = Object.keys(record)
        const stmt = this.db.prepare(`INSERT INTO leads (${columns.join(', ')}, created_at, updated_at)
          VALUES (${columns.map((key) => '$' + key).join(', ')}, $created_at, $updated_at)`)
        const params = {}
        for (const [key, value] of Object.entries(record)) params['$' + key] = value
        params.$created_at = now
        params.$updated_at = now
        const result = stmt.run(params)
        leadId = Number(result.lastInsertRowid)
        this.recordObservation(leadId, record, now)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollbackError) {}
      throw error
    }
    return { duplicate, lead: this.get(leadId, false) }
  }

  get(id, includePrivate = false) {
    const columns = includePrivate ? '*' : `id, platform, industry, account_name, douyin_id, profile_url, region,
      source_type, source_url, contact_normalized, contact_masked, contact_type, evidence, public_business, score,
      status, assignee, notes, opt_out, source_count, source_event_time, project_stage, project_deadline_time,
      opportunity_status, freshness_bucket, freshness_score, created_at, updated_at`
    const row = this.db.prepare(`SELECT ${columns} FROM leads WHERE id = ?`).get(Number(id)) || null
    return includePrivate ? row : this.presentLead(row)
  }

  presentLead(row) {
    if (!row) return null
    const result = { ...row, contact: row.contact_normalized ? this.decryptText(row.contact_normalized) : '' }
    delete result.contact_normalized
    return result
  }

  update(payload = {}) {
    const id = Number(payload.id)
    const current = id ? this.db.prepare('SELECT id, status, opt_out FROM leads WHERE id = ?').get(id) : null
    if (!current) throw new Error('线索不存在')
    if (current.opt_out && payload.opt_out === false) throw new Error('拒绝联系标记不可撤销')
    if (current.opt_out && payload.status && payload.status !== 'opt_out') throw new Error('已拒绝联系的线索不能恢复为其他状态')
    const allowed = ['industry', 'account_name', 'douyin_id', 'profile_url', 'region', 'status', 'assignee', 'notes', 'public_business']
    const fields = []
    const params = { $id: id, $updated_at: new Date().toISOString() }
    for (const key of allowed) {
      if (payload[key] === undefined) continue
      if (key === 'status' && !STATUS_LABELS[payload[key]]) throw new Error('无效的线索状态')
      fields.push(`${key} = $${key}`)
      params['$' + key] = key === 'public_business' ? (payload[key] ? 1 : 0) : String(payload[key]).slice(0, key === 'notes' ? 2000 : 1000)
    }
    if (payload.opt_out !== undefined) {
      if (!payload.opt_out) throw new Error('拒绝联系标记不可撤销')
      fields.push('opt_out = $opt_out')
      fields.push('status = $opt_out_status')
      fields.push("opt_out_at = CASE WHEN opt_out_at = '' THEN $opt_out_at ELSE opt_out_at END")
      params.$opt_out = payload.opt_out ? 1 : 0
      params.$opt_out_status = payload.opt_out ? 'opt_out' : 'reviewed'
      params.$opt_out_at = new Date().toISOString()
    }
    if (!fields.length) return this.get(id, false)
    fields.push('updated_at = $updated_at')
    this.db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = $id`).run(params)
    if (payload.opt_out) this.addEvent(id, 'opt_out', '联系人拒绝联系，永久停止业务跟进')
    else if (payload.status && payload.status !== current.status) this.addEvent(id, 'status_changed', `${current.status} -> ${payload.status}`)
    return this.get(id, false)
  }

  addEvent(leadId, type, details) {
    this.db.prepare('INSERT INTO lead_events (lead_id, event_type, details, created_at) VALUES (?, ?, ?, ?)')
      .run(Number(leadId), String(type || '').slice(0, 60), String(details || '').slice(0, 500), new Date().toISOString())
  }

  revealContact(payload = {}) {
    const id = Number(payload.id)
    const row = this.db.prepare('SELECT contact_normalized, status, opt_out, public_business FROM leads WHERE id = ?').get(id)
    if (!row) throw new Error('线索不存在')
    if (row.opt_out || row.status === 'opt_out') throw new Error('该联系人已拒绝联系，不能显示号码')
    if (!row.public_business) throw new Error('尚未确认该号码属于公开商务联系方式')
    if (row.status === 'new') throw new Error('请先把线索标记为“已审核”')
    if (!payload.acknowledged) throw new Error('必须确认合规用途后才能显示号码')
    this.addEvent(id, 'contact_revealed', '已确认仅用于正当工程业务联系')
    return { contact: this.decryptText(row.contact_normalized), acknowledged: true }
  }

  exportCsv(filters = {}) {
    const rows = []
    let page = 1
    let total = 0
    do {
      const result = this.list({ ...filters, page, pageSize: 200 })
      total = result.total
      rows.push(...result.list)
      page++
    } while (rows.length < total)
    const header = ['编号', '行业', '账号', '地区', '公开联系方式', '来源', '评分', '状态', '业务员', '备注', '来源链接', '采集时间']
    const lines = [header.map(csvCell).join(',')]
    for (const row of rows) {
      lines.push([
        row.id, this.industryName(row.industry), row.account_name, row.region, row.contact,
        row.source_type, row.score, STATUS_LABELS[row.status] || row.status, row.assignee, row.notes,
        row.source_url, row.created_at,
      ].map(csvCell).join(','))
    }
    const exportDir = path.join(this.dataDir, '导出')
    fs.mkdirSync(exportDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const exportPath = path.join(exportDir, `商机线索-${stamp}.csv`)
    fs.writeFileSync(exportPath, '\ufeff' + lines.join('\r\n'), 'utf8')
    return { success: true, path: exportPath, count: rows.length, masked: false }
  }

  industryName(id) {
    const hit = INDUSTRIES.find((item) => item.id === id)
    return hit ? hit.name : '待分类'
  }

  close() {
    try { this.db.close() } catch (error) {}
  }
}

module.exports = {
  LeadRadar,
  INDUSTRIES,
  STATUS_LABELS,
  SOURCE_TYPES,
  DISCOVERY_SOURCES,
  extractContacts,
  inferIndustry,
  scoreLead,
  buildDiscoveryPlan,
  maskContact,
  maskSensitiveText,
  defaultDataDir,
}
