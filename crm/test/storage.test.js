'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createStore } = require('../src/storage/sqlite-store');

function databasePath() {
  const dir = mkdtempSync(join(tmpdir(), 'crm-schema-2-'));
  return {
    path: join(dir, 'crm.sqlite'),
    cleanup(t) { t.after(() => rmSync(dir, { recursive: true, force: true })); }
  };
}

function addCustomer(store, id) {
  store.db.prepare('INSERT INTO customers (id, payload) VALUES (?, ?)').run(id, JSON.stringify({ id }));
}

function addApprovedEnrollment(store, id, customerId) {
  store.db.prepare(`INSERT INTO enrollment_applications
    (id, customer_id, status, submitted_by, submitted_at, decided_by, decided_at, payload)
    VALUES (?, ?, 'approved', 'consultant-1', '2026-09-07T01:00:00.000Z', 'supervisor-1', '2026-09-07T02:00:00.000Z', '{}')`)
    .run(id, customerId);
}

test('migrates schema 1 to 2 without changing existing customer data', (t) => {
  const fixture = databasePath();
  const { path } = fixture;
  let store = createStore(path);
  store.db.prepare('INSERT INTO customers (id, payload) VALUES (?, ?)').run('customer-1', JSON.stringify({ id: 'customer-1', name: '虚构客户' }));
  store.close();

  const old = new DatabaseSync(path);
  old.exec("DROP TABLE IF EXISTS follow_up_tasks; DROP TABLE IF EXISTS students; DROP TABLE IF EXISTS enrollment_applications; UPDATE metadata SET value = '1' WHERE key = 'schema_version';");
  old.close();

  store = createStore(path);
  t.after(() => store.close());
  fixture.cleanup(t);
  assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '2');
  assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM customers WHERE id = ?').get('customer-1').payload).name, '虚构客户');
  for (const table of ['enrollment_applications', 'students', 'follow_up_tasks']) {
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).n, 1);
  }
});

test('reopening schema 2 twice preserves existing rows', (t) => {
  const fixture = databasePath();
  const { path } = fixture;
  let store = createStore(path);
  addCustomer(store, 'customer-1');
  store.close();

  for (let reopen = 0; reopen < 2; reopen += 1) {
    store = createStore(path);
    assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '2');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM customers').get().n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM enrollment_applications').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM students').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM follow_up_tasks').get().n, 0);
    store.close();
  }
  fixture.cleanup(t);
});

test('rejects unsupported stored schema versions', (t) => {
  for (const version of ['0', '3', '01', '2.0', 'version-2']) {
    const fixture = databasePath();
    const { path } = fixture;
    const initial = createStore(path);
    initial.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(version);
    db.close();
    assert.throws(() => createStore(path), { code: 'UNSUPPORTED_SCHEMA_VERSION' });
    fixture.cleanup(t);
  }
});

test('enforces enrollment, student, and approval-origin task uniqueness', (t) => {
  const fixture = databasePath();
  const store = createStore(fixture.path);
  t.after(() => store.close());
  fixture.cleanup(t);
  addCustomer(store, 'customer-1');
  addCustomer(store, 'customer-2');
  const insertPending = store.db.prepare(`INSERT INTO enrollment_applications
    (id, customer_id, status, submitted_by, submitted_at, payload)
    VALUES (?, 'customer-1', 'pending', 'consultant-1', '2026-09-07T01:00:00.000Z', '{}')`);
  insertPending.run('pending-1');
  assert.throws(() => insertPending.run('pending-2'));

  addApprovedEnrollment(store, 'enrollment-1', 'customer-1');
  addApprovedEnrollment(store, 'enrollment-2', 'customer-1');
  const insertStudent = store.db.prepare("INSERT INTO students (id, customer_id, enrollment_id, created_at, payload) VALUES (?, ?, ?, '2026-09-07T03:00:00.000Z', '{}')");
  insertStudent.run('student-1', 'customer-1', 'enrollment-1');
  assert.throws(() => insertStudent.run('student-2', 'customer-1', 'enrollment-2'));
  assert.throws(() => insertStudent.run('student-3', 'customer-2', 'enrollment-1'));

  const insertTask = store.db.prepare(`INSERT INTO follow_up_tasks
    (id, customer_id, student_id, origin_type, origin_id, owner_id, due_at, status, payload)
    VALUES (?, 'customer-1', 'student-1', 'enrollment_approval', 'enrollment-1', 'consultant-1', '2026-09-08T01:00:00.000Z', 'open', '{}')`);
  insertTask.run('task-1');
  assert.throws(() => insertTask.run('task-2'));
});

test('enforces enrollment decision and follow-up task status constraints', (t) => {
  const fixture = databasePath();
  const store = createStore(fixture.path);
  t.after(() => store.close());
  fixture.cleanup(t);
  addCustomer(store, 'customer-1');
  const enrollment = store.db.prepare(`INSERT INTO enrollment_applications
    (id, customer_id, status, submitted_by, submitted_at, decided_by, decided_at, payload)
    VALUES (?, 'customer-1', ?, 'consultant-1', '2026-09-07T01:00:00.000Z', ?, ?, '{}')`);
  assert.throws(() => enrollment.run('invalid-status', 'draft', null, null));
  assert.throws(() => enrollment.run('pending-with-decision', 'pending', 'supervisor-1', '2026-09-07T02:00:00.000Z'));
  assert.throws(() => enrollment.run('approved-without-decision', 'approved', null, null));
  enrollment.run('approved', 'approved', 'supervisor-1', '2026-09-07T02:00:00.000Z');
  enrollment.run('rejected', 'rejected', 'supervisor-1', '2026-09-07T02:00:00.000Z');
  store.db.prepare("INSERT INTO students (id, customer_id, enrollment_id, created_at, payload) VALUES ('student-1', 'customer-1', 'approved', '2026-09-07T03:00:00.000Z', '{}')").run();

  const task = store.db.prepare(`INSERT INTO follow_up_tasks
    (id, customer_id, student_id, origin_type, origin_id, owner_id, due_at, status, payload)
    VALUES (?, 'customer-1', ?, ?, ?, 'consultant-1', '2026-09-08T01:00:00.000Z', ?, '{}')`);
  assert.throws(() => task.run('invalid-status', null, 'manual', null, 'deferred'));
  assert.throws(() => task.run('manual-with-origin', null, 'manual', 'enrollment-1', 'open'));
  assert.throws(() => task.run('approval-without-links', null, 'enrollment_approval', null, 'open'));
  task.run('manual-open', null, 'manual', null, 'open');
  task.run('approval-completed', 'student-1', 'enrollment_approval', 'enrollment-1', 'completed');
});
