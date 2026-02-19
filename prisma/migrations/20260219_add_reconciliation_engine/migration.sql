CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE wallets
ADD COLUMN IF NOT EXISTS available_balance NUMERIC(12,2),
ADD COLUMN IF NOT EXISTS escrow_balance NUMERIC(12,2);

UPDATE wallets
SET available_balance = COALESCE(available_balance, balance, 0),
    escrow_balance = COALESCE(escrow_balance, 0);

ALTER TABLE wallets
ALTER COLUMN available_balance SET DEFAULT 0,
ALTER COLUMN escrow_balance SET DEFAULT 0;

UPDATE wallets
SET available_balance = COALESCE(available_balance, 0),
    escrow_balance = COALESCE(escrow_balance, 0);

ALTER TABLE wallets
ALTER COLUMN available_balance SET NOT NULL,
ALTER COLUMN escrow_balance SET NOT NULL;

CREATE TABLE IF NOT EXISTS reconciliation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  available_expected NUMERIC(12,2) NOT NULL,
  available_actual NUMERIC(12,2) NOT NULL,
  escrow_expected NUMERIC(12,2) NOT NULL,
  escrow_actual NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'mismatch')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_wallet_created_at
  ON reconciliation_logs(wallet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_status_created_at
  ON reconciliation_logs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_flags_wallet_resolved
  ON reconciliation_flags(wallet_id, resolved);

CREATE INDEX IF NOT EXISTS idx_reconciliation_flags_unresolved
  ON reconciliation_flags(created_at DESC)
  WHERE resolved = FALSE;
