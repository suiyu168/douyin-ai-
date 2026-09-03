#!/usr/bin/env node
'use strict'

/* ChatGPT 网页版批量生图工具（基于 camoufox-cli）
 * 用法: node gen.js [--retry-failed]
 * 读取文案txt(----分隔) -> 逐条发送「文案+约束词」-> 等待生成 -> 下载到 输出根目录/<时间戳>/NNN.png
 */

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const readline = require('readline')

/* ==================== 配置区 ==================== */
const PROMPTS_FILE = 'D:/buddy发文/20260810_165713/文案.txt'
const OUTPUT_ROOT = 'D:/gpt背景图'
const SESSION = 'chatgpt'
const PROFILE_DIR = path.join(__dirname, 'profile')
const CLI_JS = 'C:/Users/34632/.workbuddy/binaries/node/versions/22.22.2/node_modules/camoufox-cli/dist/cli.js'
const ADD_TEXT_PY = path.join(__dirname, 'add_text.py')
const PROGRESS_FILE = path.join(__dirname, 'progress.json')
const LOG_FILE = path.join(__dirname, 'gen.log')
const PROXY = 'http://127.0.0.1:7892'

process.env.NODE_USE_ENV_PROXY = '1'
process.env.http_proxy = PROXY
process.env.https_proxy = PROXY

const GEN_TIMEOUT_MS = 6 * 60 * 1000   // 单条生成超时
const POLL_INTERVAL_MS = 10000         // 轮询间隔
const MAX_SEND_ATTEMPTS = 3            // 发送/生成失败重试次数
const MAX_DOWNLOAD_ATTEMPTS = 3        // 下载失败重试次数
const IDLE_TIMEOUT_SEC = 7200          // camoufox daemon 空闲超时
const LOGIN_WAIT_MS = 10 * 60 * 1000   // 等用户手动登录的最长时间

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0'

/* ==================== 约束词（每条文案后面固定的要求） ==================== */
const SUFFIX = `你是一名工业工程现场摄影师。

你的任务是根据我提供的工程需求，生成一张真实的项目现场照片，用于工程厂家获客。

请严格遵守以下规则：

【核心目标】
生成的图片必须像工厂老板使用手机在现场随手拍摄，用来发给施工厂家咨询报价的照片。

图片展示的是：
"项目准备施工前的真实现场状态"

而不是：
"施工完成后的案例展示"。

【真实性要求】
1. 必须是真实手机摄影风格，不要商业摄影，不要宣传册风格。
2. 画面允许存在：
- 轻微杂乱
- 施工痕迹
- 普通工业环境
- 不完美的现场状态
3. 不要过度美化，不要像AI效果图。

【施工阶段要求】
根据需求判断当前阶段：

如果文案说：
"准备做、考虑做、想改造、寻找厂家、咨询方案"

则图片必须展示：
- 改造前现场
- 原始状态
- 存在问题的地方

禁止展示：
- 已施工完成
- 已安装完成设备
- 成品效果

【场景要求】
必须体现：
- 工程规模
- 行业属性
- 施工位置
- 当前问题

让专业厂家看到图片后，可以判断：
"这是一个真实项目，有施工需求。"

【禁止内容】
禁止生成：
- 效果图
- 3D渲染图
- 设计方案图
- 厂家宣传照片
- 完工案例展示
- 过度干净整洁的场景
- 大量文字
- 广告牌
- Logo

【人物要求】
如果出现人员：
- 普通工人或现场查看人员
- 穿普通工作服、安全帽
- 自然状态
- 不要摆拍

【设备要求】
设备可以出现：
- 原有生产设备
- 施工材料
- 测量工具
- 叉车
- 托盘
- 管线
- 施工准备物品

但不要出现：
- 正在施工完成后的新设备效果

【拍摄要求】
模拟：
普通手机拍摄

参数：
- 9:16竖屏比例
- 自然光
- 真实曝光
- 普通手机镜头视角
- 现场纪实感

【最终检查】
生成前请自行检查：

1. 这张图是否像老板发给厂家询价？
2. 是否能看出工程需求？
3. 是否没有提前出现施工成果？

如果不符合，请重新调整后生成。`

