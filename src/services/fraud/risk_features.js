import pool from "../../config/db.js";

const roundNumber = (value, digits = 4) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  return Math.round((num + Number.EPSILON) * factor) / factor;
};

export const calculateRiskFeatures = async (userId, options = {}) => {
  const db = options.client ?? pool;
  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId");
  }

  const [withdrawalsResult, releasesResult, avgLagResult, disputesResult, userResult] =
    await Promise.all([
      db.query(
        `
        SELECT
          COUNT(*)::int AS total_withdrawals,
          COUNT(*) FILTER (
            WHERE created_at > NOW() - INTERVAL '48 hours'
          )::int AS withdrawals_48h
        FROM ledger_entries
        WHERE user_id = $1
          AND type IN ('withdrawal', 'withdrawal_hold')
          AND direction = 'debit'
          AND balance_type = 'available'
        `,
        [parsedUserId],
      ),
      db.query(
        `
        SELECT COUNT(*)::int AS total_releases
        FROM ledger_entries
        WHERE user_id = $1
          AND type = 'release'
          AND direction = 'credit'
          AND balance_type = 'available'
        `,
        [parsedUserId],
      ),
      db.query(
        `
        WITH withdrawals AS (
          SELECT created_at AS withdrawal_at
          FROM ledger_entries
          WHERE user_id = $1
            AND type IN ('withdrawal', 'withdrawal_hold')
            AND direction = 'debit'
            AND balance_type = 'available'
        ),
        paired AS (
          SELECT
            w.withdrawal_at,
            r.release_at,
            EXTRACT(EPOCH FROM (w.withdrawal_at - r.release_at)) / 60.0 AS diff_minutes
          FROM withdrawals w
          JOIN LATERAL (
            SELECT le.created_at AS release_at
            FROM ledger_entries le
            WHERE le.user_id = $1
              AND le.type = 'release'
              AND le.direction = 'credit'
              AND le.balance_type = 'available'
              AND le.created_at <= w.withdrawal_at
            ORDER BY le.created_at DESC
            LIMIT 1
          ) r ON TRUE
        )
        SELECT AVG(diff_minutes) AS avg_minutes
        FROM paired
        `,
        [parsedUserId],
      ),
      db.query(
        `
        SELECT COUNT(*)::int AS disputes_count
        FROM disputes d
        JOIN payments p ON p.id = d.payment_id
        LEFT JOIN applications a ON a.id = p.application_id
        WHERE
          d.raised_by = $1
          OR p.user_id = $1
          OR a.user_id = $1
        `,
        [parsedUserId],
      ),
      db.query(
        `
        SELECT created_at
        FROM users
        WHERE id = $1
        `,
        [parsedUserId],
      ),
    ]);

  const totalWithdrawals = Number(withdrawalsResult.rows[0]?.total_withdrawals ?? 0);
  const withdrawals48h = Number(withdrawalsResult.rows[0]?.withdrawals_48h ?? 0);
  const totalReleases = Number(releasesResult.rows[0]?.total_releases ?? 0);
  const disputesCount = Number(disputesResult.rows[0]?.disputes_count ?? 0);
  const avgTimeToWithdrawalRaw = avgLagResult.rows[0]?.avg_minutes;
  const avgTimeToWithdrawal =
    avgTimeToWithdrawalRaw === null || avgTimeToWithdrawalRaw === undefined
      ? null
      : roundNumber(avgTimeToWithdrawalRaw, 2);

  const withdrawalVelocity =
    totalWithdrawals > 0 ? roundNumber(withdrawals48h / totalWithdrawals, 4) : 0;
  const disputeRatio =
    totalReleases > 0 ? roundNumber(disputesCount / totalReleases, 4) : 0;

  const createdAtRaw = userResult.rows[0]?.created_at ?? null;
  const accountAgeScore = (() => {
    if (!createdAtRaw) return 0;
    const createdAt = new Date(createdAtRaw);
    if (Number.isNaN(createdAt.getTime())) return 0;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return Date.now() - createdAt.getTime() < sevenDaysMs ? 30 : 0;
  })();

  const lastActivityResult = await db.query(
    `
    SELECT MAX(created_at) AS last_activity_at
    FROM (
      SELECT created_at FROM ledger_entries WHERE user_id = $1
      UNION ALL
      SELECT d.created_at FROM disputes d
      JOIN payments p ON p.id = d.payment_id
      LEFT JOIN applications a ON a.id = p.application_id
      WHERE d.raised_by = $1 OR p.user_id = $1 OR a.user_id = $1
    ) activity
    `,
    [parsedUserId],
  );

  const lastActivityAt = lastActivityResult.rows[0]?.last_activity_at ?? null;

  return {
    userId: parsedUserId,
    totalWithdrawals,
    totalReleases,
    disputesCount,
    avgTimeToWithdrawal,
    withdrawalVelocity,
    disputeRatio,
    accountAgeScore,
    lastActivityAt,
  };
};
