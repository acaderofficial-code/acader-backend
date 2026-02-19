CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS financial_event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  withdrawal_id INTEGER REFERENCES withdrawals(id) ON DELETE SET NULL,
  dispute_id INTEGER REFERENCES disputes(id) ON DELETE SET NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_financial_event_log_created
  ON financial_event_log(created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_event_log_current_hash
  ON financial_event_log(current_hash);

CREATE INDEX IF NOT EXISTS idx_financial_event_log_user
  ON financial_event_log(user_id, created_at DESC);
