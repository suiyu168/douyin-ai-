# 成蹊云 CRM 核心业务切片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏旧 Electron 软件的前提下，交付一个可独立启动的成蹊云 CRM 核心切片，贯通客户去重、权限、订单资金台账、知识版本与 AI 转人工、仪表盘及深色客服工作台。

**Architecture:** 新代码全部位于 `crm/`，使用 Node.js 内置模块实现模块化业务核心、SQLite 持久化和 HTTP API，浏览器工作台通过同源 API 访问。领域规则不依赖 UI 或数据库，便于后续把本地 SQLite 适配器替换为 PostgreSQL，并把 FastGPT/微信接入放入独立适配器。

**Tech Stack:** Node.js 24、CommonJS、`node:test`、`node:assert/strict`、`node:sqlite`、原生 HTTP、HTML/CSS/JavaScript。

**Spec:** `docs/superpowers/specs/2026-09-03-adult-education-crm-design.md`

## Global Constraints

- 旧 `app/`、`scripts/` 和 `test/` 作为只读迁移基线，本计划不得删除或改写其业务行为。
- CRM 必须可在 AI/FastGPT 不可用时继续人工处理会话。
- 投诉、退款、合同、付款异常、资格不确定、非标准优惠、敏感资料和承诺类问题必须转人工。
- 金额一律使用人民币分整数表示；已确认收款不可覆盖或删除，只能追加冲正或退款记录。
- 权限必须在服务端执行，前端隐藏按钮不构成权限控制。
- 只有已审核、已生效且未过期的知识版本可被自动回复引用。
- 测试数据必须是虚构数据，仓库不得包含真实客户资料、Cookie、密钥或支付凭据。
- UI 延续旧软件深色、左侧导航、卡片与状态徽章的视觉语言，但业务文案必须全部替换为成人学历提升 CRM。
- 客户、订单、会话和台账主键由服务端生成；客户端 requestId 只做幂等键，跨请求冲突必须拒绝而不是覆盖既有记录。
- Cookie、渠道令牌、模型密钥和支付凭据不得返回浏览器；日志只记录脱敏、截断后的结构化摘要并实施轮转。
- 后续 Excel/CSV 导出必须中和以 `=`、`+`、`-`、`@` 开头的公式单元格；备份前必须按数据库大小检查可用磁盘空间。

---

### Task 1: 客户身份标准化与去重决策

**Files:**
- Create: `crm/package.json`
- Create: `crm/src/domain/customer.js`
- Create: `crm/test/customer.test.js`

**Interfaces:**
- Produces: `normalizePhone(value) -> string`、`normalizeWechat(value) -> string`、`customerFingerprint(input) -> { phoneHash, wechatHash, idLast4Hash }`、`decideDuplicate(candidate, existing[]) -> { decision, customerId, reasons }`。
- `decision` 只能为 `create`、`merge`、`review`；手机号或微信号精确命中返回 `merge`，只有身份证后四位命中返回 `review`，没有强证据返回 `create`。

- [ ] **Step 1: 写手机号与微信号标准化失败测试**

  在 `crm/test/customer.test.js` 使用字面量断言：`+86 138-0013-8000` 规范为 `13800138000`，` wx_Alice ` 规范为小写 `wx_alice`，非法手机号规范为空串。

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

  Run: `node --test crm/test/customer.test.js`
  Expected: FAIL，错误包含 `Cannot find module '../src/domain/customer'`。

- [ ] **Step 3: 实现最小标准化函数并导出**

  `normalizePhone` 只接受规范后的 11 位中国大陆手机号；`normalizeWechat` 去除首尾空白并转小写，空值返回空串。

- [ ] **Step 4: 运行测试并确认标准化用例通过**

  Run: `node --test crm/test/customer.test.js`
  Expected: PASS。

- [ ] **Step 5: 写去重决策失败测试**

  覆盖四个字面量场景：同手机号合并、同微信号合并、只有身份证后四位相同进入人工复核、同昵称但强标识不同则新建；断言 `reasons` 明确列出命中字段。

- [ ] **Step 6: 运行测试并确认缺少去重实现而失败**

  Run: `node --test crm/test/customer.test.js`
  Expected: FAIL，失败断言指向 `customerFingerprint` 或 `decideDuplicate`。

- [ ] **Step 7: 使用 SHA-256 摘要实现指纹与决策**

  摘要输入必须包含固定字段前缀，防止手机号摘要与微信号摘要串域；空字段不得生成摘要。

- [ ] **Step 8: 运行客户测试**

  Run: `node --test crm/test/customer.test.js`
  Expected: 全部 PASS。

- [ ] **Step 9: 提交任务**

  Commit: `feat(crm): add customer identity and deduplication rules`

