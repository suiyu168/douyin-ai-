# 知程云 CRM：报名、学员与跟进任务设计

## 1. 目标与范围

本迭代在现有 CRM 垂直切片上增加“报名申请 → 人工审批 → 建立学员 → 生成跟进任务”的可运行闭环。它继续使用当前模块化 Node.js 服务、SQLite 持久化、服务端演示身份、幂等写入和追加式审计，不引入新的运行时依赖。

本迭代交付：

- 咨询师为本人负责的客户提交报名申请。
- 主管在所属校区和团队内审批，管理员可全局审批。
- 审批通过时原子创建学员档案和首条跟进任务。
- 报名申请、学员和任务可按现有数据范围查询。
- 跟进任务支持有限、不可逆的状态流转和实时逾期判断。
- 工作台提供桌面和移动端均可使用的报名、学员和任务界面。

本迭代不交付：证件、合同或报名材料上传；生产登录；员工目录和任意人员改派；通用审批引擎；消息通知；任务重新打开或删除；重复报读多个项目；班主任分配；真实个人数据导入。

## 2. 采用方案

采用独立业务记录，而不是把报名和任务状态继续塞入客户 JSON，也不先建设通用工作流引擎：

- 报名申请保存报考意向和审批生命周期。
- 学员档案只关联客户和获批申请，不复制姓名、手机号、身份证等客户主数据。
- 跟进任务独立保存负责人、截止时间和当前状态。
- 每次写入继续由 CRM 服务统一完成权限校验、事务、审计和幂等结果保存。

这样能保持客户主档、招生审批、学员身份和执行待办各自职责单一，同时复用当前已验证的安全边界。

## 3. 角色与数据范围

所有权限都由服务端解析的 actor 和关联客户的 `campusId`、`teamId`、`ownerId` 判断。浏览器提交的角色、校区、团队、负责人、学员 ID、审批人和创建时间一律不可信。

| 动作 | 管理员 | 主管 | 咨询师 | 客服 | 班主任 | 财务 |
|---|---|---|---|---|---|---|
| 查看报名 | 全局 | 所属校区与团队 | 本人客户 | 否 | 否 | 否 |
| 提交报名 | 可以 | 否 | 本人客户 | 否 | 否 | 否 |
| 通过/拒绝报名 | 可以 | 所属校区与团队 | 否 | 否 | 否 | 否 |
| 查看学员 | 全局 | 所属校区与团队 | 否 | 否 | 分配给本人 | 否 |
| 查看任务 | 全局 | 所属校区与团队 | 本人负责的任务 | 本人负责的任务 | 否 | 否 |
| 创建任务 | 全局 | 所属校区与团队 | 本人客户 | 本人客户 | 否 | 否 |
| 更新/取消任务 | 全局 | 所属校区与团队 | 本人负责的任务 | 本人负责的任务 | 否 | 否 |

当前切片没有员工目录，因此客户端不能指定任务负责人。手工任务和审批生成的首条任务都由服务端取客户当前 `ownerId`。主管和管理员也不能在本迭代中把任务指派给任意字符串。

本地演示身份增加 `consultant-1`，仅用于回归和手工演示；`x-demo-user` 仍不是生产认证方式。

## 4. 数据模型与迁移

数据库 schema version 从 `1` 升到 `2`，迁移必须可重复执行，已有客户、来源、订单、台账、会话、审计和幂等结果不得变化。

### 4.1 `enrollment_applications`

结构字段：

- `id TEXT PRIMARY KEY`：服务端 UUID。
- `customer_id TEXT NOT NULL REFERENCES customers(id)`。
- `status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected'))`。
- `submitted_by TEXT NOT NULL`、`submitted_at TEXT NOT NULL`。
- `decided_by TEXT`、`decided_at TEXT`，待审批时为空，终态时非空。
- `payload TEXT NOT NULL`：只保存 `currentEducation`、`targetLevel`、`school`、`major`、`classType` 和拒绝原因。

为 `customer_id` 上的 `pending` 状态建立部分唯一索引，确保同一客户同时最多一条待审批申请。拒绝后允许新建下一条申请；已有学员的客户禁止再次提交。申请通过或拒绝后为终态，不能再次决定。

`targetLevel`、`school`、`major` 为必填非空字符串；`currentEducation`、`classType` 可为空。单字段最长 200 字符；拒绝原因必填且最长 500 字符。报名 payload 不接收身份证、手机号、自由备注、合同或材料正文。

### 4.2 `students`

结构字段：

- `id TEXT PRIMARY KEY`：服务端 UUID。
- `customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id)`。
- `enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollment_applications(id)`。
- `created_at TEXT NOT NULL`。
- `payload TEXT NOT NULL`：首版仅保存 `status: 'active'`。

