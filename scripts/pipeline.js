#!/usr/bin/env node
'use strict'

/* ============================================================
 * 一键全流程：文案生成 → 图片生成 → 导入发布助手 → 等用户确认发布
 *
 * 用法:
 *   node pipeline.js 24         生成 24 个作品（文案+图片+导入）
 *   node pipeline.js 24 --copy-only   只生成文案（不跑生图）
 *   node pipeline.js 24 --no-import  生成完不导入发布助手
 *   node pipeline.js --import-only   只导入（用最新文案+最新图片批次）
 *
 * 依赖（约定目录）:
 *   文案: D:\buddy发文\douinpictureword\gen_client.py --auto N
 *         输出 D:\buddy发文\<时间戳>\（文案.txt/标题.txt/话题.txt）
 *   图片: D:\chatgpt-gen\gen.js （读最新文案批次逐条生图）
 *         输出 D:\gpt背景图\<时间戳>\NNN.png
 *   导入: D:\chatgpt-gen\import-batch.js （CDP 注入发布助手 9225）
 * ============================================================ */

const { execFile, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const WORD_DIR = 'D:/buddy发文/douinpictureword'
const GEN_DIR = 'D:/chatgpt-gen'
const COPY_ROOT = 'D:/buddy发文'
const IMG_ROOT = 'D:/gpt背景图'

/* ==================== 工具 ==================== */

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    console.log('>>', cmd, args.join(' '))
    const c = spawn(cmd, args, Object.assign({ stdio: 'inherit', shell: false }, opts || {}))
    c.on('close', (code) => (code === 0 ? resolve(code) : reject(new Error(cmd + ' 退出码 ' + code))))
    c.on('error', (e) => reject(e))
  })
}

function latestDir(root, pat) {
  const dirs = fs.readdirSync(root).filter((n) => (pat || /^\d{8}_\d{6}$/).test(n) && fs.statSync(path.join(root, n)).isDirectory())
  if (!dirs.length) return null
  dirs.sort((a, b) => b.localeCompare(a))
  return path.join(root, dirs[0])
}

/* 检查依赖环境变量 */
function checkEnv() {
  const missing = ['DEEPSEEK_KEY', 'ZHIPU_KEY'].filter((k) => !process.env[k])
  if (missing.length) {
    console.warn('警告: 环境变量缺失 ' + missing.join(', ') + '（gen_client.py 可能无法调用大模型 API）')
  }
}

/* ==================== 主流程 ==================== */

async function main() {
  const args = process.argv.slice(2)
  const nArg = args.find((a) => /^\d+$/.test(a))
  const N = nArg ? parseInt(nArg, 10) : 24
  const copyOnly = args.includes('--copy-only')
  const noImport = args.includes('--no-import')
  const importOnly = args.includes('--import-only')

  if (importOnly) {
    console.log('== 仅导入 ==')
    await run('node', [path.join(GEN_DIR, 'import-batch.js')])
    return
  }

  console.log('========== 一键全流程（' + N + ' 个作品） ==========')

  /* 1. 生成文案 */
  if (!copyOnly) {
    console.log('')
    console.log('--- [1/3] 生成文案 ---')
    checkEnv()
    await run('python', ['gen_client.py', '--auto', String(N)], { cwd: WORD_DIR })
  }
  const copyDir = latestDir(COPY_ROOT)
  if (!copyDir) throw new Error('文案生成失败：' + COPY_ROOT + ' 下没有批次目录')
  console.log('文案批次:', copyDir)
  const copies = fs.readFileSync(path.join(copyDir, '文案.txt'), 'utf8')
  const nCopies = copies.split(/\r?\n----+\r?\n?/).map((x) => x.trim()).filter(Boolean).length
  console.log('文案段数:', nCopies)

  /* 2. 生成图片（gen.js 读最新文案批次） */
  if (!copyOnly) {
    console.log('')
    console.log('--- [2/3] 生成图片（' + nCopies + ' 张，耗时较长） ---')
    const genJs = path.join(GEN_DIR, 'gen.js')
    let gs = fs.readFileSync(genJs, 'utf8')
    const m = gs.match(/PROMPTS_FILE = '[^']*'/)
    if (m) gs = gs.replace(m[0], `PROMPTS_FILE = '${path.join(copyDir, '文案.txt').replace(/\\/g, '/')}'`)
    fs.writeFileSync(genJs, gs, 'utf8')
    await run('node', ['gen.js'], { cwd: GEN_DIR })
  }

  /* 3. 导入发布助手 */
  if (!noImport) {
    console.log('')
    console.log('--- [3/3] 导入发布助手 ---')
    await run('node', [path.join(GEN_DIR, 'import-batch.js')])
  }

  console.log('')
  console.log('========== 全流程完成 ==========')
  console.log('请到发布助手核对作品，点「批量发布」')
}

main().catch((e) => {
  console.error('流程失败:', e.message)
  process.exit(1)
})