### Task 2: 服务端角色权限与数据范围

**Files:**
- Create: `crm/src/domain/authorization.js`
- Create: `crm/test/authorization.test.js`

**Interfaces:**
- Consumes: 客户对象中的 `ownerId`、`teamId` 和 `campusId`。
- Produces: `can(actor, action, resource) -> boolean`、`assertAllowed(actor, action, resource) -> void`、`maskSensitiveCustomer(customer, actor) -> customerView`。
- 角色固定为 `admin`、`supervisor`、`service`、`consultant`、`teacher`、`finance`；actor 可同时拥有多个角色，权限取并集但数据范围必须满足至少一条角色规则。

- [ ] **Step 1: 写权限拒绝优先测试**

  覆盖客服仅看本人客户、主管仅看本团队、咨询师仅看已分配客户、班主任仅看已分配学员、财务可看订单但不可看完整会话、管理员可管理组织；未列出的 action 必须拒绝。

- [ ] **Step 2: 运行测试并确认模块缺失失败**

  Run: `node --test crm/test/authorization.test.js`
  Expected: FAIL，错误包含 `Cannot find module '../src/domain/authorization'`。

- [ ] **Step 3: 实现显式动作矩阵与数据范围判断**

  不允许使用“管理员之外默认放行”；`assertAllowed` 拒绝时抛出带 `FORBIDDEN` code 的错误。

- [ ] **Step 4: 写敏感字段脱敏测试**

  没有 `customer.sensitive.read` 权限时手机号显示为 `138****8000`、身份证只显示后四位占位；财务可读取订单识别所需手机号但默认看不到完整会话正文。

- [ ] **Step 5: 实现脱敏并运行权限测试**

  Run: `node --test crm/test/authorization.test.js`
  Expected: 全部 PASS。

- [ ] **Step 6: 提交任务**

  Commit: `feat(crm): enforce role and data-scope authorization`

### Task 3: 追加式订单与资金台账

**Files:**
- Create: `crm/src/domain/finance.js`
- Create: `crm/test/finance.test.js`

**Interfaces:**
- Produces: `quoteOrder(input) -> order`、`appendLedgerEntry(order, entry) -> order`、`summarizeOrder(order, now) -> { agreed, receivable, received, refunded, reversed, outstanding, netReceived, overdue }`。
- 资金 entry 类型固定为 `payment`、`refund`、`reversal`、`adjustment`；每条包含唯一 `idempotencyKey`、整数 `amountCents`、`status` 和时间。

- [ ] **Step 1: 写订单金额与分期失败测试**

  使用手算字面量覆盖标价 1000000 分、批准优惠 50000 分、成交价 950000 分，两笔已确认收款后待收正确；未批准优惠必须抛出 `UNAPPROVED_DISCOUNT`。

- [ ] **Step 2: 运行测试并确认模块缺失失败**

  Run: `node --test crm/test/finance.test.js`
  Expected: FAIL，错误包含 `Cannot find module '../src/domain/finance'`。

- [ ] **Step 3: 实现订单报价与汇总**

  对所有金额执行 `Number.isSafeInteger` 和非负校验；只有 `confirmed` 台账项进入汇总。

- [ ] **Step 4: 写幂等、退款、冲正和逾期失败测试**

  重复 `idempotencyKey` 必须抛出 `DUPLICATE_LEDGER_ENTRY`；退款降低净回款但不改原收款；冲正单独累计；到期仍有待收时 `overdue=true`。

- [ ] **Step 5: 实现追加式台账并冻结旧条目副本**

  `appendLedgerEntry` 返回新订单对象，不修改输入对象；任何更新/删除 API 均不在本接口中出现。

- [ ] **Step 6: 运行资金测试**

  Run: `node --test crm/test/finance.test.js`
  Expected: 全部 PASS。

- [ ] **Step 7: 提交任务**

  Commit: `feat(crm): add append-only order ledger`

### Task 4: 知识版本与 AI 风险转人工

**Files:**
- Create: `crm/src/domain/ai-triage.js`
- Create: `crm/test/ai-triage.test.js`

**Interfaces:**
- Produces: `isKnowledgeActive(version, now) -> boolean`、`triageMessage(input) -> { mode, reasons, citations }`。
- `mode` 只能为 `auto_reply`、`suggestion`、`human_required`；没有有效引用或置信度低于 `0.75` 时为 `suggestion`，强制人工风险命中时无条件为 `human_required`。

- [ ] **Step 1: 写知识生效窗口失败测试**

  覆盖草稿、未审核、未来生效、已经失效和当前有效五种知识版本，只允许最后一种返回 `true`。

