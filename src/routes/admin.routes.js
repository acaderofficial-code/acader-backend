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
  syncWalletAvailableBalances,
} from "../services/ledger.service.js";

const router = express.Router();

router.use(verifyToken, requireAdmin);

/**
 * Get dashboard stats
 */
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const users = await pool.query("SELECT COUNT(*) FROM users");
    const payments = await pool.query("SELECT COUNT(*) FROM payments");
    const paymentVolume = await pool.query(
      "SELECT SUM(amount) FROM payments WHERE status = 'paid' OR status = 'released'",
    );
    const disputes = await pool.query(
      "SELECT COUNT(*) FROM disputes WHERE status IN ('open', 'under_review')",
    );
    const withdrawals = await pool.query(
      "SELECT COUNT(*) FROM withdrawals WHERE status = 'pending'",
    );

    res.json({
      totalUsers: parseInt(users.rows[0].count),
      totalPayments: parseInt(payments.rows[0].count),
      totalVolume: parseInt(paymentVolume.rows[0].sum || 0),
      openDisputes: parseInt(disputes.rows[0].count),
      pendingWithdrawals: parseInt(withdrawals.rows[0].count),
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
 * Admin dispute status update
 * PATCH /api/admin/disputes/:id/status
 * body: { status: "under_review" | "rejected" }
 */
router.patch(
  "/disputes/:id/status",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body ?? {};

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
