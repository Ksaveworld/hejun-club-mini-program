CREATE TABLE grant_person_evidence (
 user_id TEXT PRIMARY KEY REFERENCES users(id), app_id TEXT NOT NULL, open_id TEXT NOT NULL,
 evidence_reference TEXT NOT NULL, revision BIGINT NOT NULL CHECK (revision > 0),
 expires_at TEXT NOT NULL, active BOOLEAN NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), changed_at TEXT NOT NULL
);
CREATE TABLE grant_person_approvals (
 reference TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 level TEXT NOT NULL CHECK (level IN ('basic','star')),
 identity_revision BIGINT NOT NULL CHECK (identity_revision > 0),
 revision BIGINT NOT NULL CHECK (revision > 0), expires_at TEXT NOT NULL, active BOOLEAN NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), changed_at TEXT NOT NULL
);
