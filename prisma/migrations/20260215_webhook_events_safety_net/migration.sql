CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT,
  event_type TEXT,
  reference TEXT,
  payload JSONB,
  received_at TIMESTAMP DEFAULT NOW(),
  event_id TEXT UNIQUE,
  event TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE webhook_events
ADD COLUMN IF NOT EXISTS event_type TEXT;

ALTER TABLE webhook_events
ADD COLUMN IF NOT EXISTS received_at TIMESTAMP DEFAULT NOW();

UPDATE webhook_events
SET event_type = COALESCE(event_type, event)
WHERE event_type IS NULL;

UPDATE webhook_events
SET received_at = COALESCE(received_at, created_at, NOW())
WHERE received_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
  ON webhook_events(event_type);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON webhook_events(received_at);
