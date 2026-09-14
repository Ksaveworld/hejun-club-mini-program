import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_version VALUES (1);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('member','admin')), created_at TEXT NOT NULL,
      referral_code TEXT NOT NULL UNIQUE,
      referrer_id TEXT REFERENCES users(id), referral_source TEXT CHECK(referral_source IN ('explicit','default')),
      referral_at TEXT, referral_locked_at TEXT, consent_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS native_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL, auth_mode TEXT NOT NULL CHECK(auth_mode IN ('local-trial','wechat'))
    );
    CREATE TABLE IF NOT EXISTS wechat_identities (
      app_id TEXT NOT NULL, open_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, PRIMARY KEY(app_id,open_id), UNIQUE(app_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL CHECK(status IN ('review','pending','paid','cancelled','rejected')),
      profile_json TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT, expires_at TEXT,
      actual_paid_cents INTEGER, referrer_id TEXT REFERENCES users(id), referral_source TEXT,
      reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, review_note TEXT,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      UNIQUE(user_id,idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_order ON orders(user_id) WHERE status IN ('review','pending');
    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT PRIMARY KEY REFERENCES users(id), order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
      plan_id TEXT NOT NULL, starts_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_receipts (
      transaction_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
      payload_hash TEXT NOT NULL, received_at TEXT NOT NULL, outcome TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','published','rejected')), reason TEXT,
      created_at TEXT NOT NULL, reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT,
      idempotency_key TEXT NOT NULL, UNIQUE(user_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
      target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('news','knowledge')),
      access_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published')),
      revision INTEGER NOT NULL CHECK(revision > 0), created_by TEXT NOT NULL REFERENCES users(id),
      updated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      published_at TEXT, idempotency_key TEXT NOT NULL, creation_hash TEXT NOT NULL,
      UNIQUE(created_by,idempotency_key)
    );
    INSERT OR IGNORE INTO schema_version VALUES (2);
    CREATE TABLE IF NOT EXISTS feedback_tickets (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','processing','resolved')), revision INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      UNIQUE(user_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS feedback_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id),
      actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL CHECK(action IN ('accept','reply')),
      body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, UNIQUE(actor_id,idempotency_key)
    );
    INSERT OR IGNORE INTO schema_version VALUES (3);
  `);
  transaction(db, () => {
    const additions = {
      feedback_tickets: { member_read_seq: 'INTEGER NOT NULL DEFAULT 0', confirmed_at: 'TEXT', related_order_id: 'TEXT REFERENCES orders(id)' },
      feedback_events: { author_kind: "TEXT NOT NULL DEFAULT 'staff'" }
    };
    for (const [table, columns] of Object.entries(additions)) {
      const existing = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
      for (const [column, type] of Object.entries(columns)) if (!existing.has(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + type);
    }
    db.exec('INSERT OR IGNORE INTO schema_version VALUES (4)');
  });
  transaction(db, () => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS service_resources (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('translation','lectures','directory','visits')),
      access_json TEXT NOT NULL, action_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published')),
      revision INTEGER NOT NULL CHECK(revision > 0), created_by TEXT NOT NULL REFERENCES users(id),
      updated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      published_at TEXT, idempotency_key TEXT NOT NULL, creation_hash TEXT NOT NULL,
      UNIQUE(created_by,idempotency_key)
    );
    INSERT OR IGNORE INTO schema_version VALUES (5);
    `);
  });
  db.exec(`CREATE TABLE IF NOT EXISTS article_documents (
    article_id TEXT PRIMARY KEY REFERENCES articles(id), sha256 TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0),
    pages INTEGER NOT NULL CHECK(pages>0), imported_at TEXT NOT NULL
  ); INSERT OR IGNORE INTO schema_version VALUES (6);`);
  db.exec(`CREATE TABLE IF NOT EXISTS report_previews (
    article_id TEXT PRIMARY KEY REFERENCES article_documents(article_id),
    sha256 TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL CHECK(byte_size>0),
    pages INTEGER NOT NULL CHECK(pages BETWEEN 1 AND 10)
  ); INSERT OR IGNORE INTO schema_version VALUES (7);`);
  db.exec(`CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY, content_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','published')), revision INTEGER NOT NULL CHECK(revision>0),
    created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    published_at TEXT,idempotency_key TEXT NOT NULL,creation_hash TEXT NOT NULL,UNIQUE(created_by,idempotency_key)
  ); INSERT OR IGNORE INTO schema_version VALUES (8);`);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function audit(db, actor, action, target, detail = {}, now = new Date().toISOString()) {
  db.prepare('INSERT INTO audit_log(actor_id,action,target_id,detail,created_at) VALUES (?,?,?,?,?)')
    .run(actor, action, target, JSON.stringify(detail), now);
}
