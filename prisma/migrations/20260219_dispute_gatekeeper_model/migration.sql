ALTER TABLE payments
ADD COLUMN IF NOT EXISTS disputed BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE disputes
SET status = 'rejected',
    resolved_at = COALESCE(resolved_at, NOW())
WHERE status = 'closed';

UPDATE disputes
SET resolution = 'release_to_student'
WHERE resolution = 'release';

UPDATE disputes
SET resolution = 'refund_to_company'
WHERE resolution = 'refund';

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY payment_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM disputes
  WHERE status IN ('open', 'under_review')
)
UPDATE disputes d
SET status = 'rejected',
    resolved_at = COALESCE(d.resolved_at, NOW())
FROM ranked r
WHERE d.id = r.id
  AND r.rn > 1;

ALTER TABLE disputes
ALTER COLUMN status SET DEFAULT 'open';

ALTER TABLE disputes
DROP CONSTRAINT IF EXISTS disputes_status_check;

ALTER TABLE disputes
ADD CONSTRAINT disputes_status_check
CHECK (status IN ('open', 'under_review', 'resolved', 'rejected'));

ALTER TABLE disputes
DROP CONSTRAINT IF EXISTS disputes_resolution_check;

ALTER TABLE disputes
ADD CONSTRAINT disputes_resolution_check
CHECK (
  resolution IS NULL
  OR resolution IN ('release_to_student', 'refund_to_company', 'partial_refund')
);

UPDATE payments p
SET disputed = EXISTS (
  SELECT 1
  FROM disputes d
  WHERE d.payment_id = p.id
    AND d.status IN ('open', 'under_review')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_one_active_per_payment
  ON disputes(payment_id)
  WHERE status IN ('open', 'under_review');

CREATE INDEX IF NOT EXISTS idx_payments_disputed
  ON payments(disputed);