学员展示时按 `customer_id` 读取当前客户主档并执行权限和脱敏；学生表不复制客户姓名、手机、身份证、校区、团队或负责人。

### 4.3 `follow_up_tasks`

结构字段：

- `id TEXT PRIMARY KEY`：服务端 UUID。
- `customer_id TEXT NOT NULL REFERENCES customers(id)`。
- `student_id TEXT REFERENCES students(id)`，普通售前任务可为空。
- `origin_type TEXT NOT NULL CHECK(origin_type IN ('manual', 'enrollment_approval'))`。
- `origin_id TEXT`：审批生成任务保存 enrollment ID，手工任务为空。
- `owner_id TEXT NOT NULL`：服务端取客户当前 `ownerId`。
- `due_at TEXT NOT NULL`：规范化 UTC ISO 时间。
- `status TEXT NOT NULL CHECK(status IN ('open', 'in_progress', 'completed', 'cancelled'))`。
- `payload TEXT NOT NULL`：仅保存任务标题。

为 `owner_id, status, due_at` 建立查询索引；为非空的 `origin_type, origin_id` 建立唯一约束，数据库层防止一次审批生成多条首任务。

审批生成的任务标题固定为“完成报名交接”，截止时间固定为审批时间后 24 小时，负责人固定为客户当前负责人。手工任务标题必填且最长 200 字符；截止时间必须是有效日期，浏览器不能提交 owner、status、studentId 或 origin 字段。

## 5. 状态与事务规则

### 5.1 报名

1. 咨询师或管理员提交申请。
2. 服务端重新加载客户并校验 `enrollment.submit` 权限。
3. 若已存在学员，返回 `STUDENT_EXISTS`；若已有待审批申请，返回 `ENROLLMENT_PENDING`。
4. 主管或管理员对待审批申请执行一次 `approved` 或 `rejected` 决定。
5. 拒绝时只更新申请终态并保存拒绝原因。
6. 通过时在一个 `BEGIN IMMEDIATE` 事务内更新申请、创建学员、创建首任务、写一条安全审计和保存幂等结果。任一步失败全部回滚。

并发决定由申请当前状态条件和唯一约束共同保护。不同 requestId 的第二次决定返回 `ENROLLMENT_ALREADY_DECIDED`；相同 requestId、actor 签名和动作返回第一次保存的逐字节结果，权限降级后重放仍须拒绝。

### 5.2 跟进任务

允许的状态转换：

- `open → in_progress`
- `open → completed`
- `open → cancelled`
- `in_progress → completed`
- `in_progress → cancelled`

`completed` 和 `cancelled` 是终态。相同状态、倒退、重新打开或未知状态返回 `INVALID_TASK_TRANSITION`，且不产生部分写入。

逾期不是持久状态。当 `status` 为 `open` 或 `in_progress` 且 `dueAt < clock()` 时，查询结果返回 `overdue: true`；等于当前时刻不算逾期。完成或取消的任务永不显示逾期。

## 6. 服务接口

`createCrmService()` 新增以下同步 JSON 安全接口：

- `submitEnrollment({ actor, requestId, customerId, enrollment })`，其中 enrollment 仅含 `currentEducation`、`targetLevel`、`school`、`major`、`classType`。
- `decideEnrollment({ actor, requestId, enrollmentId, decision })`，其中 decision 为 `{ status: 'approved' }` 或 `{ status: 'rejected', reason }`。
- `listEnrollments({ actor, scope? })`
- `listStudents({ actor, scope? })`
- `createFollowUpTask({ actor, requestId, customerId, task })`，其中 task 仅含必填 `title` 和 `dueAt`。
- `updateFollowUpTaskStatus({ actor, requestId, taskId, status })`
- `listFollowUpTasks({ actor, scope? })`

所有写方法复用当前 `write()` 的事务、审计、requestId 冲突和权限重放机制。`write()` 继续以关联 `customerId` 保存幂等结果，不改变现有全局 requestId 语义。

列表结果按关联客户的数据范围过滤，并只返回各模块固定 DTO。报名 DTO 返回申请字段、状态、提交/决定元数据，以及不含身份证和备注的客户摘要。任务 DTO 仅包含任务、客户和学员引用、标题、负责人、截止时间、状态和派生逾期值；不返回客户完整 payload。学员 DTO 返回学员字段及固定客户摘要 `{ id, name, maskedPhone, campusId, teamId, assignedTeacherId }`。新增的学生摘要函数必须先校验 `student.read`，所有角色看到的手机号均为掩码，且永不返回身份证、微信号或备注；它不能通过放宽通用 `customer.read` 来实现。

