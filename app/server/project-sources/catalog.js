'use strict'

// 省级入口以全国公共资源交易平台“平台导航”公布的官方地址为准。
// 每个入口只读取公开首页/公告列表，不登录、不绕过验证码；动态站点抓不到静态公告时由国家聚合源补位。
const PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS = [
  ['beijing', '北京', 'https://ggzyfw.beijing.gov.cn/', [
    ['https://ggzyfw.beijing.gov.cn/jyxxgcjszbjh/', '工程建设·招标计划'],
    ['https://ggzyfw.beijing.gov.cn/jyxxggjtbyqs/', '工程建设·招标公告'],
  ]],
  ['tianjin', '天津', 'https://ggzy.zwfwb.tj.gov.cn/'],
  ['hebei', '河北', 'https://szj.hebei.gov.cn/'],
  ['shanxi', '山西', 'https://prec.sxzwfw.gov.cn/'],
  ['inner-mongolia', '内蒙古', 'https://ggzyjy.nmg.gov.cn/'],
  ['liaoning', '辽宁', 'https://ggzy.ln.gov.cn/jyfb/', [
    ['https://ggzy.ln.gov.cn/jyfb/', '交易信息发布'],
  ]],
  ['jilin', '吉林', 'https://www.jl.gov.cn/', [
    ['https://www.jl.gov.cn/ggzy/ccsggzy/ccsjyxx/ccsgcjs/ccszbjh/', '长春·工程建设·招标计划'],
    ['https://www.jl.gov.cn/ggzy/ccsggzy/ccsjyxx/ccsgcjs/ccsgczbgg/', '长春·工程建设·招标公告'],
  ]],
  ['heilongjiang', '黑龙江', 'https://ggzyjyw.hlj.gov.cn/'],
  ['shanghai', '上海', 'https://www.shggzy.com/'],
  ['jiangsu', '江苏', 'https://jsggzy.jszwfw.gov.cn/', [
    ['https://jsggzy.jszwfw.gov.cn/jyxx/tradeInfonew.html', '交易信息'],
    ['https://jsggzy.jszwfw.gov.cn/tradeInfonew_sqt.html', '交易查询'],
  ]],
  ['zhejiang', '浙江', 'https://ggzy.zj.gov.cn/'],
  ['anhui', '安徽', 'https://ggzy.ah.gov.cn/'],
  ['fujian', '福建', 'https://ggzyfw.fujian.gov.cn/'],
  ['jiangxi', '江西', 'https://www.jxsggzy.cn/'],
  ['shandong', '山东', 'https://ggzyjy.shandong.gov.cn/'],
  ['henan', '河南', 'https://ggzy.fgw.henan.gov.cn/'],
  ['hubei', '湖北', 'https://www.hbggzyfwpt.cn/'],
  ['hunan', '湖南', 'https://www.hnsggzy.com/'],
  ['guangdong', '广东', 'https://ygp.gdzwfw.gov.cn/'],
  ['guangxi', '广西', 'https://ggzy.jgswj.gxzf.gov.cn/gxggzy/'],
  ['hainan', '海南', 'https://ggzy.hainan.gov.cn/ggzy/', [
    ['https://ggzy.hainan.gov.cn/ggzy/ggzy/index.htm', '全省交易公告'],
  ]],
  ['chongqing', '重庆', 'https://www.cqggzy.com/'],
  ['sichuan', '四川', 'https://ggzyjy.sc.gov.cn/'],
  ['guizhou', '贵州', 'https://ggzy.guizhou.gov.cn/'],
  ['yunnan', '云南', 'https://ggzy.yn.gov.cn/'],
  ['tibet', '西藏', 'https://ggzy.xizang.gov.cn/'],
  ['shaanxi', '陕西', 'https://www.sxggzyjy.cn/'],
  ['gansu', '甘肃', 'https://ggzyjy.gansu.gov.cn/'],
  ['qinghai', '青海', 'https://www.qhggzyjy.gov.cn/'],
  ['ningxia', '宁夏', 'https://ggzyjy.fzggw.nx.gov.cn/'],
  ['xinjiang', '新疆', 'https://ggzy.xinjiang.gov.cn/'],
  ['xpcc', '新疆兵团', 'https://ggzy.xjbt.gov.cn/'],
].map(([key, region, baseUrl, seedEntries = []]) => {
  const parsed = new URL(baseUrl)
  const seedUrls = seedEntries.map(([url, label]) => {
    const seed = new URL(url)
    if (seed.protocol !== 'https:' || seed.hostname !== parsed.hostname) {
      throw new Error(`省级官方入口 ${region} 的种子栏目不在同一 HTTPS 主机`)
    }
    return { url: seed.href, label }
  })
  return {
    id: `province-${key}`,
    name: `全国公共资源交易平台（${region}）`,
    region,
    baseUrl: parsed.href,
    type: 'province-home',
    maxPages: 1,
    allowedHosts: [parsed.hostname],
    seedUrls,
  }
})