- [ ] **Step 2: 运行测试并确认模块缺失失败**

  Run: `node --test crm/test/ai-triage.test.js`
  Expected: FAIL，错误包含 `Cannot find module '../src/domain/ai-triage'`。

- [ ] **Step 3: 实现知识版本判定**

  日期统一解析为毫秒；无效日期不得被视为有效知识。

- [ ] **Step 4: 写自动回复、建议和强制人工失败测试**

  普通报名材料问答在置信度 `0.9` 且有有效引用时自动回复；无引用或 `0.74` 时只建议；投诉、退款、合同、付款异常、资格不确定、非标准优惠、身份证、保过和包毕业分别强制人工。

- [ ] **Step 5: 实现风险规则和优先级**

  风险命中优先于置信度与引用；`reasons` 返回稳定机器码，`citations` 只保留有效知识版本 ID。

- [ ] **Step 6: 运行 AI 分流测试**

  Run: `node --test crm/test/ai-triage.test.js`
  Expected: 全部 PASS。

- [ ] **Step 7: 提交任务**

  Commit: `feat(crm): add governed AI triage rules`

### Task 5: SQLite 持久化、审计和业务服务

**Files:**
- Create: `crm/src/storage/sqlite-store.js`
- Create: `crm/src/services/crm-service.js`
- Create: `crm/test/crm-service.test.js`

**Interfaces:**
- Consumes: Tasks 1-4 的所有领域接口。
- Produces: `createStore(dbPath)`、`createCrmService({ store, clock })`；service 暴露 `importCustomer`、`listCustomers`、`createOrder`、`appendPayment`、`triageConversation`、`dashboard`。
- 每个写操作必须接收 `actor` 和 `requestId`，并追加包含操作者、动作、对象、前后摘要、时间和 requestId 的审计事件。
- 所有实体 ID 由 service/store 生成；重复 requestId 返回原操作结果，任何跨请求实体 ID 冲突均返回错误且不得 UPSERT 覆盖业务载荷。

- [ ] **Step 1: 写迁移与跨重启持久化失败测试**

  使用临时 SQLite 文件创建客户和订单，关闭后重新打开，断言数据仍存在且迁移重复运行不报错。

- [ ] **Step 2: 运行测试并确认模块缺失失败**

  Run: `node --test crm/test/crm-service.test.js`
  Expected: FAIL，错误包含 `Cannot find module '../src/storage/sqlite-store'`。

- [ ] **Step 3: 建立最小表结构**

  建立 `customers`、`customer_identities`、`orders`、`ledger_entries`、`conversations`、`audit_events` 和 `metadata`；启用外键、WAL 和事务。

- [ ] **Step 4: 写服务权限、去重和审计失败测试**

  同一手机号跨批次导入只产生一个主客户并保留两条来源；越权列表被拒绝；每次导入、订单和资金写入均产生审计事件。

- [ ] **Step 5: 实现客户、订单与资金服务事务**

  所有去重判断和写入处于同一事务；`idempotencyKey` 在数据库中唯一；服务端生成实体 ID；服务端调用 Task 2 权限，不信任前端角色声明之外的数据范围。

- [ ] **Step 6: 写 AI 降级与仪表盘失败测试**

  AI 无引用时会话保存为 `suggestion`；风险消息保存为 `human_required`；仪表盘从订单和已确认台账计算客户数、成交额、实收、待收、退款和净回款。

- [ ] **Step 7: 实现会话保存和报表聚合**

  报表不得读取备注中的金额；每项汇总能返回底层订单 ID 集合用于追溯。

- [ ] **Step 8: 运行服务测试与全部 CRM 测试**

  Run: `node --test crm/test/*.test.js`
  Expected: 全部 PASS。

- [ ] **Step 9: 提交任务**

  Commit: `feat(crm): persist core workflow with audit trail`

### Task 6: 同源 HTTP API 与深色 CRM 工作台

**Files:**
- Create: `crm/src/http/server.js`
- Create: `crm/src/http/routes.js`
- Create: `crm/public/index.html`
- Create: `crm/public/styles.css`
- Create: `crm/public/app.js`
- Create: `crm/test/http.test.js`

**Interfaces:**
- Consumes: `createCrmService`。
- Produces: `createServer({ service, publicDir })`；提供 `/api/health`、`/api/dashboard`、`/api/customers`、`/api/orders`、`/api/ledger`、`/api/conversations/triage` 和静态工作台。
- 演示认证只接受服务端配置的 `x-demo-user` ID 并映射到内置虚构 actor；未知 ID 返回 401，不能由请求自行提交角色。

- [ ] **Step 1: 写健康检查、认证和越权失败测试**

  健康检查返回 200；无 `x-demo-user` 的业务请求返回 401；客服访问其他团队客户返回 403；错误响应结构固定为 `{ error: { code, message } }`。

