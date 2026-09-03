'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LeadRadar, extractContacts, inferIndustry, maskSensitiveText, buildDiscoveryPlan } = require('../app/server/lead-radar')

test('识别常见公开商务电话并脱敏', () => {
  const contacts = extractContacts('商务合作：138 0013 8000，座机 0371-12345678，400-123-4567')
  assert.deepEqual(contacts.map((item) => item.normalized), ['13800138000', '4001234567', '037112345678'])
  assert.equal(contacts[0].masked, '138****8000')
  assert.equal(maskSensitiveText('公开业务电话 138 0013 8000'), '公开业务电话 138****8000')
  assert.equal(maskSensitiveText('公开业务电话 １３８００１３８０００'), '公开业务电话 138****8000')
  assert.equal(maskSensitiveText('公开业务电话 一三八〇〇一三八〇〇〇'), '公开业务电话 138****8000')
  assert.equal(maskSensitiveText('公开业务电话 一三八 〇〇一三 八〇〇〇'), '公开业务电话 138****8000')
  assert.deepEqual(extractContacts('订单号13800138000123，不是电话号码'), [])
  assert.deepEqual(extractContacts('项目编号：13800138000，不是电话号码'), [])
})

test('根据五类行业关键词分类', () => {
  assert.equal(inferIndustry('承接郑州环氧地坪和固化地坪施工'), 'flooring')
  assert.equal(inferIndustry('果蔬保鲜冷库设计安装'), 'cold_storage')
  assert.equal(inferIndustry('西贾乡南李村冷链仓储项目'), 'cold_storage')
  assert.equal(inferIndustry('副食品类采购，包含冷冻食品和罐头'), 'unknown')
  assert.equal(inferIndustry('食品厂无尘车间净化工程改造'), 'cleanroom')
  assert.equal(inferIndustry('OCR：冷库 安装 业务 电话'), 'cold_storage')
  assert.equal(inferIndustry('膜结构停车棚生产安装'), 'membrane')
  assert.equal(inferIndustry('厂房移动推拉棚和电动伸缩棚'), 'retractable_shed')
})