/* ==================== 工具函数 ==================== */

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`
  console.log(line)
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8') } catch (e) {}
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: -1, out: '', err: 'timeout' }), timeoutMs || 120000)
    execFile(process.execPath, [CLI_JS].concat(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(t)
      resolve({ code: err ? (err.code || -1) : 0, out: stdout || '', err: stderr || (err && err.message) || '' })
    })
  })
}

function runPy(args, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: -1, out: '', err: 'timeout' }), timeoutMs || 120000)
    execFile('python', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(t)
      resolve({ code: err ? (err.code || -1) : 0, out: stdout || '', err: stderr || (err && err.message) || '' })
    })
  })
}

function ccli(args, timeoutMs) {
  return runCli(['--session', SESSION, '--proxy', PROXY].concat(args), timeoutMs)
}

/* eval 表达式：返回 JSON 字符串；解析容错（CLI 输出 {data:{result:...}}） */
async function evalJs(expr, timeoutMs) {
  const r = await ccli(['--json', 'eval', expr], timeoutMs || 60000)
  if (r.code !== 0) return { ok: false, reason: 'cli-error', detail: (r.err || '').slice(0, 300) }
  const out = String(r.out).trim()
  if (!out) return { ok: false, reason: 'empty-output' }
  let s = out
  try {
    const j = JSON.parse(out)
    if (j && typeof j === 'object') {
      if (j.success === false) return { ok: false, reason: 'page-error', detail: (j.error || '').slice(0, 300) }
      if ('data' in j && j.data && 'result' in j.data) s = String(j.data.result)
      else if ('result' in j) s = String(j.result)
    }
  } catch (e) {}
  try {
    const v = JSON.parse(s)
    return { ok: true, value: v }
  } catch (e) {
    return { ok: false, reason: 'bad-json', raw: s.slice(0, 300) }
  }
}

function tsFolder() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(promptText, () => { rl.close(); resolve() })
  })
}

/* ==================== 核心流程 ==================== */

/* 1. 启动浏览器（后台 daemon，open 命令不退出） */
async function ensureBrowser() {
  const s = await ccli(['url'], 20000)
  if (s.code === 0 && s.out.includes('chatgpt')) {
    log('浏览器会话已存在，复用')
    return
  }
  log('启动 Camoufox 浏览器窗口...')
  const { spawn } = require('child_process')
  const args = ['--session', SESSION, '--headed', '--persistent', PROFILE_DIR, '--proxy', PROXY, '--timeout', String(IDLE_TIMEOUT_SEC), 'open', 'https://chatgpt.com/']
  const child = spawn(process.execPath, [CLI_JS].concat(args), { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 30; i++) {
    await wait(5000)
    const c = await ccli(['url'], 20000)
    if (c.code === 0 && c.out.includes('chatgpt')) {
      log('浏览器已打开 chatgpt.com')
      return
    }
  }
  log('浏览器启动超时，请检查代理/内核')
  process.exit(1)
}

/* 2. 检查登录态，未登录则等用户手动登录 */
async function ensureLogin() {
  const start = Date.now()
  while (Date.now() - start < LOGIN_WAIT_MS) {
    const r = await evalJs(`(function(){
      return JSON.stringify({auth: location.href.indexOf('/auth') >= 0 || location.href.indexOf('auth.openai.com') >= 0, hasComposer: !!document.querySelector('#prompt-textarea'), url: location.href.slice(0, 80)});
    })()`)
    if (r.ok && r.value) {
      const v = r.value
      if (v.hasComposer && !v.auth) {
        log('检测到已登录，继续')
        return true
      }
      if (v.auth) {
        log('检测到登录页面，请在弹出的浏览器窗口中登录 ChatGPT...（最多等 10 分钟）')
      }
    }
    await wait(5000)
  }
  log('等待登录超时，请重新运行脚本')
  process.exit(1)
}

/* 2.5 开新会话（清掉旧图，保证计数与文案严格对应） */
async function ensureFreshChat() {
  const r = await evalJs(`(function(){
    const el = Array.from(document.querySelectorAll('button, a')).find(e => {
      const t = ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.innerText || '')).toLowerCase();
      return t.indexOf('new chat') >= 0 || t.indexOf('new conversation') >= 0 || e.getAttribute('href') === '/';
    });
    if (el) { el.click(); return JSON.stringify({ok:true}); }
    return JSON.stringify({ok:false});
  })()`, 30000)
  if (r.ok && r.value && r.value.ok) {
    await wait(3000)
    log('已开新会话')
    return true
  }
  await wait(3000)
  return true
}

/* 3. 发送一条文案：execCommand 插入文本 + 点击发送按钮 */
async function sendPrompt(fullText) {
  const r = await evalJs(`(function(){
    const t = document.querySelector('#prompt-textarea');
    if (!t) return JSON.stringify({ok:false, reason:'no-composer'});
    t.focus();
    const text = ${JSON.stringify(fullText)};
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    return JSON.stringify({ok:true, len:text.length});
  })()`, 30000)
  if (!r.ok || !r.value || !r.value.ok) return { ok: false, reason: (r.value && r.value.reason) || r.reason }

  // 等待发送按钮激活，点击发送
  for (let i = 0; i < 12; i++) {
    await wait(1000)
    const c = await evalJs(`(function(){
      const b = document.querySelector('[data-testid="send-button"]');
      return JSON.stringify({exists: !!b, disabled: b ? b.disabled : null});
    })()`, 20000)
    if (c.ok && c.value && c.value.exists && !c.value.disabled) {
      const k = await evalJs(`(function(){
        const b = document.querySelector('[data-testid="send-button"]');
        if (!b || b.disabled) return JSON.stringify({ok:false});
        b.click();
        return JSON.stringify({ok:true});
      })()`, 20000)
      if (k.ok && k.value && k.value.ok) return { ok: true }
      return { ok: false, reason: 'click-fail' }
    }
  }
  return { ok: false, reason: 'send-button-timeout' }
}

/* 4. 统计已加载的生成图片数量 */
async function countGeneratedImgs() {
  const r = await evalJs(`(function(){
    const imgs = Array.from(document.querySelectorAll('main img')).filter(i => i.complete && i.naturalWidth > 0);
    return JSON.stringify(imgs.length);
  })()`, 30000)
  if (r.ok) return Number(r.value) || 0
  return 0
}

/* 5. 等一条生成完成（页面上出现新的已加载图片） */
async function waitGeneration(prevCount) {
  const start = Date.now()
  while (Date.now() - start < GEN_TIMEOUT_MS) {
    const n = await countGeneratedImgs()
    if (n > prevCount) return { ok: true, n }
    await wait(POLL_INTERVAL_MS)
  }
  return { ok: false, reason: 'timeout' }
}

/* 6. 从页面最新已加载图片 canvas 取 base64 存盘 */
async function downloadImgFromCanvas(filePath) {
  const res = await evalJs(`(function(){
    const imgs = Array.from(document.querySelectorAll('main img')).filter(i => i.complete && i.naturalWidth > 0);
    const img = imgs[imgs.length - 1];
    if (!img) return JSON.stringify({ok:false, reason:'no-img'});
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return JSON.stringify({ok:true, dataUrl: c.toDataURL('image/png')});
    } catch (e) {
      return JSON.stringify({ok:false, reason:String(e).slice(0,200)});
    }
  })()`, 512 * 1024 * 1024)
  if (!res.ok) return { ok: false, reason: res.reason }
  const j = res.value
  if (!j || !j.ok || !j.dataUrl) return { ok: false, reason: (j && j.reason) || 'no-dataurl' }
  const b64 = String(j.dataUrl).split(',')[1]
  if (!b64) return { ok: false, reason: 'bad-dataurl' }
  const buf = Buffer.from(b64, 'base64')
  if (!buf.length) return { ok: false, reason: 'empty-buf' }
  fs.writeFileSync(filePath, buf)
  return { ok: true, bytes: buf.length, ext: 'png' }
}

/* 7. 处理单条文案 */
async function processItem(item, index, outputDir) {  const text = item.text
  const fullText = text + '\n\n' + SUFFIX
  const num = String(index + 1).padStart(3, '0')

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    log(`[${num}] 发送（尝试 ${attempt}/${MAX_SEND_ATTEMPTS}）: ${text.slice(0, 30)}...`)
    const s = await sendPrompt(fullText)
    if (!s.ok) {
      log(`[${num}] 发送失败: ${s.reason}，刷新重试`)
      await ccli(['reload'], 30000)
      await wait(20000)
      continue
    }

    const prev = await countGeneratedImgs()
    const w = await waitGeneration(prev)
    if (!w.ok) {
      log(`[${num}] 生成超时（${GEN_TIMEOUT_MS / 60000}分钟），刷新重发`)
      await ccli(['reload'], 30000)
      await wait(20000)
      continue
    }

    log(`[${num}] 图片已生成，开始下载`)
    let dlOk = false
    for (let d = 1; d <= MAX_DOWNLOAD_ATTEMPTS && !dlOk; d++) {
      const filePath = path.join(outputDir, num + '.png')
      const dl = await downloadImgFromCanvas(filePath)
      if (dl.ok) {
        log(`[${num}] 下载完成: ${path.basename(filePath)} (${Math.round(dl.bytes / 1024)}KB)`)
        const at = await addTextToImage(filePath, text, item.textMode || 'full')
        if (at.ok) {
          log(`[${num}] 文案已叠加: ${at.mode}, ${at.position}, RGB(${at.color.join(',')})`)
        } else {
          log(`[${num}] 文案叠加失败: ${at.reason}（图片已保存，可后续补加）`)
        }
        return { status: 'done', file: path.basename(filePath) }
      }
      log(`[${num}] 下载失败(${d}): ${dl.reason}，重试`)
      await wait(10000)
    }
    log(`[${num}] 下载彻底失败，刷新后重发整条`)
    await ccli(['reload'], 30000)
    await wait(20000)
  }
  return { status: 'failed', error: 'attempts-exhausted' }
}

/* 7.5 给图片叠加文案（位置/颜色随机，mode: full|title|none） */
async function addTextToImage(filePath, text, mode) {
  const r = await runPy([ADD_TEXT_PY, filePath, text, filePath, mode], 60000)
  if (r.code !== 0) return { ok: false, reason: (r.err || '').slice(0, 200) }
  try {
    const j = JSON.parse(r.out.trim())
    return { ok: true, mode: j.mode || mode, position: j.position || '?', color: j.color || [] }
  } catch (e) {
    return { ok: false, reason: 'bad-output' }
  }
}

/* ==================== main ==================== */

async function main() {
  const retryFailed = process.argv.includes('--retry-failed')
  log('========== ChatGPT 批量生图开始 ==========')

  if (!fs.existsSync(PROMPTS_FILE)) {
    log('找不到文案文件: ' + PROMPTS_FILE)
    process.exit(1)
  }
  const raw = fs.readFileSync(PROMPTS_FILE, 'utf8')
  const texts = raw.split('----').map((s) => s.trim()).filter((s) => s.length > 0)
  log(`文案条数: ${texts.length}`)

  // 进度
  let progress = null
  if (fs.existsSync(PROGRESS_FILE)) {
    try { progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) } catch (e) { progress = null }
  }
  if (!progress || !progress.outputDir || !fs.existsSync(progress.outputDir)) {
    const ts = tsFolder()
    // 30% 的条目分配 title/none 模式（随机挑索引，保证比例稳定）
    const specialCount = Math.max(1, Math.round(texts.length * 0.3))
    const specialIdx = new Set()
    while (specialIdx.size < specialCount) {
      specialIdx.add(Math.floor(Math.random() * texts.length))
    }
    progress = {
      ts,
      outputDir: path.join(OUTPUT_ROOT, ts),
      items: texts.map((t, i) => {
        let textMode = 'full'
        if (specialIdx.has(i)) textMode = Math.random() < 0.5 ? 'title' : 'none'
        return { i, text: t, textMode, status: 'pending' }
      }),
    }
    fs.mkdirSync(progress.outputDir, { recursive: true })
    const mCount = {}
    progress.items.forEach((x) => (mCount[x.textMode] = (mCount[x.textMode] || 0) + 1))
    log(`输出目录: ${progress.outputDir}，模式分布: ${JSON.stringify(mCount)}`)
  } else {
    log(`恢复进度: ${progress.outputDir}（已处理 ${progress.items.filter((x) => x.status === 'done').length}/${progress.items.length}）`)
  }

  // 与文案条数对齐
  while (progress.items.length < texts.length) {
    progress.items.push({ i: progress.items.length, text: texts[progress.items.length], textMode: 'full', status: 'pending' })
  }

  await ensureBrowser()
  await ensureLogin()
  await ensureFreshChat()

  const todo = progress.items.filter((it) => it.status === 'pending' || (retryFailed && it.status === 'failed'))
  if (!todo.length) {
    log('没有待处理项（全部完成）。加 --retry-failed 重跑失败的。')
  }

  for (const it of todo) {
    const r = await processItem(it, it.i, progress.outputDir)
    it.status = r.status
    it.error = r.error || null
    if (r.file) it.file = r.file
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8')
  }

  const done = progress.items.filter((x) => x.status === 'done').length
  const failed = progress.items.filter((x) => x.status === 'failed')
  log(`========== 完成：${done}/${progress.items.length} ==========`)
  if (failed.length) {
    log(`失败 ${failed.length} 条: ` + failed.map((x) => String(x.i + 1).padStart(3, '0')).join(', '))
    log('重跑失败项: node gen.js --retry-failed')
  }
  log(`图片位置: ${progress.outputDir}`)
}

main().catch((e) => {
  log('运行异常: ' + (e && e.stack || e))
  process.exit(1)
})