- [ ] **Step 2: 运行测试并确认模块缺失失败**

  Run: `node --test crm/test/http.test.js`
  Expected: FAIL，错误包含 `Cannot find module '../src/http/server'`。

- [ ] **Step 3: 实现 JSON 路由、大小限制和统一错误边界**

  请求体上限 1 MiB；非 JSON 写请求返回 415；未知 API 返回 404；生产错误不返回堆栈。

- [ ] **Step 4: 运行 HTTP 测试并确认 API 用例通过**

  Run: `node --test crm/test/http.test.js`
  Expected: PASS。

- [ ] **Step 5: 按旧软件视觉语言建立工作台**

  左侧导航包含工作台、客户、AI 会话、报名学员、订单收款、报表、组织权限和知识库；主页卡片显示新增客户、待人工、成交额、实收和待收；客户表格显示阶段、负责人、下次跟进和脱敏手机号；状态徽章区分 AI 已回复、待人工确认和人工接管。

- [ ] **Step 6: 接入真实同源 API 并提供错误/空状态**

  页面不得硬编码业务统计；加载失败显示可重试提示，空列表显示引导文案；金额统一格式化为人民币。

- [ ] **Step 7: 增加静态资源与内容类型测试**

  断言 `/`、`/styles.css`、`/app.js` 返回正确内容类型，路径穿越请求返回 404。

- [ ] **Step 8: 运行 HTTP 与全部 CRM 测试**

  Run: `node --test crm/test/*.test.js`
  Expected: 全部 PASS。

- [ ] **Step 9: 提交任务**

  Commit: `feat(crm): add secure API and dark operations workspace`

### Task 7: 启动入口、虚构演示数据与交付说明

**Files:**
- Create: `crm/src/index.js`
- Create: `crm/src/demo/seed.js`
- Create: `crm/README.md`
- Modify: `package.json`
- Modify: `README.md`
- Test: `crm/test/smoke.test.js`

**Interfaces:**
- Consumes: `createStore`、`createCrmService`、`createServer`。
- Produces: 根命令 `pnpm crm:start`、`pnpm crm:test`；默认只监听 `127.0.0.1:4310`，可通过 `CRM_HOST`、`CRM_PORT`、`CRM_DATA_DIR` 覆盖。

- [ ] **Step 1: 写真实进程冒烟失败测试**

  在随机端口启动 `crm/src/index.js`，轮询 `/api/health`，断言 200 后优雅关闭；测试超时必须清理子进程。

- [ ] **Step 2: 运行测试并确认入口缺失失败**

  Run: `node --test crm/test/smoke.test.js`
  Expected: FAIL，错误指向入口不存在或健康检查不可达。

- [ ] **Step 3: 实现启动与优雅关闭**

  处理 `SIGINT`、`SIGTERM`，先停止 HTTP 再关闭 SQLite；数据目录不存在时安全创建，不接受项目根目录作为清理目标。

- [ ] **Step 4: 添加幂等虚构演示数据**

  只允许姓名 `演示学员一/二/三`、`13800000001/2/3` 和虚构订单；以固定种子键防止重复启动反复插入。

- [ ] **Step 5: 更新说明与根脚本**

  根 README 首段明确“成蹊云 CRM 正在 `crm/` 开发，旧抖音工具为 legacy 基线”；`crm/README.md` 写出启动、演示账号、数据位置、测试、当前完成范围和不得使用真实数据的警告。

- [ ] **Step 6: 运行冒烟、CRM 全套与旧系统回归**

  Run: `node --test crm/test/*.test.js && node --test test/*.test.js`
  Expected: 两套测试全部 PASS，0 fail。

- [ ] **Step 7: 检查语法、差异和秘密形态**

  Run: 对 `crm/**/*.js` 执行 `node --check`；运行 `git diff --check`；扫描 `.env`、token、password、cookie 和私钥形态，确认只有虚构测试值。

- [ ] **Step 8: 提交任务**

  Commit: `docs(crm): add runnable demo and operator guide`

## Plan Self-Review

- Spec coverage: 本切片覆盖客户去重、RBAC/脱敏、订单资金台账、AI 转人工与知识版本、审计、基础报表和可运行工作台；Excel 文件解析、真实 FastGPT、企业微信、个人微信、材料上传、完整审批和生产 PostgreSQL 留给后续独立计划。
- Placeholder scan: 占位词与含糊实施步骤扫描均无命中。
- Type consistency: Task 5 只消费 Tasks 1-4 明确导出的接口；Task 6 只消费 Task 5 的 service；Task 7 组合已定义的 store、service 和 server。
