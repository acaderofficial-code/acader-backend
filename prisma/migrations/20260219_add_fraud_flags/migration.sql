CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS fraud_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_triggered TEXT NOT NULL,
  risk_score INTEGER NOT NULL CHECK (risk_score >= 0),
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_flags_user_created_at
  ON fraud_flags(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fraud_flags_score_created_at
  ON fraud_flags(risk_score DESC, created_at DESC);
