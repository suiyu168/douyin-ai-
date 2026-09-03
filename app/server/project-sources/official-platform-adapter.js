'use strict'

const cheerio = require('cheerio')

const NOTICE_SIGNAL_RE = /(项目|工程|施工|建设|改造|装修|安装|招标|采购|询价|磋商|谈判|资格预审|招标计划|立项|备案|核准|审批|推介|施工许可|环评|拟建|扩建|技改|厂房|产业园|仓储|冷链)/i
const LIST_SIGNAL_RE = /(交易信息|交易公开|公告公示|招标公告|采购公告|工程建设|政府采购|招标计划|交易公告|项目交易|项目公示|项目推介|办理结果|备案公示|施工许可|环评公示|拟推介)/i
const DATE_RE = /(20[0-9]{2})[年.\-/](1[0-2]|0?[1-9])[月.\-/](3[01]|[12][0-9]|0?[1-9])日?/

function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizedDate(match) {
  if (!match) return ''
  return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`
}

function officialProjectUrl(baseUrl, query = {}) {
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim()) url.searchParams.set(key, String(value).trim())
  }
  url.hash = ''
  return url.href
}

function safeJson(value) {
  try { return JSON.parse(String(value || '')) } catch (error) { return null }
}

function parseBeijingPromotionJson(text, source) {
  const payload = safeJson(text)
  const rows = payload && payload.page && Array.isArray(payload.page.list) ? payload.page.list : []
  const publicUrl = String(source && source.publicUrl || 'https://tzxm.beijing.gov.cn/proRecommend')
  return rows.map((row) => {
    const title = cleanText(row.PROJECT_NAME)
    const projectCode = cleanText(row.NATION_PROJECT_CODE || row.PROJECT_CODE)
    const publishedAt = cleanText(row.PROMOTION_TIME).replace(/年/g, '-').replace(/月/g, '').replace(/-([0-9])$/, '-0$1')
    const budget = row.TOTAL_INVSTMT || row.XMZJ ? `${cleanText(row.TOTAL_INVSTMT || row.XMZJ)}万元` : ''
    const region = cleanText(`北京${row.SITE_BELONGING || ''}`)
    const detailText = [
      `项目阶段：民间资本推介`, `项目名称：${title}`, projectCode && `项目代码：${projectCode}`,
      row.PROJECT_CODE && row.PROJECT_CODE !== projectCode && `北京项目代码：${cleanText(row.PROJECT_CODE)}`,
      row.INDUSTRY && `所属行业：${cleanText(row.INDUSTRY)}`, region && `建设地点：${region}`,
      row.ITEM_PROGRESS && `建设进度：${cleanText(row.ITEM_PROGRESS)}`, budget && `总投资：${budget}`,
      row.INSTRUCTION && `建设内容及规模：${cleanText(row.INSTRUCTION)}`,
      row.CONTACT && `项目联系人：${cleanText(row.CONTACT)}`,
      row.XMLXRDH && `联系电话：${cleanText(row.XMLXRDH)}`,
    ].filter(Boolean).join('\n')
    return {
      title,
      url: officialProjectUrl(publicUrl, { projectCode }),
      publishedAt,
      region,
      buyer: cleanText(row.CONTACT),
      listText: detailText,
      detailText,
      budget,
      projectCode,
      projectStage: 'promotion',
    }
  }).filter((row) => row.title && row.title.length >= 4)
}

function parseGuangdongPromotionJson(text, source) {
  const payload = safeJson(text)
  const rows = payload && payload.data && Array.isArray(payload.data.list) ? payload.data.list : []
  const publicUrl = String(source && source.publicUrl || 'https://tzxm.gd.gov.cn/zwtpages/publicityPages/project_promotion.html')
  return rows.map((row) => {
    const title = cleanText(row.projectName)
    const projectCode = cleanText(row.projectCode)
    const region = cleanText(`广东${row.admdivName || ''}`)
    const budget = row.totalMoney !== undefined && row.totalMoney !== null ? `${cleanText(row.totalMoney)}万元` : ''
    const dateMatch = cleanText(row.promotionTime).match(DATE_RE)
    const detailText = [
      '项目阶段：民间资本推介', `项目名称：${title}`, projectCode && `项目代码：${projectCode}`,
      row.theIndustryName && `所属行业：${cleanText(row.theIndustryName)}`, region && `建设地点：${region}`,
      budget && `总投资：${budget}`, row.contactName && `项目联系人：${cleanText(row.contactName)}`,
    ].filter(Boolean).join('\n')
    return {
      title,
      url: officialProjectUrl(publicUrl, { projectCode, projectId: row.projectId }),
      publishedAt: normalizedDate(dateMatch),
      region,
      buyer: cleanText(row.contactName),
      listText: detailText,
      detailText,
      budget,
      projectCode,
      projectStage: 'promotion',
    }
  }).filter((row) => row.title && row.title.length >= 4)
}

function parseGuangxiPromotionList(html, source) {
  const $ = cheerio.load(String(html || ''))
  const publicUrl = String(source && source.publicUrl || source && source.baseUrl || '')
  const result = []
  const seen = new Set()
  $('tr').each((index, element) => {
    const cells = $(element).find('td').map((cellIndex, cell) => cleanText($(cell).text())).get()
    if (cells.length < 6 || !DATE_RE.test(cells[0])) return
    const title = cells[1]
    const projectCode = cells[2]
    if (!title || title.length < 4 || !projectCode || seen.has(projectCode)) return
    const budget = cells[5] ? `${cells[5]}万元` : ''
    const detailText = [
      '项目阶段：民间资本推介', `项目名称：${title}`, `项目代码：${projectCode}`,
      cells[3] && `审批类型：${cells[3]}`, cells[4] && `所属行业：${cells[4]}`,
      '建设地点：广西', budget && `总投资：${budget}`, `推介时间：${cells[0]}`,
    ].filter(Boolean).join('\n')
    seen.add(projectCode)
    result.push({
      title,
      url: officialProjectUrl(publicUrl, { projectCode }),
      publishedAt: cells[0],
      region: '广西',
      buyer: '',
      listText: detailText,
      detailText,
      budget,
      projectCode,
      projectStage: 'promotion',
    })
  })
  return result.slice(0, 300)
}

function parseOfficialPlatformPage(html, source) {
  const $ = cheerio.load(String(html || ''))
  const allowedHosts = new Set(Array.isArray(source && source.allowedHosts) ? source.allowedHosts : [])
  const baseUrl = String(source && source.baseUrl || '')
  const region = String(source && source.region || '')
  const result = []
  const seen = new Set()
  $('a[href]').each((index, element) => {
    const anchor = $(element)
    const title = cleanText(anchor.attr('title') || anchor.text())
    if (title.length < 8 || title.length > 500 || !NOTICE_SIGNAL_RE.test(title)) return
    const href = cleanText(anchor.attr('href'))
    if (!href || /^(?:javascript:|mailto:|tel:|#)/i.test(href)) return
    let parsed
    try { parsed = new URL(href, baseUrl) } catch (error) { return }
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) return
    if (/\.(?:pdf|docx?|xlsx?|zip|rar)(?:$|\?)/i.test(parsed.pathname)) return
    parsed.hash = ''
    const url = parsed.href
    if (seen.has(url)) return
    const container = anchor.closest('li,tr,article,section,div')
    const listText = cleanText(container.length ? container.text() : title).slice(0, 1500)
    const dateMatch = listText.match(DATE_RE) || title.match(DATE_RE)
    seen.add(url)
    result.push({
      title,
      url,
      publishedAt: normalizedDate(dateMatch),
      region,
      buyer: '',
      listText,
    })
  })
  // 国投公开列表使用可点击表格行而不是 a[href]。只识别该已核验来源的固定 UUID
  // 参数，并在同一 HTTPS 主机内还原公开详情地址；不执行页面脚本。
  if (String(source && source.id || '') === 'public-web-sdic') {
    $('tr[onclick*="urlChange"]').each((index, element) => {
      const row = $(element)
      const action = cleanText(row.attr('onclick'))
      const args = action.match(/urlChange\(\s*['"]([a-f0-9-]{30,})['"]\s*,\s*['"]([a-f0-9-]{30,})['"]\s*\)/i)
      if (!args) return
      const cells = row.find('td').map((cellIndex, cell) => cleanText($(cell).text())).get()
      const title = cells.filter((value) => value.length >= 8 && NOTICE_SIGNAL_RE.test(value))
        .sort((a, b) => b.length - a.length)[0] || ''
      if (!title) return
      const parsed = new URL(`/cgxx/ggDetail?gcGuid=${encodeURIComponent(args[2])}&ggGuid=${encodeURIComponent(args[1])}`, baseUrl)
      if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname) || seen.has(parsed.href)) return
      const listText = cleanText(row.text()).slice(0, 1500)
      const dateMatch = listText.match(DATE_RE) || title.match(DATE_RE)
      seen.add(parsed.href)
      result.push({ title, url: parsed.href, publishedAt: normalizedDate(dateMatch), region, buyer: '', listText })
    })
  }
  return result.slice(0, 300)
}

function discoverOfficialListPages(html, source) {
  const $ = cheerio.load(String(html || ''))
  const allowedHosts = new Set(Array.isArray(source && source.allowedHosts) ? source.allowedHosts : [])
  const baseUrl = String(source && source.baseUrl || '')
  const rows = []
  const seen = new Set([baseUrl])
  $('a[href]').each((index, element) => {
    const anchor = $(element)
    const label = cleanText(anchor.attr('title') || anchor.text())
    if (!label || label.length > 40 || !LIST_SIGNAL_RE.test(label)) return
    if (label.length > 12 && /(项目|工程).*(公告|招标|采购|询价|磋商|谈判)/.test(label)) return
    const href = cleanText(anchor.attr('href'))
    if (!href || /^(?:javascript:|mailto:|tel:|#)/i.test(href)) return
    let parsed
    try { parsed = new URL(href, baseUrl) } catch (error) { return }
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) return
    if (/\.(?:pdf|docx?|xlsx?|zip|rar)(?:$|\?)/i.test(parsed.pathname)) return
    parsed.hash = ''
    const url = parsed.href
    if (seen.has(url)) return
    seen.add(url)
    rows.push({ url, label })
  })
  return rows.slice(0, 6)
}

module.exports = {
  NOTICE_SIGNAL_RE,
  LIST_SIGNAL_RE,
  parseOfficialPlatformPage,
  discoverOfficialListPages,
  parseBeijingPromotionJson,
  parseGuangdongPromotionJson,
  parseGuangxiPromotionList,
}
