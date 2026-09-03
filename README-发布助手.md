# 发布助手（vcat-neo）

全新界面的抖音图文发布工具。独立于原小V猫，**完全不访问宝特云任何链接**，
界面全新（深色主题），仅支持抖音图文发布。

## 目录结构

```
D:\vcat-neo-app\            ← 可运行的应用（Electron 壳 + resources\app）
├── СVè.exe                 ← 启动入口（双击运行）
└── resources\app\
    ├── main.js             ← Electron 主进程（窗口/IPC/加载 server.js）
    ├── preload.js          ← contextBridge（CatBridge.getCall 桥）
    ├── index.html          ← 全新前端页面
    ├── assets\
    │   ├── style.css       ← 深色主题样式（opencode 风格）
    │   └── app.js          ← 前端逻辑（零依赖手写）
    └── server\
        ├── server.js       ← 后端核心（账号/发布/音乐/定时/任务）
        ├── accounts.json   ← 账号数据（沿用原小V猫）
        ├── publish-tasks.json ← 任务数据（沿用原小V猫）
        └── localconfig.json   ← 配置
```

开发源目录：`D:\vcat-neo\`（改代码后需复制到 vcat-neo-app\resources\app）。

## 与免费版的区别

- 界面全新（深色，opencode 风格），前端为手写零依赖 HTML/JS/CSS
- **已去除全部宝特云引用**（图标/头像/地区数据/公告/支付/VIP 入口）
- 只保留抖音图文发布（批量/定时/自动选音乐/任务记录）
- 账号与任务数据沿用原小V猫（首次运行时需复制 userData 登录态，见下）

## 登录态（重要）

Electron 的 `persist:xxx` 分区登录态存在 `%APPDATA%\vcat-neo\Partitions\`。
**从原版迁移**：把原版 `%APPDATA%\小V猫\Partitions` 的全部子目录复制到
`%APPDATA%\vcat-neo\Partitions`（覆盖合并）。复制前需关闭原版。

## 调试

- 调试端口固定 9225：`http://127.0.0.1:9225/json/list`
- 用 `cdp-call.js` 可注入脚本调试前端/后端接口
- 后端日志：`resources\app\server\publish.log`（发布链路）、`bridge.log`（IPC）、`music-debug.log`（音乐失败）

## 前端页面

- **发布**：选账号（多选卡片）→ 选图片 → 标题/正文 → 搜音乐 → 立即/定时 → 发布
- **账号**：账号列表、删除
- **任务**：任务记录（状态徽章：待发布/发布中/已发布/已暂停/失败/定时等待），10 秒自动刷新
- **设置**：发布间隔

## 说明

- 发布/定时/音乐等核心逻辑与免费版完全一致（同一份 server.js 裁剪而来）
- 定时发布为本地定时（不依赖抖音平台定时）
- 音乐选择失败时不阻断发布（无音乐发布），日志记录原因
