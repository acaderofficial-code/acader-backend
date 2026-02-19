import express from "express";
import pool from "../config/db.js";
import { requireAdmin } from "../middleware/admin.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { safeNotify } from "../utils/notify.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  applyPaymentPartialRefundLedger,
  applyPaymentRefundLedger,
  applyPaymentTransitionLedger,
  createWithdrawalHold,
  releaseWithdrawalHold,
  syncWalletAvailableBalances,
} from "../services/ledger.service.js";
import {
  FRAUD_REVIEW_STATUS,
  getWalletRestriction,
  restrictWallet,
} from "../services/fraud/review_queue.js";
import {
  createRiskAuditLog,
  RISK_AUDIT_ACTION,
} from "../services/fraud/risk_audit.js";
import {
  appendFinancialEventLog,
  FINANCIAL_EVENT_TYPE,
  verifyFinancialEventChain,
} from "../services/financial_event_log.service.js";

const router = express.Router();
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_REGEX.test(String(value ?? ""));

router.use(verifyToken, requireAdmin);

/**
 * Get dashboard stats
 */
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const [
      users,
      payments,
      paymentVolume,
      disputes,
      withdrawals,
      pendingFraudReviews,
      restrictedWallets,
      unresolvedReconciliationFlags,
      latestSettlement,
    ] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM payments"),
      pool.query(
        "SELECT SUM(amount) FROM payments WHERE status = 'paid' OR status = 'released'",
      ),
      pool.query(
        "SELECT COUNT(*) FROM disputes WHERE status IN ('open', 'under_review')",
      ),
      pool.query(
        "SELECT COUNT(*) FROM withdrawals WHERE status IN ('pending', 'pending_review')",
      ),
      pool.query("SELECT COUNT(*) FROM fraud_reviews WHERE status = 'PENDING'"),
      pool.query("SELECT COUNT(*) FROM wallet_restrictions"),
      pool.query(
        "SELECT COUNT(*) FROM reconciliation_flags WHERE resolved = false",
      ),
      pool.query("SELECT MAX(report_date) AS latest_settlement_date FROM settlement_reports"),
    ]);

    res.json({
      totalUsers: parseInt(users.rows[0].count),
      totalPayments: parseInt(payments.rows[0].count),
      totalVolume: parseInt(paymentVolume.rows[0].sum || 0),
      openDisputes: parseInt(disputes.rows[0].count),
      pendingWithdrawals: parseInt(withdrawals.rows[0].count),
      pendingFraudReviews: parseInt(pendingFraudReviews.rows[0].count),
      restrictedWallets: parseInt(restrictedWallets.rows[0].count),
      unresolvedReconciliationFlags: parseInt(
        unresolvedReconciliationFlags.rows[0].count,
      ),
      latestSettlementDate:
        latestSettlement.rows[0]?.latest_settlement_date ?? null,
    });
  }),
);

/**
 * View all users
 */
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      "SELECT id, email, role FROM users ORDER BY id DESC",
    );
    res.json(result.rows);
  }),
);

/**
 * View all payments
 */
router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT p.*, u.email 
     FROM payments p 
     JOIN users u ON p.user_id = u.id
     ORDER BY p.created_at DESC`,
    );
    res.json(result.rows);
  }),
);

/**
 * View all disputes
 */
router.get(
  "/disputes",
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT d.*, u.email 
     FROM disputes d 
     JOIN users u ON d.raised_by = u.id
     ORDER BY d.created_at DESC`,
    );
    res.json(result.rows);
  }),
);

/**
 * View all withdrawals
 */
