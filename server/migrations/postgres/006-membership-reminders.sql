-- Opt-in only; no template, schedule, account or permission is fabricated.
CREATE TABLE _club_reminder_choices (
 user_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 app_id TEXT NOT NULL, open_id TEXT NOT NULL, template_id TEXT NOT NULL, config_version TEXT NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('accept','reject','ban','filter')), created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,idempotency_key)
);
CREATE TABLE _club_reminder_events (
 id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, event_json JSONB NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE _club_reminder_tasks (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), app_id TEXT NOT NULL, open_id TEXT NOT NULL,
 template_id TEXT NOT NULL, config_version TEXT NOT NULL, membership_order_id TEXT NOT NULL REFERENCES orders(id),
 expires_at TEXT NOT NULL, offset_days BIGINT NOT NULL CHECK(offset_days IN (30,15,7,3,1)), due_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('waiting_permission','transmitting','accepted','delivered','failed','unknown','cancelled')),
 provider_message_id TEXT, grant_id TEXT, attempts_json JSONB NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT,
 UNIQUE(user_id,app_id,membership_order_id,expires_at,offset_days), UNIQUE(app_id,provider_message_id)
);
CREATE TABLE _club_reminder_grants (
 id TEXT PRIMARY KEY REFERENCES _club_reminder_events(id), user_id TEXT NOT NULL REFERENCES users(id),
 app_id TEXT NOT NULL, open_id TEXT NOT NULL, template_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('available','reserved','consumed','revoked')),
 task_id TEXT UNIQUE REFERENCES _club_reminder_tasks(id), created_at TEXT NOT NULL
);
INSERT INTO settings(key,value) VALUES('_club_membership_reminders_migration','006-membership-reminders-v1');
