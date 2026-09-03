#!/usr/bin/env node
'use strict'

/* 一键导入：把文案批次 + 图片批次整合进发布助手批量发布页
 * 用法: node import-batch.js [--copy-dir <文案批次> --img-dir <图片批次>]
 * 默认取 D:\buddy发文 和 D:\gpt背景图 下各自最新的批次目录
 *
 * 流程: 读目录 -> 解析 标题.txt/文案.txt/话题.txt(----分隔) + NNN.png
 *      -> CDP 连发布助手(9225) -> 清空上次作品 -> 按作品添加图片/标题/文案/话题
 *      -> 切到批量发布页，用户确认后点发布
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const CDP_PORT = 9225
const COPY_ROOT = 'D:/buddy发文'
const IMG_ROOT = 'D:/gpt背景图'

/* ==================== 工具 ==================== */

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = ''
      r.on('data', (c) => d += c)
      r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } })
    }).on('error', rej)
  })
}

function latestDir(root) {
  const dirs = fs.readdirSync(root)
    .filter((n) => /^\d{8}_\d{6}$/.test(n) && fs.statSync(path.join(root, n)).isDirectory())
  if (!dirs.length) throw new Error(root + ' 下没有时间戳批次目录')
  dirs.sort((a, b) => b.localeCompare(a))
  return path.join(root, dirs[0])
}

/* 解析 ---- 分隔的文本文件 */
function splitParts(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return raw.split(/\r?\n----+\r?\n?/).map((x) => x.trim()).filter(Boolean)
}

function listImages(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|gif|bmp|webp)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((f) => path.join(dir, f))
}

/* ==================== CDP ==================== */

async function connect() {
  const targets = await getJson('http://127.0.0.1:' + CDP_PORT + '/json')
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url))
  if (!page) throw new Error('找不到发布助手主页面（应用在运行吗？端口 ' + CDP_PORT + '）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = {}
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id] }
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const send = (method, params) => new Promise((res) => {
    const mid = ++id
    pending[mid] = res
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  return { ws, send }
}

async function evalJS(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.result && r.result.exceptionDetails) {
    throw new Error('页面 JS 错误: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  }
  return r.result && r.result.result ? r.result.result.value : undefined
}

/* ==================== 主流程 ==================== */

async function main() {
  const args = process.argv.slice(2)
  let copyDir = null, imgDir = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--copy-dir') copyDir = args[++i]
    else if (args[i] === '--img-dir') imgDir = args[++i]
  }
  copyDir = copyDir || latestDir(COPY_ROOT)
  imgDir = imgDir || latestDir(IMG_ROOT)
  console.log('文案批次:', copyDir)
  console.log('图片批次:', imgDir)

  /* 1. 解析文案：标题按行，文案/话题按 ---- 分隔 */
  const titleRaw = fs.readFileSync(path.join(copyDir, '标题.txt'), 'utf8')
  const titles = titleRaw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  const copies = splitParts(path.join(copyDir, '文案.txt'))
  const tagLines = splitParts(path.join(copyDir, '话题.txt'))
  const n = Math.max(titles.length, copies.length, tagLines.length)
  if (!n) throw new Error('文案目录里没有解析到任何作品')
  console.log('作品数:', n, '(标题', titles.length, '/ 文案', copies.length, '/ 话题', tagLines.length, ')')

  /* 2. 图片：按作品子目录优先，其次拍平 NNN.png */
  const subDirs = fs.readdirSync(imgDir)
    .filter((x) => fs.statSync(path.join(imgDir, x)).isDirectory())
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  let postsImages = []
  if (subDirs.length >= n) {
    postsImages = subDirs.slice(0, n).map((d) => listImages(path.join(imgDir, d)))
    console.log('图片按子目录分组:', subDirs.length, '组')
  } else {
    const all = listImages(imgDir)
    postsImages = all.map((f) => [f])
    console.log('图片拍平分组:', all.length, '张')
  }

  /* 3. 校验数量 */
  const imgN = postsImages.length
  if (imgN < n) {
    console.warn('警告: 图片只有 ' + imgN + ' 张，但文案有 ' + n + ' 个作品，前 ' + imgN + ' 个作品将配图，其余无图')
  }

  /* 4. 组装注入数据 */
  const posts = []
  for (let i = 0; i < n; i++) {
    const imgs = postsImages[i] || []
    const p = {
      title: (titles[i] || '').trim(),
      desc: (copies[i] || '').trim(),
      tags: (tagLines[i] || '').trim(),
      images: imgs.map((p2) => ({
        path: p2.replace(/\//g, '\\'),
        url: 'file://' + p2.replace(/\\/g, '/'),
      })),
    }
    posts.push(p)
  }

  /* 5. CDP 注入 */
  console.log('连接发布助手:', CDP_PORT)
  const cdp = await connect()
  const dataB64 = Buffer.from(JSON.stringify(posts)).toString('base64')

  const result = await evalJS(cdp, `(async function(){
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(dataB64)}), (c) => c.charCodeAt(0))))
    if (typeof batchState === 'undefined') return { ok: false, err: 'batchState 未定义（页面未初始化完成）' }
    const prevCount = batchState.posts.length
    batchState.posts = data.map((p, i) => ({
      id: 'bp' + Date.now() + i,
      images: p.images || [],
      title: p.title || '',
      desc: p.desc || '',
      tags: p.tags || '',
      music: null,
    }))
    if (typeof renderBatchPosts === 'function') renderBatchPosts()
    if (typeof saveBatchState === 'function') saveBatchState()
    const navBtn = Array.from(document.querySelectorAll('.nav-item')).find((b) => b.dataset.page === 'batch')
    if (navBtn) navBtn.click()
    return { ok: true, prevCount: prevCount, count: batchState.posts.length }
  })()`)

  console.log('注入结果:', JSON.stringify(result))
  if (!result || !result.ok) throw new Error('注入失败: ' + JSON.stringify(result).slice(0, 200))

  const withImg = posts.filter((p) => p.images.length).length
  const without = posts.filter((p) => !p.images.length).length
  console.log('')
  console.log('========== 导入完成 ==========')
  console.log('总作品:', posts.length, '/ 带图:', withImg, '/ 无图:', without)
  console.log('已清空上次 ' + result.prevCount + ' 个作品')
  console.log('发布助手已切到批量发布页，请核对后点「批量发布」')
  console.log('注意: 音乐需要点「选择音乐」/「按分类随机」设置')
  cdp.ws.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exit(1)
})
