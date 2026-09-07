'use strict';

const crypto = require('node:crypto');
const { quoteOrder, appendLedgerEntry, summarizeOrder } = require('../domain/finance');
const { normalizePhone, normalizeWechat, normalizeIdLast4, customerFingerprint, decideDuplicate } = require('../domain/customer');
const { createEnrollmentApplication, decideEnrollmentApplication, createStudentRecord } = require('../domain/enrollment');
const { createFollowUpTask, approvalTaskDueAt, taskView } = require('../domain/follow-up-task');
const { ROLES, can, assertAllowed, maskSensitiveCustomer, maskModuleCustomerSummary } = require('../domain/authorization');
const { triageMessage } = require('../domain/ai-triage');

function fail(code, details) { const error = new Error(code); error.code = code; if (details) error.details = details; throw error; }
function record(value, code) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!Object.hasOwn(descriptor, 'value')) fail(code);
  return value;
}
function string(value, code, { required = false, max = 200 } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(code);
  return value.trim();
}
function date(value) {
  let milliseconds;
  try { milliseconds = Date.prototype.getTime.call(value); }
  catch { milliseconds = (typeof value === 'string' || typeof value === 'number') ? new Date(value).getTime() : NaN; }
  if (!Number.isFinite(milliseconds)) fail('INVALID_DATE');
  return new Date(milliseconds).toISOString();
}
function actorSnapshot(value) {
  record(value, 'FORBIDDEN');
  const actor = { id: string(value.id, 'FORBIDDEN', { required: true }), roles: [], campusIds: [], teamIds: [] };
  for (const field of ['roles', 'campusIds', 'teamIds']) {
    const items = value[field] === undefined && field === 'teamIds' ? [] : value[field];
    if (!Array.isArray(items) || items.length > 1000) fail('FORBIDDEN');
    actor[field] = items.map(item => string(item, 'FORBIDDEN', { required: true }));
  }
  if (!actor.roles.some(role => ROLES.includes(role))) fail('FORBIDDEN');
  return actor;
}
function actorSignature(actor) { return JSON.stringify({ id: actor.id, roles: [...actor.roles].sort(), campusIds: [...actor.campusIds].sort(), teamIds: [...actor.teamIds].sort() }); }
function customerPayload(input) {
  record(input, 'INVALID_CUSTOMER');
  const result = {};
  for (const field of ['name', 'phone', 'wechat', 'idNumber', 'idLast4', 'ownerId', 'campusId', 'teamId', 'assignedTeacherId', 'stage', 'nextFollowUpAt', 'notes']) {
    result[field] = string(input[field], 'INVALID_CUSTOMER', { required: ['name', 'ownerId', 'campusId', 'teamId'].includes(field), max: field === 'notes' ? 4000 : 200 });
  }
  result.phone = normalizePhone(result.phone); result.wechat = normalizeWechat(result.wechat);
  result.idNumber = result.idNumber.replace(/x$/i, 'X');
  if (input.phone && !result.phone) fail('INVALID_CUSTOMER');
  const explicitIdLast4 = normalizeIdLast4(result.idLast4);
  if (result.idLast4 && !explicitIdLast4) fail('INVALID_CUSTOMER');
  const derivedIdLast4 = normalizeIdLast4(result.idNumber.slice(-4));
  if (explicitIdLast4 && derivedIdLast4 && explicitIdLast4 !== derivedIdLast4) fail('INVALID_CUSTOMER');
  result.idLast4 = explicitIdLast4 || derivedIdLast4;
  if (result.nextFollowUpAt) result.nextFollowUpAt = date(result.nextFollowUpAt);
  return result;
}