const VERIFIED_PROJECT_HOSTS = new Set(
  PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS.flatMap((source) => source.allowedHosts)
)

// 非政府集中平台同样会发布大量公开工程商机。这里只接入无需登录、静态首页可核验、
// robots.txt 未禁止公开栏目读取的建设单位/央企采购平台；每轮仍按低频串行读取。
const PUBLIC_ORGANIZATION_PROJECT_SOURCES = [
  {
    id: 'public-web-sdic',
    name: '国投集团电子采购平台',
    region: '',
    baseUrl: 'https://www.sdicc.com.cn/',
    type: 'organization-home',
    maxPages: 1,
    allowedHosts: ['www.sdicc.com.cn'],
    seedUrls: [
      { url: 'https://www.sdicc.com.cn/cgxx/ggList', label: '招标公告' },
      { url: 'https://www.sdicc.com.cn/cgxx/ggList?ggXingZhi=2', label: '非招标公告' },
      { url: 'https://www.sdicc.com.cn/cgxx/planNoticeList', label: '招标计划' },
    ],
  },
  {
    id: 'public-web-ctg',
    name: '中国三峡集团电子采购平台',
    region: '',
    baseUrl: 'https://eps.ctg.com.cn/',
    type: 'organization-home',
    maxPages: 1,
    allowedHosts: ['eps.ctg.com.cn'],
    seedUrls: [
      { url: 'https://eps.ctg.com.cn/cms/channel/1ywgg1/index.htm', label: '招标公告' },
      { url: 'https://eps.ctg.com.cn/cms/channel/2ywgg1/index.htm', label: '采购公告' },
    ],
  },
  {
    id: 'public-web-sinomach',
    name: '国机集团电子采购平台',
    region: '',
    baseUrl: 'https://epp.sinomach.com.cn/',
    type: 'organization-home',
    maxPages: 1,
    allowedHosts: ['epp.sinomach.com.cn'],
    seedUrls: [
      { url: 'https://epp.sinomach.com.cn/zbzq/001001/tender_zone.html', label: '招标公告' },
      { url: 'https://epp.sinomach.com.cn/cgzq/002001/tender_zone.html', label: '采购公告' },
    ],
  },
  {
    id: 'public-web-chinasalt',
    name: '中盐集团电子采购平台',
    region: '',
    baseUrl: 'https://ecp.chinasalt.com.cn/',
    type: 'organization-home',
    maxPages: 1,
    allowedHosts: ['ecp.chinasalt.com.cn'],
    seedUrls: [
      { url: 'https://ecp.chinasalt.com.cn/zbcg/moreinfo.html', label: '招标采购专区' },
      { url: 'https://ecp.chinasalt.com.cn/zbcg/001001/zjcg_zbgg.html', label: '招标公告' },
    ],
  },
  {
    id: 'public-web-crp',
    name: '华润守正采购交易平台',
    region: '',
    baseUrl: 'https://www.szecp.com.cn/',
    type: 'organization-home',
    maxPages: 1,
    allowedHosts: ['www.szecp.com.cn'],
    seedUrls: [
      { url: 'https://www.szecp.com.cn/first_zbgg/index.html', label: '招标采购' },
      { url: 'https://www.szecp.com.cn/first_cggg/index.html', label: '非招标采购' },
    ],
  },
  {
    id: 'public-web-gxzb',
    name: '国信招标集团电子交易平台',
    region: '',
    baseUrl: 'https://ebid.gxzb.com.cn/',
    type: 'organization-home',
    maxPages: 1,
    allowedHosts: ['ebid.gxzb.com.cn'],
    seedUrls: [
      { url: 'https://ebid.gxzb.com.cn/biddingBulletin/index.html', label: '招标公告' },
      { url: 'https://ebid.gxzb.com.cn/cms/category/bulletinList.html?dates=300&categoryId=88&tabName=%E6%8B%9B%E6%A0%87%E6%8A%95%E6%A0%87&page=1', label: '公告公示' },
    ],
  },
]

