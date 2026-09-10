# 知程云知识库与客服答疑工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可运行、可测试的本地知识库闭环，让受权人员创建、审核、发布和失效资料，让客服会话只引用当前有效资料，并安全处理待确认与人工接管队列。

**Architecture:** 新增独立知识领域模块和 SQLite v3 迁移，CRM 服务继续统一权限、事务、全局幂等与审计。HTTP 层只暴露白名单字段；浏览器不能提交置信度或引用。现有无框架深色工作台通过同源 API 管理知识和会话，真实 FastGPT 保留为后续受信任适配器。

**Tech Stack:** Node.js 24、CommonJS、`node:sqlite`、`node:test`、原生 HTTP、原生 HTML/CSS/JavaScript。

**Spec:** `docs/superpowers/specs/2026-09-10-knowledge-support-workbench-design.md`

## Global Constraints

- 只使用虚构演示资料和虚构客户消息，禁止写入真实身份、合同、付款或学员数据。
- 分类固定为 `policy`、`product`、`script`、`risk`、`excellent_conversation`。
- 知识版本固定状态为 `draft`、`pending_review`、`approved`、`rejected`、`published`、`expired`。
- 标题最多 200 字符，正文最多 20,000 字符，关键词最多 30 个且每个最多 80 字符。
- 检索最多返回 5 条；先按命中关键词数降序，再按发布时间降序、稳定 ID 升序。
- 浏览器不能提交模型置信度、引用、审核人、发布时间或知识状态。
- 风险规则优先于知识命中；本地无可信模型置信度时不得产生 `auto_reply`。
- 不增加运行时依赖，不改 legacy 应用，不更名现有工作树、分支、数据库路径或幂等前缀。
- 每个任务先运行直接相关的测试；只在最终里程碑运行 CRM 与 legacy 全量回归。

## File Structure

- Create `crm/src/domain/knowledge.js`: 知识输入、版本状态机、有效期与稳定关键词检索。
- Create `crm/src/domain/conversation.js`: 人工处理状态初始化与合法转换。
- Create `crm/test/knowledge.test.js`: 知识领域的边界和恶意输入测试。
- Create `crm/test/conversation.test.js`: 会话处理状态测试。
- Modify `crm/src/storage/sqlite-store.js`: v2→v3 迁移、知识表和通用幂等结果资源引用。
- Modify `crm/test/storage.test.js`: v3 结构、迁移、回滚和重开测试。
- Modify `crm/src/domain/authorization.js`: 全局知识权限和 scoped 会话处理权限。
- Modify `crm/test/authorization.test.js`: 各角色知识/会话权限矩阵。
- Modify `crm/src/services/crm-service.js`: 知识生命周期、检索、会话列表和处理服务。
- Modify `crm/test/crm-service.test.js`: 事务、幂等、审计、DTO、检索和会话闭环。
- Modify `crm/src/http/routes.js`: 知识和会话 API、筛选白名单与错误映射。
- Modify `crm/test/http.test.js`: HTTP 合约、字段剥离和方法约束。
- Modify `crm/public/index.html`: 启用知识库导航、知识管理区和会话队列区。
- Modify `crm/public/app.js`: 知识/会话加载、渲染和操作。
- Modify `crm/public/styles.css`: 知识与会话组件的深色响应式样式。
- Modify `crm/test/enrollment.test.js`: 扩展现有工作台 DOM 验收，确保新增模块不破坏报名流程。
- Modify `crm/src/demo/seed.js`: 用服务接口写入一条已发布虚构政策和一条人工会话。
- Modify `crm/test/smoke.test.js`: 重启幂等和用户可见闭环。
- Modify `crm/README.md`, `README.md`, `docs/WORK_STATUS.md`: 操作说明、边界与交接。

---

### Task 1: 知识领域规则

**Files:**
- Create: `crm/src/domain/knowledge.js`
- Create: `crm/test/knowledge.test.js`

