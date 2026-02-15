CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER REFERENCES payments(id) ON DELETE CASCADE,
  raised_by INTEGER REFERENCES users(id),
  reason TEXT,
  status VARCHAR(50) DEFAULT 'open',
  resolution VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);
