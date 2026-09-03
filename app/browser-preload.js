/* 内置浏览器 webview 的 guest preload：
 * 覆写 window.open / 拦截 target=_blank，把"新开页面"请求转发给主页面开标签页 */
'use strict'
try {
  window.__preloadRan = true
  const { ipcRenderer } = require('electron')
  const openTab = (url) => {
    if (url && !url.startsWith('about:')) {
      try { ipcRenderer.sendToHost('open-tab', url) } catch (e) {}
    }
  }
  try {
    window.open = function (url) {
      openTab(String(url || ''))
      return null
    }
  } catch (e) {}
  document.addEventListener(
    'click',
    (e) => {
      try {
        const t = e.target
        const a = t && t.closest ? t.closest('a[target="_blank"]') : null
        if (a) {
          e.preventDefault()
          e.stopPropagation()
          openTab(a.href)
        }
      } catch (err) {}
    },
    true
  )
} catch (e) {}
