CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS user_risk_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_withdrawals INTEGER NOT NULL DEFAULT 0,
  total_releases INTEGER NOT NULL DEFAULT 0,
  disputes_count INTEGER NOT NULL DEFAULT 0,
  avg_time_to_withdrawal DOUBLE PRECISION,
  withdrawal_velocity DOUBLE PRECISION,
  last_activity_at TIMESTAMP,
  risk_score INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_risk_profiles_score
  ON user_risk_profiles(risk_score DESC);

CREATE INDEX IF NOT EXISTS idx_user_risk_profiles_updated_at
  ON user_risk_profiles(updated_at DESC);
