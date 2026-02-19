CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS fraud_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  withdrawal_id INTEGER REFERENCES withdrawals(id) ON DELETE SET NULL,
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  admin_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_fraud_reviews_status_created
  ON fraud_reviews(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fraud_reviews_user_created
  ON fraud_reviews(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fraud_reviews_pending_unique
  ON fraud_reviews(user_id, reason, COALESCE(payment_id, -1), COALESCE(withdrawal_id, -1))
  WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS wallet_restrictions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
