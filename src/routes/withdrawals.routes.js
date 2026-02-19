import express from "express";
import pool from "../config/db.js";
import { safeNotify } from "../utils/notify.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  createWithdrawalHold,
  getUserBalanceByType,
  releaseWithdrawalHold,
} from "../services/ledger.service.js";
import { evaluateWithdrawalRisk } from "../services/fraud/risk_rules.js";
import {
  createBehaviourRiskFlag,
  updateUserRiskProfile,
} from "../services/fraud/risk_profile.js";
import { BEHAVIOURAL_RISK_THRESHOLD } from "../services/fraud/risk_score.js";
import {
  enqueueFraudReview,
  FRAUD_REVIEW_REASON,
  getPendingFraudReviewForUser,
  getUserRiskScore,
  getWalletRestriction,
} from "../services/fraud/review_queue.js";

const router = express.Router();
const FRAUD_BLOCK_THRESHOLD = 60;

const notifyAdminsOfFraud = async (client, message) => {
  const adminRows = await client.query(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC",
  );

  for (const admin of adminRows.rows) {
    await client.query(
      `
      INSERT INTO notifications (user_id, title, message, type)
      VALUES ($1, $2, $3, $4)
      `,
      [admin.id, "Suspicious Withdrawal Attempt", message, "fraud_alert"],
    );
  }
};

const createPendingReviewWithdrawal = async (
  client,
  { userId, amount, bankName, accountNumber },
) => {
  const inserted = await client.query(
    `
    INSERT INTO withdrawals (user_id, amount, status, bank_name, account_number)
    VALUES ($1, $2, 'pending_review', $3, $4)
    RETURNING *
    `,
    [userId, amount, bankName, accountNumber],
  );

  const withdrawal = inserted.rows[0];
  const providerRef = `withdrawal_${withdrawal.id}`;
  const withRef = await client.query(
    `
    UPDATE withdrawals
    SET provider_ref = COALESCE(provider_ref, $1)
    WHERE id = $2
    RETURNING *
    `,
    [providerRef, withdrawal.id],
  );

  return withRef.rows[0] ?? withdrawal;
};

/**
 * User requests withdrawal (authenticated; user_id from token)
 */
