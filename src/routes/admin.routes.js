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
        SELECT d.*, p.id as payment_id, p.status as payment_status, p.amount as payment_amount, p.user_id as payment_user_id
        FROM disputes d
        JOIN payments p ON d.payment_id = p.id
        WHERE d.id = $1
        FOR UPDATE
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