function identityFieldsConflict(master, candidate) {
  const masterExplicit = normalizeIdLast4(master.idLast4);
  const masterDerived = normalizeIdLast4(typeof master.idNumber === 'string' ? master.idNumber.slice(-4) : '');
  const candidateExplicit = normalizeIdLast4(candidate.idLast4);
  const candidateDerived = normalizeIdLast4(candidate.idNumber.slice(-4));
  if ((masterExplicit && masterDerived && masterExplicit !== masterDerived)
    || (candidateExplicit && candidateDerived && candidateExplicit !== candidateDerived)) return true;
  const masterSuffix = masterExplicit || masterDerived;
  const candidateSuffix = candidateExplicit || candidateDerived;
  if (masterSuffix && candidateSuffix && masterSuffix !== candidateSuffix) return true;
  return Boolean(master.idNumber && candidate.idNumber && master.idNumber !== candidate.idNumber);
}

function createCrmService({ store, clock = () => new Date() }) {
  const { db } = store;
  const loadCustomer = id => {
    const row = db.prepare('SELECT payload FROM customers WHERE id = ?').get(string(id, 'INVALID_CUSTOMER', { required: true }));
    if (!row) fail('NOT_FOUND');
    return JSON.parse(row.payload);
  };
  const loadEnrollment = id => {
    const row = db.prepare('SELECT payload FROM enrollment_applications WHERE id = ?').get(string(id, 'INVALID_ENROLLMENT', { required: true }));
    if (!row) fail('NOT_FOUND');
    return JSON.parse(row.payload);
  };
  function write(input, action, requiredPermissions, work) {
    record(input, 'INVALID_REQUEST');
    const actor = actorSnapshot(input.actor);
    const requestId = string(input.requestId, 'INVALID_REQUEST_ID', { required: true });
    const signature = actorSignature(actor);
    try {
      return store.transaction(() => {
        const previous = db.prepare('SELECT * FROM request_results WHERE request_id = ?').get(requestId);
        if (previous) {
          if (previous.actor_id !== actor.id || previous.actor_signature !== signature) fail('FORBIDDEN');
          if (previous.action !== action) fail('REQUEST_ID_CONFLICT');
          const customer = loadCustomer(previous.customer_id);
          for (const permission of requiredPermissions) assertAllowed(actor, permission, customer);
          return JSON.parse(previous.result);
        }
        const timestamp = date(clock());
        const operation = work(actor, timestamp);
        const result = JSON.stringify(operation.result);
        db.prepare(`INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, request_id, timestamp, before_summary, after_summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), actor.id, action, operation.entityType, operation.entityId, requestId, timestamp, JSON.stringify(operation.before ?? null), JSON.stringify(operation.after));
        db.prepare(`INSERT INTO request_results (request_id, actor_id, actor_signature, action, customer_id, result)
          VALUES (?, ?, ?, ?, ?, ?)`).run(requestId, actor.id, signature, action, operation.customerId, result);
        return JSON.parse(result);
      });
    } catch (error) {
      // Unique-key conflicts never overwrite existing business payloads.
      if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) fail('ID_CONFLICT');
      throw error;
    }
  }
  function importCustomer(input) {
    return write(input, 'customer.import', ['customer.write'], (actor, timestamp) => {
      const candidate = customerPayload(input.customer);
      assertAllowed(actor, 'customer.write', candidate);
      const rawSource = input.source === undefined ? {} : record(input.source, 'INVALID_SOURCE');
      const source = { channel: string(rawSource.channel, 'INVALID_SOURCE'), batch: string(rawSource.batch, 'INVALID_SOURCE') };
      const fingerprint = customerFingerprint(candidate);
      const existing = new Map();
      for (const field of ['phone', 'wechat', 'idLast4']) {
        const hash = fingerprint[`${field}Hash`];
        if (!hash) continue;
        for (const row of db.prepare('SELECT customer_id FROM customer_identities WHERE field = ? AND hash = ? ORDER BY customer_id').all(field, hash)) {
          if (!existing.has(row.customer_id)) {
            assertAllowed(actor, 'customer.write', loadCustomer(row.customer_id));
            existing.set(row.customer_id, { id: row.customer_id });
          }
          existing.get(row.customer_id)[field] = candidate[field];
        }
      }
      const decision = decideDuplicate(candidate, [...existing.values()]);
      if (decision.decision === 'review') fail('CUSTOMER_REVIEW_REQUIRED', { decision: 'review', reasons: decision.reasons });
      const saved = decision.decision === 'merge' ? loadCustomer(decision.customerId) : { ...candidate, id: crypto.randomUUID(), createdAt: timestamp };
      const changedFields = [];
      if (decision.decision === 'merge') {
        if (identityFieldsConflict(saved, candidate)) {
          fail('CUSTOMER_REVIEW_REQUIRED', { decision: 'review', reasons: ['IDENTITY_FIELD_CONFLICT'] });
        }
        for (const field of ['name', 'phone', 'wechat', 'idNumber', 'idLast4', 'assignedTeacherId', 'stage', 'nextFollowUpAt', 'notes']) {
          if (!saved[field] && candidate[field]) {
            saved[field] = candidate[field];
            changedFields.push(field);
          }
        }
        if (changedFields.length > 0) db.prepare('UPDATE customers SET payload = ? WHERE id = ?').run(JSON.stringify(saved), saved.id);
      }
      if (decision.decision === 'create') db.prepare('INSERT INTO customers (id, payload) VALUES (?, ?)').run(saved.id, JSON.stringify(saved));
      for (const field of ['phone', 'wechat', 'idLast4']) {
        const hash = fingerprint[`${field}Hash`];
        if (hash && !db.prepare('SELECT 1 FROM customer_identities WHERE customer_id = ? AND field = ? AND hash = ?').get(saved.id, field, hash)) {
          db.prepare('INSERT INTO customer_identities (customer_id, field, hash) VALUES (?, ?, ?)').run(saved.id, field, hash);
        }
      }
      const sourceId = crypto.randomUUID();
      db.prepare('INSERT INTO customer_sources (id, customer_id, payload) VALUES (?, ?, ?)').run(sourceId, saved.id, JSON.stringify({ ...source, id: sourceId, customerId: saved.id, createdAt: timestamp }));
      return { customerId: saved.id, entityType: 'customer', entityId: saved.id,
        before: decision.decision === 'merge' ? { exists: true } : null,
        after: { decision: decision.decision, sourceCount: db.prepare('SELECT count(*) AS n FROM customer_sources WHERE customer_id = ?').get(saved.id).n, ...(decision.decision === 'merge' ? { changedFields: changedFields.sort() } : {}) },
        result: { decision: decision.decision, reasons: decision.reasons, customer: maskSensitiveCustomer(saved, actor), sourceId } };
    });
  }
  function scopedReadContext(input, action) {
    record(input, 'INVALID_REQUEST');
    const actor = actorSnapshot(input.actor);
    const rawScope = input.scope === undefined ? {} : record(input.scope, 'INVALID_SCOPE');
    const scope = {};
    for (const [key, value] of Object.entries(rawScope)) {
      if (!['campusId', 'teamId', 'ownerId'].includes(key)) fail('INVALID_SCOPE');
      scope[key] = string(value, 'INVALID_SCOPE', { required: true });
    }
    const campuses = scope.campusId ? [scope.campusId] : actor.campusIds.length ? actor.campusIds : [''];
    const teams = scope.teamId ? [scope.teamId] : actor.teamIds.length ? actor.teamIds : [''];
    const permitted = campuses.some(campusId => teams.some(teamId => can(actor, action, {
      campusId, teamId, ownerId: scope.ownerId || actor.id, assignedTeacherId: actor.id,
    })));
    if (!permitted) fail('FORBIDDEN');
    return { actor, scope };
  }
  const readContext = input => scopedReadContext(input, 'customer.read');
  function visibleCustomers(actor, scope) {
    return db.prepare('SELECT payload FROM customers ORDER BY id').all().map(row => JSON.parse(row.payload))
      .filter(customer => Object.entries(scope).every(([key, value]) => customer[key] === value) && can(actor, 'customer.read', customer));
  }
  function listCustomers(input) {
    const { actor, scope } = readContext(input);
    return { customers: visibleCustomers(actor, scope).map(customer => maskSensitiveCustomer(customer, actor)) };
  }
  function submitEnrollment(input) {
    return write(input, 'enrollment.submit', ['enrollment.submit'], (actor, timestamp) => {
      const customer = loadCustomer(input.customerId);
      assertAllowed(actor, 'enrollment.submit', customer);
      if (db.prepare('SELECT 1 FROM students WHERE customer_id = ?').get(customer.id)) fail('STUDENT_EXISTS');
      if (db.prepare("SELECT 1 FROM enrollment_applications WHERE customer_id = ? AND status = 'pending'").get(customer.id)) fail('ENROLLMENT_PENDING');
      const enrollment = createEnrollmentApplication({
        id: crypto.randomUUID(), customerId: customer.id, submittedBy: actor.id, submittedAt: timestamp, input: input.enrollment,
      });
      db.prepare(`INSERT INTO enrollment_applications
        (id, customer_id, status, submitted_by, submitted_at, decided_by, decided_at, payload)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`)
        .run(enrollment.id, customer.id, enrollment.status, enrollment.submittedBy, enrollment.submittedAt, JSON.stringify(enrollment));
      return { customerId: customer.id, entityType: 'enrollment', entityId: enrollment.id,
        after: { status: 'pending' }, result: { enrollment } };
    });
  }
  function decideEnrollment(input) {
    return write(input, 'enrollment.decide', ['enrollment.decide'], (actor, timestamp) => {
      const enrollment = loadEnrollment(input.enrollmentId);
      const customer = loadCustomer(enrollment.customerId);
      assertAllowed(actor, 'enrollment.decide', customer);
      const decided = decideEnrollmentApplication(enrollment, input.decision, actor.id, timestamp);
      if (decided.status === 'approved' && db.prepare('SELECT 1 FROM students WHERE customer_id = ?').get(customer.id)) fail('STUDENT_EXISTS');
      const update = db.prepare(`UPDATE enrollment_applications
        SET status = ?, decided_by = ?, decided_at = ?, payload = ?
        WHERE id = ? AND status = 'pending'`)
        .run(decided.status, decided.decidedBy, decided.decidedAt, JSON.stringify(decided), decided.id);
      if (Number(update.changes) !== 1) fail('ENROLLMENT_ALREADY_DECIDED');

      let student = null;
      let task = null;
      if (decided.status === 'approved') {
        student = createStudentRecord({ id: crypto.randomUUID(), customerId: customer.id, enrollmentId: decided.id, createdAt: timestamp });
        db.prepare('INSERT INTO students (id, customer_id, enrollment_id, created_at, payload) VALUES (?, ?, ?, ?, ?)')
          .run(student.id, student.customerId, student.enrollmentId, student.createdAt, JSON.stringify(student));
        const savedTask = createFollowUpTask({
          id: crypto.randomUUID(), customerId: customer.id, studentId: student.id,
          originType: 'enrollment_approval', originId: decided.id, ownerId: customer.ownerId,
          title: '完成报名交接', dueAt: approvalTaskDueAt(timestamp),
        });
        db.prepare(`INSERT INTO follow_up_tasks
          (id, customer_id, student_id, origin_type, origin_id, owner_id, due_at, status, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(savedTask.id, savedTask.customerId, savedTask.studentId, savedTask.originType, savedTask.originId,
            savedTask.ownerId, savedTask.dueAt, savedTask.status, JSON.stringify(savedTask));
        task = taskView(savedTask, timestamp);
      }
      return { customerId: customer.id, entityType: 'enrollment', entityId: decided.id,
        before: { status: enrollment.status },
        after: { status: decided.status, studentCreated: student !== null, taskCreated: task !== null },
        result: { enrollment: decided, student, task } };
    });
  }
  function listEnrollments(input) {
    const { actor, scope } = scopedReadContext(input, 'enrollment.read');
    const enrollments = db.prepare('SELECT payload FROM enrollment_applications ORDER BY submitted_at, id').all()
      .map(row => JSON.parse(row.payload))
      .flatMap(enrollment => {
        const customer = loadCustomer(enrollment.customerId);
        if (!Object.entries(scope).every(([key, value]) => customer[key] === value) || !can(actor, 'enrollment.read', customer)) return [];
        return [{ ...enrollment, customer: maskModuleCustomerSummary(customer, actor, 'enrollment.read') }];
      });
    return { enrollments };
  }
  function listStudents(input) {
    const { actor, scope } = scopedReadContext(input, 'student.read');
    const students = db.prepare('SELECT payload FROM students ORDER BY created_at, id').all()
      .map(row => JSON.parse(row.payload))
      .flatMap(student => {
        const customer = loadCustomer(student.customerId);
        if (!Object.entries(scope).every(([key, value]) => customer[key] === value) || !can(actor, 'student.read', customer)) return [];
        return [{ ...student, customer: maskModuleCustomerSummary(customer, actor, 'student.read') }];
      });
    return { students };
  }
  function loadOrder(id) {
    const row = db.prepare('SELECT payload FROM orders WHERE id = ?').get(string(id, 'INVALID_ORDER', { required: true }));
    if (!row) fail('NOT_FOUND');
    const order = JSON.parse(row.payload);
    order.ledger = db.prepare('SELECT payload FROM ledger_entries WHERE order_id = ? ORDER BY sequence').all(order.id).map(entry => JSON.parse(entry.payload));
    return order;
  }
  function createOrder(input) {
    return write(input, 'order.create', ['customer.write'], (actor, timestamp) => {
      const customer = loadCustomer(input.customerId);
      assertAllowed(actor, 'customer.write', customer);
      const raw = record(input.order, 'INVALID_ORDER');
      if (Object.hasOwn(raw, 'discountApproved') && typeof raw.discountApproved !== 'boolean') fail('INVALID_ORDER');
      const order = { listPriceCents: raw.listPriceCents };
      for (const field of ['discountCents', 'discountApproved']) if (Object.hasOwn(raw, field)) order[field] = raw[field];
      if (Object.hasOwn(raw, 'dueAt')) order.dueAt = date(raw.dueAt);
      if (Object.hasOwn(raw, 'title')) order.title = string(raw.title, 'INVALID_ORDER');
      const saved = quoteOrder({ ...order, id: crypto.randomUUID(), customerId: customer.id, createdAt: timestamp });
      const summary = summarizeOrder(saved, timestamp);
      db.prepare('INSERT INTO orders (id, customer_id, payload) VALUES (?, ?, ?)').run(saved.id, customer.id, JSON.stringify(saved));
      return { customerId: customer.id, entityType: 'order', entityId: saved.id, after: summary, result: { order: saved, summary } };
    });
  }
  function appendPayment(input) {
    return write(input, 'ledger.append', ['ledger.write'], (actor, timestamp) => {
      const order = loadOrder(input.orderId);
      const customer = loadCustomer(order.customerId);
      assertAllowed(actor, 'ledger.write', customer);
      const raw = record(input.entry, 'INVALID_LEDGER_ENTRY');
      const entry = { id: crypto.randomUUID() };
      for (const field of ['type', 'idempotencyKey', 'amountCents', 'status', 'direction']) if (Object.hasOwn(raw, field)) entry[field] = raw[field];
      if (Object.hasOwn(raw, 'direction') && typeof raw.direction !== 'string') fail('INVALID_LEDGER_ENTRY');
      entry.idempotencyKey = string(entry.idempotencyKey, 'INVALID_LEDGER_ENTRY', { required: true });
      entry.occurredAt = date(raw.occurredAt);
      if (db.prepare('SELECT 1 FROM ledger_entries WHERE idempotency_key = ?').get(entry.idempotencyKey)) fail('DUPLICATE_LEDGER_ENTRY');
      const saved = appendLedgerEntry(order, entry);
      const summary = summarizeOrder(saved, timestamp);
      const savedEntry = saved.ledger.at(-1);
      db.prepare('INSERT INTO ledger_entries (id, order_id, idempotency_key, payload) VALUES (?, ?, ?, ?)').run(savedEntry.id, order.id, savedEntry.idempotencyKey, JSON.stringify(savedEntry));
      return { customerId: customer.id, entityType: 'ledger_entry', entityId: savedEntry.id, before: summarizeOrder(order, timestamp), after: summary, result: { order: saved, summary } };
    });
  }
  function triageConversation(input) {
    return write(input, 'conversation.triage', ['customer.write', 'conversation.read'], (actor, timestamp) => {
      const customer = loadCustomer(input.customerId);
      assertAllowed(actor, 'customer.write', customer);
      assertAllowed(actor, 'conversation.read', customer);
      const raw = record(input.conversation, 'INVALID_CONVERSATION');
      const message = string(raw.message, 'INVALID_CONVERSATION', { required: true, max: 16000 });
      const decision = triageMessage({ message, confidence: raw.confidence, citations: raw.citations, now: timestamp });
      const conversation = { id: crypto.randomUUID(), customerId: customer.id, message, ...decision, createdAt: timestamp };
      db.prepare('INSERT INTO conversations (id, customer_id, payload) VALUES (?, ?, ?)').run(conversation.id, customer.id, JSON.stringify(conversation));
      return { customerId: customer.id, entityType: 'conversation', entityId: conversation.id,
        after: { mode: decision.mode, reasons: decision.reasons, citationCount: decision.citations.length }, result: { conversation } };
    });
  }
  function dashboard(input) {
    const { actor, scope } = readContext(input);
    const customers = visibleCustomers(actor, scope);
    const conversationCustomerIds = new Set(customers.filter(customer => can(actor, 'conversation.read', customer)).map(customer => customer.id));
    const pendingConversationIds = db.prepare('SELECT id, customer_id, payload FROM conversations ORDER BY id').all()
      .filter(row => conversationCustomerIds.has(row.customer_id) && JSON.parse(row.payload).mode === 'human_required')
      .map(row => row.id);
    const orderCustomerIds = new Set(customers.filter(customer => can(actor, 'order.read', customer)).map(customer => customer.id));
    const metrics = Object.fromEntries(['agreed', 'receivable', 'received', 'outstanding', 'refunded', 'reversed', 'netReceived'].map(key => [key, { amountCents: 0, orderIds: [] }]));
    const totals = Object.fromEntries(Object.keys(metrics).map(key => [key, 0n]));
    const timestamp = date(clock());
    for (const row of db.prepare('SELECT id, customer_id FROM orders ORDER BY id').all()) {
      if (!orderCustomerIds.has(row.customer_id)) continue;
      const summary = summarizeOrder(loadOrder(row.id), timestamp);
      for (const key of Object.keys(metrics)) {
        totals[key] += BigInt(summary[key]);
        // An order contributes to a metric when its own value for that metric is nonzero.
        if (summary[key] !== 0) metrics[key].orderIds.push(row.id);
      }
    }
    for (const key of Object.keys(metrics)) {
      if (totals[key] > BigInt(Number.MAX_SAFE_INTEGER) || totals[key] < -BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_TOTAL');
      metrics[key].amountCents = Number(totals[key]);
    }
    return { customerCount: customers.length, metrics, pendingHumanCount: pendingConversationIds.length, pendingConversationIds };
  }
  return {
    importCustomer, listCustomers, submitEnrollment, decideEnrollment, listEnrollments, listStudents,
    createOrder, appendPayment, triageConversation, dashboard,
  };
}

module.exports = { createCrmService };
