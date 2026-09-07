# Enrollment, Student, and Follow-up Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a tested local CRM workflow in which a consultant submits an enrollment, a scoped supervisor or administrator decides it, approval atomically creates one student and one first follow-up task, and authorized staff can manage follow-up tasks.

**Architecture:** Add two pure domain modules for enrollment and task state, migrate the existing strict SQLite store from schema 1 to 2, and expose the workflow through the existing transactional `createCrmService` boundary. Extend the fixed-path HTTP router and the same-origin workbench without trusting browser-owned identity, ownership, scope, status, timestamps, or generated IDs.

**Tech Stack:** Node.js 24+, CommonJS, `node:test`, `node:assert/strict`, built-in `node:sqlite`, built-in HTTP server, plain HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-07-enrollment-student-follow-up-design.md`

## Global Constraints

- Continue using the isolated worktree at `C:\Users\Administrator\Desktop\douyinauto-master\.worktrees\chengqiyun-core-slice` on branch `codex/chengqiyun-core-slice`.
- Do not add runtime dependencies or change the legacy Electron application under `app/`, `scripts/`, or `test/`.
- Use fictional demonstration data only; never commit real customer, identity, payment, contract, or material data.
- Every production behavior follows red-green-refactor: add one observable failing test, run it and confirm the expected failure, add the minimum implementation, then run the focused and full relevant suites.
- All entity IDs, actor identity, ownership, scope, status, decision metadata, and generated timestamps are server-owned.
- Every write is synchronous, transactionally atomic, audited with a safe summary, and idempotent through the existing globally unique `requestId` contract.
- Do not add delete, reopen, arbitrary assignment, file upload, notification, production authentication, generic approval-engine, or repeat-program-enrollment behavior.
- Preserve the existing exact-route, explicit-field-allowlist, 1 MiB JSON limit, `no-store`, CSP, safe error-envelope, and static-file-containment guarantees.
- Preserve all 132 CRM tests and all 95 legacy tests while adding the new coverage.

---

### Task 1: Enrollment and student domain rules

**Files:**
- Create: `crm/src/domain/enrollment.js`
- Create: `crm/test/enrollment.test.js`

**Interfaces:**
- Consumes: Plain own-property records and server-generated identifiers/timestamps.
- Produces: `createEnrollmentApplication(input) -> frozen Enrollment`, `decideEnrollmentApplication(enrollment, decision, actorId, decidedAt) -> frozen Enrollment`, and `createStudentRecord(input) -> frozen Student`.
- `Enrollment` is `{ id, customerId, status, currentEducation, targetLevel, school, major, classType, submittedBy, submittedAt, decidedBy, decidedAt, rejectionReason }`.
- `Student` is `{ id, customerId, enrollmentId, status: 'active', createdAt }`.

- [ ] **Step 1: Write failing domain tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEnrollmentApplication,
  decideEnrollmentApplication,
  createStudentRecord,
} = require('../src/domain/enrollment');

const pending = () => createEnrollmentApplication({
  id: 'enrollment-1', customerId: 'customer-1', submittedBy: 'consultant-1',
  submittedAt: '2026-09-07T01:00:00.000Z',
  input: { currentEducation: ' 高中 ', targetLevel: ' 专升本 ', school: ' 虚构大学 ', major: ' 计算机 ', classType: ' 周末班 ' },
});

test('creates one normalized pending enrollment without caller-owned lifecycle fields', () => {
  const input = { currentEducation: ' 高中 ', targetLevel: ' 专升本 ', school: ' 虚构大学 ', major: ' 计算机 ', classType: ' 周末班 ', status: 'approved', decidedBy: 'browser' };
  const enrollment = createEnrollmentApplication({ id: 'enrollment-1', customerId: 'customer-1', submittedBy: 'consultant-1', submittedAt: '2026-09-07T01:00:00.000Z', input });
  assert.deepEqual(enrollment, {
    id: 'enrollment-1', customerId: 'customer-1', status: 'pending',
    currentEducation: '高中', targetLevel: '专升本', school: '虚构大学', major: '计算机', classType: '周末班',
    submittedBy: 'consultant-1', submittedAt: '2026-09-07T01:00:00.000Z', decidedBy: '', decidedAt: '', rejectionReason: '',
  });
  assert.equal(Object.isFrozen(enrollment), true);
  assert.equal(input.status, 'approved');
});

test('approves or rejects a pending enrollment exactly once', () => {
  assert.equal(decideEnrollmentApplication(pending(), { status: 'approved' }, 'supervisor-1', '2026-09-07T02:00:00.000Z').status, 'approved');
  const rejected = decideEnrollmentApplication(pending(), { status: 'rejected', reason: ' 信息不完整 ' }, 'supervisor-1', '2026-09-07T02:00:00.000Z');
  assert.equal(rejected.rejectionReason, '信息不完整');
  assert.throws(() => decideEnrollmentApplication(rejected, { status: 'approved' }, 'admin-1', '2026-09-07T03:00:00.000Z'), { code: 'ENROLLMENT_ALREADY_DECIDED' });
});

test('rejects malformed enrollment fields and decisions', () => {
  for (const input of [null, [], {}, { targetLevel: '本科', school: '', major: '计算机' }, { targetLevel: '本科', school: '学校', major: 'x'.repeat(201) }]) {
    assert.throws(() => createEnrollmentApplication({ id: 'e', customerId: 'c', submittedBy: 'u', submittedAt: '2026-09-07T01:00:00.000Z', input }), { code: 'INVALID_ENROLLMENT' });
  }
  for (const decision of [{ status: 'rejected' }, { status: 'approved', reason: 'browser reason' }, { status: 'pending' }, []]) {
    assert.throws(() => decideEnrollmentApplication(pending(), decision, 'supervisor-1', '2026-09-07T02:00:00.000Z'), { code: 'INVALID_ENROLLMENT_DECISION' });
  }
});

test('creates an active student that references but does not copy customer data', () => {
  assert.deepEqual(createStudentRecord({ id: 'student-1', customerId: 'customer-1', enrollmentId: 'enrollment-1', createdAt: '2026-09-07T02:00:00.000Z' }), {
    id: 'student-1', customerId: 'customer-1', enrollmentId: 'enrollment-1', status: 'active', createdAt: '2026-09-07T02:00:00.000Z',
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test crm/test/enrollment.test.js`