router.get(
  "/withdrawals",
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT w.*, u.email 
     FROM withdrawals w 
     JOIN users u ON w.user_id = u.id
     ORDER BY w.created_at DESC`,
    );
    res.json(result.rows);
  }),
);

/**
 * Fraud manual review queue (admin only)
 * GET /api/admin/fraud/reviews
 */
router.get(
  "/fraud/reviews",
  asyncHandler(async (req, res) => {
    const requestedStatus = String(req.query.status ?? "PENDING").toUpperCase();
    const includeAll = requestedStatus === "ALL";
    const allowedStatuses = Object.values(FRAUD_REVIEW_STATUS);

    if (!includeAll && !allowedStatuses.includes(requestedStatus)) {
      return res.status(400).json({
        message: "Invalid status. Use PENDING|APPROVED|REJECTED|ALL",
      });
    }

    const statusClause = includeAll ? "" : "WHERE fr.status = $1";
    const values = includeAll ? [] : [requestedStatus];

    const result = await pool.query(
      `
      SELECT
        fr.id,
        fr.user_id,
        u.email AS user_email,
        fr.payment_id,
        p.provider_ref AS payment_reference,
        fr.withdrawal_id,
        w.amount AS withdrawal_amount,
        w.status AS withdrawal_status,
        fr.risk_score,
        fr.reason,
        fr.status,
        fr.reviewed_by,
        fr.reviewed_at,
        fr.admin_note,
        fr.created_at
      FROM fraud_reviews fr
      JOIN users u ON u.id = fr.user_id
      LEFT JOIN payments p ON p.id = fr.payment_id
      LEFT JOIN withdrawals w ON w.id = fr.withdrawal_id
      ${statusClause}
      ORDER BY fr.created_at ASC
      `,
      values,
    );

    res.json({
      status: includeAll ? "ALL" : requestedStatus,
      total: result.rows.length,
      reviews: result.rows,
    });
  }),
);

/**
 * Approve fraud review (admin only)
 * POST /api/admin/fraud/reviews/:id/approve
 */
router.post(
  "/fraud/reviews/:id/approve",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const adminId = Number(req.user.id);
    const adminNote =
      typeof req.body?.admin_note === "string" ? req.body.admin_note.trim() : "";

    if (!isUuid(id)) {
      return res.status(400).json({ message: "Invalid review id" });
    }

    const client = await pool.connect();
    let updatedReview = null;
    let updatedWithdrawal = null;
    let targetUserId = null;
    try {
      await client.query("BEGIN");

      const reviewResult = await client.query(
        `
        SELECT *
        FROM fraud_reviews
        WHERE id = $1
        FOR UPDATE
        `,
        [id],
      );

      if (reviewResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Fraud review not found" });
      }

      const review = reviewResult.rows[0];
      targetUserId = review.user_id;
      if (review.status !== FRAUD_REVIEW_STATUS.PENDING) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Fraud review already resolved" });
      }

      if (review.withdrawal_id) {
        const withdrawalResult = await client.query(
          `
          SELECT *
          FROM withdrawals
          WHERE id = $1
          FOR UPDATE
          `,
          [review.withdrawal_id],
        );

        if (withdrawalResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Withdrawal not found for review" });
        }

        const withdrawal = withdrawalResult.rows[0];
        if (withdrawal.status === "pending_review") {
          await createWithdrawalHold(client, withdrawal);
          const withdrawalUpdateResult = await client.query(
            `
            UPDATE withdrawals
            SET status = 'pending',
                processed_at = NULL,
                failure_reason = NULL
            WHERE id = $1
            RETURNING *
            `,
            [withdrawal.id],
          );
          updatedWithdrawal = withdrawalUpdateResult.rows[0] ?? withdrawal;
        } else {
          updatedWithdrawal = withdrawal;
        }
      }

      const reviewUpdateResult = await client.query(
        `
        UPDATE fraud_reviews
        SET status = 'APPROVED',
            reviewed_by = $2,
            reviewed_at = NOW(),
            admin_note = COALESCE(NULLIF($3, ''), admin_note)
        WHERE id = $1
        RETURNING *
        `,
        [id, adminId, adminNote],
      );

      updatedReview = reviewUpdateResult.rows[0];
      await appendFinancialEventLog(
        {
          eventType: FINANCIAL_EVENT_TYPE.WITHDRAWAL_APPROVED,
          userId: review.user_id,
          withdrawalId: review.withdrawal_id ?? null,
          eventPayload: {
            source: "manual_review",
            review_id: review.id,
            review_reason: review.reason,
            risk_score: review.risk_score,
            admin_note: adminNote || null,
          },
        },
        { client },
      );
      await createRiskAuditLog(
        {
          userId: review.user_id,
          actionType: RISK_AUDIT_ACTION.ADMIN_APPROVED,
          reason: adminNote || "MANUAL_REVIEW_APPROVED",
          riskScore: review.risk_score ?? null,
          relatedPaymentId: review.payment_id ?? null,
          relatedWithdrawalId: review.withdrawal_id ?? null,
          adminId,
        },
        { client },
      );
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }

    if (Number.isInteger(targetUserId) && targetUserId > 0) {
      await safeNotify(
        targetUserId,
        "fraud_review_approved",
        "Your account activity review was approved.",
        id,
      );
      if (updatedWithdrawal?.id) {
        await safeNotify(
          targetUserId,
          "withdrawal_review_approved",
          "Your withdrawal passed manual review and is ready for processing.",
          updatedWithdrawal.id,
        );
      }
    }

    res.json({
      message: "Fraud review approved",
      review: updatedReview,
      withdrawal: updatedWithdrawal,
    });
  }),
);

/**
 * Reject fraud review (admin only)
 * POST /api/admin/fraud/reviews/:id/reject
 */
router.post(
  "/fraud/reviews/:id/reject",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const adminId = Number(req.user.id);
    const adminNote =
      typeof req.body?.admin_note === "string" ? req.body.admin_note.trim() : "";

    if (!isUuid(id)) {
      return res.status(400).json({ message: "Invalid review id" });
    }

    const client = await pool.connect();
    let updatedReview = null;
    let updatedWithdrawal = null;
    let restriction = null;
    let targetUserId = null;
    try {
      await client.query("BEGIN");

      const reviewResult = await client.query(
        `
        SELECT *
        FROM fraud_reviews
        WHERE id = $1
        FOR UPDATE
        `,
        [id],
      );

      if (reviewResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Fraud review not found" });
      }

      const review = reviewResult.rows[0];
      targetUserId = review.user_id;
      if (review.status !== FRAUD_REVIEW_STATUS.PENDING) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Fraud review already resolved" });
      }

      if (review.withdrawal_id) {
        const withdrawalResult = await client.query(
          `
          SELECT *
          FROM withdrawals
          WHERE id = $1
          FOR UPDATE
          `,
          [review.withdrawal_id],
        );

        if (withdrawalResult.rows.length > 0) {
          const withdrawal = withdrawalResult.rows[0];

          if (withdrawal.status === "pending") {
            await releaseWithdrawalHold(client, withdrawal, {
              reversalType: "withdrawal_reversal",
              idempotencySuffix: "review_reverse",
            });
          }

          if (["pending_review", "pending"].includes(withdrawal.status)) {
            const withdrawalUpdateResult = await client.query(
              `
              UPDATE withdrawals
              SET status = 'rejected',
                  processed_at = NOW(),
                  failure_reason = COALESCE(NULLIF($2, ''), failure_reason, 'Rejected during fraud review')
              WHERE id = $1
              RETURNING *
              `,
              [withdrawal.id, adminNote],
            );
            updatedWithdrawal = withdrawalUpdateResult.rows[0] ?? withdrawal;
          } else {
            updatedWithdrawal = withdrawal;
          }
        }
      }

      const restrictionReason =
        adminNote || `Manual fraud review rejected (${review.reason})`;
      restriction = await restrictWallet(review.user_id, restrictionReason, { client });

      const reviewUpdateResult = await client.query(
        `
        UPDATE fraud_reviews
        SET status = 'REJECTED',
            reviewed_by = $2,
            reviewed_at = NOW(),
            admin_note = COALESCE(NULLIF($3, ''), admin_note)
        WHERE id = $1
        RETURNING *
        `,
        [id, adminId, adminNote],
      );
      updatedReview = reviewUpdateResult.rows[0];

      await appendFinancialEventLog(
        {
          eventType: FINANCIAL_EVENT_TYPE.WITHDRAWAL_REJECTED,
          userId: review.user_id,
          withdrawalId: review.withdrawal_id ?? null,
          eventPayload: {
            source: "manual_review",
            review_id: review.id,
            review_reason: review.reason,
            risk_score: review.risk_score,
            admin_note: adminNote || null,
          },
        },
        { client },
      );
      await appendFinancialEventLog(
        {
          eventType: FINANCIAL_EVENT_TYPE.WALLET_RESTRICTED,
          userId: review.user_id,
          withdrawalId: review.withdrawal_id ?? null,
          paymentId: review.payment_id ?? null,
          eventPayload: {
            reason: restrictionReason || "FINANCIAL_RISK",
            source: "manual_review",
            review_id: review.id,
          },
        },
        { client },
      );

      await createRiskAuditLog(
        {
          userId: review.user_id,
          actionType: RISK_AUDIT_ACTION.ADMIN_REJECTED,
          reason: adminNote || "MANUAL_REVIEW_REJECTED",
          riskScore: review.risk_score ?? null,
          relatedPaymentId: review.payment_id ?? null,
          relatedWithdrawalId: review.withdrawal_id ?? null,
          adminId,
        },
        { client },
      );
      await createRiskAuditLog(
        {
          userId: review.user_id,
          actionType: RISK_AUDIT_ACTION.WALLET_RESTRICTED,
          reason: restrictionReason || "FINANCIAL_RISK",
          riskScore: review.risk_score ?? null,
          relatedPaymentId: review.payment_id ?? null,
          relatedWithdrawalId: review.withdrawal_id ?? null,
          adminId,
        },
        { client },
      );

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }

    if (Number.isInteger(targetUserId) && targetUserId > 0) {
      await safeNotify(
        targetUserId,
        "fraud_review_rejected",
        "Your account was restricted due to financial risk. Contact support for review.",
        id,
      );
    }

    res.json({
      message: "Fraud review rejected and account restricted",
      review: updatedReview,
      restriction,
      withdrawal: updatedWithdrawal,
    });
  }),
);

/**
 * Risk audit logs for a user (admin only)
 * GET /api/admin/audit/risk/:userId?limit=100&offset=0
 */
router.get(
  "/audit/risk/:userId",
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const [logsResult, totalResult] = await Promise.all([
      pool.query(
        `
        SELECT
          ral.*,
          u.email AS user_email,
          admin_user.email AS admin_email,
          p.provider_ref AS payment_reference,
          w.amount AS withdrawal_amount,
          w.status AS withdrawal_status
        FROM risk_audit_logs ral
        JOIN users u ON u.id = ral.user_id
        LEFT JOIN users admin_user ON admin_user.id = ral.admin_id
        LEFT JOIN payments p ON p.id = ral.related_payment_id
        LEFT JOIN withdrawals w ON w.id = ral.related_withdrawal_id
        WHERE ral.user_id = $1
        ORDER BY ral.created_at DESC
        LIMIT $2 OFFSET $3
        `,
        [userId, limit, offset],
      ),
      pool.query(
        `
        SELECT COUNT(*)::int AS total
        FROM risk_audit_logs
        WHERE user_id = $1
        `,
        [userId],
      ),
    ]);

    res.json({
      user_id: userId,
      pagination: {
        limit,
        offset,
        total: totalResult.rows[0]?.total ?? 0,
      },
      logs: logsResult.rows,
    });
  }),
);

/**
 * Verify immutable financial event hash chain
 * GET /api/admin/audit/financial/verify
 */
router.get(
  "/audit/financial/verify",
  asyncHandler(async (_req, res) => {
    const verification = await verifyFinancialEventChain();
    res.json(verification);
  }),
);

/**
 * Financial event logs (admin only)
 * GET /api/admin/audit/financial/events?limit=100&offset=0&event_type=...
 */
router.get(
  "/audit/financial/events",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const eventType =
      typeof req.query.event_type === "string" ? req.query.event_type.trim() : "";

    const filters = [];
    const values = [];
    if (eventType) {
      values.push(eventType);
      filters.push(`fel.event_type = $${values.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const eventsQuery = `
      SELECT
        fel.id,
        fel.event_type,
        fel.user_id,
        u.email AS user_email,
        fel.payment_id,
        p.provider_ref AS payment_reference,
        fel.withdrawal_id,
        w.amount AS withdrawal_amount,
        fel.dispute_id,
        fel.event_payload,
        fel.previous_hash,
        fel.current_hash,
        fel.created_at
      FROM financial_event_log fel
      LEFT JOIN users u ON u.id = fel.user_id
      LEFT JOIN payments p ON p.id = fel.payment_id
      LEFT JOIN withdrawals w ON w.id = fel.withdrawal_id
      ${whereClause}
      ORDER BY fel.created_at DESC, fel.id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM financial_event_log fel
      ${whereClause}
    `;

    const [eventsResult, countResult] = await Promise.all([
      pool.query(eventsQuery, [...values, limit, offset]),
      pool.query(countQuery, values),
    ]);

    res.json({
      filters: {
        event_type: eventType || null,
      },
      pagination: {
        limit,
        offset,
        total: countResult.rows[0]?.total ?? 0,
      },
      events: eventsResult.rows,
    });
  }),
);

