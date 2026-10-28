-- Explicit opt-in schema only. No reviewer, password, entitlement or production
-- member/payment/referral data is inserted by this migration.
CREATE TABLE _club_review_accounts (
 id TEXT COLLATE "C" PRIMARY KEY,
 username TEXT COLLATE "C" NOT NULL UNIQUE,
 password_hash TEXT COLLATE "C" NOT NULL CHECK(password_hash ~ '^[a-f0-9]{32}:[a-f0-9]{128}$'),
 app_id TEXT COLLATE "C" NOT NULL CHECK(app_id='wx47d5e3e20fd77f65'),
 app_version TEXT COLLATE "C" NOT NULL CHECK(app_version='1.1.0'),
 plan_id TEXT COLLATE "C" NOT NULL CHECK(plan_id IN ('basic','star')),
 scope_json JSONB NOT NULL CHECK(jsonb_typeof(scope_json)='object'),
 starts_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 approved_by TEXT COLLATE "C" NOT NULL CHECK(length(trim(approved_by))>0),
 approval_ref TEXT COLLATE "C" NOT NULL CHECK(length(trim(approval_ref))>0),
 approved_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 CHECK(expires_at=starts_at+INTERVAL '720 hours'),
 CHECK((plan_id='basic' AND username='review_basic_110') OR (plan_id='star' AND username='review_star_110')),
 UNIQUE(app_id,app_version,plan_id)
);
CREATE TABLE _club_review_sessions (
 token_hash TEXT COLLATE "C" PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 account_id TEXT COLLATE "C" NOT NULL REFERENCES _club_review_accounts(id),
 auth_mode TEXT COLLATE "C" NOT NULL CHECK(auth_mode='review'),
 grant_digest TEXT COLLATE "C" NOT NULL CHECK(grant_digest ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 consent_json JSONB NOT NULL CHECK(jsonb_typeof(consent_json)='object'),
 CHECK(expires_at>created_at AND expires_at<=created_at+INTERVAL '12 hours')
);
CREATE INDEX _club_review_sessions_account ON _club_review_sessions(account_id);
INSERT INTO settings(key,value) VALUES('_club_review_access_migration','007-review-access-v1');
