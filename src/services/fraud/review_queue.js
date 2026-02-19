import pool from "../../config/db.js";

export const FRAUD_REVIEW_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

export const FRAUD_REVIEW_REASON = {
  AI_RISK_THRESHOLD_EXCEEDED: "AI_RISK_THRESHOLD_EXCEEDED",
  RULE_ENGINE_FLAG: "RULE_ENGINE_FLAG",
  DISPUTE_OPENED: "DISPUTE_OPENED",
};

export const enqueueFraudReview = async (params, options = {}) => {
  const db = options.client ?? pool;
  const {
    userId,
    paymentId = null,
    withdrawalId = null,
    riskScore = 0,
    reason,
  } = params;

  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId for fraud review");
  }
  if (!reason || typeof reason !== "string") {
    throw new Error("reason is required for fraud review");
  }

  const parsedPaymentId =
    paymentId === null || paymentId === undefined ? null : Number(paymentId);
  const parsedWithdrawalId =
    withdrawalId === null || withdrawalId === undefined
      ? null
      : Number(withdrawalId);
  const parsedRiskScore = Math.max(0, Math.min(100, Math.round(Number(riskScore) || 0)));

  const existing = await db.query(
    `
    SELECT *
    FROM fraud_reviews
    WHERE user_id = $1
      AND reason = $2
      AND COALESCE(payment_id, -1) = COALESCE($3, -1)
      AND COALESCE(withdrawal_id, -1) = COALESCE($4, -1)
      AND status = 'PENDING'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [parsedUserId, reason, parsedPaymentId, parsedWithdrawalId],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const insert = await db.query(
    `
    INSERT INTO fraud_reviews (
      user_id,
      payment_id,
      withdrawal_id,
      risk_score,
      reason,
      status
    )
    VALUES ($1, $2, $3, $4, $5, 'PENDING')
    RETURNING *
    `,
    [
      parsedUserId,
      parsedPaymentId,
      parsedWithdrawalId,
      parsedRiskScore,
      reason,
    ],
  );

  return insert.rows[0] ?? null;
};

export const getPendingFraudReviewForUser = async (userId, options = {}) => {
  const db = options.client ?? pool;
  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId");
  }

  const result = await db.query(
    `
    SELECT *
    FROM fraud_reviews
    WHERE user_id = $1
      AND status = 'PENDING'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [parsedUserId],
  );
  return result.rows[0] ?? null;
};

export const getWalletRestriction = async (userId, options = {}) => {
  const db = options.client ?? pool;
  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId");
  }

  const result = await db.query(
    `
    SELECT *
    FROM wallet_restrictions
    WHERE user_id = $1
    LIMIT 1
    `,
    [parsedUserId],
  );
  return result.rows[0] ?? null;
};

export const restrictWallet = async (userId, reason, options = {}) => {
  const db = options.client ?? pool;
  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId");
  }

  const normalizedReason = reason?.trim() || "Restricted due to financial risk";

  const result = await db.query(
    `
    INSERT INTO wallet_restrictions (user_id, reason)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE
      SET reason = EXCLUDED.reason
    RETURNING *
    `,
    [parsedUserId, normalizedReason],
  );

  return result.rows[0] ?? null;
};

export const getUserRiskScore = async (userId, options = {}) => {
  const db = options.client ?? pool;
  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId");
  }

  const result = await db.query(
    `
    SELECT risk_score
    FROM user_risk_profiles
    WHERE user_id = $1
    LIMIT 1
    `,
    [parsedUserId],
  );

  const riskScore = Number(result.rows[0]?.risk_score ?? 0);
  if (!Number.isFinite(riskScore)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(riskScore)));
};
