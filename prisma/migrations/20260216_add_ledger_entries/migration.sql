CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  balance_type TEXT NOT NULL CHECK (balance_type IN ('available', 'escrow', 'locked', 'platform')),
  type TEXT,
  reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT ledger_entries_user_scope_chk CHECK (
    (balance_type = 'platform' AND user_id IS NULL)
    OR (balance_type <> 'platform' AND user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_user_type_created
  ON ledger_entries(user_id, balance_type, created_at);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_reference
  ON ledger_entries(reference);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_type
  ON ledger_entries(type);

CREATE OR REPLACE FUNCTION prevent_ledger_entries_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_ledger_entries_mutation();

-- Backfill current wallet balances into ledger as opening balances.
INSERT INTO ledger_entries (
  user_id,
  amount,
  direction,
  balance_type,
  type,
  reference,
  idempotency_key
)
SELECT
  w.user_id,
  w.balance,
  'credit',
  'available',
  'opening_balance',
  'wallet:' || w.user_id,
  'wallet:' || w.user_id || ':opening_available'
FROM wallets w
WHERE w.user_id IS NOT NULL
  AND COALESCE(w.balance, 0) > 0
ON CONFLICT (idempotency_key) DO NOTHING;

-- Backfill paid-in-escrow payments so release/refund transitions have ledger history.
INSERT INTO ledger_entries (
  user_id,
  amount,
  direction,
  balance_type,
  type,
  reference,
  idempotency_key
)
SELECT
  NULL,
  p.amount,
  'debit',
  'platform',
  'opening_escrow',
  COALESCE(p.provider_ref, 'payment:' || p.id::text),
  'payment:' || p.id::text || ':opening_escrow:debit'
FROM payments p
WHERE p.status = 'paid'
  AND COALESCE(p.escrow, FALSE) = TRUE
  AND p.amount > 0
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO ledger_entries (
  user_id,
  amount,
  direction,
  balance_type,
  type,
  reference,
  idempotency_key
)
SELECT
  p.user_id,
  p.amount,
  'credit',
  'escrow',
  'opening_escrow',
  COALESCE(p.provider_ref, 'payment:' || p.id::text),
  'payment:' || p.id::text || ':opening_escrow:credit'
FROM payments p
WHERE p.status = 'paid'
  AND COALESCE(p.escrow, FALSE) = TRUE
  AND p.amount > 0
ON CONFLICT (idempotency_key) DO NOTHING;

