ALTER TABLE ledger_entries
DROP CONSTRAINT IF EXISTS ledger_entries_balance_type_check;

ALTER TABLE ledger_entries
ADD CONSTRAINT ledger_entries_balance_type_check
CHECK (balance_type IN ('available', 'escrow', 'locked', 'platform', 'revenue'));
