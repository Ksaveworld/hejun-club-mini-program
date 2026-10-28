-- Explicit, additive opt-in only. Never applied by constructing a disabled service.
CREATE TABLE _club_reward_ledger_state (
  id TEXT PRIMARY KEY CHECK(id='main'),
  state_json JSONB NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>=0),
  updated_at TEXT NOT NULL
);
CREATE TABLE _club_reward_ledger_commands (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TABLE _club_reward_order_snapshots (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  snapshot_json JSONB NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO settings(key,value) VALUES('_club_reward_ledger_migration','003-reward-ledger-v1');