**Interfaces:**
- Produces: `normalizeKnowledgeDraft(input)` → 冻结的规范化草稿。
- Produces: `createKnowledgeVersion({ id, entryId, versionNumber, draft, actorId, now })` → `draft` 版本。
- Produces: `transitionKnowledgeVersion(version, { action, actorId, now, reason? })` → 新版本快照。
- Produces: `isKnowledgeVersionActive(version, now)` → boolean。
- Produces: `searchActiveKnowledge(versions, { message, now, limit? })` → 排序后的版本数组。
- Produces constants: `KNOWLEDGE_CATEGORIES`, `KNOWLEDGE_STATUSES`。

- [ ] **Step 1: Write failing normalization and state tests**

```js
test('normalizes a bounded draft without trusting inherited fields', () => {
  const input = Object.assign(Object.create({ status: 'published' }), {
    category: 'policy', title: ' 报名材料 ', body: ' 身份材料仅由人工核验。 ',
    source: '虚构政策手册', keywords: [' 材料 ', '报名', '材料'],
    effectiveAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z'
  });
  assert.deepEqual(normalizeKnowledgeDraft(input), {
    category: 'policy', title: '报名材料', body: '身份材料仅由人工核验。',
    source: '虚构政策手册', keywords: ['材料', '报名'],
    effectiveAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z'
  });
});

test('enforces the review and publication state machine', () => {
  const draft = createKnowledgeVersion({ id: 'v1', entryId: 'e1', versionNumber: 1,
    draft: validDraft(), actorId: 'supervisor-a', now });
  const pending = transitionKnowledgeVersion(draft, { action: 'submit', actorId: 'supervisor-a', now });
  assert.throws(() => transitionKnowledgeVersion(pending, { action: 'approve', actorId: 'supervisor-a', now }), hasCode('SELF_REVIEW_FORBIDDEN'));
  const approved = transitionKnowledgeVersion(pending, { action: 'approve', actorId: 'admin-1', now });
  const published = transitionKnowledgeVersion(approved, { action: 'publish', actorId: 'admin-1', now });
  assert.equal(published.status, 'published');
  assert.equal(isKnowledgeVersionActive(published, now), true);
});
```

- [ ] **Step 2: Run the new domain tests and verify RED**

Run: `node --test test/knowledge.test.js`

Expected: FAIL because `../src/domain/knowledge` does not exist.

- [ ] **Step 3: Implement normalization, transitions, and active dates**

```js
const KNOWLEDGE_CATEGORIES = Object.freeze(['policy', 'product', 'script', 'risk', 'excellent_conversation']);
const KNOWLEDGE_STATUSES = Object.freeze(['draft', 'pending_review', 'approved', 'rejected', 'published', 'expired']);
const TRANSITIONS = Object.freeze({
  submit: ['draft', 'pending_review'], approve: ['pending_review', 'approved'],
  reject: ['pending_review', 'rejected'], publish: ['approved', 'published'],
  expire: ['published', 'expired']
});
```

Implement own-data-property reads, strict length checks, ISO date conversion, `expiresAt > effectiveAt`, keyword trim/deduplication, immutable returned arrays, self-review rejection, and metadata snapshots for submit/review/publish/expire.

- [ ] **Step 4: Add failing stable-search tests**

```js
test('searches only active versions with stable bounded ranking', () => {
  const matches = searchActiveKnowledge([
    published('b', ['报名'], '2026-09-02T00:00:00Z'),
    published('a', ['报名', '材料'], '2026-09-01T00:00:00Z'),
    expired('x', ['报名', '材料', '流程'])
  ], { message: '报名材料是什么', now, limit: 5 });
  assert.deepEqual(matches.map(item => item.id), ['a', 'b']);
});
```

- [ ] **Step 5: Run RED, implement literal substring scoring, and run GREEN**

Run before implementation: `node --test --test-name-pattern="searches only active" test/knowledge.test.js`

Expected: FAIL because `searchActiveKnowledge` is absent or incomplete.

