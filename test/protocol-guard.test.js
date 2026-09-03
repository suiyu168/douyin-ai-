'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { isAllowedNavigation, getNavigationUrl, getProtocol, isAllowedDouyinWebUrl } = require('../app/protocol-guard')

test('允许普通网页协议并拦截抖音自定义协议', () => {
  assert.equal(isAllowedNavigation('https://www.douyin.com/video/123'), true)
  assert.equal(isAllowedNavigation('http://127.0.0.1:3000/'), true)
  assert.equal(isAllowedNavigation('about:blank'), true)
  assert.equal(isAllowedNavigation('blob:https://www.douyin.com/example'), true)
  assert.equal(isAllowedNavigation('bytedance://open/aweme'), false)
  assert.equal(isAllowedNavigation('snssdk1128://aweme/detail/123'), false)
  assert.equal(isAllowedNavigation('javascript:alert(1)'), false)
})

test('只允许项目目录内部的 file 页面', () => {
  const root = path.resolve(__dirname, '..', 'app')
  assert.equal(isAllowedNavigation(pathToFileURL(path.join(root, 'index.html')).href, { fileRoot: root }), true)
  assert.equal(isAllowedNavigation(pathToFileURL(path.resolve(root, '..', 'package.json')).href, { fileRoot: root }), false)
  assert.equal(isAllowedNavigation('https://www.douyin.com/', { fileRoot: root, allowWeb: false }), false)
})

test('兼容 Electron 新旧导航事件参数', () => {
  assert.equal(getNavigationUrl('bytedance://open'), 'bytedance://open')
  assert.equal(getNavigationUrl({ url: 'https://www.douyin.com/' }), 'https://www.douyin.com/')
  assert.equal(getProtocol('bytedance://open'), 'bytedance:')
})

test('登录弹窗只信任真实抖音域名而不是查询参数文本', () => {
  assert.equal(isAllowedDouyinWebUrl('https://creator.douyin.com/'), true)
  assert.equal(isAllowedDouyinWebUrl('https://www.amemv.com/auth'), true)
  assert.equal(isAllowedDouyinWebUrl('https://evil.example/?next=amemv.com'), false)
  assert.equal(isAllowedDouyinWebUrl('https://douyin.com.evil.example/'), false)
  assert.equal(isAllowedDouyinWebUrl('bytedance://creator.douyin.com/'), false)
})
