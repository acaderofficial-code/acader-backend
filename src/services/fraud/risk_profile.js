import pool from "../../config/db.js";
import { calculateRiskFeatures } from "./risk_features.js";
import { generateRiskScore } from "./risk_score.js";

const asJson = (value) => JSON.stringify(value);

export const updateUserRiskProfile = async (userId, options = {}) => {
  const db = options.client ?? pool;
  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId");
  }

  const features = await calculateRiskFeatures(parsedUserId, { client: db });
  const score = generateRiskScore(features);

  const upsert = await db.query(
    `
    INSERT INTO user_risk_profiles (
      user_id,
      total_withdrawals,
      total_releases,
      disputes_count,
      avg_time_to_withdrawal,
      withdrawal_velocity,
      last_activity_at,
      risk_score,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      total_withdrawals = EXCLUDED.total_withdrawals,
      total_releases = EXCLUDED.total_releases,
      disputes_count = EXCLUDED.disputes_count,
      avg_time_to_withdrawal = EXCLUDED.avg_time_to_withdrawal,
      withdrawal_velocity = EXCLUDED.withdrawal_velocity,
      last_activity_at = EXCLUDED.last_activity_at,
      risk_score = EXCLUDED.risk_score,
      updated_at = NOW()
    RETURNING *
    `,
    [
      parsedUserId,
      features.totalWithdrawals,
      features.totalReleases,
      features.disputesCount,
      features.avgTimeToWithdrawal,
      features.withdrawalVelocity,
      features.lastActivityAt,
      score.riskScore,
    ],
  );

  return {
    profile: upsert.rows[0],
    features,
    score,
  };
};

export const getUserRiskProfile = async (userId, options = {}) => {
  const db = options.client ?? pool;
  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId");
  }

  const result = await db.query(
    `
    SELECT *
    FROM user_risk_profiles
    WHERE user_id = $1
    LIMIT 1
    `,
    [parsedUserId],
  );

  return result.rows[0] ?? null;
};

export const refreshRiskProfilesForUsers = async (userIds, options = {}) => {
  const db = options.client ?? pool;
  const unique = [...new Set((userIds ?? []).map((v) => Number(v)))].filter(
    (v) => Number.isInteger(v) && v > 0,
  );

  if (unique.length === 0) {
    return [];
  }

  const results = [];
  for (const userId of unique) {
    try {
      const updated = await updateUserRiskProfile(userId, { client: db });
      results.push(updated);
    } catch (err) {
      console.error("[risk_profile] update failed", {
        userId,
        error: err.message,
      });
    }
  }
  return results;
};

export const createBehaviourRiskFlag = async (
  userId,
  riskScore,
  metadata,
  options = {},
) => {
  const db = options.client ?? pool;
  const parsedUserId = Number(userId);
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0) {
    throw new Error("Invalid userId");
  }

  const result = await db.query(
    `
    INSERT INTO fraud_flags (user_id, rule_triggered, risk_score, metadata)
    VALUES ($1, $2, $3, $4::jsonb)
    RETURNING *
    `,
    [
      parsedUserId,
      "AI_RISK_THRESHOLD_EXCEEDED",
      Number(riskScore) || 0,
      asJson(metadata ?? {}),
    ],
  );

  return result.rows[0] ?? null;
};
