CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,
  plan_code          TEXT NOT NULL,
  seat_qty           INTEGER NOT NULL,
  period_start       INTEGER NOT NULL,
  period_end         INTEGER NOT NULL,
  accrued_units      INTEGER NOT NULL DEFAULT 0,
  paid_invoice_count INTEGER NOT NULL DEFAULT 0,
  max_retries        INTEGER NOT NULL DEFAULT 3,
  current_invoice_id TEXT,
  lifecycle_state    TEXT NOT NULL DEFAULT 'trialing',  -- trialing|active|past_due|canceled|expired
  superseded_by      TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id                 TEXT PRIMARY KEY,
  subscription_id    TEXT NOT NULL REFERENCES subscriptions(id),
  license_fee_amount INTEGER NOT NULL,
  usage_amount       INTEGER NOT NULL DEFAULT 0,
  total_due          INTEGER NOT NULL DEFAULT 0,
  settlement_state   TEXT NOT NULL DEFAULT 'draft'      -- draft|open|paid|void|uncollectible
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount     INTEGER NOT NULL,
  paid_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dunning_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   TEXT NOT NULL REFERENCES invoices(id),
  attempted_at INTEGER NOT NULL,
  outcome      TEXT NOT NULL                             -- 'failed'
);

CREATE TABLE IF NOT EXISTS outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_summary (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),
  plan_code       TEXT NOT NULL,
  status          TEXT NOT NULL,
  open_balance    INTEGER NOT NULL,
  lifetime_paid   INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