test('导入、去重、审核和拒绝联系闭环', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-leads-'))
  const radar = new LeadRadar({ dataDir })
  t.after(() => {
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const payload = {
    sourceType: 'profile',
    accountName: '郑州某某地坪工程',
    sourceUrl: 'https://www.douyin.com/user/example',
    rawText: '郑州环氧地坪、固化地坪施工，业务电话 13800138000，欢迎咨询报价。',
  }
  const first = radar.importText(payload)
  assert.equal(first.imported, 1)
  assert.equal(first.duplicates, 0)
  assert.equal(first.list[0].industry, 'flooring')
  assert.ok(first.list[0].score >= 70)
  assert.match(first.list[0].evidence, /138\*\*\*\*8000/)
  assert.doesNotMatch(first.list[0].evidence, /13800138000|138 0013 8000/)
  assert.equal(first.list[0].contact, '13800138000')
  const stored = radar.db.prepare('SELECT contact_normalized, source_text FROM leads WHERE id = ?').get(first.list[0].id)
  assert.notEqual(stored.contact_normalized, '13800138000')
  assert.match(stored.contact_normalized, /^test:/)
  assert.match(stored.source_text, /^test:/)

  const second = radar.importText(payload)
  assert.equal(second.imported, 0)
  assert.equal(second.duplicates, 1)
  assert.equal(radar.getOverview().total, 1)
  assert.equal(radar.list({ industry: 'flooring', contactOnly: true }).total, 1)
  assert.equal(radar.list({ keyword: '郑州' }).list[0].account_name, '郑州某某地坪工程')
  assert.equal(radar.list({ keyword: '环氧地坪' }).total, 1)
  assert.equal(radar.list({ keyword: '某某地坪' }).total, 1)
  assert.equal(radar.list({ keyword: '13800138000' }).total, 1)

  const id = first.list[0].id
  assert.throws(() => radar.revealContact({ id }), /先把线索标记/)
  radar.update({ id, status: 'reviewed', assignee: '张三' })
  assert.throws(() => radar.revealContact({ id }), /确认合规用途/)
  assert.equal(radar.revealContact({ id, acknowledged: true }).contact, '13800138000')
  radar.update({ id, opt_out: true })
  assert.deepEqual(radar.getEvents({ id }).list.map((event) => event.event_type).slice(0, 2), ['opt_out', 'contact_revealed'])
  assert.throws(() => radar.revealContact({ id }), /拒绝联系/)
  assert.throws(() => radar.update({ id, opt_out: false }), /不可撤销/)
  assert.throws(() => radar.update({ id, status: 'reviewed' }), /不能恢复/)
  const csv = radar.exportCsv({ industry: 'flooring' })
  assert.match(fs.readFileSync(csv.path, 'utf8'), /13800138000/)

  const personal = radar.importText({
    sourceType: 'profile',
    accountName: '个人账号',
    rawText: '日常生活记录 13900139000',
  }).list[0]
  radar.update({ id: personal.id, status: 'reviewed' })
  assert.throws(() => radar.revealContact({ id: personal.id }), /公开商务联系方式/)
})

test('旧版明文记录会在再次启动时自动迁移', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-migrate-'))
  let radar = new LeadRadar({ dataDir })
  const lead = radar.importText({
    sourceType: 'profile',
    accountName: '旧版冷库厂家',
    rawText: '承接冷库安装工程，业务电话 13700137000。',
  }).list[0]
  radar.update({ id: lead.id, status: 'reviewed' })
  radar.db.prepare(`UPDATE leads SET contact_raw = ?, contact_normalized = ?, source_text = ?, search_text = '', evidence = ? WHERE id = ?`)
    .run('13700137000', '13700137000', '承接冷库安装工程，业务电话 13700137000。', '业务电话 13700137000', lead.id)
  radar.close()

  radar = new LeadRadar({ dataDir })
  t.after(() => {
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const stored = radar.db.prepare('SELECT contact_raw, contact_normalized, source_text, search_text, evidence FROM leads WHERE id = ?').get(lead.id)
  assert.match(stored.contact_raw, /^test:/)
  assert.match(stored.contact_normalized, /^test:/)
  assert.match(stored.source_text, /^test:/)
  assert.match(stored.search_text, /冷库安装工程/)
  assert.doesNotMatch(stored.search_text, /13700137000/)
  assert.doesNotMatch(stored.evidence, /13700137000/)
  assert.equal(radar.revealContact({ id: lead.id, acknowledged: true }).contact, '13700137000')
})

test('同一联系方式去重但完整保留每个工程和视频来源', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-lead-sources-'))
  const radar = new LeadRadar({ dataDir })
  t.after(() => {
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const first = radar.importText({
    platform: 'ccgp', sourceType: 'procurement', industry: 'flooring', accountName: '采购单位甲',
    sourceUrl: 'https://www.ccgp.gov.cn/project/a', rawText: '厂房环氧地坪工程，联系电话13800138000',
  })
  radar.importText({
    platform: 'ggzy', sourceType: 'public_resource', industry: 'cold_storage', accountName: '采购单位乙',
    sourceUrl: 'https://www.ggzy.gov.cn/project/b', rawText: '园区冷库改造工程，项目联系电话13800138000',
  })
  const lead = radar.list({ contactOnly: true }).list[0]
  assert.equal(radar.getOverview().total, 1)
  assert.equal(lead.source_count, 2)
  const sources = radar.getSources({ id: first.list[0].id })
  assert.equal(sources.total, 2)
  assert.deepEqual(new Set(sources.list.map((row) => row.source_url)), new Set([
    'https://www.ccgp.gov.cn/project/a', 'https://www.ggzy.gov.cn/project/b',
  ]))
  assert.ok(sources.list.every((row) => /13800138000/.test(row.source_text)))
  const stored = radar.db.prepare('SELECT source_text FROM lead_sources LIMIT 1').get()
  assert.match(stored.source_text, /^test:/)
})

test('生成并管理多渠道检索任务', (t) => {
  const plan = buildDiscoveryPlan({ industry: 'cold_storage', region: '郑州', intent: 'project', sources: ['ccgp', 'gov_projects', 'amap'] })
  assert.equal(plan.length, 9)
  assert.ok(plan.every((item) => item.query.includes('郑州')))
  assert.ok(plan.some((item) => item.url.includes('ccgp.gov.cn')))
  assert.ok(plan.some((item) => item.url.includes('site%3Agov.cn')))
  assert.ok(buildDiscoveryPlan({ industry: 'flooring', sources: ['ggzy'] }).every((item) => item.url.includes('site%3Aggzy.gov.cn')))

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-discovery-'))
  const radar = new LeadRadar({ dataDir })
  t.after(() => {
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const created = radar.createDiscoveryPlan({ industry: 'cold_storage', region: '郑州', intent: 'project', sources: ['ccgp'] })
  assert.equal(created.created, 3)
  const repeated = radar.createDiscoveryPlan({ industry: 'cold_storage', region: '郑州', intent: 'project', sources: ['ccgp'] })
  assert.equal(repeated.created, 0)
  assert.equal(repeated.refreshed, 3)
  const task = radar.listDiscoveryTasks({ status: 'pending' }).list[0]
  assert.equal(radar.updateDiscoveryTask({ id: task.id, status: 'opened' }).status, 'opened')
})

test('完整号码 CSV 导出不会在 200 条处截断', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-export-'))
  const radar = new LeadRadar({ dataDir })
  t.after(() => {
    radar.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  for (let i = 0; i < 205; i++) {
    radar.importText({
      industry: 'cold_storage',
      sourceType: 'manual',
      sourceUrl: 'https://example.com/project/' + i,
      rawText: '冷库工程公开项目编号 ' + i,
    })
  }
  const result = radar.exportCsv({ industry: 'cold_storage' })
  assert.equal(result.count, 205)
  assert.equal(result.masked, false)
  assert.equal(fs.readFileSync(result.path, 'utf8').split(/\r?\n/).length, 206)
})
