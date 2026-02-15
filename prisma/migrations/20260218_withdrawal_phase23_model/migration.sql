ALTER TABLE ledger_entries
DROP CONSTRAINT IF EXISTS ledger_entries_balance_type_check;

ALTER TABLE ledger_entries
ADD CONSTRAINT ledger_entries_balance_type_check
CHECK (
  balance_type IN ('available', 'escrow', 'locked', 'platform', 'revenue', 'payout')
);

ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS provider_ref TEXT,
ADD COLUMN IF NOT EXISTS transfer_code TEXT,
ADD COLUMN IF NOT EXISTS failure_reason TEXT;

UPDATE withdrawals
SET provider_ref = COALESCE(provider_ref, 'withdrawal_' || id::text)
WHERE provider_ref IS NULL;

ALTER TABLE withdrawals
ALTER COLUMN provider_ref SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_provider_ref
  ON withdrawals(provider_ref);
