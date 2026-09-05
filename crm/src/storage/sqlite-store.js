'use strict';

const { DatabaseSync } = require('node:sqlite');

function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  let closed = false;
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    db.exec(`BEGIN IMMEDIATE;
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
      ) STRICT;
      COMMIT;`);
  } catch (error) { db.close(); throw error; }

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
