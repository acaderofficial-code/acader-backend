import express from "express";
import pool from "../config/db.js";
import { requireAdmin } from "../middleware/admin.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { safeNotify } from "../utils/notify.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { applyPaymentTransitionLedger } from "../services/ledger.service.js";

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
      "SELECT COUNT(*) FROM disputes WHERE status = 'open'",
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
 * Ledger report (admin only)
 * GET /api/admin/reports/ledger
 * Query params:
 * - user_id
 * - balance_type: available|escrow|locked|platform
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

    const allowedBalanceTypes = ["available", "escrow", "locked", "platform"];
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
          message: "Invalid balance_type. Use available|escrow|locked|platform",
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

    const [summaryResult, countResult, entriesResult, platformResult, perUserResult] =
      await Promise.all([
        pool.query(summaryQuery, values),
        pool.query(countQuery, values),
        pool.query(entriesQuery, [...values, parsedLimit, parsedOffset]),
        pool.query(platformQuery, platformValues),
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
      per_user_balances: perUserResult.rows,
      entries: entriesResult.rows,
    });
  }),
);

/**
 * Admin resolves dispute
 */
router.patch(
  "/disputes/:id/resolve",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { resolution } = req.body;

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid dispute id" });
    }

    const allowed = ["release", "refund"];
    if (!allowed.includes(resolution)) {
      return res.status(400).json({ message: "Invalid resolution" });
    }

    const client = await pool.connect();
    let updatedDispute;
    let paymentUserId;
    try {
      await client.query("BEGIN");

      const disputeResult = await client.query(
        `
        SELECT
          d.*,
          p.id as payment_id,
          p.status as payment_status,
          p.amount as payment_amount,
          p.user_id as payment_user_id,
          p.application_id as payment_application_id,
          a.user_id as student_user_id,
          c.user_id as company_user_id
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
      paymentUserId = dispute.payment_user_id;

      if (dispute.status !== "open") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Dispute already resolved" });
      }

      if (dispute.payment_status !== "disputed") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "Payment is not in disputed state",
        });
      }

      const targetStatus = resolution === "release" ? "released" : "refunded";
      const paymentForLedger = {
        id: dispute.payment_id,
        user_id: dispute.payment_user_id,
        amount: dispute.payment_amount,
        status: dispute.payment_status,
        provider_ref: `payment:${dispute.payment_id}`,
      };

      await applyPaymentTransitionLedger(client, paymentForLedger, targetStatus, {
        idempotencyPrefix: `payment:${dispute.payment_id}:${dispute.payment_status}->${targetStatus}`,
        companyUserId: dispute.company_user_id ?? undefined,
        studentUserId: dispute.student_user_id ?? undefined,
        requireStudentUserId: targetStatus === "released",
      });

      if (resolution === "release") {
        await client.query(
          "UPDATE payments SET status = 'released', escrow = false, released_at = NOW() WHERE id = $1",
          [dispute.payment_id],
        );
      }

      if (resolution === "refund") {
        await client.query(
          "UPDATE payments SET status = 'refunded', escrow = false, refunded_at = NOW() WHERE id = $1",
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
        [resolution, id],
      );

      updatedDispute = updated.rows[0];
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const notifMessage =
      resolution === "release"
        ? "Your dispute has been resolved and payment was released to your wallet."
        : "Your dispute has been resolved and payment was refunded.";

    await safeNotify(paymentUserId, "dispute_resolved", notifMessage, id);

    res.json({
      message: "Dispute resolved successfully",
      dispute: updatedDispute,
    });
  }),
);

export default router;
