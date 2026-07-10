-- Migration number: 0001

CREATE TABLE licenses (
  key TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  org_id TEXT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  paddle_subscription_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NULL
);

CREATE INDEX idx_licenses_paddle_subscription_id
  ON licenses (paddle_subscription_id);

-- Append-only webhook log; UNIQUE event_id doubles as the idempotency guard.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
