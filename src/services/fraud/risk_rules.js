import pool from "../../config/db.js";

const RULES = {
  LARGE_WITHDRAWAL_RATIO: "LARGE_WITHDRAWAL_RATIO",
  MULTIPLE_WITHDRAWALS_24H: "MULTIPLE_WITHDRAWALS_24H",
  NEW_ACCOUNT_DRAINING: "NEW_ACCOUNT_DRAINING",
  FAST_PAYOUT_AFTER_RELEASE: "FAST_PAYOUT_AFTER_RELEASE",
};

const roundCurrency = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const toPositiveAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("withdrawalAmount must be a positive number");
  }
  return amount;
};

export const evaluateWithdrawalRisk = async (
  userId,
  withdrawalAmount,
  options = {},
) => {
  const db = options.client ?? pool;
  const amount = toPositiveAmount(withdrawalAmount);
  const triggeredRules = [];
  let riskScore = 0;

  const walletResult = await db.query(
    `
    SELECT
      id,
      user_id,
      COALESCE(available_balance, balance, 0)::numeric AS available_balance
    FROM wallets
    WHERE user_id = $1
    LIMIT 1
    `,
    [userId],
  );

  const availableBalance = roundCurrency(
    walletResult.rows[0]?.available_balance ?? 0,
  );
  const withdrawalRatio =
    availableBalance > 0 ? amount / availableBalance : Number.POSITIVE_INFINITY;

  if (availableBalance > 0 && amount > availableBalance * 0.7) {
    riskScore += 40;
    triggeredRules.push(RULES.LARGE_WITHDRAWAL_RATIO);
  }

  const withdrawals24hResult = await db.query(
    `
    SELECT COUNT(*)::int AS count
    FROM ledger_entries
    WHERE user_id = $1
      AND type IN ('withdrawal', 'withdrawal_hold')
      AND created_at > NOW() - INTERVAL '24 hours'
    `,
    [userId],
  );
  const withdrawals24h = Number(withdrawals24hResult.rows[0]?.count ?? 0);
  if (withdrawals24h > 3) {
    riskScore += 30;
    triggeredRules.push(RULES.MULTIPLE_WITHDRAWALS_24H);
  }

  const firstDepositResult = await db.query(
    `
    SELECT MIN(created_at) AS first_deposit_at
    FROM ledger_entries
    WHERE user_id = $1
      AND direction = 'credit'
      AND type IN ('deposit', 'release', 'opening_balance')
    `,
    [userId],
  );

  const firstDepositAtRaw = firstDepositResult.rows[0]?.first_deposit_at ?? null;
  if (firstDepositAtRaw) {
    const firstDepositAt = new Date(firstDepositAtRaw);
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (now - firstDepositAt.getTime() < twoDaysMs) {
      riskScore += 25;
      triggeredRules.push(RULES.NEW_ACCOUNT_DRAINING);
    }
  }

  const recentReleaseResult = await db.query(
    `
    SELECT COUNT(*)::int AS count
    FROM ledger_entries
    WHERE user_id = $1
      AND type = 'release'
      AND balance_type = 'available'
      AND direction = 'credit'
      AND created_at > NOW() - INTERVAL '1 hour'
    `,
    [userId],
  );
  const recentReleaseCount = Number(recentReleaseResult.rows[0]?.count ?? 0);
  if (recentReleaseCount > 0) {
    riskScore += 35;
    triggeredRules.push(RULES.FAST_PAYOUT_AFTER_RELEASE);
  }

  return {
    riskScore,
    triggeredRules,
    metadata: {
      userId,
      withdrawalAmount: roundCurrency(amount),
      availableBalance,
      withdrawalRatio: Number.isFinite(withdrawalRatio)
        ? roundCurrency(withdrawalRatio)
        : null,
      withdrawals24h,
      firstDepositAt: firstDepositAtRaw,
      recentReleaseCount,
      evaluatedAt: new Date().toISOString(),
    },
  };
};

export const FRAUD_RULES = RULES;
