'use strict'

const path = require('node:path')
const { fileURLToPath } = require('node:url')

const SAFE_WEB_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'blob:', 'data:', 'devtools:'])
const DOUYIN_HOST_ROOTS = ['douyin.com', 'amemv.com', 'iesdouyin.com']

function isPathInside(filePath, rootPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function isAllowedNavigation(value, options = {}) {
  const raw = String(value || '').trim()
  if (!raw) return false
  let url
  try { url = new URL(raw) } catch (error) { return false }
  if (SAFE_WEB_PROTOCOLS.has(url.protocol)) return options.allowWeb !== false
  if (url.protocol !== 'file:' || !options.fileRoot) return false
  try { return isPathInside(fileURLToPath(url), options.fileRoot) } catch (error) { return false }
}

function getNavigationUrl(details) {
  if (typeof details === 'string') return details
  return String(details && (details.url || details.targetUrl) || '')
}

function getProtocol(value) {
  try { return new URL(String(value || '')).protocol || 'unknown:' } catch (error) { return 'invalid:' }
}

function isAllowedDouyinWebUrl(value) {
  let url
  try { url = new URL(String(value || '')) } catch (error) { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return DOUYIN_HOST_ROOTS.some((root) => host === root || host.endsWith('.' + root))
}

module.exports = { isAllowedNavigation, getNavigationUrl, getProtocol, isAllowedDouyinWebUrl }
