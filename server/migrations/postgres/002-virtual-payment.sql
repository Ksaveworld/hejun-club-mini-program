-- Explicit additive upgrade only; do not change historical 001/baseline markers.
CREATE TABLE _club_virtual_payment_attempts (
  order_id TEXT COLLATE "C" PRIMARY KEY REFERENCES orders(id),
  user_id TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  app_id TEXT COLLATE "C" NOT NULL,
  env BIGINT NOT NULL CHECK(env IN (0,1)),
  snapshot_json TEXT COLLATE "C" NOT NULL,
  issued_at TEXT COLLATE "C" NOT NULL,
  provider_order_id TEXT COLLATE "C",
  receipt_hash TEXT COLLATE "C",
  receipt_json TEXT COLLATE "C",
  state TEXT COLLATE "C" NOT NULL CHECK(state IN ('issued','paid','delivered','closed','reconciliation')),
  delivery_state TEXT COLLATE "C" NOT NULL CHECK(delivery_state IN ('waiting','pending','processing','confirmed','blocked')),
  delivery_lease TEXT COLLATE "C",
  last_query_json TEXT COLLATE "C",
  next_check_at TEXT COLLATE "C" NOT NULL,
  retry_count BIGINT NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  last_error_code TEXT COLLATE "C",
  updated_at TEXT COLLATE "C" NOT NULL,
  UNIQUE(app_id,env,provider_order_id)
);
CREATE INDEX virtual_payment_recovery ON _club_virtual_payment_attempts(next_check_at,order_id)
  WHERE state IN ('issued','paid');
