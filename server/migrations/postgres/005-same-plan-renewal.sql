-- Explicit additive migration; no historical orders or memberships are rewritten.
CREATE TABLE _club_order_transactions (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  kind TEXT NOT NULL CHECK(kind IN ('first_purchase','renewal')),
  snapshot_json JSONB NOT NULL,
  applied_at TEXT,
  expires_at TEXT
);
INSERT INTO settings(key,value) VALUES('_club_same_plan_renewal_migration','005-same-plan-renewal-v1');