router.post(
  "/",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { amount, bank_name, account_number } = req.body;
    const user_id = req.user.id;
    const normalizedAmount = Number(amount);

    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return res.status(400).json({ message: "Invalid amount" });
    }
    if (!bank_name || !account_number) {
      return res.status(400).json({ message: "bank_name and account_number are required" });
    }

    const client = await pool.connect();
    let createdWithdrawal;
    try {
      await client.query("BEGIN");

      const userRow = await client.query(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [user_id],
      );

      if (userRow.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "User not found" });
      }

      const restriction = await getWalletRestriction(user_id, { client });
      if (restriction) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          message: "Account restricted due to financial risk.",
        });
      }

      const pendingReview = await getPendingFraudReviewForUser(user_id, { client });
      if (pendingReview) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: "Withdrawal pending admin review.",
          review_id: pendingReview.id,
        });
      }

      const disputedPayment = await client.query(
        `
        SELECT p.id
        FROM payments p
        LEFT JOIN applications a ON a.id = p.application_id
        WHERE p.disputed = true
          AND (
            p.user_id = $1
            OR a.user_id = $1
          )
        LIMIT 1
        `,
        [user_id],
      );

      if (disputedPayment.rows.length > 0) {
        const blockedPaymentId = Number(disputedPayment.rows[0].id);
        const riskScore = await getUserRiskScore(user_id, { client });
        const review = await enqueueFraudReview(
          {
            userId: user_id,
            paymentId: blockedPaymentId,
            riskScore,
            reason: FRAUD_REVIEW_REASON.RULE_ENGINE_FLAG,
          },
          { client },
        );

        await notifyAdminsOfFraud(
          client,
          `User ${user_id} withdrawal blocked due to active dispute (review ${review?.id ?? "pending"})`,
        );

        await client.query("COMMIT");
        return res.status(409).json({
          message: "Withdrawal blocked: you have a payment under dispute",
          review_id: review?.id ?? null,
        });
      }

      const availableBalance = await getUserBalanceByType(
        client,
        user_id,
        "available",
      );
      if (availableBalance < normalizedAmount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Insufficient balance" });
      }

      const behavioural = await updateUserRiskProfile(user_id, {
        client,
      });
      const behaviouralScore = Number(
        behavioural.profile?.risk_score ?? behavioural.score?.riskScore ?? 0,
      );

      if (behaviouralScore > BEHAVIOURAL_RISK_THRESHOLD) {
        const metadata = {
          withdrawalAmount: normalizedAmount,
          timestamp: new Date().toISOString(),
          triggeredSignals: behavioural.score?.triggeredSignals ?? [],
          features: behavioural.features,
          threshold: BEHAVIOURAL_RISK_THRESHOLD,
        };

        await createBehaviourRiskFlag(
          user_id,
          behaviouralScore,
          metadata,
          { client },
        );

        const reviewWithdrawal = await createPendingReviewWithdrawal(client, {
          userId: user_id,
          amount: normalizedAmount,
          bankName: bank_name,
          accountNumber: account_number,
        });

        const review = await enqueueFraudReview(
          {
            userId: user_id,
            withdrawalId: reviewWithdrawal.id,
            riskScore: behaviouralScore,
            reason: FRAUD_REVIEW_REASON.AI_RISK_THRESHOLD_EXCEEDED,
          },
          { client },
        );

        await notifyAdminsOfFraud(
          client,
          `User ${user_id} withdrawal blocked by behavioural risk model (review ${review?.id ?? "pending"})`,
        );

        console.error(`🚨 Fraud Risk Triggered for userId ${user_id}`);
        console.error("Rules:");
        console.error(["AI_RISK_THRESHOLD_EXCEEDED"]);
        console.error(`Score: ${behaviouralScore}`);

        await client.query("COMMIT");
        return res.status(403).json({
          message: "Withdrawal blocked due to high behavioural risk.",
          review_id: review?.id ?? null,
          withdrawal_id: reviewWithdrawal.id,
          risk: {
            riskScore: behaviouralScore,
            triggeredRules: ["AI_RISK_THRESHOLD_EXCEEDED"],
            triggeredSignals: behavioural.score?.triggeredSignals ?? [],
          },
        });
      }

      const risk = await evaluateWithdrawalRisk(user_id, normalizedAmount, {
        client,
      });

      if (risk.riskScore >= FRAUD_BLOCK_THRESHOLD) {
        const rulesText = risk.triggeredRules.join(",");
        const metadata = {
          ...risk.metadata,
          withdrawalAmount: normalizedAmount,
          timestamp: new Date().toISOString(),
        };

        await client.query(
          `
          INSERT INTO fraud_flags (user_id, rule_triggered, risk_score, metadata)
          VALUES ($1, $2, $3, $4::jsonb)
          `,
          [user_id, rulesText, risk.riskScore, JSON.stringify(metadata)],
        );

        const reviewWithdrawal = await createPendingReviewWithdrawal(client, {
          userId: user_id,
          amount: normalizedAmount,
          bankName: bank_name,
          accountNumber: account_number,
        });

        const review = await enqueueFraudReview(
          {
            userId: user_id,
            withdrawalId: reviewWithdrawal.id,
            riskScore: risk.riskScore,
            reason: FRAUD_REVIEW_REASON.RULE_ENGINE_FLAG,
          },
          { client },
        );

        await notifyAdminsOfFraud(
          client,
          `User ${user_id} withdrawal flagged by fraud engine (review ${review?.id ?? "pending"})`,
        );

        console.error(`🚨 Fraud Risk Triggered for userId ${user_id}`);
        console.error("Rules:");
        console.error(risk.triggeredRules);
        console.error(`Score: ${risk.riskScore}`);

        await client.query("COMMIT");
        return res.status(403).json({
          message: "Withdrawal under review due to risk detection.",
          review_id: review?.id ?? null,
          withdrawal_id: reviewWithdrawal.id,
          risk: {
            riskScore: risk.riskScore,
            triggeredRules: risk.triggeredRules,
          },
        });
      }

      const withdrawal = await client.query(
        `INSERT INTO withdrawals (user_id, amount, bank_name, account_number)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [user_id, normalizedAmount, bank_name, account_number],
      );

      createdWithdrawal = withdrawal.rows[0];
      const providerRef = `withdrawal_${createdWithdrawal.id}`;
      const withReference = await client.query(
        `UPDATE withdrawals
         SET provider_ref = COALESCE(provider_ref, $1)
         WHERE id = $2
         RETURNING *`,
        [providerRef, createdWithdrawal.id],
      );
      createdWithdrawal = withReference.rows[0] ?? createdWithdrawal;
      await createWithdrawalHold(client, createdWithdrawal);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({
      message: "Withdrawal request created",
      withdrawal: createdWithdrawal,
    });
  }),
);

/**
 * Admin processes withdrawal (refund on reject + notifications)
 */
router.patch(
  "/:id/status",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status, reason } = req.body;
    const id = parseInt(req.params.id, 10);

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid withdrawal id" });
    }

    const allowed = ["approved", "processing", "rejected"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const targetStatus = status === "approved" ? "processing" : status;

    const client = await pool.connect();
    let withdrawal;
    let updated;
    try {
      await client.query("BEGIN");

      const current = await client.query(
        "SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE",
        [id],
      );

      if (current.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Withdrawal not found" });
      }

      withdrawal = current.rows[0];

      if (withdrawal.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Already processed" });
      }

      if (targetStatus === "rejected") {
        await releaseWithdrawalHold(client, withdrawal, {
          reversalType: "withdrawal_reversal",
          idempotencySuffix: "reverse",
        });
      }

      const updatedResult =
        targetStatus === "processing"
          ? await client.query(
              `UPDATE withdrawals
               SET status = 'processing', processed_at = NULL, failure_reason = NULL
               WHERE id = $1
               RETURNING *`,
              [id],
            )
          : await client.query(
              `UPDATE withdrawals
               SET status = 'rejected', processed_at = NOW(), failure_reason = COALESCE($1, failure_reason, 'Rejected by admin')
               WHERE id = $2
               RETURNING *`,
              [reason ?? null, id],
            );

      updated = updatedResult.rows[0];
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (targetStatus === "processing") {
      await safeNotify(
        withdrawal.user_id,
        "withdrawal_processing",
        "Your withdrawal has been approved and moved to processing.",
        updated.id,
      );
    }
    if (targetStatus === "rejected") {
      await safeNotify(
        withdrawal.user_id,
        "withdrawal_rejected",
        "Your withdrawal was rejected and funds returned.",
        updated.id,
      );
    }

    res.json({
      message: `Withdrawal ${targetStatus}`,
      withdrawal: updated,
    });
  }),
);

export default router;
