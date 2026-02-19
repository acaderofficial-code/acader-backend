import pool from "../../config/db.js";

export const RISK_AUDIT_ACTION = {
  AI_FLAG: "AI_FLAG",
  RULE_FLAG: "RULE_FLAG",
  WITHDRAWAL_BLOCKED: "WITHDRAWAL_BLOCKED",
  ADMIN_APPROVED: "ADMIN_APPROVED",
  ADMIN_REJECTED: "ADMIN_REJECTED",
  WALLET_RESTRICTED: "WALLET_RESTRICTED",
  DISPUTE_OPENED: "DISPUTE_OPENED",
  DISPUTE_RESOLVED: "DISPUTE_RESOLVED",
  ESCROW_RELEASE_APPROVED: "ESCROW_RELEASE_APPROVED",
  ESCROW_RELEASE_REJECTED: "ESCROW_RELEASE_REJECTED",
};

const parseRequiredUserId = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Invalid user_id for risk audit log");
  }
  return parsed;
};

const parseOptionalId = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

const parseOptionalRiskScore = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
};

export const createRiskAuditLog = async (params, options = {}) => {
  const db = options.client ?? pool;
  const {
    userId,
    actionType,
    reason = null,
    riskScore = null,
    relatedPaymentId = null,
    relatedWithdrawalId = null,
    adminId = null,
  } = params;

  const parsedUserId = parseRequiredUserId(userId);
  if (!actionType || typeof actionType !== "string") {
    throw new Error("actionType is required for risk audit log");
  }

  const normalizedReason =
    typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null;

  const insertResult = await db.query(
    `
    INSERT INTO risk_audit_logs (
      user_id,
      action_type,
      reason,
      risk_score,
      related_payment_id,
      related_withdrawal_id,
      admin_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [
      parsedUserId,
      actionType,
      normalizedReason,
      parseOptionalRiskScore(riskScore),
      parseOptionalId(relatedPaymentId),
      parseOptionalId(relatedWithdrawalId),
      parseOptionalId(adminId),
    ],
  );

  return insertResult.rows[0] ?? null;
};