/**
 * View webhook events (admin only)
 * GET /api/admin/webhooks
 * Query params:
 * - provider
 * - event_type
 * - reference
 * - limit (default 100, max 500)
 * - offset (default 0)
 */
router.get(
  "/webhooks",
  asyncHandler(async (req, res) => {
    const {
      provider,
      event_type,
      reference,
      limit = "100",
      offset = "0",
    } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const filters = [];
    const values = [];

    if (provider) {
      values.push(provider);
      filters.push(`provider = $${values.length}`);
    }

    if (event_type) {
      values.push(event_type);
      filters.push(`event_type = $${values.length}`);
    }

    if (reference) {
      values.push(`%${reference}%`);
      filters.push(`reference ILIKE $${values.length}`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const eventsQuery = `
      SELECT id, provider, event_id, event_type, reference, payload, received_at
      FROM webhook_events
      ${whereClause}
      ORDER BY received_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM webhook_events
      ${whereClause}
    `;

    const [eventsResult, countResult] = await Promise.all([
      pool.query(eventsQuery, [...values, parsedLimit, parsedOffset]),
      pool.query(countQuery, values),
    ]);

    res.json({
      filters: {
        provider: provider ?? null,
        event_type: event_type ?? null,
        reference: reference ?? null,
      },
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        total: countResult.rows[0]?.total ?? 0,
      },
      events: eventsResult.rows,
    });
  }),
);

/**
 * Ledger report (admin only)
 * GET /api/admin/reports/ledger
 * Query params:
 * - user_id
 * - balance_type: available|escrow|locked|platform|revenue|payout
 * - type
 * - reference (partial match)
 * - from (ISO date)
 * - to (ISO date)
 * - limit (default 100, max 500)
 * - offset (default 0)
 * - per_user_limit (default 200, max 1000)
 */
router.get(
  "/reports/ledger",
  asyncHandler(async (req, res) => {
    const {
      user_id,
      balance_type,
      type,
      reference,
      from,
      to,
      limit = "100",
      offset = "0",
      per_user_limit = "200",
    } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const parsedPerUserLimit = Math.min(
      Math.max(parseInt(per_user_limit, 10) || 200, 1),
      1000,
    );

    const allowedBalanceTypes = [
      "available",
      "escrow",
      "locked",
      "platform",
      "revenue",
      "payout",
    ];
    const filters = [];
    const values = [];

    let parsedUserId;
    if (user_id !== undefined) {
      parsedUserId = parseInt(user_id, 10);
      if (Number.isNaN(parsedUserId) || parsedUserId <= 0) {
        return res.status(400).json({ message: "Invalid user_id" });
      }
      values.push(parsedUserId);
      filters.push(`le.user_id = $${values.length}`);
    }

    if (balance_type !== undefined) {
      if (!allowedBalanceTypes.includes(balance_type)) {
        return res.status(400).json({
          message:
            "Invalid balance_type. Use available|escrow|locked|platform|revenue|payout",
        });
      }
      values.push(balance_type);
      filters.push(`le.balance_type = $${values.length}`);
    }

    if (type !== undefined) {
      values.push(type);
      filters.push(`le.type = $${values.length}`);
    }

    if (reference !== undefined) {
      values.push(`%${reference}%`);
      filters.push(`le.reference ILIKE $${values.length}`);
    }

    let fromIso;
    if (from !== undefined) {
      const parsed = new Date(from);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: "Invalid from date" });
      }
      fromIso = parsed.toISOString();
      values.push(fromIso);
      filters.push(`le.created_at >= $${values.length}`);
    }

    let toIso;
    if (to !== undefined) {
      const parsed = new Date(to);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: "Invalid to date" });
      }
      toIso = parsed.toISOString();
      values.push(toIso);
      filters.push(`le.created_at <= $${values.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const summaryQuery = `
      SELECT
        COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount ELSE 0 END), 0) AS total_credits,
        COALESCE(SUM(CASE WHEN le.direction = 'debit' THEN le.amount ELSE 0 END), 0) AS total_debits,
        COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount WHEN le.direction = 'debit' THEN -le.amount ELSE 0 END), 0) AS net_change
      FROM ledger_entries le
      ${whereClause}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total_count
      FROM ledger_entries le
      ${whereClause}
    `;

    const entriesQuery = `
      SELECT
        le.id,
        le.user_id,
        u.email,
        le.amount,
        le.direction,
        le.balance_type,
        le.type,
        le.reference,
        le.idempotency_key,
        le.created_at
      FROM ledger_entries le
      LEFT JOIN users u ON u.id = le.user_id
      ${whereClause}
      ORDER BY le.created_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

    const platformFilters = ["balance_type = 'platform'"];
    const platformValues = [];
    if (toIso) {
      platformValues.push(toIso);
      platformFilters.push(`created_at <= $${platformValues.length}`);
    }
    const platformWhere = `WHERE ${platformFilters.join(" AND ")}`;

    const platformQuery = `
      SELECT
        COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0) AS total_credits,
        COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END), 0) AS total_debits,
        COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount WHEN direction = 'debit' THEN -amount ELSE 0 END), 0) AS balance
      FROM ledger_entries
      ${platformWhere}
    `;

    const revenueFilters = ["balance_type = 'revenue'"];
    const revenueValues = [];
    if (toIso) {
      revenueValues.push(toIso);
      revenueFilters.push(`created_at <= $${revenueValues.length}`);
    }
    const revenueWhere = `WHERE ${revenueFilters.join(" AND ")}`;

    const revenueQuery = `
      SELECT
        COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END), 0) AS total_credits,
        COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END), 0) AS total_debits,
        COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount WHEN direction = 'debit' THEN -amount ELSE 0 END), 0) AS balance
      FROM ledger_entries
      ${revenueWhere}
    `;

    const perUserValues = [];
    const perUserFilters = ["le.user_id IS NOT NULL"];
    if (parsedUserId) {
      perUserValues.push(parsedUserId);
      perUserFilters.push(`le.user_id = $${perUserValues.length}`);
    }
    if (toIso) {
      perUserValues.push(toIso);
      perUserFilters.push(`le.created_at <= $${perUserValues.length}`);
    }
    perUserValues.push(parsedPerUserLimit);

    const perUserQuery = `
      SELECT
        le.user_id,
        u.email,
        COALESCE(SUM(CASE WHEN le.balance_type = 'available' AND le.direction = 'credit' THEN le.amount
                          WHEN le.balance_type = 'available' AND le.direction = 'debit' THEN -le.amount
                          ELSE 0 END), 0) AS available_balance,
        COALESCE(SUM(CASE WHEN le.balance_type = 'escrow' AND le.direction = 'credit' THEN le.amount
                          WHEN le.balance_type = 'escrow' AND le.direction = 'debit' THEN -le.amount
                          ELSE 0 END), 0) AS escrow_balance,
        COALESCE(SUM(CASE WHEN le.balance_type = 'locked' AND le.direction = 'credit' THEN le.amount
                          WHEN le.balance_type = 'locked' AND le.direction = 'debit' THEN -le.amount
                          ELSE 0 END), 0) AS locked_balance,
        COALESCE(SUM(CASE WHEN le.balance_type = 'revenue' AND le.direction = 'credit' THEN le.amount
                          WHEN le.balance_type = 'revenue' AND le.direction = 'debit' THEN -le.amount
                          ELSE 0 END), 0) AS revenue_balance,
        COALESCE(SUM(CASE WHEN le.balance_type = 'payout' AND le.direction = 'credit' THEN le.amount
                          WHEN le.balance_type = 'payout' AND le.direction = 'debit' THEN -le.amount
                          ELSE 0 END), 0) AS payout_balance,
        COALESCE(SUM(CASE WHEN le.direction = 'credit' THEN le.amount
                          WHEN le.direction = 'debit' THEN -le.amount
                          ELSE 0 END), 0) AS net_balance
      FROM ledger_entries le
      LEFT JOIN users u ON u.id = le.user_id
      WHERE ${perUserFilters.join(" AND ")}
      GROUP BY le.user_id, u.email
      ORDER BY le.user_id ASC
      LIMIT $${perUserValues.length}
    `;

    const [
      summaryResult,
      countResult,
      entriesResult,
      platformResult,
      revenueResult,
      perUserResult,
    ] =
      await Promise.all([
        pool.query(summaryQuery, values),
        pool.query(countQuery, values),
        pool.query(entriesQuery, [...values, parsedLimit, parsedOffset]),
        pool.query(platformQuery, platformValues),
        pool.query(revenueQuery, revenueValues),
        pool.query(perUserQuery, perUserValues),
      ]);

    res.json({
      filters: {
        user_id: parsedUserId ?? null,
        balance_type: balance_type ?? null,
        type: type ?? null,
        reference: reference ?? null,
        from: fromIso ?? null,
        to: toIso ?? null,
      },
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        total: countResult.rows[0]?.total_count ?? 0,
      },
      summary: summaryResult.rows[0],
      platform_balance: platformResult.rows[0],
      revenue_balance: revenueResult.rows[0],
      per_user_balances: perUserResult.rows,
      entries: entriesResult.rows,
    });
  }),
);