模块列表的 scope 校验必须使用对应的 `enrollment.read`、`student.read` 或 `task.read` 动作，不能复用并误信当前只判断 `customer.read` 的读取辅助函数。列表默认返回 actor 可见的全部状态，并按创建时间、ID 做确定性排序。

审计动作固定为 `enrollment.submit`、`enrollment.decide`、`task.create`、`task.status.update`。摘要只包含状态、是否创建学员/任务和安全的字段名列表，不包含报名 payload、拒绝原因、姓名、电话、身份证或任务标题。

## 7. HTTP 接口与错误

继续使用固定路径、精确方法和显式字段白名单：

- `GET|POST /api/enrollments`
- `POST /api/enrollment-decisions`
- `GET /api/students`
- `GET|POST /api/follow-up-tasks`
- `POST /api/follow-up-task-status`

GET 只接受当前 `campusId`、`teamId`、`ownerId` scope 查询参数。POST 不接受查询参数，请求体只映射对应服务接口拥有的字段。未知字段被丢弃，原型对象、数组、超大 JSON 和错误媒体类型沿用当前安全错误包络。

业务冲突 `ENROLLMENT_PENDING`、`STUDENT_EXISTS`、`ENROLLMENT_ALREADY_DECIDED`、`INVALID_TASK_TRANSITION` 返回 HTTP 409；输入错误返回 400，未认证返回 401，越权返回 403，不存在返回 404。错误响应不包含路径、堆栈、数据库文本或业务 payload。

## 8. 工作台设计

启用现有“报名学员”导航，增加三个紧凑区域：

1. 待审批报名：显示经权限过滤的客户识别信息、报考层次、院校、专业、班型和提交时间。咨询师可提交；主管和管理员可通过或填写原因后拒绝。
2. 已建档学员：显示学员编号、经权限处理的客户信息、来源申请和建档时间。
3. 跟进任务：卡片显示标题、客户、负责人、截止时间、状态和逾期标记，并提供当前角色允许的下一状态按钮。

桌面端可采用网格或表格，940px 以下切换为卡片；不得依赖水平滚动才能完成审批或更新任务。日期使用 `<time datetime>` 和本地化文本。提交期间按钮禁用，结果写入现有 `role=status` 区域；请求代次继续防止慢响应覆盖新状态。所有外部文本通过 DOM 文本节点渲染，禁止拼接 `innerHTML`。

## 9. 仪表盘

现有 dashboard 增加三个可追溯指标：

- `pendingEnrollmentCount` 与对应 enrollment IDs。
- `studentCount` 与对应 student IDs。
- `openTaskCount`、`overdueTaskCount` 与对应 task IDs；`openTaskCount` 统计 `open` 和 `in_progress` 两种非终态。

指标只统计 actor 实际可读取的关联客户和模块，不从客户备注或页面状态推断。任务逾期使用与列表相同的实时规则。

## 10. 测试与验收

所有生产行为遵循测试先行，并至少覆盖：

- schema version 1 数据库无损升级到 2，重复打开不重复迁移。
- 咨询师只能提交本人客户；主管不能跨校区或团队审批；浏览器伪造角色、owner、状态和 ID 无效。
- 缺少必填字段、超长字段、非法日期、非法决定和原型输入全部无写入。
- 同一客户最多一条待审批、最多一名学员；拒绝后可重新提交。
- 通过审批原子创建学员和一条首任务；UUID 冲突、审计失败、request result 失败和并发审批全部回滚或只成功一次。
- 相同 requestId 重放逐字节一致，跨 actor、跨动作和权限降级重放失败。
- 任务状态转换矩阵、终态、逾期边界和重启持久化正确。
- 列表与 dashboard 按实际权限过滤，任务 DTO 和审计不泄露客户或报名敏感字段。
- HTTP 路由方法、字段白名单、状态码和安全错误包络正确。
- 工作台按钮权限、提交中状态、无障碍状态反馈、移动端卡片和安全文本渲染正确。
- CRM 全量测试和旧 Electron 95 项回归全部通过。

验收演示使用虚构数据完成：咨询师提交 → 主管拒绝 → 咨询师重新提交 → 主管通过 → 学员出现 → 首任务进入处理中并完成；刷新和重启后结果不重复、不丢失。

## 11. 安全与后续边界

- 当前 SQLite 是本地可验收适配器，不替代后续 PostgreSQL、加密字段和生产身份认证。
- 不在审计、日志、任务列表或 dashboard 中保存完整客户 payload。
- 不提供报名、学员、任务或审计删除接口。
- 不自动发送微信消息，不上传真实材料，不接受真实支付或身份数据。
- 员工目录、任务改派、班主任工作台、材料清单、对象存储、通知和通用审批流留到后续独立设计。
