# 小V猫功能详细说明

> 本文档基于小V猫（原版 + 免费版改造）的代码与实测整理，覆盖完整功能清单、
> 页面结构、数据模型与已知边界。配套代码仓库见 `app/`（发布助手全新界面版）。

## 1. 产品定位

小V猫是**多平台自媒体账号管理 + 内容分发工具**（Electron 桌面应用）：
- 一个软件管理多个平台的账号（抖音/小红书/快手/视频号/公众号/B站等 18 个平台）
- 批量创作内容、批量分发到多账号、定时发布
- 账号防关联（指纹浏览器）、cookie 提取/续期
- 数据统计、评论互动（部分平台）、星图任务/商品带货（抖音）

原版为会员制（宝特云账号体系），免费版改造后免登录、恒定 VIP。

## 2. 支持的平台（18 个）

| platKey | 平台 | 登录页 | 发布能力 |
|---|---|---|---|
| Douyin | 抖音 | creator.douyin.com | 图文/视频 |
| BuYin | 抖店 | buyin.jinritemai.com | - |
| DouDian | 抖店 | fxg.jinritemai.com | - |
| Channels | 视频号 | channels.weixin.qq.com | 视频 |
| WxStore | 微信小店 | store.weixin.qq.com | - |
| GongZhongHao | 公众号 | mp.weixin.qq.com | 图文 |
| XiaoHongShu / Rednote | 小红书 | creator.xiaohongshu.com | 图文/视频 |
| KuaiShou | 快手 | cp.kuaishou.com | 图文/视频 |
| Bili | 哔哩哔哩 | passport.bilibili.com | 视频 |
| BaiJiaHao | 百家号 | baijiahao.baidu.com | - |
| TouTiao | 头条号 | mp.toutiao.com | - |
| XiGua | 西瓜视频 | studio.ixigua.com | 视频 |
| Zhihu | 知乎 | www.zhihu.com | 视频 |
| JDDR | 京东达人 | dr.jd.com | - |
| PDD | 拼多多 | live.pinduoduo.com | - |
| Goofish | 闲鱼 | www.goofish.com | - |
| Custom | 自定义 | 自定义 | - |

每个平台有独立图标、登录页、主页 URL；发布能力按 `canPostPic`（图文）/
`canPostVideo`（视频）标记过滤。

## 3. 功能模块（按页面路由）

### 3.1 发布中心
| 路由 | 功能 |
|---|---|
| `/publish/post` | 单作品发布（视频/图文选择） |
| `/publish/pics` | 图文发布（多图上传） |
| `/publish/batch` | **批量发布**（多作品 × 多账号） |
| `/publish/draft` | 草稿箱（保存/恢复） |
| `/publish/history` | 发布历史/任务记录 |

### 3.2 账号管理（`/account`）
| 子页 | 功能 |
|---|---|
| `/account?manage=group` | 账号分组 |
| `/account?manage=offline` | 离线账号 |
| `/account?manage=proxy` | 代理设置（批量添加/删除/设置代理 IP） |
| `/account?manage=tag` | 账号标签 |
| `/account?manage=verified` | 认证账号 |

账号操作：添加（webview 扫码登录自动识别）、删除、批量删除、批量隐藏、
批量导出、批量分配权限、同步登录、同步主账号备注、批量设置备注。

### 3.3 数据统计（`/data`）
| 路由 | 功能 |
|---|---|
| `/data/stat-overview` | 总览（发布数/成功数/成功率/今日） |
| `/data/stat-plat` | 按平台统计 |
| `/data/stat-account` | 按账号统计（创建/成功/失败） |
| `/data/stat-income` | 收益统计 |

### 3.4 监控（`/monitor`）
| 路由 | 功能 |
|---|---|
| `/monitor/account` | 账号监控 |
| `/monitor/flow` | 流量监控 |
| `/monitor/post` | 作品监控 |

### 3.5 评论互动（`/chat`）
| 路由 | 功能 |
|---|---|
| `/chat/comment` | 评论管理 |
| `/chat/msg` | 私信 |
| `/chat/reply-comment` | 回复评论 |
| `/chat/reply-msg` | 回复私信 |

### 3.6 作品管理（`/postlist`）
| 路由 | 功能 |
|---|---|
| `/postlist/local` | 本地作品 |
| `/postlist/online` | 在线作品 |
| `/postlist/posttask` | 发布任务 |

