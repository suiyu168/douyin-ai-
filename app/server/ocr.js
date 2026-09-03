'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createWorker, OEM } = require('tesseract.js')

function defaultModelDir() {
  if (process.env.VCAT_OCR_MODEL_DIR) return path.resolve(process.env.VCAT_OCR_MODEL_DIR)
  if (process.platform === 'win32' && fs.existsSync('D:\\')) return 'D:\\小V猫数据\\抖音自动化\\OCR'
  return path.join(process.cwd(), 'data', 'ocr')
}

class LocalOcr {
  constructor(options = {}) {
    this.modelDir = path.resolve(options.modelDir || defaultModelDir())
    this.cacheDir = path.join(this.modelDir, 'cache')
    this.workerPromise = null
    this.queue = Promise.resolve()
  }

  getInfo() {
    const model = path.join(this.modelDir, 'chi_sim.traineddata.gz')
    return { available: fs.existsSync(model), modelDir: this.modelDir, engine: 'Tesseract.js 本地中文模型' }
  }

  async getWorker() {
    if (this.workerPromise) return this.workerPromise
    const info = this.getInfo()
    if (!info.available) throw new Error(`OCR 中文模型不存在：${info.modelDir}`)
    fs.mkdirSync(this.cacheDir, { recursive: true })
    this.workerPromise = createWorker('chi_sim', OEM.LSTM_ONLY, {
      langPath: this.modelDir,
      cachePath: this.cacheDir,
      cacheMethod: 'readOnly',
      gzip: true,
    }).catch((error) => {
      this.workerPromise = null
      throw error
    })
    return this.workerPromise
  }

  recognize(imagePath) {
    const rawPath = String(imagePath || '').trim()
    if (!rawPath) return Promise.reject(new Error('请选择存在的图片文件'))
    const resolved = path.resolve(rawPath)
    if (!fs.existsSync(resolved)) return Promise.reject(new Error('请选择存在的图片文件'))
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) return Promise.reject(new Error('OCR 仅支持图片文件'))
    if (stat.size > 25 * 1024 * 1024) return Promise.reject(new Error('图片不能超过 25MB'))
    if (!/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(resolved)) return Promise.reject(new Error('仅支持 PNG、JPG、WEBP、BMP、TIFF 图片'))

    const job = this.queue.then(async () => {
      const worker = await this.getWorker()
      const result = await worker.recognize(resolved)
      return { text: String(result && result.data && result.data.text || '').trim(), confidence: Number(result && result.data && result.data.confidence || 0) }
    })
    this.queue = job.catch(() => {})
    return job
  }

  async close() {
    if (!this.workerPromise) return
    try { await (await this.workerPromise).terminate() } catch (error) {}
    this.workerPromise = null
  }
}

module.exports = { LocalOcr, defaultModelDir }
