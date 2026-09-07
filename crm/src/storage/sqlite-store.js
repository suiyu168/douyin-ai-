'use strict';

const { DatabaseSync } = require('node:sqlite');

function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  let closed = false;
  let startupTransaction = false;
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    db.exec('BEGIN IMMEDIATE');
    startupTransaction = true;
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO metadata (key, value) SELECT 'schema_version', '1'
        WHERE NOT EXISTS (SELECT 1 FROM metadata WHERE key = 'schema_version');
      CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS customer_identities (
        customer_id TEXT NOT NULL REFERENCES customers(id), field TEXT NOT NULL,
        hash TEXT NOT NULL, PRIMARY KEY(customer_id, field, hash)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS identity_lookup ON customer_identities(field, hash);
      CREATE UNIQUE INDEX IF NOT EXISTS strong_identity_unique ON customer_identities(field, hash)
        WHERE field IN ('phone', 'wechat');
      CREATE TABLE IF NOT EXISTS customer_sources (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ledger_entries (
        sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL REFERENCES orders(id),
        idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL,
        before_summary TEXT NOT NULL, after_summary TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS request_results (
        request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_signature TEXT NOT NULL,
        action TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id), result TEXT NOT NULL
      ) STRICT;`);

    const version = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value;
    if (!/^(?:0|[1-9]\d*)$/.test(version) || Number(version) < 1 || Number(version) > 2) {
      throw Object.assign(new Error('UNSUPPORTED_SCHEMA_VERSION'), { code: 'UNSUPPORTED_SCHEMA_VERSION' });
    }
    if (version === '1') {
      db.exec(`
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
        UPDATE metadata SET value = '2' WHERE key = 'schema_version';`);
    }
    db.exec('COMMIT');
    startupTransaction = false;
  } catch (error) {
    if (startupTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the startup error. */ }
    }
    db.close();
    throw error;
  }

  function transaction(work) {
    const asyncError = () => Object.assign(new Error('ASYNC_TRANSACTION'), { code: 'ASYNC_TRANSACTION' });
    if (work?.constructor?.name === 'AsyncFunction') throw asyncError();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (result && typeof result.then === 'function') throw asyncError();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { db, transaction, close() { if (!closed) { db.close(); closed = true; } } };
}

module.exports = { createStore };
