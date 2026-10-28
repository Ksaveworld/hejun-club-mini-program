-- Proposal only. Ethan assigns the migration number and runtime table allowlist.
-- Apply inside the caller's explicit schema transaction. No legacy row is rewritten.
CREATE TABLE collab_associations (id TEXT PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true);
CREATE TABLE collab_accounts (user_id TEXT PRIMARY KEY REFERENCES users(id), association_id TEXT NOT NULL REFERENCES collab_associations(id), active BOOLEAN NOT NULL DEFAULT true, actions_json TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1);
CREATE TABLE collab_objects (kind TEXT NOT NULL CHECK(kind IN ('articles','activities')), object_id TEXT NOT NULL, association_id TEXT NOT NULL REFERENCES collab_associations(id), blocked BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY(kind,object_id));
CREATE TABLE collab_compliance (id TEXT PRIMARY KEY, kind TEXT NOT NULL, object_id TEXT NOT NULL, content_revision BIGINT NOT NULL, content_hash TEXT NOT NULL, text_version TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE collab_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), level TEXT NOT NULL CHECK(level='star'), starts_at TEXT NOT NULL, expires_at TEXT NOT NULL, reason TEXT NOT NULL, approval_reference TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('active','revoked')), idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, revoked_by TEXT REFERENCES users(id), revoke_reason TEXT);
CREATE INDEX collab_grants_user ON collab_grants(user_id);
CREATE TABLE collab_grant_batches (idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, created_at TEXT NOT NULL);
