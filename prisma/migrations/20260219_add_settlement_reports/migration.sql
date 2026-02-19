CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS settlement_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date DATE NOT NULL UNIQUE,
  escrow_inflow NUMERIC(14,2) NOT NULL DEFAULT 0,
  released_to_students NUMERIC(14,2) NOT NULL DEFAULT 0,
  refunded_to_companies NUMERIC(14,2) NOT NULL DEFAULT 0,
  withdrawals NUMERIC(14,2) NOT NULL DEFAULT 0,
  platform_fees NUMERIC(14,2) NOT NULL DEFAULT 0,
  system_available_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  system_escrow_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_reports_created_at
  ON settlement_reports(created_at DESC);