### 3.7 其他
| 路由 | 功能 |
|---|---|
| `/setting/notice` | 通知设置 |
| `/` | 首页（公告、会员状态、快捷入口） |

## 4. 发布表单字段（CAT_* 体系）

发布表单是"通用字段 + 平台专属字段"结构，前端用 `CAT_xxx` 命名，平台前缀
`Douyin_CAT_xxx` 等区分。

### 4.1 通用字段
| 字段 | 含义 |
|---|---|
| `CAT_title` | 标题（各平台长度限制不同） |
| `CAT_desc` | 简介/正文 |
| `CAT_tags` | 话题标签（最多 10 个） |
| `CAT_cover` / `CAT_cover2` | 封面（主/次，视频 4:3 等） |
| `CAT_timing` | 定时发布（`{type:1 立即 / 2 定时 / 3 本机定时}`） |
| `CAT_music` | 音乐（`{title, author, id_str, duration}`） |
| `CAT_comment` | 追评 |
| `CAT_mention` | @好友 |
| `CAT_poi` / `CAT_location` | 位置/POI |
| `CAT_collection` | 合集 |
| `CAT_declare` / `CAT_ORIGINAL_STATEMENT` | 自主声明/原创声明 |
| `CAT_interact` | 互动设置 |
| `CAT_settings` | 设置项（允许同帧/下载类型/关闭同城等） |
| `CAT_section` | 分段 |
| `CAT_topic` | 话题 |

### 4.2 抖音专属字段
| 字段 | 含义 |
|---|---|
| `Douyin_CAT_music` | 音乐（对应 `music_id` / `music_end_time`） |
| `Douyin_CAT_shop` | 商品（`shop` 链接类型/商品选择） |
| `Douyin_CAT_starTask` | 星图任务（订单选择/任务 ID） |
| `Douyin_CAT_linkType` | 标签类型（购物车/小店） |
| `Douyin_CAT_cover2` | 封面2（视频 4:3） |

### 4.3 快手/视频号/小红书专属
- 快手（KuaiShou）：`CAT_shortTitle`（短标题）、`CAT_download`（下载设置）、
  `CAT_hideType`、`CAT_visibility`、`CAT_sound_setting`（声音设置）、
  `CAT_skuIds`、`CAT_goods`
- 视频号（Channels）：`CAT_shortTitle`、`CAT_extReading`（扩展链接）、
  `CAT_event`（活动）、`CAT_groupChat`（群聊）、`followPostInfo`（关注后发帖）
- 小红书（XiaoHongShu/Rednote）：封面、标签、`CAT_isVertical`

### 4.4 其他平台字段
- 公众号（GongZhongHao）：`CAT_section`（分段）、`CAT_topic`
- 通用带货：`CAT_anchor`（锚点）、`CAT_game`（游戏）、`CAT_product`（商品）、
  `CAT_spu`、`CAT_associateTasks`（关联任务）、`CAT_bannerTask`（横幅任务）、
  `CAT_fanqieBook`（番茄小说）、`CAT_mixData`（混合数据，含 `mix_order`）

## 5. 批量发布（重点）

**批量发布页**（`/publish/batch`）是核心功能：

### 5.1 作品管理
- **批量添加作品**：选图片文件/整个文件夹/多个文件，自动按"图片数量/作品"
  分组（`imagesPerPost`）生成 N 个作品
- 作品列表可拖拽排序、增删
- 每个作品独立：图片、标题、正文、封面

### 5.2 批量设置（batchBarSetting）
顶部批量设置栏支持以下字段的**批量应用**：
- `title` 标题、`desc` 正文、`tags` 话题、`comment` 追评
- 抖音：`Douyin_CAT_music` 音乐、`Douyin_CAT_starTask` 星图任务

批量应用动作（5 种）：
| 动作 | 含义 |
|---|---|
| `same` | 同一值应用到所有作品 |
| `random` | 从候选列表随机抽取（可指定数量，默认 1） |
| `list` | 按列表逐条分配（第 i 个作品用第 i 个值） |
| `clean` | 清空该字段 |
| `open` | 打开配置弹窗 |

### 5.3 分发模式
- 多账号选择：每个作品发到选中的所有账号
- `publishOrder` 发布顺序：按文件顺序 / 按账号 / 按时间（`publishOrderWthTime`）
- 批量输入内容：一次粘贴多组内容（标题/正文），按行/分隔符拆分
- 批量顺序/批量随机：对作品顺序重排