for (const source of PUBLIC_ORGANIZATION_PROJECT_SOURCES) {
  const base = new URL(source.baseUrl)
  if (base.protocol !== 'https:' || !source.allowedHosts.includes(base.hostname)) {
    throw new Error(`公开组织采购入口 ${source.name} 不是已核验的 HTTPS 主机`)
  }
  for (const seed of source.seedUrls) {
    const parsed = new URL(seed.url)
    if (parsed.protocol !== 'https:' || !source.allowedHosts.includes(parsed.hostname)) {
      throw new Error(`公开组织采购入口 ${source.name} 的种子栏目不在同一 HTTPS 主机`)
    }
  }
  for (const host of source.allowedHosts) VERIFIED_PROJECT_HOSTS.add(host)
}

// 投资审批/民间资本推介属于招标之前的早期项目线索。这里只启用无需登录、无需验证码、
// 已验证可稳定返回公开项目清单的官方接口；带验证码的公开查询页只保留人工入口，不自动读取。
const EARLY_STAGE_PROJECT_SOURCES = [
  {
    id: 'investment-beijing-promotion',
    name: '北京市投资项目平台·民间资本推介',
    region: '北京',
    baseUrl: 'https://tzxm.beijing.gov.cn/proRecommend/queryRecommendData',
    publicUrl: 'https://tzxm.beijing.gov.cn/proRecommend',
    type: 'beijing-promotion-api',
    sourceStage: 'promotion',
    maxPages: 2,
    maxBackfillPages: 50,
    allowedHosts: ['tzxm.beijing.gov.cn'],
    seedUrls: [],
  },
  {
    id: 'investment-guangdong-promotion',
    name: '广东省投资项目平台·民间资本推介',
    region: '广东',
    baseUrl: 'https://tzxm.gd.gov.cn/tzxmspweb/api/ProCheck/promotionList',
    publicUrl: 'https://tzxm.gd.gov.cn/zwtpages/publicityPages/project_promotion.html',
    type: 'guangdong-promotion-api',
    sourceStage: 'promotion',
    maxPages: 1,
    allowedHosts: ['tzxm.gd.gov.cn'],
    seedUrls: [],
  },
  {
    id: 'investment-guangxi-promotion',
    name: '广西投资项目平台·拟推介项目',
    region: '广西',
    baseUrl: 'https://zxsp.fgw.gxzf.gov.cn/promotion/promotion-plan.jspx',
    publicUrl: 'https://zxsp.fgw.gxzf.gov.cn/promotion/promotion-plan.jspx',
    type: 'guangxi-promotion-list',
    sourceStage: 'promotion',
    maxPages: 2,
    maxBackfillPages: 100,
    allowedHosts: ['zxsp.fgw.gxzf.gov.cn'],
    seedUrls: [],
  },
]

for (const source of EARLY_STAGE_PROJECT_SOURCES) {
  const parsed = new URL(source.baseUrl)
  if (parsed.protocol !== 'https:' || !source.allowedHosts.includes(parsed.hostname)) {
    throw new Error(`早期项目官方入口 ${source.name} 不是已核验的 HTTPS 主机`)
  }
  for (const host of source.allowedHosts) VERIFIED_PROJECT_HOSTS.add(host)
}

const MANUAL_ONLY_PROJECT_SOURCES = [
  {
    id: 'investment-national-approval-query',
    name: '全国投资项目在线审批监管平台·办理结果公示',
    baseUrl: 'https://new.tzxm.gov.cn/bsdt/#gxframe',
    status: 'manual',
    compliance: '公开查询需要验证码；仅提供人工入口，系统不自动识别或绕过验证码',
  },
  {
    id: 'ccgp-purchase-intention',
    name: '中国政府采购网·采购意向公开',
    baseUrl: 'https://cgyx.ccgp.gov.cn/cgyx/pub/pubSearch',
    status: 'manual',
    compliance: '公开搜索需要验证码；仅提供人工入口，系统不自动识别或绕过验证码',
  },
]

module.exports = {
  PROVINCIAL_PUBLIC_RESOURCE_PLATFORMS,
  PUBLIC_ORGANIZATION_PROJECT_SOURCES,
  EARLY_STAGE_PROJECT_SOURCES,
  MANUAL_ONLY_PROJECT_SOURCES,
  VERIFIED_PROJECT_HOSTS,
}
