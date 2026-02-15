ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS event TEXT;

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS payload JSONB;

-- Optional backfill for old rows where event is null:
UPDATE webhook_events
SET event = split_part(event_id, ':', 1)
WHERE event IS NULL AND event_id LIKE '%:%';
