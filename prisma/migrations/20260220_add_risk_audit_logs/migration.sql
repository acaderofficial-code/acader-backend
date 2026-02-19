CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS risk_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  reason TEXT,
  risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
  related_payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  related_withdrawal_id INTEGER REFERENCES withdrawals(id) ON DELETE SET NULL,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_audit_logs_user_created
  ON risk_audit_logs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_audit_logs_action_created
  ON risk_audit_logs(action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_audit_logs_payment
  ON risk_audit_logs(related_payment_id);

CREATE INDEX IF NOT EXISTS idx_risk_audit_logs_withdrawal
  ON risk_audit_logs(related_withdrawal_id);