### 5.4 批量创建任务
- `bulkCreateWithStat` 一次性创建 N×M 任务（作品×账号）
- 创建后自动 `startPublishTask` 后台排队执行
- `taskInitialStatus` 可配置初始状态

### 5.5 已知前端 Bug（批量同步丢音乐）
批量设置音乐时，前端 `commonToFormValues`（`WE` 函数）的字段转换列表只有
`title/cover/desc/tags/timing/comment`，**不含 music**——"一个账号选歌批量同步
到其他账号"时音乐会丢失，只有第一个账号的任务带音乐。
**新界面版已规避**：每个任务独立携带音乐字段。

## 6. 定时发布

- `CAT_timing` 支持三种：立即（type=1）、平台定时（type=2）、本机定时（type=3）
- 平台定时：`publishTime` 传给平台
- 本机定时：本地每 30s 扫描待发队列，到点自动触发（不依赖平台）
- 时间格式兼容：`{type,time:Date}` 对象 / ISO 字符串 / 数字时间戳
- 应用重启后恢复未到点的定时任务
- 中断遗留的 `publishing` 任务（无 finishTime）启动时重置为 `pending`

## 7. 音乐选择（抖音）

音乐弹窗（`Gx` 组件）：
- **分类标签**：推荐/热门榜/收藏/飙升榜/原创榜 + 卡点/纯音乐/旅行/DJ/搞笑/流行/伤感
- **列表**：歌曲（封面、歌名、作者、时长、使用量）、试听、分页加载
- **搜索**：关键词搜索（tsearch 接口）
- 选择后写入 `CAT_music`：`{id_str, title, author, duration, play_url}`
- 发布时按歌名搜索 → 点击"使用"选中

**音乐数据接口**（抖音站内，无需宝特云）：
| 接口 | 说明 |
|---|---|
| `getMusicCategory` | 分类列表（creator.douyin.com/web/api/media/music/category） |
| `getsongList` | 分类歌单（.../music/list?type=&category_id=&offset=） |
| `searchMusic` | 关键词搜索（tsearch.amemv.com，需 agw-auth signature） |

**已知边界**：
- "原声"类（title 形如 `@xxx创作的原声`）在音乐面板搜索不到（不在歌曲库）
- 抖音"推荐"分类第一项常是"原声"，点"使用"易点错行
- 搜不到目标歌时不盲目点推荐歌（修复后），记日志继续无音乐发布

## 8. 账号体系

### 8.1 登录
- webview 内嵌登录页（各平台官方登录页）扫码登录
- `AccountManager.listenSession` 每 2.5s 轮询分区 cookie：
  - 抖音：`sessionid`/`sessionid_ss` 存在即登录
  - 小红书：`web_session`；快手：`kuaishou.server.web_st`；
    视频号：`wxsid`；公众号：`appmsg_token`；B站：`SESSDATA`
- 检测到登录 → 自动提取 cookie → 保存账号 → 关闭登录窗
- 抖音自动补全真实昵称/头像（`syncDouyinAccountProfile`）、稳定数字 uid
  （`fetchDouyinUid`，扫码登录的 `uid_tt` 可能是 hash）

### 8.2 账号数据（accounts.json）
```
{ uid, platform, nickname, avatar, remark, group_id, proxy_id,
  partition, cookieData, cookies, isLogin, status, add_time, sub_name }
```
- `partition`：Electron 分区（`persist:xxxx`），隔离各账号登录态
- `cookieData`：会话 cookie 字符串（用于外部浏览器注入）

### 8.3 登录续航（云续航）
- `setTalentRenewal`：启用/关闭"登录续航"（后台保持登录态）
- `getTalentReviveCookie`：获取续航 cookie
- 达人/星图相关：`LoginAccount.getTalentReviveCookie` 等

### 8.4 会员/子账号体系
- VIP 购买、续费、到期提醒、子账号购买/分配权限
- 免费版恒定 VIP（2099-12-31），所有付费门槛不触发

## 9. 防关联浏览器

### 9.1 原版：比特浏览器（BitBrowser）
- 检测安装路径（含 localconfig 覆盖 `bitbrowserPath`）
- 每账号独立 profile：`--user-data-dir=userData/bitbrowser-profiles/<uid>`
- 随机调试端口（9300+）→ CDP 注入 cookie → 打开平台页
- **新界面版已移除**（改用 Camoufox）