Expected: FAIL because `../src/domain/enrollment` does not exist.

- [ ] **Step 3: Implement the enrollment domain module**

```js
'use strict';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function ownRecord(value, code) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!Object.hasOwn(descriptor, 'value')) fail(code);
  return value;
}
function value(input, key, code, required = false, max = 200) {
  const raw = Object.hasOwn(input, key) ? input[key] : '';
  if (typeof raw !== 'string' || raw.length > max || (required && !raw.trim())) fail(code);
  return raw.trim();
}
function requiredString(raw, code) {
  if (typeof raw !== 'string' || !raw.trim()) fail(code);
  return raw.trim();
}

function createEnrollmentApplication({ id, customerId, submittedBy, submittedAt, input }) {
  ownRecord(input, 'INVALID_ENROLLMENT');
  return Object.freeze({
    id: requiredString(id, 'INVALID_ENROLLMENT'), customerId: requiredString(customerId, 'INVALID_ENROLLMENT'), status: 'pending',
    currentEducation: value(input, 'currentEducation', 'INVALID_ENROLLMENT'),
    targetLevel: value(input, 'targetLevel', 'INVALID_ENROLLMENT', true),
    school: value(input, 'school', 'INVALID_ENROLLMENT', true),
    major: value(input, 'major', 'INVALID_ENROLLMENT', true),
    classType: value(input, 'classType', 'INVALID_ENROLLMENT'),
    submittedBy: requiredString(submittedBy, 'INVALID_ENROLLMENT'), submittedAt: requiredString(submittedAt, 'INVALID_ENROLLMENT'),
    decidedBy: '', decidedAt: '', rejectionReason: '',
  });
}

function decideEnrollmentApplication(enrollment, decision, actorId, decidedAt) {
  ownRecord(enrollment, 'INVALID_ENROLLMENT'); ownRecord(decision, 'INVALID_ENROLLMENT_DECISION');
  if (enrollment.status !== 'pending') fail('ENROLLMENT_ALREADY_DECIDED');
  if (!['approved', 'rejected'].includes(decision.status)) fail('INVALID_ENROLLMENT_DECISION');
  const rejectionReason = value(decision, 'reason', 'INVALID_ENROLLMENT_DECISION', decision.status === 'rejected', 500);
  if (decision.status === 'approved' && rejectionReason) fail('INVALID_ENROLLMENT_DECISION');
  return Object.freeze({ ...enrollment, status: decision.status, decidedBy: requiredString(actorId, 'INVALID_ENROLLMENT_DECISION'), decidedAt: requiredString(decidedAt, 'INVALID_ENROLLMENT_DECISION'), rejectionReason });
}

function createStudentRecord({ id, customerId, enrollmentId, createdAt }) {
  return Object.freeze({ id: requiredString(id, 'INVALID_STUDENT'), customerId: requiredString(customerId, 'INVALID_STUDENT'), enrollmentId: requiredString(enrollmentId, 'INVALID_STUDENT'), status: 'active', createdAt: requiredString(createdAt, 'INVALID_STUDENT') });
}

module.exports = { createEnrollmentApplication, decideEnrollmentApplication, createStudentRecord };
```

- [ ] **Step 4: Run focused and CRM tests**

Run: `node --test crm/test/enrollment.test.js && node --test crm/test/*.test.js`

Expected: both commands PASS with zero failures.

- [ ] **Step 5: Commit Task 1**

```powershell
git add crm/src/domain/enrollment.js crm/test/enrollment.test.js
git commit -m "feat(crm): define enrollment domain lifecycle"
```

---

### Task 2: Follow-up task domain state machine

**Files:**
- Create: `crm/src/domain/follow-up-task.js`
- Create: `crm/test/follow-up-task.test.js`

**Interfaces:**
- Consumes: Server-owned task identity/ownership/origin plus caller-provided title and due time.
- Produces: `createFollowUpTask(input) -> frozen FollowUpTask`, `transitionFollowUpTask(task, nextStatus) -> frozen FollowUpTask`, `approvalTaskDueAt(approvedAt) -> ISO string`, `taskView(task, now) -> frozen FollowUpTaskWithOverdue`.
- `FollowUpTask` is `{ id, customerId, studentId, originType, originId, ownerId, title, dueAt, status }`.

- [ ] **Step 1: Write failing state-machine tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFollowUpTask, transitionFollowUpTask, approvalTaskDueAt, taskView } = require('../src/domain/follow-up-task');

const openTask = () => createFollowUpTask({
  id: 'task-1', customerId: 'customer-1', studentId: '', originType: 'manual', originId: '', ownerId: 'consultant-1',
  title: ' 电话确认 ', dueAt: '2026-09-08T02:00:00.000Z', status: 'completed',
});

test('creates an open task and ignores caller-owned status', () => {
  assert.deepEqual(openTask(), { id: 'task-1', customerId: 'customer-1', studentId: '', originType: 'manual', originId: '', ownerId: 'consultant-1', title: '电话确认', dueAt: '2026-09-08T02:00:00.000Z', status: 'open' });
});