Implementation must normalize message text once, count distinct matched keywords, exclude score zero and inactive versions, apply the specified deterministic sort, clamp the limit to `1..5`, and return copied snapshots.

Run after implementation: `node --test test/knowledge.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the domain unit**

```bash
git add crm/src/domain/knowledge.js crm/test/knowledge.test.js
git commit -m "feat(crm): add governed knowledge domain"
```

---

### Task 2: SQLite v3 knowledge storage and generic idempotency

**Files:**
- Modify: `crm/src/storage/sqlite-store.js`
- Modify: `crm/test/storage.test.js`

**Interfaces:**
- Consumes: knowledge statuses and service persistence needs from Task 1.
- Produces tables: `knowledge_entries`, `knowledge_versions`.
- Produces a rebuilt `request_results` whose `customer_id` is nullable and whose `resource_type`/`resource_id` identify customer or knowledge replays.

- [ ] **Step 1: Write failing v3 schema and reopen tests**

```js
test('migrates to schema v3 with governed knowledge and generic request results', (t) => {
  const { store, reopen } = fileStore(t);
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '3');
  assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_%' ORDER BY name").all().map(row => row.name), ['knowledge_entries', 'knowledge_versions']);
  const customerId = store.db.prepare("PRAGMA table_info(request_results)").all().find(row => row.name === 'customer_id');
  assert.equal(customerId.notnull, 0);
  assert.doesNotThrow(() => reopen());
});
```

- [ ] **Step 2: Run storage tests and verify RED**

Run: `node --test --test-name-pattern="schema v3" test/storage.test.js`

Expected: FAIL with schema version `2` or missing knowledge tables.

- [ ] **Step 3: Implement sequential v1→v2→v3 migration**

Use a mutable `version`; after the existing v1 migration set it to `2`, then execute v3 in the same startup transaction. Create:

```sql
CREATE TABLE knowledge_entries (
  id TEXT PRIMARY KEY, category TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE knowledge_versions (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES knowledge_entries(id),
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  status TEXT NOT NULL CHECK(status IN ('draft','pending_review','approved','rejected','published','expired')),
  effective_at TEXT NOT NULL, expires_at TEXT, published_at TEXT, payload TEXT NOT NULL,
  UNIQUE(entry_id, version_number)
) STRICT;
CREATE UNIQUE INDEX one_published_version_per_entry
  ON knowledge_versions(entry_id) WHERE status = 'published';
```

Rebuild `request_results` inside the transaction with `customer_id TEXT REFERENCES customers(id)`, `resource_type TEXT NOT NULL`, `resource_id TEXT NOT NULL`; copy every old row as `resource_type='customer'` and `resource_id=customer_id` before dropping the old table.

- [ ] **Step 4: Test migration rollback and existing database survival**

Add a v2 fixture containing one customer and one request result, reopen with v3, and assert payload, foreign keys, request ID, actor signature and result remain byte-for-byte equivalent. Add a malformed version fixture and assert startup rolls back without deleting the file.

Run: `node --test test/storage.test.js`

Expected: PASS.

- [ ] **Step 5: Commit storage migration**

```bash
git add crm/src/storage/sqlite-store.js crm/test/storage.test.js
git commit -m "feat(crm): persist versioned knowledge"
```

---

### Task 3: Knowledge and conversation authorization

**Files:**
- Modify: `crm/src/domain/authorization.js`
- Modify: `crm/test/authorization.test.js`

**Interfaces:**
- Produces actions: `knowledge.published.read`, `knowledge.manage`, `knowledge.review`, `knowledge.publish`, `conversation.update`.
- Global knowledge actions do not depend on customer campus/team fields.
- `conversation.update` uses the same customer owner/team scope as `conversation.read`.

- [ ] **Step 1: Write the failing role matrix**

```js
test('separates global knowledge workflow permissions by role', () => {
  assert.equal(can(admin, 'knowledge.publish', {}), true);
  assert.equal(can(supervisor, 'knowledge.manage', {}), true);
  assert.equal(can(supervisor, 'knowledge.review', {}), true);
  assert.equal(can(supervisor, 'knowledge.publish', {}), false);
  assert.equal(can(serviceActor, 'knowledge.published.read', {}), true);
  assert.equal(can(serviceActor, 'knowledge.manage', {}), false);
  assert.equal(can(financeActor, 'knowledge.published.read', {}), false);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test --test-name-pattern="global knowledge" test/authorization.test.js`

Expected: FAIL because the new actions are denied.

- [ ] **Step 3: Implement global actions before scoped role branches**

Add exact allowlists:

```js
const GLOBAL_KNOWLEDGE = Object.freeze({
  admin: ['knowledge.published.read', 'knowledge.manage', 'knowledge.review', 'knowledge.publish'],
  supervisor: ['knowledge.published.read', 'knowledge.manage', 'knowledge.review'],
  service: ['knowledge.published.read'],
  consultant: ['knowledge.published.read']
});
```

Keep finance and teacher denied. Add `conversation.update` beside scoped `conversation.read` for admin, supervisor, service and consultant only.

- [ ] **Step 4: Run authorization tests GREEN**

Run: `node --test test/authorization.test.js`

Expected: PASS.

- [ ] **Step 5: Commit authorization**

```bash
git add crm/src/domain/authorization.js crm/test/authorization.test.js
git commit -m "feat(crm): authorize knowledge workflow"
```

---

### Task 4: Knowledge lifecycle service

**Files:**
- Modify: `crm/src/services/crm-service.js`
- Modify: `crm/test/crm-service.test.js`

**Interfaces:**
- Consumes: Task 1 knowledge functions, Task 2 tables/generic request results, Task 3 permissions.
- Produces service methods: `createKnowledgeEntry`, `reviseKnowledgeEntry`, `submitKnowledgeVersion`, `reviewKnowledgeVersion`, `publishKnowledgeVersion`, `expireKnowledgeVersion`, `deleteKnowledgeDraft`, `listKnowledgeEntries`, `searchPublishedKnowledge`.
- Create/revise payload: `{ knowledge: { category, title, body, source, keywords, effectiveAt, expiresAt } }`.
- Review payload: `{ versionId, review: { decision: 'approved'|'rejected', reason? } }`.
- List result: `{ entries: [{ id, category, createdBy, createdAt, versions }] }` with permission-trimmed versions.

- [ ] **Step 1: Write a failing create-to-publish service test**

```js
test('creates, independently reviews, publishes, and lists a knowledge version', (t) => {
  const { service } = fixture(t);
  const created = service.createKnowledgeEntry({ actor: supervisor, requestId: 'k-create-1', knowledge: validKnowledge() });
  const pending = service.submitKnowledgeVersion({ actor: supervisor, requestId: 'k-submit-1', versionId: created.version.id });
  assert.throws(() => service.reviewKnowledgeVersion({ actor: supervisor, requestId: 'k-self-review', versionId: created.version.id, review: { decision: 'approved' } }), hasCode('SELF_REVIEW_FORBIDDEN'));
  const approved = service.reviewKnowledgeVersion({ actor: admin, requestId: 'k-review-1', versionId: created.version.id, review: { decision: 'approved' } });
  const published = service.publishKnowledgeVersion({ actor: admin, requestId: 'k-publish-1', versionId: created.version.id });
  assert.equal(pending.version.status, 'pending_review');
  assert.equal(approved.version.status, 'approved');
  assert.equal(published.version.status, 'published');
  assert.equal(service.listKnowledgeEntries({ actor: serviceActor }).entries[0].versions[0].body, validKnowledge().body);
});
```

- [ ] **Step 2: Run service RED**

Run: `node --test --test-name-pattern="creates, independently reviews" test/crm-service.test.js`

Expected: FAIL because `createKnowledgeEntry` is missing.

- [ ] **Step 3: Generalize write replay without weakening existing customer writes**

Keep the current `write` call signature. Default `resourceType` to `customer` and `resourceId` to `operation.customerId`; knowledge operations return `customerId: null`, `resourceType: 'knowledge_version'`, and their version ID. On replay, require the supplied knowledge replay callback instead of calling `loadCustomer(null)`. Insert the new resource fields in the same `request_results` row so request IDs remain globally unique.

- [ ] **Step 4: Implement create, submit, review, and list**

Use `crypto.randomUUID()` for entry/version IDs; assign version `1`; persist the entry and version atomically. Loaders parse JSON payloads but verify row ID, entry ID, version number and state columns agree with the payload before use. List deterministically by entry creation time then ID; versions by version number descending.

For published readers return only `{ id, entryId, versionNumber, category, title, body, source, effectiveAt, expiresAt, publishedAt, status }`. Managers additionally receive submit/review metadata but never an audit payload.

- [ ] **Step 5: Add failing revision, replacement, delete, and idempotency tests**

Cover these literal outcomes:

```js
assert.equal(revised.version.versionNumber, 2);
assert.equal(replacement.version.status, 'published');
assert.equal(service.listKnowledgeEntries({ actor: admin }).entries[0].versions.find(v => v.id === first.id).status, 'expired');
assert.deepEqual(service.createKnowledgeEntry(createRequest), service.createKnowledgeEntry(createRequest));
assert.throws(() => service.createKnowledgeEntry({ ...createRequest, actor: otherAdmin }), hasCode('FORBIDDEN'));
assert.throws(() => service.deleteKnowledgeDraft({ actor: admin, requestId: 'delete-submitted', versionId: submitted.id }), hasCode('INVALID_KNOWLEDGE_TRANSITION'));
```

- [ ] **Step 6: Run RED, implement remaining lifecycle, then run GREEN**

Publishing first expires any currently published version for the same entry in the same transaction. Revision copies the previous business fields into a new normalized draft with the next version number. Delete physically removes only `draft` and removes the entry only when no versions remain.

Run: `node --test test/crm-service.test.js`

Expected: PASS, including every pre-existing service test.

- [ ] **Step 7: Verify audit redaction and commit**

Assert knowledge audit `before_summary`/`after_summary` include IDs, category, version number and status only; assert neither contains the body, source, keywords or customer message.

```bash
git add crm/src/services/crm-service.js crm/test/crm-service.test.js
git commit -m "feat(crm): manage knowledge lifecycle"
```

---

### Task 5: Trusted retrieval and human conversation queue

**Files:**
- Create: `crm/src/domain/conversation.js`
- Create: `crm/test/conversation.test.js`
- Modify: `crm/src/services/crm-service.js`
- Modify: `crm/test/crm-service.test.js`
- Modify: `crm/test/ai-triage.test.js`

**Interfaces:**
- Produces `initialHandlingStatus(mode)` and `transitionHandlingStatus(conversation, nextStatus)`.
- Extends `triageConversation` internal service input with optional trusted `confidence` and `citationIds`; public HTTP never forwards them.
- Produces `listConversations({ actor, scope? })` → `{ conversations }`.
- Produces `updateConversationStatus({ actor, requestId, conversationId, status })` → `{ conversation }`.

- [ ] **Step 1: Write failing conversation state tests**

```js
test('keeps AI decision immutable while handling moves forward', () => {
  assert.equal(initialHandlingStatus('suggestion'), 'pending');
  assert.equal(initialHandlingStatus('human_required'), 'pending');
  const confirmed = transitionHandlingStatus({ mode: 'suggestion', handlingStatus: 'pending' }, 'confirmed');
  assert.deepEqual(confirmed, { mode: 'suggestion', handlingStatus: 'confirmed' });
  assert.throws(() => transitionHandlingStatus({ mode: 'human_required', handlingStatus: 'pending' }, 'confirmed'), hasCode('INVALID_CONVERSATION_TRANSITION'));
});
```

- [ ] **Step 2: Run RED, implement the transition table, run GREEN**

Allowed transitions are `suggestion: pending→confirmed→closed`, `human_required: pending→taken_over→closed`, and `auto_reply: closed` with no manual transition.

Run: `node --test test/conversation.test.js`

Expected: PASS after implementation.

- [ ] **Step 3: Write failing service retrieval tests**

Create one published matching policy, one draft matching policy and one expired policy. Assert a normal message receives only the published ID and remains `suggestion` with `LOW_CONFIDENCE`; assert a refund message remains `human_required`; assert service input containing unknown or inactive `citationIds` cannot make them valid.

```js
assert.deepEqual(normal.conversation.citations, [published.id]);
assert.equal(normal.conversation.mode, 'suggestion');
assert.equal(risky.conversation.mode, 'human_required');
assert.deepEqual(forged.conversation.citations, []);
```

- [ ] **Step 4: Implement server-owned citation resolution**

Load candidate versions from SQLite and call `searchActiveKnowledge`. If internal `citationIds` exist, intersect them with current active rows and preserve deterministic search order. Pass full server-owned version snapshots to `triageMessage`; never trust caller-supplied status, dates or body. Without finite trusted confidence, omit confidence so local results stay `suggestion`.

- [ ] **Step 5: Implement conversation list and update services**

Store `handlingStatus` when creating the conversation. Lists filter through `conversation.read` against each customer and return a masked customer summary plus decision, reasons, citation IDs and handling status. Updates require `conversation.update`, preserve message/mode/reasons/citations, apply the domain transition and audit only `{ handlingStatus }` before/after.

- [ ] **Step 6: Run focused service and triage tests**

Run: `node --test test/conversation.test.js test/ai-triage.test.js test/crm-service.test.js`

Expected: PASS.

- [ ] **Step 7: Commit the conversation unit**

```bash
git add crm/src/domain/conversation.js crm/test/conversation.test.js crm/src/services/crm-service.js crm/test/crm-service.test.js crm/test/ai-triage.test.js
git commit -m "feat(crm): connect knowledge to support queue"
```

---

### Task 6: Same-origin knowledge and conversation HTTP API

**Files:**
- Modify: `crm/src/http/routes.js`
- Modify: `crm/test/http.test.js`

**Interfaces:**
- GET `/api/knowledge?category=&status=` → `listKnowledgeEntries`.
- POST `/api/knowledge` → `createKnowledgeEntry`.
- POST `/api/knowledge-revisions` → `reviseKnowledgeEntry`.
- POST `/api/knowledge-submissions` → `submitKnowledgeVersion`.
- POST `/api/knowledge-reviews` → `reviewKnowledgeVersion`.
- POST `/api/knowledge-publications` → `publishKnowledgeVersion`.
- POST `/api/knowledge-expirations` → `expireKnowledgeVersion`.
- POST `/api/knowledge-draft-deletions` → `deleteKnowledgeDraft`.
- GET `/api/conversations?campusId=&teamId=&ownerId=` → `listConversations`.
- POST `/api/conversation-status` → `updateConversationStatus`.

- [ ] **Step 1: Extend the HTTP spy and write failing route contract tests**

Assert exact service arguments and verify browser-supplied workflow fields are absent:

```js
assert.deepEqual(calls.createKnowledgeEntry[0].knowledge, {
  category: 'policy', title: '虚构报名材料', body: '仅供测试', source: '虚构来源',
  keywords: ['报名', '材料'], effectiveAt: '2026-09-01', expiresAt: '2026-10-01'
});
assert.deepEqual(calls.triageConversation[0].conversation, { message: '报名材料是什么' });
assert.equal(Object.hasOwn(calls.triageConversation[0].conversation, 'confidence'), false);
assert.equal(Object.hasOwn(calls.triageConversation[0].conversation, 'citationIds'), false);
```

- [ ] **Step 2: Run HTTP RED**

Run: `node --test --test-name-pattern="knowledge|conversation" test/http.test.js`

Expected: FAIL with 404 or missing spy call.

- [ ] **Step 3: Implement query and body allowlists**

Add a `knowledgeFilterFor(target)` that accepts each of `category` and `status` at most once and rejects all other query keys as `INVALID_FILTER`. Reuse `scopeFor` for conversations. Use `pick` with exact fields from the interface list; never forward status/actor/reviewer/publisher/confidence/citations from nested browser objects.

- [ ] **Step 4: Add method, error, and request-boundary tests**

Map `SELF_REVIEW_FORBIDDEN` to 403. Map `KNOWLEDGE_VERSION_CONFLICT`, `INVALID_KNOWLEDGE_TRANSITION`, `INVALID_CONVERSATION_TRANSITION` to 409. Map malformed filters and knowledge payloads to 400. Assert unsupported methods return 405 with exact `Allow` headers and that the existing 1 MiB JSON limit still applies.

- [ ] **Step 5: Run complete HTTP tests and commit**

Run: `node --test test/http.test.js`

Expected: PASS.

```bash
git add crm/src/http/routes.js crm/test/http.test.js
git commit -m "feat(crm): expose governed knowledge api"
```

---

### Task 7: Knowledge management and support queue UI

**Files:**
- Modify: `crm/public/index.html`
- Modify: `crm/public/app.js`
- Modify: `crm/public/styles.css`
- Modify: `crm/test/http.test.js`
- Modify: `crm/test/enrollment.test.js`

**Interfaces:**
- Consumes: Task 6 same-origin API.
- Produces accessible knowledge list/form/actions and conversation list/actions without a frontend framework.

- [ ] **Step 1: Write failing static workbench assertions**

```js
for (const label of ['知识库管理', '新建知识', '提交审核', '审核通过', '发布', '失效', '客服会话队列', '确认建议', '人工接管', '关闭会话']) {
  assert.match(html, new RegExp(label));
}
for (const path of ['/api/knowledge', '/api/knowledge-submissions', '/api/knowledge-reviews', '/api/knowledge-publications', '/api/knowledge-expirations', '/api/conversations', '/api/conversation-status']) {
  assert.match(app, new RegExp(path.replaceAll('/', '\\/')));
}
```

- [ ] **Step 2: Run UI RED**

Run: `node --test --test-name-pattern="workbench source declares" test/http.test.js`

Expected: FAIL because the disabled knowledge navigation and old legend do not contain the new controls.

- [ ] **Step 3: Build semantic HTML sections**

Enable the knowledge navigation button. Add `knowledge-section` with category/status filters, manager-only create form and `knowledge-list`. Replace the AI legend-only section with `conversation-section` containing the legend and `conversation-list`. Every input has a `<label>`, every status message uses the existing live region, and forms use native `required`/`maxlength` matching server limits.

- [ ] **Step 4: Add role-aware loading, rendering, and mutations**

Extend `load()` to request knowledge and conversations via `moduleResult`. Render with `textContent` only. Show manager controls only for admin/supervisor and publication controls only for admin. Derive available action buttons from returned states, not from hidden client state. Reuse `mutate()` so buttons lock during writes and lists refresh after success or uncertain failure.

- [ ] **Step 5: Add failing DOM behavior tests then implement action wiring**

Test with the existing fake DOM/fetch harness that a supervisor can create and submit but sees no publish button, admin can review/publish, service sees only published cards, and clicking `人工接管` posts only `{ conversationId, status: 'taken_over' }` plus the generated request ID.

Run before wiring: `node --test --test-name-pattern="knowledge workbench|conversation queue" test/enrollment.test.js`

Expected: FAIL because handlers or rendered controls are missing.

Run after wiring: `node --test test/enrollment.test.js test/http.test.js`

Expected: PASS.

- [ ] **Step 6: Add focused responsive styles**

Reuse `.panel`, `.workflow-grid`, `.workflow-card`, `.workflow-form`, `.badge` and `.workflow-actions`. Add only knowledge category/status badges, a two-column management layout above 960px and one-column layout below 960px. Preserve visible focus, contrast, touch targets and horizontal table safety.

- [ ] **Step 7: Commit the workbench**

```bash
git add crm/public/index.html crm/public/app.js crm/public/styles.css crm/test/http.test.js crm/test/enrollment.test.js
git commit -m "feat(crm): add knowledge support workbench"
```

---

### Task 8: Fictional demo, documentation, and milestone verification

**Files:**
- Modify: `crm/src/demo/seed.js`
- Modify: `crm/test/smoke.test.js`
- Modify: `crm/README.md`
- Modify: `README.md`
- Modify: `docs/WORK_STATUS.md`

**Interfaces:**
- Consumes: all Tasks 1–7.
- Produces a repeatable fictional demo and documented operator flow.

- [ ] **Step 1: Write failing idempotent seed assertions**

Start the app twice against one temporary directory. Assert exactly one knowledge entry/version is published, the same IDs survive restart, no duplicate audit/request rows appear, and the seeded normal/risk conversations show `suggestion`/`human_required` respectively.

Run: `node --test --test-name-pattern="fictional seed" test/smoke.test.js`

Expected: FAIL because seed knowledge and conversations are absent.

- [ ] **Step 2: Seed through public service methods only**

Retain every existing `chengqiyun-demo:*` request ID unchanged. Add stable new IDs under `zhichengyun-demo:knowledge:v1:*`. Create, submit, approve and publish a fictional policy titled `虚构报名材料说明`; then triage one matching normal message and one退款风险消息. Never insert directly into SQLite.

- [ ] **Step 3: Run smoke GREEN**

Run: `node --test test/smoke.test.js`

Expected: PASS with restart idempotency.

- [ ] **Step 4: Update operator documentation**

Document the five categories, demo role permissions, create→review→publish flow, AI decision versus handling state, local-only limitations, fictional-data warning, unchanged legacy storage path, and FastGPT failure-to-human fallback. Update `docs/WORK_STATUS.md` with the actual verified counts and the next unresolved production dependency.

- [ ] **Step 5: Run milestone verification**

Run from repository root:

```bash
node --test crm/test/*.test.js
npm test
node --check crm/src/domain/knowledge.js
node --check crm/src/domain/conversation.js
node --check crm/src/services/crm-service.js
node --check crm/src/http/routes.js
node --check crm/public/app.js
git diff --check
```

Expected: all CRM tests pass; all 95 legacy tests pass; every syntax check exits 0; `git diff --check` reports no errors.

- [ ] **Step 6: Review the exact milestone diff**

Confirm no real personal data, secret, generated database, dependency folder, branch rename, database-path rename or unrelated legacy modification is present. Confirm browser requests cannot carry confidence/citations and knowledge audit summaries contain no body/message text.

- [ ] **Step 7: Commit and push the milestone**

```bash
git add README.md crm docs/WORK_STATUS.md
git commit -m "docs(crm): publish knowledge workbench guide"
git push origin codex/chengqiyun-core-slice
```

## Plan Self-Review

- Spec coverage: Tasks 1–8 cover categories, immutable versions, draft deletion, review separation, publish/expire behavior, active-date rules, stable search, permissions, server-owned citations, AI/manual states, API allowlists, workbench, audit redaction, fictional seed, failure fallback and full regression.
- Scope: one coherent vertical slice; real FastGPT, document upload/chunking, vector retrieval, channel sending and quality analytics remain outside this plan.
- Type consistency: every service/API/UI name is defined once in the Interfaces blocks and reused with the same spelling and payload shape.
- Compatibility: existing branch/worktree paths, default database path, SQLite filename and old seed request IDs remain unchanged.
- Placeholder scan: the plan contains no unfinished requirements; every implementation step names concrete behavior, file, command and expected result.
