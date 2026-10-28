-- Standalone proposal; the integrator assigns the migration number/allowlist.
-- Run only through grant-migration.mjs in an explicitly selected schema transaction.
-- Existing collaboration-v1 installations adopt these tables without rebuilding them.
CREATE TABLE collab_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  level TEXT NOT NULL CHECK(level='star'),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  approval_reference TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id),
  revoke_reason TEXT
);
CREATE INDEX collab_grants_user ON collab_grants(user_id);
CREATE TABLE collab_grant_batches (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