/**
 * Reconciliation logs (admin only)
 * GET /api/admin/reports/reconciliation/logs
 * Query params:
 * - status: ok|mismatch
 * - wallet_id
 * - limit (default 100, max 500)
 * - offset (default 0)
 */
router.get(
  "/reports/reconciliation/logs",
  asyncHandler(async (req, res) => {
    const {
      status,
      wallet_id,
      limit = "100",
      offset = "0",
    } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const filters = [];
    const values = [];

    if (status !== undefined) {
      if (!["ok", "mismatch"].includes(String(status))) {
        return res.status(400).json({ message: "Invalid status. Use ok|mismatch" });
      }
      values.push(String(status));
      filters.push(`rl.status = $${values.length}`);
    }

    let parsedWalletId;
    if (wallet_id !== undefined) {
      parsedWalletId = parseInt(wallet_id, 10);
      if (Number.isNaN(parsedWalletId) || parsedWalletId <= 0) {
        return res.status(400).json({ message: "Invalid wallet_id" });
      }
      values.push(parsedWalletId);
      filters.push(`rl.wallet_id = $${values.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const logsQuery = `
      SELECT
        rl.*,
        w.user_id,
        u.email,
        EXISTS (
          SELECT 1
          FROM reconciliation_flags rf
          WHERE rf.wallet_id = rl.wallet_id
            AND rf.resolved = false
        ) AS has_unresolved_flag
      FROM reconciliation_logs rl
      JOIN wallets w ON w.id = rl.wallet_id
      JOIN users u ON u.id = w.user_id
      ${whereClause}
      ORDER BY rl.created_at DESC, rl.id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM reconciliation_logs rl
      ${whereClause}
    `;

    const [logsResult, countResult] = await Promise.all([
      pool.query(logsQuery, [...values, parsedLimit, parsedOffset]),
      pool.query(countQuery, values),
    ]);

    res.json({
      filters: {
        status: status ?? null,
        wallet_id: parsedWalletId ?? null,
      },
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        total: countResult.rows[0]?.total ?? 0,
      },
      logs: logsResult.rows,
    });
  }),
);

/**
 * Reconciliation flags (admin only)
 * GET /api/admin/reports/reconciliation/flags
 * Query params:
 * - resolved: true|false|all (default false)
 * - wallet_id
 * - limit (default 100, max 500)
 * - offset (default 0)
 */
router.get(
  "/reports/reconciliation/flags",
  asyncHandler(async (req, res) => {
    const {
      resolved = "false",
      wallet_id,
      limit = "100",
      offset = "0",
    } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const normalizedResolved = String(resolved).toLowerCase();
    const filters = [];
    const values = [];

    if (normalizedResolved !== "all") {
      if (normalizedResolved !== "true" && normalizedResolved !== "false") {
        return res.status(400).json({
          message: "Invalid resolved filter. Use true|false|all",
        });
      }
      values.push(normalizedResolved === "true");
      filters.push(`rf.resolved = $${values.length}`);
    }

    let parsedWalletId;
    if (wallet_id !== undefined) {
      parsedWalletId = parseInt(wallet_id, 10);
      if (Number.isNaN(parsedWalletId) || parsedWalletId <= 0) {
        return res.status(400).json({ message: "Invalid wallet_id" });
      }
      values.push(parsedWalletId);
      filters.push(`rf.wallet_id = $${values.length}`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const flagsQuery = `
      SELECT
        rf.*,
        w.user_id,
        u.email
      FROM reconciliation_flags rf
      JOIN wallets w ON w.id = rf.wallet_id
      JOIN users u ON u.id = w.user_id
      ${whereClause}
      ORDER BY rf.created_at DESC, rf.id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM reconciliation_flags rf
      ${whereClause}
    `;

    const [flagsResult, countResult] = await Promise.all([
      pool.query(flagsQuery, [...values, parsedLimit, parsedOffset]),
      pool.query(countQuery, values),
    ]);

    res.json({
      filters: {
        resolved: normalizedResolved,
        wallet_id: parsedWalletId ?? null,
      },
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        total: countResult.rows[0]?.total ?? 0,
      },
      flags: flagsResult.rows,
    });
  }),
);

/**
 * Resolve a reconciliation flag (admin only)
 * PATCH /api/admin/reports/reconciliation/flags/:id/resolve
 */
router.patch(
  "/reports/reconciliation/flags/:id/resolve",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      return res.status(400).json({ message: "Invalid flag id" });
    }

    const result = await pool.query(
      `
      UPDATE reconciliation_flags
      SET resolved = true
      WHERE id = $1
      RETURNING *
      `,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Reconciliation flag not found" });
    }

    res.json({
      message: "Reconciliation flag marked as resolved",
      flag: result.rows[0],
    });
  }),
);

/**
 * Settlement reports (admin only)
 * GET /api/admin/reports/settlements
 * Query params:
 * - from (YYYY-MM-DD)
 * - to (YYYY-MM-DD)
 * - limit (default 100, max 500)
 * - offset (default 0)
 */
router.get(
  "/reports/settlements",
  asyncHandler(async (req, res) => {
    const { from, to, limit = "100", offset = "0" } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const filters = [];
    const values = [];

    let fromDate;
    if (from !== undefined) {
      fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) {
        return res.status(400).json({ message: "Invalid from date" });
      }
      values.push(fromDate.toISOString().slice(0, 10));
      filters.push(`report_date >= $${values.length}::date`);
    }

    let toDate;
    if (to !== undefined) {
      toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) {
        return res.status(400).json({ message: "Invalid to date" });
      }
      values.push(toDate.toISOString().slice(0, 10));
      filters.push(`report_date <= $${values.length}::date`);
    }

    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const reportsQuery = `
      SELECT *
      FROM settlement_reports
      ${whereClause}
      ORDER BY report_date DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM settlement_reports
      ${whereClause}
    `;

    const totalsQuery = `
      SELECT
        COALESCE(SUM(escrow_inflow), 0) AS escrow_inflow,
        COALESCE(SUM(released_to_students), 0) AS released_to_students,
        COALESCE(SUM(refunded_to_companies), 0) AS refunded_to_companies,
        COALESCE(SUM(withdrawals), 0) AS withdrawals,
        COALESCE(SUM(platform_fees), 0) AS platform_fees
      FROM settlement_reports
      ${whereClause}
    `;

    const [reportsResult, countResult, totalsResult] = await Promise.all([
      pool.query(reportsQuery, [...values, parsedLimit, parsedOffset]),
      pool.query(countQuery, values),
      pool.query(totalsQuery, values),
    ]);

    res.json({
      filters: {
        from: fromDate ? fromDate.toISOString().slice(0, 10) : null,
        to: toDate ? toDate.toISOString().slice(0, 10) : null,
      },
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        total: countResult.rows[0]?.total ?? 0,
      },
      totals: totalsResult.rows[0],
      reports: reportsResult.rows,
    });
  }),
);

/**
 * Admin dispute status update
 * PATCH /api/admin/disputes/:id/status
 * body: { status: "under_review" | "rejected" }
 */
router.patch(
  "/disputes/:id/status",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body ?? {};
    const adminId = Number(req.user.id);

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid dispute id" });
    }

    const allowed = ["under_review", "rejected"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const client = await pool.connect();
    let updatedDispute;
    let payment;
    try {
      await client.query("BEGIN");

      const disputeResult = await client.query(
        `
        SELECT
          d.*,
          p.id AS payment_id,
          p.status AS payment_status,
          p.disputed AS payment_disputed,
          p.user_id AS payment_user_id,
          a.user_id AS student_user_id
        FROM disputes d
        JOIN payments p ON d.payment_id = p.id
        LEFT JOIN applications a ON a.id = p.application_id
        WHERE d.id = $1
        FOR UPDATE OF d, p
        `,
        [id],
      );

      if (disputeResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Dispute not found" });
      }

      const dispute = disputeResult.rows[0];
      payment = dispute;

      if (["resolved", "rejected"].includes(dispute.status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Dispute already closed" });
      }

      if (status === "under_review") {
        const updated = await client.query(
          `
          UPDATE disputes
          SET status = 'under_review'
          WHERE id = $1
          RETURNING *
          `,
          [id],
        );
        updatedDispute = updated.rows[0];
      }

      if (status === "rejected") {
        const updated = await client.query(
          `
          UPDATE disputes
          SET status = 'rejected',
              resolved_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [id],
        );
        updatedDispute = updated.rows[0];

        await client.query(
          `
          UPDATE payments
          SET disputed = false
          WHERE id = $1
          `,
          [dispute.payment_id],
        );

        await createRiskAuditLog(
          {
            userId: dispute.payment_user_id,
            actionType: RISK_AUDIT_ACTION.DISPUTE_RESOLVED,
            reason: "DISPUTE_REJECTED",
            relatedPaymentId: dispute.payment_id,
            adminId,
          },
          { client },
        );
        await appendFinancialEventLog(
          {
            eventType: FINANCIAL_EVENT_TYPE.DISPUTE_RESOLVED,
            userId: dispute.payment_user_id,
            paymentId: dispute.payment_id,
            disputeId: dispute.id,
            eventPayload: {
              status: "rejected",
              source: "admin_status_update",
            },
          },
          { client },
        );

        const studentUserId = Number(dispute.student_user_id);
        if (
          Number.isInteger(studentUserId) &&
          studentUserId > 0 &&
          studentUserId !== dispute.payment_user_id
        ) {
          await createRiskAuditLog(
            {
              userId: studentUserId,
              actionType: RISK_AUDIT_ACTION.DISPUTE_RESOLVED,
              reason: "DISPUTE_REJECTED",
              relatedPaymentId: dispute.payment_id,
              adminId,
            },
            { client },
          );
          await appendFinancialEventLog(
            {
              eventType: FINANCIAL_EVENT_TYPE.DISPUTE_RESOLVED,
              userId: studentUserId,
              paymentId: dispute.payment_id,
              disputeId: dispute.id,
              eventPayload: {
                status: "rejected",
                source: "admin_status_update",
              },
            },
            { client },
          );
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }

    await safeNotify(
      payment.payment_user_id,
      "dispute_status_updated",
      `Dispute status updated to ${status}.`,
      id,
    );

    const studentUserId = Number(payment.student_user_id);
    if (
      Number.isInteger(studentUserId) &&
      studentUserId > 0 &&
      studentUserId !== payment.payment_user_id
    ) {
      await safeNotify(
        studentUserId,
        "dispute_status_updated",
        `Dispute status updated to ${status}.`,
        id,
      );
    }

    res.json({
      message: "Dispute status updated",
      dispute: updatedDispute,
    });
  }),
);

/**
 * Admin resolves dispute
 * PATCH /api/admin/disputes/:id/resolve
 * body: { resolution: "release_to_student" | "refund_to_company" | "partial_refund", partial_amount?: number }
 */
router.patch(
  "/disputes/:id/resolve",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { resolution, partial_amount } = req.body ?? {};
    const adminId = Number(req.user.id);
    const normalizedResolution =
      resolution === "release"
        ? "release_to_student"
        : resolution === "refund"
          ? "refund_to_company"
          : resolution;

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid dispute id" });
    }

    const allowed = [
      "release_to_student",
      "refund_to_company",
      "partial_refund",
    ];
    if (!allowed.includes(normalizedResolution)) {
      return res.status(400).json({ message: "Invalid resolution" });
    }

    if (normalizedResolution === "partial_refund") {
      const parsedPartial = Number(partial_amount);
      if (!Number.isFinite(parsedPartial) || parsedPartial <= 0) {
        return res
          .status(400)
          .json({ message: "partial_amount must be a positive number" });
      }
    }

    const client = await pool.connect();
    let updatedDispute;
    let disputeRow;
    try {
      await client.query("BEGIN");

      const disputeResult = await client.query(
        `
        SELECT
          d.*,
          p.id AS payment_id,
          p.status AS payment_status,
          p.amount AS payment_amount,
          p.user_id AS payment_user_id,
          p.provider_ref AS payment_provider_ref,
          p.escrow AS payment_escrow,
          p.disputed AS payment_disputed,
          a.user_id AS student_user_id,
          c.user_id AS company_user_id
        FROM disputes d
        JOIN payments p ON d.payment_id = p.id
        LEFT JOIN applications a ON a.id = p.application_id
        LEFT JOIN companies c ON c.id = p.company_id
        WHERE d.id = $1
        FOR UPDATE OF d, p
        `,
        [id],
      );

      if (disputeResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Dispute not found" });
      }

      const dispute = disputeResult.rows[0];
      disputeRow = dispute;

      if (!["open", "under_review"].includes(dispute.status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Dispute already closed" });
      }

      if (dispute.payment_disputed !== true && dispute.payment_status !== "disputed") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Payment is not under dispute" });
      }

      const companyUserId = Number(dispute.company_user_id);
      const studentUserId = Number(dispute.student_user_id);

      if (!Number.isInteger(companyUserId) || companyUserId <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid company mapping" });
      }

      const paymentForLedger = {
        id: dispute.payment_id,
        user_id: dispute.payment_user_id,
        amount: dispute.payment_amount,
        status: dispute.payment_status,
        provider_ref:
          dispute.payment_provider_ref ?? `payment:${dispute.payment_id}`,
        escrow: dispute.payment_escrow,
        company_user_id: dispute.company_user_id,
        student_user_id: dispute.student_user_id,
      };

      if (normalizedResolution === "release_to_student") {
        if (!Number.isInteger(studentUserId) || studentUserId <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Invalid student mapping" });
        }

        const restriction = await getWalletRestriction(studentUserId, { client });
        if (restriction) {
          await client.query("ROLLBACK");
          try {
            await createRiskAuditLog({
              userId: studentUserId,
              actionType: RISK_AUDIT_ACTION.ESCROW_RELEASE_REJECTED,
              reason: "STUDENT_RESTRICTED",
              relatedPaymentId: dispute.payment_id,
              adminId,
            });
            await appendFinancialEventLog({
              eventType: FINANCIAL_EVENT_TYPE.ESCROW_RELEASE_REJECTED,
              userId: studentUserId,
              paymentId: dispute.payment_id,
              disputeId: dispute.id,
              eventPayload: {
                reason: "STUDENT_RESTRICTED",
                source: "dispute_resolve",
                restriction_reason: restriction.reason ?? null,
              },
            });
          } catch (auditErr) {
            console.error("[risk_audit] release rejection log failed", auditErr.message);
          }
          return res.status(409).json({
            message: "Student account restricted due to financial risk.",
          });
        }

        if (
          dispute.payment_status === "paid" ||
          dispute.payment_status === "disputed"
        ) {
          await applyPaymentTransitionLedger(client, paymentForLedger, "released", {
            idempotencyPrefix: `payment:${dispute.payment_id}:${dispute.payment_status}->released:dispute`,
            companyUserId: companyUserId,
            studentUserId:
              Number.isInteger(studentUserId) && studentUserId > 0
                ? studentUserId
                : undefined,
            requireStudentUserId: true,
          });
        } else if (dispute.payment_status !== "released") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: "Release resolution requires payment in paid/released state",
          });
        }

        await client.query(
          `
          UPDATE payments
          SET status = 'released',
              escrow = false,
              released_at = COALESCE(released_at, NOW()),
              disputed = false
          WHERE id = $1
          `,
          [dispute.payment_id],
        );

        await createRiskAuditLog(
          {
            userId: studentUserId,
            actionType: RISK_AUDIT_ACTION.ESCROW_RELEASE_APPROVED,
            reason: "DISPUTE_RELEASE_TO_STUDENT",
            relatedPaymentId: dispute.payment_id,
            adminId,
          },
          { client },
        );
      }

      if (normalizedResolution === "refund_to_company") {
        if (["paid", "released"].includes(dispute.payment_status)) {
          const refundResult = await applyPaymentRefundLedger(client, paymentForLedger, {
            idempotencyPrefix: `payment:${dispute.payment_id}:${dispute.payment_status}->refunded:dispute`,
            companyUserId: companyUserId,
            studentUserId:
              Number.isInteger(studentUserId) && studentUserId > 0
                ? studentUserId
                : undefined,
          });
          await syncWalletAvailableBalances(
            client,
            refundResult.walletUserIds ?? [],
          );
        } else if (dispute.payment_status === "disputed") {
          await applyPaymentTransitionLedger(client, paymentForLedger, "refunded", {
            idempotencyPrefix: `payment:${dispute.payment_id}:${dispute.payment_status}->refunded:dispute_legacy`,
            companyUserId: companyUserId,
            studentUserId:
              Number.isInteger(studentUserId) && studentUserId > 0
                ? studentUserId
                : undefined,
          });
        } else {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: "Refund resolution requires payment in paid/released state",
          });
        }

        await client.query(
          `
          UPDATE payments
          SET status = 'refunded',
              escrow = false,
              refunded_at = COALESCE(refunded_at, NOW()),
              disputed = false
          WHERE id = $1
          `,
          [dispute.payment_id],
        );
      }

      if (normalizedResolution === "partial_refund") {
        if (dispute.payment_status !== "released") {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message: "Partial refund is only supported for released payments",
          });
        }

        if (!Number.isInteger(studentUserId) || studentUserId <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Invalid student mapping" });
        }

        const parsedPartial = Number(partial_amount);
        const partialResult = await applyPaymentPartialRefundLedger(
          client,
          paymentForLedger,
          {
            partialAmount: parsedPartial,
            idempotencyPrefix: `payment:${dispute.payment_id}:${dispute.payment_status}->partial_refund:dispute`,
            companyUserId: companyUserId,
            studentUserId: studentUserId,
          },
        );

        await syncWalletAvailableBalances(
          client,
          partialResult.walletUserIds ?? [],
        );

        await client.query(
          `
          UPDATE payments
          SET status = 'released',
              escrow = false,
              disputed = false
          WHERE id = $1
          `,
          [dispute.payment_id],
        );
      }

      const updated = await client.query(
        `
        UPDATE disputes
        SET status = 'resolved',
            resolution = $1,
            resolved_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [normalizedResolution, id],
      );

      updatedDispute = updated.rows[0];
      await createRiskAuditLog(
        {
          userId: dispute.payment_user_id,
          actionType: RISK_AUDIT_ACTION.DISPUTE_RESOLVED,
          reason: normalizedResolution,
          relatedPaymentId: dispute.payment_id,
          adminId,
        },
        { client },
      );
      await appendFinancialEventLog(
        {
          eventType: FINANCIAL_EVENT_TYPE.DISPUTE_RESOLVED,
          userId: dispute.payment_user_id,
          paymentId: dispute.payment_id,
          disputeId: dispute.id,
          eventPayload: {
            resolution: normalizedResolution,
            source: "admin_resolve",
          },
        },
        { client },
      );
      if (
        Number.isInteger(studentUserId) &&
        studentUserId > 0 &&
        studentUserId !== dispute.payment_user_id
      ) {
        await createRiskAuditLog(
          {
            userId: studentUserId,
            actionType: RISK_AUDIT_ACTION.DISPUTE_RESOLVED,
            reason: normalizedResolution,
            relatedPaymentId: dispute.payment_id,
            adminId,
          },
          { client },
        );
        await appendFinancialEventLog(
          {
            eventType: FINANCIAL_EVENT_TYPE.DISPUTE_RESOLVED,
            userId: studentUserId,
            paymentId: dispute.payment_id,
            disputeId: dispute.id,
            eventPayload: {
              resolution: normalizedResolution,
              source: "admin_resolve",
            },
          },
          { client },
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }

    const companyNotif =
      normalizedResolution === "release_to_student"
        ? "Dispute resolved: payment released to student."
        : normalizedResolution === "refund_to_company"
          ? "Dispute resolved: payment refunded to company."
          : "Dispute resolved: partial refund processed.";

    await safeNotify(
      disputeRow.payment_user_id,
      "dispute_resolved",
      companyNotif,
      id,
    );

    const studentUserId = Number(disputeRow.student_user_id);
    if (
      Number.isInteger(studentUserId) &&
      studentUserId > 0 &&
      studentUserId !== disputeRow.payment_user_id
    ) {
      const studentNotif =
        normalizedResolution === "release_to_student"
          ? "Dispute resolved: payment released to your wallet."
          : normalizedResolution === "refund_to_company"
            ? "Dispute resolved: payment was refunded to company."
            : "Dispute resolved: partial refund was processed.";

      await safeNotify(studentUserId, "dispute_resolved", studentNotif, id);
    }

    res.json({
      message: "Dispute resolved successfully",
      dispute: updatedDispute,
    });
  }),
);

export default router;