test('allows only forward task transitions', () => {
  for (const status of ['in_progress', 'completed', 'cancelled']) assert.equal(transitionFollowUpTask(openTask(), status).status, status);
  const started = transitionFollowUpTask(openTask(), 'in_progress');
  for (const status of ['completed', 'cancelled']) assert.equal(transitionFollowUpTask(started, status).status, status);
  for (const [task, status] of [[started, 'open'], [transitionFollowUpTask(openTask(), 'completed'), 'open'], [openTask(), 'open'], [openTask(), 'unknown']]) {
    assert.throws(() => transitionFollowUpTask(task, status), { code: 'INVALID_TASK_TRANSITION' });
  }
});

test('derives approval due time and overdue at a strict instant boundary', () => {
  assert.equal(approvalTaskDueAt('2026-09-07T02:00:00.000Z'), '2026-09-08T02:00:00.000Z');
  assert.equal(taskView(openTask(), '2026-09-08T02:00:00.000Z').overdue, false);
  assert.equal(taskView(openTask(), '2026-09-08T02:00:00.001Z').overdue, true);
  assert.equal(taskView(transitionFollowUpTask(openTask(), 'completed'), '2026-09-09T00:00:00.000Z').overdue, false);
});

test('rejects malformed task records, origins, titles, and dates', () => {
  const base = { id: 't', customerId: 'c', studentId: '', originType: 'manual', originId: '', ownerId: 'u', title: 'call', dueAt: '2026-09-08T00:00:00.000Z' };
  for (const change of [{ title: '' }, { title: 'x'.repeat(201) }, { dueAt: 'bad' }, { originType: 'browser' }, { originType: 'enrollment_approval', originId: '' }]) {
    assert.throws(() => createFollowUpTask({ ...base, ...change }), { code: 'INVALID_FOLLOW_UP_TASK' });
  }
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test crm/test/follow-up-task.test.js`

Expected: FAIL because `../src/domain/follow-up-task` does not exist.

- [ ] **Step 3: Implement the task domain module**

Implement exact allowlists `manual` and `enrollment_approval`, the transition map below, native `Date.prototype.getTime.call()` validation, and a copied frozen return so callers cannot mutate stored state:

```js
const TRANSITIONS = Object.freeze({
  open: Object.freeze(['in_progress', 'completed', 'cancelled']),
  in_progress: Object.freeze(['completed', 'cancelled']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

function transitionFollowUpTask(task, nextStatus) {
  if (!TRANSITIONS[task?.status]?.includes(nextStatus)) fail('INVALID_TASK_TRANSITION');
  return Object.freeze({ ...task, status: nextStatus });
}

function approvalTaskDueAt(approvedAt) {
  return new Date(milliseconds(approvedAt, 'INVALID_FOLLOW_UP_TASK') + 24 * 60 * 60 * 1000).toISOString();
}

function taskView(task, now) {
  const overdue = ['open', 'in_progress'].includes(task.status) && milliseconds(task.dueAt, 'INVALID_FOLLOW_UP_TASK') < milliseconds(now, 'INVALID_FOLLOW_UP_TASK');
  return Object.freeze({ ...task, overdue });
}
```

`createFollowUpTask()` must trim strings, force `status: 'open'`, require a blank `originId` for `manual`, require a nonblank `originId` and `studentId` for `enrollment_approval`, and reject non-plain/accessor-bearing inputs with `INVALID_FOLLOW_UP_TASK`.

- [ ] **Step 4: Run focused and CRM tests**

Run: `node --test crm/test/follow-up-task.test.js && node --test crm/test/*.test.js`

Expected: both commands PASS with zero failures.

- [ ] **Step 5: Commit Task 2**

```powershell
git add crm/src/domain/follow-up-task.js crm/test/follow-up-task.test.js
git commit -m "feat(crm): define follow-up task state machine"
```

---

### Task 3: Versioned schema 2 migration

**Files:**
- Modify: `crm/src/storage/sqlite-store.js`
- Create: `crm/test/storage.test.js`

**Interfaces:**
- Consumes: Existing schema version 1 database or a new empty database.
- Produces: Schema version `2` with `enrollment_applications`, `students`, and `follow_up_tasks`; existing `createStore(dbPath) -> { db, transaction, close }` remains unchanged.

- [ ] **Step 1: Write a failing migration test**

Create a file-backed store, insert one fictional customer, close it, use `DatabaseSync` to set metadata to version `1` and remove the three new tables if present, then reopen through `createStore()`:

```js
test('migrates schema 1 to 2 without changing existing customer data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-schema-2-'));
  const path = join(dir, 'crm.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = createStore(path);
  store.db.prepare('INSERT INTO customers (id, payload) VALUES (?, ?)').run('customer-1', JSON.stringify({ id: 'customer-1', name: '虚构客户' }));
  store.close();

  const old = new DatabaseSync(path);
  old.exec("DROP TABLE IF EXISTS follow_up_tasks; DROP TABLE IF EXISTS students; DROP TABLE IF EXISTS enrollment_applications; UPDATE metadata SET value = '1' WHERE key = 'schema_version';");
  old.close();

  store = createStore(path);
  t.after(() => store.close());
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '2');
  assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get('customer-1').payload).name, '虚构客户');
  for (const table of ['enrollment_applications', 'students', 'follow_up_tasks']) {
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).n, 1);
  }
});
```

Add tests that reopen schema 2 twice, reject metadata versions above `2` with `UNSUPPORTED_SCHEMA_VERSION`, enforce one pending enrollment per customer, enforce one student per customer/enrollment, enforce one approval-origin task, and enforce every status/decision CHECK constraint.

- [ ] **Step 2: Run the migration test and verify RED**

Run: `node --test crm/test/storage.test.js`

Expected: FAIL because metadata remains `1` and the three tables do not exist.

- [ ] **Step 3: Implement ordered migration inside the existing startup transaction**

Keep the version 1 table creation intact. After it, read and validate `metadata.schema_version`; for version `1`, execute:

```sql
CREATE TABLE enrollment_applications (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  payload TEXT NOT NULL,
  CHECK((status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
     OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_pending_enrollment_per_customer
  ON enrollment_applications(customer_id) WHERE status = 'pending';
CREATE TABLE students (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE REFERENCES customers(id),
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollment_applications(id),
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE follow_up_tasks (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  student_id TEXT REFERENCES students(id),
  origin_type TEXT NOT NULL CHECK(origin_type IN ('manual', 'enrollment_approval')),
  origin_id TEXT,
  owner_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'in_progress', 'completed', 'cancelled')),
  payload TEXT NOT NULL,
  CHECK((origin_type = 'manual' AND origin_id IS NULL AND student_id IS NULL)
     OR (origin_type = 'enrollment_approval' AND origin_id IS NOT NULL AND student_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_task_per_approval
  ON follow_up_tasks(origin_type, origin_id) WHERE origin_id IS NOT NULL;
CREATE INDEX follow_up_task_queue ON follow_up_tasks(owner_id, status, due_at);
UPDATE metadata SET value = '2' WHERE key = 'schema_version';
```

Throw an error with `code = 'UNSUPPORTED_SCHEMA_VERSION'` before any migration when the stored integer is below `1`, above `2`, or not canonical decimal text. Roll back and close the database on any startup migration error.

- [ ] **Step 4: Run storage and full CRM tests**

Run: `node --test crm/test/storage.test.js && node --test crm/test/*.test.js`

Expected: both commands PASS; reopening a version 2 file does not alter row counts.

- [ ] **Step 5: Commit Task 3**

```powershell
git add crm/src/storage/sqlite-store.js crm/test/storage.test.js
git commit -m "feat(crm): migrate enrollment workflow storage"
```

---

### Task 4: Enrollment, student, and task authorization

**Files:**
- Modify: `crm/src/domain/authorization.js`
- Modify: `crm/test/authorization.test.js`

**Interfaces:**
- Consumes: Existing actor and customer-shaped scope resource.
- Produces: New actions `enrollment.read`, `enrollment.submit`, `enrollment.decide`, `task.read`, `task.create`, `task.update`; extended `student.read`; `maskModuleCustomerSummary(customer, actor, action) -> frozen fixed summary`.

- [ ] **Step 1: Add failing literal authorization tests**

```js
test('enrollment actions separate submission from scoped approval', () => {
  const own = { id: 'c', campusId: 'campus-a', teamId: 'team-a', ownerId: 'consultant-1', assignedTeacherId: 'teacher-1' };
  assert.equal(can(actor(['consultant'], { id: 'consultant-1' }), 'enrollment.submit', own), true);
  assert.equal(can(actor(['consultant'], { id: 'consultant-1' }), 'enrollment.decide', own), false);
  assert.equal(can(actor(['supervisor'], { id: 'supervisor-1', teamIds: ['team-a'] }), 'enrollment.decide', own), true);
  assert.equal(can(actor(['supervisor'], { id: 'supervisor-1', teamIds: ['team-b'] }), 'enrollment.decide', own), false);
  assert.equal(can(actor(['service'], { id: 'consultant-1' }), 'enrollment.submit', own), false);
});

test('task actions allow scoped supervisors and the customer owner only', () => {
  const own = { campusId: 'campus-a', teamId: 'team-a', ownerId: 'consultant-1' };
  for (const role of ['consultant', 'service']) assert.equal(can(actor([role], { id: 'consultant-1' }), 'task.update', own), true);
  assert.equal(can(actor(['consultant'], { id: 'other' }), 'task.update', own), false);
  assert.equal(can(actor(['finance'], { id: 'finance-1' }), 'task.read', own), false);
});

test('student summaries require student.read and always mask the phone', () => {
  const customer = { id: 'c', name: '虚构客户', phone: '13800138000', idNumber: '110101199001011234', wechat: 'secret', notes: 'private', campusId: 'campus-a', teamId: 'team-a', ownerId: 'consultant-1', assignedTeacherId: 'teacher-1' };
  assert.deepEqual(maskModuleCustomerSummary(customer, actor(['teacher'], { id: 'teacher-1' }), 'student.read'), {
    id: 'c', name: '虚构客户', maskedPhone: '138****8000', campusId: 'campus-a', teamId: 'team-a', assignedTeacherId: 'teacher-1',
  });
  assert.throws(() => maskModuleCustomerSummary(customer, actor(['finance'], { id: 'finance-1' }), 'student.read'), { code: 'FORBIDDEN' });
});
```

Add `maskModuleCustomerSummary` to the existing authorization import. Keep the existing `actor(roles, extra)` helper unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="enrollment actions|task actions|student summaries" crm/test/authorization.test.js`

Expected: FAIL because the actions and summary export are absent.

- [ ] **Step 3: Implement exact role rules and fixed summary**

Add to `roleAllows()`:

```js
// admin: add every new action
// supervisor: enrollment.read, enrollment.decide, student.read, task.read, task.create, task.update with campus + team match
// consultant: enrollment.read, enrollment.submit, task.read, task.create, task.update with campus + owner match
// service: task.read, task.create, task.update with campus + owner match
// teacher: retain student.read with campus + assignedTeacherId match
// finance: no new actions
```

Implement and export:

```js
function maskModuleCustomerSummary(customer, actor, action) {
  if (!['enrollment.read', 'student.read', 'task.read'].includes(action)) assertAllowed(actor, '__invalid_summary_action__', customer);
  assertAllowed(actor, action, customer);
  return Object.freeze({
    id: customer.id,
    name: customer.name,
    maskedPhone: maskPhone(customer.phone ?? ''),
    campusId: customer.campusId,
    teamId: customer.teamId,
    assignedTeacherId: customer.assignedTeacherId ?? '',
  });
}
```

Do not grant teachers general `customer.read` and do not change the finance-only customer allowlist.

- [ ] **Step 4: Run authorization and full CRM tests**

Run: `node --test crm/test/authorization.test.js && node --test crm/test/*.test.js`

Expected: both commands PASS with existing role behavior unchanged.

- [ ] **Step 5: Commit Task 4**

```powershell
git add crm/src/domain/authorization.js crm/test/authorization.test.js
git commit -m "feat(crm): authorize enrollment and task workflows"
```

---

### Task 5: Transactional enrollment submission and decision service

**Files:**
- Modify: `crm/src/services/crm-service.js`
- Modify: `crm/test/crm-service.test.js`

**Interfaces:**
- Consumes: Task 1 domain functions, Task 2 approval-task functions, Task 3 tables, Task 4 actions and summary.
- Produces: `submitEnrollment`, `decideEnrollment`, `listEnrollments`, and `listStudents` on the object returned by `createCrmService()`.
- Results: submission returns `{ enrollment }`; rejection returns `{ enrollment, student: null, task: null }`; approval returns `{ enrollment, student, task }`; lists return `{ enrollments }` and `{ students }`.

- [ ] **Step 1: Add a failing end-to-end service test for the approved flow**

```js
test('scoped approval atomically creates one student and first task', (t) => {
  const { store, service } = fixture(t);
  const consultant = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const supervisor = { id: 'supervisor-1', roles: ['supervisor'], campusIds: ['campus-a'], teamIds: ['team-a'] };
  const customerId = imported(service, 'enrollment-customer', { ownerId: 'consultant-1', assignedTeacherId: 'teacher-1' }).customer.id;
  const submitted = service.submitEnrollment({ actor: consultant, requestId: 'submit-1', customerId, enrollment: { currentEducation: '高中', targetLevel: '本科', school: '虚构大学', major: '计算机', classType: '周末班' } });
  const approved = service.decideEnrollment({ actor: supervisor, requestId: 'approve-1', enrollmentId: submitted.enrollment.id, decision: { status: 'approved' } });

  assert.equal(approved.enrollment.status, 'approved');
  assert.equal(approved.student.customerId, customerId);
  assert.deepEqual(approved.task, {
    id: approved.task.id, customerId, studentId: approved.student.id, originType: 'enrollment_approval', originId: submitted.enrollment.id,
    ownerId: 'consultant-1', title: '完成报名交接', dueAt: '2026-09-06T00:00:00.000Z', status: 'open', overdue: false,
  });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM students').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM follow_up_tasks').get().n, 1);
});
```

The existing fixture clock is `2026-09-05T00:00:00.000Z`, so the hand-derived due time is exactly one day later.

Add separate failing tests for: consultant ownership; supervisor campus/team scope; admin global access; service/teacher/finance denial; one pending application; rejection with required reason; resubmission after rejection; `STUDENT_EXISTS`; `ENROLLMENT_ALREADY_DECIDED`; server IDs/timestamps; request replay; cross-actor and downgraded replay; generated ID collision; audit/request-result trigger rollback; and a safe audit summary that contains no school, major, reason, customer name, phone, or identity number. Add a file-backed test that completes reject → resubmit → approve, closes the store, reopens it, and asserts the enrollment/student/task IDs and states are byte-equivalent.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern="enrollment|approval|student" crm/test/crm-service.test.js`

Expected: FAIL because the four service methods do not exist.

- [ ] **Step 3: Implement enrollment loaders, persistence, lists, and transactions**

Import the Task 1 and Task 2 functions plus `maskModuleCustomerSummary`. Add private loaders that parse persisted payload and never accept caller-owned IDs.

`submitEnrollment()` must use:

```js
return write(input, 'enrollment.submit', ['enrollment.submit'], (actor, timestamp) => {
  const customer = loadCustomer(input.customerId);
  assertAllowed(actor, 'enrollment.submit', customer);
  if (db.prepare('SELECT 1 FROM students WHERE customer_id = ?').get(customer.id)) fail('STUDENT_EXISTS');
  if (db.prepare("SELECT 1 FROM enrollment_applications WHERE customer_id = ? AND status = 'pending'").get(customer.id)) fail('ENROLLMENT_PENDING');
  const enrollment = createEnrollmentApplication({ id: crypto.randomUUID(), customerId: customer.id, submittedBy: actor.id, submittedAt: timestamp, input: input.enrollment });
  db.prepare('INSERT INTO enrollment_applications (id, customer_id, status, submitted_by, submitted_at, decided_by, decided_at, payload) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)')
    .run(enrollment.id, customer.id, enrollment.status, enrollment.submittedBy, enrollment.submittedAt, JSON.stringify(enrollment));
  return { customerId: customer.id, entityType: 'enrollment', entityId: enrollment.id, after: { status: 'pending' }, result: { enrollment } };
});
```

`decideEnrollment()` must load the application and customer inside `write()`, authorize `enrollment.decide`, transition the application, and update the row with `WHERE id = ? AND status = 'pending'`. On rejection, return null student/task. On approval, create the student and the fixed enrollment-origin task with three separate server UUIDs for student, task, and audit, persist all rows in the same transaction, and return `taskView(task, timestamp)`.

For lists, parse actor/scope with a new neutral helper that validates the same scope keys as today. Filter actual rows by both the scope object and `can(actor, moduleAction, customer)`. Enrollment and student entries use `maskModuleCustomerSummary()` with the matching read action and deterministic `[submittedAt|createdAt, id]` ordering.

- [ ] **Step 4: Run service, CRM, and legacy tests**

Run: `node --test crm/test/crm-service.test.js && node --test crm/test/*.test.js && node --test test/*.test.js`

Expected: all commands PASS, including the 132 existing CRM and 95 legacy cases.

- [ ] **Step 5: Commit Task 5**

```powershell
git add crm/src/services/crm-service.js crm/test/crm-service.test.js
git commit -m "feat(crm): add transactional enrollment approval"
```

---

### Task 6: Follow-up task service and dashboard metrics

**Files:**
- Modify: `crm/src/services/crm-service.js`
- Modify: `crm/test/crm-service.test.js`

**Interfaces:**
- Consumes: Task 2 state machine, Task 3 task table, Task 4 authorization.
- Produces: `createFollowUpTask`, `updateFollowUpTaskStatus`, `listFollowUpTasks`; dashboard fields `pendingEnrollmentCount`, `pendingEnrollmentIds`, `studentCount`, `studentIds`, `openTaskCount`, `openTaskIds`, `overdueTaskCount`, `overdueTaskIds`.

- [ ] **Step 1: Add failing task lifecycle and dashboard tests**

```js
test('customer owner creates and advances a task while overdue is derived', (t) => {
  const { service } = fixture(t);
  const consultant = { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] };
  const customerId = imported(service, 'task-customer', { ownerId: 'consultant-1' }).customer.id;
  const created = service.createFollowUpTask({ actor: consultant, requestId: 'task-create', customerId, task: { title: '联系客户', dueAt: '2026-09-04T23:59:59.999Z', ownerId: 'browser-owner', status: 'completed' } }).task;
  assert.equal(created.ownerId, 'consultant-1');
  assert.equal(created.status, 'open');
  assert.equal(created.overdue, true);
  const started = service.updateFollowUpTaskStatus({ actor: consultant, requestId: 'task-start', taskId: created.id, status: 'in_progress' }).task;
  assert.equal(started.status, 'in_progress');
  assert.equal(service.updateFollowUpTaskStatus({ actor: consultant, requestId: 'task-done', taskId: created.id, status: 'completed' }).task.overdue, false);
});

test('dashboard exposes only traceable visible workflow counts', (t) => {
  const { service } = fixture(t);
  // Build one pending enrollment, one approved student with an open overdue task, and one hidden cross-campus workflow.
  const report = service.dashboard({ actor: admin });
  assert.deepEqual(report.pendingEnrollmentIds.length, report.pendingEnrollmentCount);
  assert.deepEqual(report.studentIds.length, report.studentCount);
  assert.deepEqual(report.openTaskIds.length, report.openTaskCount);
  assert.deepEqual(report.overdueTaskIds.length, report.overdueTaskCount);
});
```

Add failing tests for every allowed/forbidden transition, terminal immutability, exact due-time boundary, scope filtering, owner filtering, browser owner/status/origin stripping, malformed dates/titles, request replay, permission downgrade, audit rollback, generated ID collision, deterministic sorting, safe DTO shape, and summaries with no title/customer payload.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern="task|workflow counts|overdue" crm/test/crm-service.test.js`

Expected: FAIL because the task service methods and dashboard fields are absent.

- [ ] **Step 3: Implement task writes, list projection, and dashboard aggregates**

`createFollowUpTask()` uses action `task.create`, reloads the customer, uses the customer's current `ownerId`, forces manual origin fields, persists the domain record, and returns `taskView(task, timestamp)`.

`updateFollowUpTaskStatus()` uses action `task.status.update` for the audit name and permission `task.update`; it loads the task then its customer inside the transaction and authorizes against `{ ...customer, ownerId: task.ownerId }`, so the persisted task owner—not a later customer-owner change—controls owner access. It transitions through `transitionFollowUpTask()`, updates both the `status` column and payload, and returns the view at the current clock.

`listFollowUpTasks()` filters by requested scope and `task.read` on `{ ...customer, ownerId: task.ownerId }`, applies `taskView(task, clock())`, returns no customer payload, and sorts by `dueAt` then `id`.

Extend dashboard using actual persisted rows and the same permission checks:

```js
const pendingEnrollmentIds = visible enrollment rows with status === 'pending';
const studentIds = visible student rows;
const openTasks = task rows authorized through their persisted owner whose status is 'open' or 'in_progress';
const overdueTasks = openTasks whose taskView(task, timestamp).overdue is true;
```

Never derive counts from notes, UI state, or unfiltered row totals.

- [ ] **Step 4: Run service, CRM, and legacy tests**

Run: `node --test crm/test/crm-service.test.js && node --test crm/test/*.test.js && node --test test/*.test.js`

Expected: all commands PASS with zero failures.

- [ ] **Step 5: Commit Task 6**

```powershell
git add crm/src/services/crm-service.js crm/test/crm-service.test.js
git commit -m "feat(crm): manage follow-up tasks and workflow metrics"
```

---

### Task 7: Fixed-path HTTP contracts

**Files:**
- Modify: `crm/src/http/routes.js`
- Modify: `crm/test/http.test.js`

**Interfaces:**
- Consumes: Task 5 and 6 service methods.
- Produces: `GET|POST /api/enrollments`, `POST /api/enrollment-decisions`, `GET /api/students`, `GET|POST /api/follow-up-tasks`, `POST /api/follow-up-task-status`; demo actor `consultant-1`.

- [ ] **Step 1: Extend the HTTP spy and write failing route tests**

Add the seven service methods to `spyService()` and literal response envelopes. Test each route with `x-demo-user: consultant-1` or a permitted role and assert the exact forwarded object:

```js
assert.deepEqual(calls.find(call => call.method === 'submitEnrollment').input, {
  actor: { id: 'consultant-1', roles: ['consultant'], campusIds: ['campus-a'], teamIds: [] },
  requestId: 'submit-http', customerId: 'customer-1',
  enrollment: { currentEducation: '高中', targetLevel: '本科', school: '虚构大学', major: '计算机', classType: '周末班' },
});
assert.deepEqual(calls.find(call => call.method === 'createFollowUpTask').input.task, { title: '联系客户', dueAt: '2026-09-08T00:00:00.000Z' });
```

Send hostile fields `roles`, `ownerId`, `status`, `studentId`, `originId`, `submittedBy`, `decidedBy`, `createdAt`, `id`, `token`, and `cookie`; assert none reach the spy. Test query rejection on POST, exact GET scope allowlist, every `Allow` header, unknown paths, and mapping of the four new business conflicts to 409 without leaking the thrown message.

Before implementing the routes, add one real-service HTTP test. Create an in-memory store and a fixed-clock service, import a fictional consultant-owned customer directly through the service, then exercise this exact sequence through `withServer()`:

```js
const apiPost = (base, path, user, body) => json(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-demo-user': user },
  body: JSON.stringify(body),
});

const first = await apiPost(base, '/api/enrollments', 'consultant-1', { requestId: 'http-submit-1', customerId, enrollment: enrollmentInput });
const rejected = await apiPost(base, '/api/enrollment-decisions', 'supervisor-1', { requestId: 'http-reject', enrollmentId: first.body.enrollment.id, decision: { status: 'rejected', reason: '信息不完整' } });
const second = await apiPost(base, '/api/enrollments', 'consultant-1', { requestId: 'http-submit-2', customerId, enrollment: enrollmentInput });
const approved = await apiPost(base, '/api/enrollment-decisions', 'supervisor-1', { requestId: 'http-approve', enrollmentId: second.body.enrollment.id, decision: { status: 'approved' } });
const started = await apiPost(base, '/api/follow-up-task-status', 'consultant-1', { requestId: 'http-task-start', taskId: approved.body.task.id, status: 'in_progress' });
const completed = await apiPost(base, '/api/follow-up-task-status', 'consultant-1', { requestId: 'http-task-complete', taskId: approved.body.task.id, status: 'completed' });
assert.deepEqual([first.response.status, rejected.response.status, second.response.status, approved.response.status, started.response.status, completed.response.status], [200, 200, 200, 200, 200, 200]);
assert.equal((await json(`${base}/api/students`, { headers: { 'x-demo-user': 'supervisor-1' } })).body.students.length, 1);
```

Use literal `enrollmentInput` values from the design and assert a service/finance decision attempt returns 403.

- [ ] **Step 2: Run HTTP tests and verify RED**

Run: `node --test --test-name-pattern="enrollment|student|follow-up" crm/test/http.test.js`

Expected: FAIL with 404/missing spy methods because the routes are absent.

- [ ] **Step 3: Implement actors, routes, allowlists, and error mapping**

Add:

```js
'consultant-1': Object.freeze({ id: 'consultant-1', roles: Object.freeze(['consultant']), campusIds: Object.freeze(['campus-a']), teamIds: Object.freeze([]) })
```

Forward only:

```js
pick(body.enrollment, ['currentEducation', 'targetLevel', 'school', 'major', 'classType'])
pick(body.decision, ['status', 'reason'])
pick(body.task, ['title', 'dueAt'])
```

The task-status route forwards the top-level `status` primitive only. Add `ENROLLMENT_PENDING`, `STUDENT_EXISTS`, `ENROLLMENT_ALREADY_DECIDED`, and `INVALID_TASK_TRANSITION` to the 409 set. Keep fixed exact paths rather than dynamic URL IDs.

- [ ] **Step 4: Run HTTP and full CRM tests**

Run: `node --test crm/test/http.test.js && node --test crm/test/*.test.js`

Expected: both commands PASS; existing raw-path, content-type, body-limit, static-file, CSP, and error-envelope cases remain green.

- [ ] **Step 5: Commit Task 7**

```powershell
git add crm/src/http/routes.js crm/test/http.test.js
git commit -m "feat(crm): expose enrollment and task APIs"
```

---

### Task 8: Enrollment workbench and fictional seed

**Files:**
- Modify: `crm/src/demo/seed.js`
- Modify: `crm/public/index.html`
- Modify: `crm/public/app.js`
- Modify: `crm/public/styles.css`
- Modify: `crm/test/http.test.js`
- Modify: `crm/test/smoke.test.js`

**Interfaces:**
- Consumes: Task 7 same-origin JSON APIs and server-owned demo actors.
- Produces: Enabled `报名学员` navigation; enrollment form/list, student cards, task cards/actions; one idempotent fictional consultant customer and pending enrollment seed.

- [ ] **Step 1: Write failing workbench and seed tests**

Update the source-contract tests so `报名学员` must have `data-target="enrollment-section"` and must not be disabled. Assert IDs for `enrollment-form`, `enrollment-list`, `student-list`, `task-form`, and `task-list`; identity options for `consultant-1` and `supervisor-1`; `<time>` creation in app code; POST calls to all workflow endpoints; `replaceChildren`/`textContent` rendering; submit-button disabled state; and 940px card layout.

Extend the restart smoke test with literal expectations:

```js
assert.equal(firstDashboard.customerCount, 4);
assert.equal(firstDashboard.pendingEnrollmentCount, 1);
assert.equal(firstDashboard.studentCount, 0);
assert.equal(firstDashboard.openTaskCount, 0);
assert.equal(firstDashboard.overdueTaskCount, 0);
assert.deepEqual(secondDashboard, firstDashboard);
```

The new fourth customer is `虚构报名客户`, phone `13800000004`, owner `consultant-1`; the pending application uses fictional school/program values and stable request IDs under `chengqiyun-demo:enrollment:v1`.

- [ ] **Step 2: Run workbench and smoke tests and verify RED**

Run: `node --test --test-name-pattern="workbench|entrypoint becomes healthy" crm/test/http.test.js crm/test/smoke.test.js`

Expected: FAIL because the navigation is disabled, elements/API calls are absent, and seed metrics still show three customers with no pending enrollment.

- [ ] **Step 3: Add the idempotent fictional seed**

In `seedDemoData()`, retain all existing `chengqiyun-demo:v1` requests unchanged. Add one new customer request and one submission request using the consultant actor:

```js
const consultant = DEMO_ACTORS['consultant-1'];
const enrollmentCustomer = service.importCustomer({
  actor: consultant,
  requestId: 'chengqiyun-demo:enrollment:v1:customer:1',
  customer: { name: '虚构报名客户', phone: '13800000004', ownerId: 'consultant-1', campusId: 'campus-a', teamId: 'team-a', assignedTeacherId: 'teacher-1', stage: '待报名审核', notes: '仅用于本地虚构演示。' },
  source: { channel: 'local-fictional-demo', batch: 'enrollment-seed-v1' },
}).customer;
const enrollment = service.submitEnrollment({
  actor: consultant,
  requestId: 'chengqiyun-demo:enrollment:v1:submit:1',
  customerId: enrollmentCustomer.id,
  enrollment: { currentEducation: '高中', targetLevel: '本科', school: '虚构大学', major: '数字媒体', classType: '周末班' },
}).enrollment;
```

Include the new IDs in the seed return object. Reopening must replay, not duplicate, both writes.

- [ ] **Step 4: Build the accessible same-origin UI**

In HTML, enable the navigation target and add:

- A consultant submission form with customer, current education, target level, school, major, class type.
- A pending/history enrollment card list with supervisor/admin decision controls.
- A student card list.
- A manual task form with customer, title, and due time.
- A task card list with only forward-state buttons.

In JavaScript, replace `request(path)` with `request(path, options = {})`, always inject the selected server demo header, and add `post(path, body)`. Fetch dashboard, customers, enrollments, students, and tasks under the existing generation guard. Build every external value with `document.createElement`, `.textContent`, and `<time dateTime=...>`; never interpolate external data into `innerHTML`.

Use a local literal role map only to hide impossible controls for usability; do not treat it as authorization. Every mutation generates `crypto.randomUUID()` request IDs, disables its submitting button, posts the allowlisted payload, reports through `#status`, and reloads all lists after success.

In CSS, use `.workflow-grid` and `.workflow-card` with the existing colors/focus styles. At `max-width: 940px`, change the workflow grid to one column and keep every form control/button at least 40px high. At `max-width: 600px`, stack action groups without horizontal scrolling.

- [ ] **Step 5: Run workbench, smoke, and full CRM tests**

Run: `node --test crm/test/http.test.js crm/test/smoke.test.js && node --test crm/test/*.test.js`

Expected: all commands PASS; a second process start yields byte-equivalent dashboard data and no duplicate seed rows.

- [ ] **Step 6: Commit Task 8**

```powershell
git add crm/src/demo/seed.js crm/public/index.html crm/public/app.js crm/public/styles.css crm/test/http.test.js crm/test/smoke.test.js
git commit -m "feat(crm): add enrollment and task workbench"
```

---

### Task 9: Documentation, final verification, and remote checkpoint

**Files:**
- Modify: `crm/README.md`
- Modify: `README.md`
- Modify: `.superpowers/sdd/2026-09-07-enrollment-student-follow-up/progress.md` (ignored local execution ledger)

**Interfaces:**
- Consumes: Complete Tasks 1–8 workflow.
- Produces: Runnable operator instructions, documented fictional roles/routes/boundaries, full verification evidence, and a pushed feature-branch checkpoint.

- [ ] **Step 1: Update operator documentation**

Document in `crm/README.md`:

- `consultant-1` submission, `supervisor-1` scoped decision, and admin global decision.
- The five new fixed API paths and their server-owned fields.
- The exact task transitions and approval-generated 24-hour task.
- Fictional-data-only warning and explicit absence of material upload, production auth, arbitrary assignment, notifications, and repeat enrollment.
- Commands `npm run crm:start` and `npm run crm:test`.

Update the root README feature-branch section to name the new workflow without describing it as production-ready.

- [ ] **Step 2: Run final verification on the exact worktree HEAD**

Run:

```powershell
node --test crm/test/*.test.js
node --test test/*.test.js
$files = Get-ChildItem crm/src -Recurse -Filter *.js
$files += Get-Item crm/public/app.js
foreach ($file in $files) { node --check $file.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
git diff --check
git status --short --branch
```

Expected: all CRM tests PASS, all 95 legacy tests PASS, syntax checks exit 0, diff check is clean, and only the intended documentation/ledger state remains before commit.

- [ ] **Step 3: Commit documentation**

```powershell
git add README.md crm/README.md
git commit -m "docs(crm): publish enrollment workflow guide"
```

- [ ] **Step 4: Request independent spec and quality review**

Ask one reviewer to compare the full implementation range with `docs/superpowers/specs/2026-09-07-enrollment-student-follow-up-design.md`, reproduce authorization/concurrency/privacy boundaries, and return separate `SPEC_COMPLIANT` and `QUALITY_APPROVED` verdicts. For each verified finding, add a failing regression test, observe RED, implement the minimum fix, rerun focused/full suites, commit, and request re-review.

- [ ] **Step 5: Record the final execution evidence**

Create or update `.superpowers/sdd/2026-09-07-enrollment-student-follow-up/progress.md` with the Task 1–9 commit hashes, focused/full test counts, review rounds, final review verdicts, and any explicitly deferred spec boundaries. This ledger remains ignored and must not be forced into Git.

- [ ] **Step 6: Push and verify the remote branch**

```powershell
git push origin codex/chengqiyun-core-slice
git ls-remote --heads origin codex/chengqiyun-core-slice
git rev-parse codex/chengqiyun-core-slice
```

Expected: remote and local hashes are identical. Do not merge into `main` without a separate user instruction.