### 9.2 免费版/新界面版：Camoufox（推荐）
- 开源防关联浏览器（Firefox 内核，MIT 协议，C++ 级指纹伪装）
- 每账号独立指纹环境：`camoufox-cli --session <uid> --persistent <profileDir> --headed`
  指纹首次生成后永久冻结
- 自动注入 cookie（JSON 文件 → `cookies import`）
- 支持 `--proxy` 代理 + 按代理 IP 自动伪装时区定位
- 安装：`npm install -g camoufox-cli` + `node patch-camoufox-cli.js`（Windows 修复）+
  `camoufox-cli install`（内核 ~500MB，国内可手动下载解压到
  `%LOCALAPPDATA%\camoufox\camoufox\Cache` + version.json）

## 10. 发布执行链路（抖音图文，核心）

发布任务由后端队列逐个执行（`runPublishQueue`）：
1. 用账号 `partition` 创建**隐藏窗口**打开
   `creator.douyin.com/creator-micro/content/post/image`（复用登录态）
2. CDP 真实鼠标点击上传区 + `Page.setInterceptFileChooserDialog` 拦截 +
   `DOM.setFileInputFiles` 注入本地图片（支持多图）
3. native setter 填标题（`input.semi-input`）、`innerText` 填正文（contenteditable）、
   话题以 `#话题` 追加到正文
4. 自动选音乐（带 `CAT_music` 时）：点击"选择音乐"→ 搜索框填歌名 + 回车 →
   匹配"使用"按钮 → 面板关闭即选中
5. 点击发布 → 监听 `did-navigate` 跳转作品管理页 = 成功（70s 超时保护）

任务状态：0 待发布 / 1 正在发布 / 2 已发布 / 3 已暂停 / 4 失败 / 6 本机定时等待

## 11. 任务记录与统计

- `Models.PublishLog.queryAll` → `{list, total}`（含标题/账号/状态/创建/完成时间）
- `Models.PublishTaskStat.querySummary` → `{overview, accountList, dailyList}`
  （总数/成功/失败/今日/成功率/按账号）
- 历史清理：`publishHistoryClearLogRange`（按状态+时间清理）

## 12. 数据文件（server 目录）

| 文件 | 内容 |
|---|---|
| `accounts.json` | 账号列表（uid/partition/nickname/cookieData…） |
| `publish-tasks.json` | 发布任务队列 |
| `localconfig.json` | 本地配置（批量设置栏、发布间隔等） |
| `publish.log` | 发布链路日志 |
| `bridge.log` | IPC 调用日志 |
| `music-debug.log` | 音乐接口失败日志 |
| `publish-probe.log` | 发布页侦察日志 |

## 13. 免费版 vs 新界面版（发布助手 vcat-neo）

| 维度 | 免费版（原前端） | 新界面版（vcat-neo） |
|---|---|---|
| 前端 | app.min.js 压缩 bundle（4.5MB） | 手写零依赖 HTML/JS/CSS |
| 界面 | 原版界面（浅色） | 全新深色（opencode 风格） |
| 宝特云 | 残留静态资源（图标/地区数据/公告） | **零依赖** |
| 平台 | 18 个 | 仅抖音 |
| 批量发布 | 完整（多作品×多账号） | 已支持多账号，批量作品 UI 待完善 |
| 评论互动/数据统计 | 有（多为空实现） | 未做 |
| 登录 | 免登录恒定 VIP | 同 |
| 防关联 | Camoufox | Camoufox |
| 账号添加 | webview 扫码自动识别 | 已实现（扫码弹窗） |
| 定时/音乐/任务 | 完整 | 完整 |

## 14. 已知问题与限制

1. **批量同步丢音乐**（原版前端 bug）：`commonToFormValues` 不含 music，
   批量分发只第一个账号带音乐（新界面版已规避）
2. **音乐"原声"搜不到**：`@xxx创作的原声` 不在歌曲库（平台限制）
3. **账号掉线检测未实现**：仅登录检测，logout 事件未接
4. **定时发布为本地定时**：不依赖抖音平台定时（type=3 时）
5. **多实例互踢**：应用名相同单实例锁互斥，不能与原版同时运行
6. **发布仅支持抖音图文**：视频/其他平台未实现自动化
7. **追评/置顶等发布页高级选项**：不自动设置（按页面默认）
8. **依赖抖音页面结构**：选择音乐/上传区选择器若抖音改版需同步调整
