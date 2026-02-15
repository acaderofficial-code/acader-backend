import express from "express";
import pool from "../config/db.js";
import { v4 as uuidv4 } from "uuid";
import { safeNotify } from "../utils/notify.js";
import { sendEmail } from "../utils/email.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  markPaymentAsPaidByReference,
  verifyPaystackReference,
} from "../services/paystack.service.js";
import { applyPaymentTransitionLedger } from "../services/ledger.service.js";

const router = express.Router();

/**
 * Create a payment record (authenticated; user_id from token)
 */
router.post(
  "/",
  verifyToken,
  asyncHandler(async (req, res) => {
    const {
      company_id,
      project_id,
      application_id,
      amount,
      provider,
      provider_ref,
    } = req.body;
    const user_id = req.user.id;

    const appCheck = await pool.query(
      "SELECT status FROM applications WHERE id = $1",
      [application_id],
    );

    if (appCheck.rows.length === 0) {
      return res.status(404).json({ message: "Application not found" });
    }

    if (appCheck.rows[0].status !== "accepted") {
      return res.status(400).json({
        message: "Payment not allowed until application is accepted",
      });
    }

    const ref = provider_ref || uuidv4();

    const result = await pool.query(
      `INSERT INTO payments 
      (user_id, company_id, project_id, application_id, amount, provider, provider_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [user_id, company_id, project_id, application_id, amount, provider, ref],
    );

    res.status(201).json(result.rows[0]);
  }),
);

/**
 * GET all payments (admin only); optional query: search, status
 */
router.get(
  "/",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { search, status } = req.query;

    let query = "SELECT * FROM payments WHERE 1=1";
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      query += ` AND (
        id::text ILIKE $${values.length}
        OR user_id::text ILIKE $${values.length}
        OR provider_ref ILIKE $${values.length}
      )`;
    }

    if (status) {
      values.push(status);
      query += ` AND status = $${values.length}`;
    }

    query += " ORDER BY created_at DESC";

    const result = await pool.query(query, values);
    res.json(result.rows);
  }),
);

/**
 * Get payments for a user (owner or admin only)
 */
router.get(
  "/user/:id",
  verifyToken,
  asyncHandler(async (req, res) => {
    const targetId = parseInt(req.params.id, 10);
    if (Number.isNaN(targetId)) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    if (req.user.id !== targetId && req.user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    const result = await pool.query(
      `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC`,
      [targetId],
    );
    res.json(result.rows);
  }),
);

/**
 * GET payment by id (owner or admin only)
 */
router.get(
  "/:id",
  verifyToken,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid payment id" });
    }
    const result = await pool.query("SELECT * FROM payments WHERE id = $1", [
      id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }
    const payment = result.rows[0];
    if (payment.user_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    res.json(payment);
  }),
);

/**
 * Verify Paystack payment (authenticated)
 */
router.get(
  "/verify/:reference",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { reference } = req.params;
    await verifyPaystackReference(reference);

    const { payment, updated } = await markPaymentAsPaidByReference(reference, {
      enforceUserId: req.user.role === "admin" ? undefined : req.user.id,
    });

    if (updated) {
      await safeNotify(
        payment.user_id,
        "payment_paid",
        "Your payment has been received and is now in escrow.",
        payment.id,
      );
    }

    res.json({
      message: "Payment verified & marked as paid",
      payment,
    });
  }),
);

/**
 * Update payment status (admin only)
 */
router.patch(
  "/:id/status",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const id = parseInt(req.params.id, 10);

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid payment id" });
    }

    const allowed = ["pending", "paid", "released", "refunded", "disputed"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const current = await pool.query("SELECT * FROM payments WHERE id=$1", [
      id,
    ]);

    if (current.rows.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }

    const payment = current.rows[0];
    const currentStatus = payment.status;
    let escrow = payment.escrow;

    const transitions = {
      pending: ["paid"],
      paid: ["released", "refunded"],
      released: ["disputed"],
      disputed: ["released", "refunded"],
      refunded: [],
    };

    if (!transitions[currentStatus].includes(status)) {
      return res.status(400).json({
        message: `Invalid transition: ${currentStatus} → ${status}`,
      });
    }

    if (status === "released") {
      const check = await pool.query(
        `
        SELECT p.status AS project_status, a.status AS application_status
        FROM payments pay
        JOIN projects p ON pay.project_id = p.id
        JOIN applications a ON pay.application_id = a.id
        WHERE pay.id = $1
        `,
        [id],
      );

      if (check.rows.length === 0) {
        return res.status(400).json({
          message: "Payment is not linked to a valid project/application",
        });
      }

      const { project_status, application_status } = check.rows[0];

      if (project_status !== "completed") {
        return res.status(400).json({ message: "Project not completed" });
      }

      if (application_status !== "accepted") {
        return res.status(400).json({ message: "Application not accepted" });
      }
    }

    if (status === "paid") escrow = true;
    if (status === "released") escrow = false;
    if (status === "refunded") escrow = false;

    const client = await pool.connect();
    let updatedPayment;
    try {
      await client.query("BEGIN");

      const result = await client.query(
        `
        UPDATE payments
        SET status = $1,
            escrow = $2,
            paid_at = CASE WHEN $1 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            released_at = CASE WHEN $1 = 'released' THEN NOW() ELSE released_at END,
            refunded_at = CASE WHEN $1 = 'refunded' THEN NOW() ELSE refunded_at END
        WHERE id = $3
        RETURNING *
        `,
        [status, escrow, id],
      );

      updatedPayment = result.rows[0];

      if (!updatedPayment) {
        throw new Error("Payment not found");
      }

      await applyPaymentTransitionLedger(client, payment, status, {
        idempotencyPrefix: `payment:${payment.id}:${payment.status}->${status}`,
      });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (status === "paid") {
      await safeNotify(
        updatedPayment.user_id,
        "payment_paid",
        "Your payment has been received and is now in escrow.",
        id,
      );
    }

    if (status === "released") {
      await safeNotify(
        updatedPayment.user_id,
        "payment_released",
        "Your payment has been released to your wallet.",
        id,
      );

      const userResult = await pool.query(
        "SELECT email FROM users WHERE id = $1",
        [updatedPayment.user_id],
      );
      const user = userResult.rows[0];

      if (user?.email) {
        try {
          await sendEmail(
            user.email,
            "Payment Released",
            `
            <h2>Your payment has been released</h2>
            <p>₦${updatedPayment.amount} has been added to your wallet.</p>
            `,
          );
        } catch (err) {
          console.error("Email failed:", err.message);
        }
      }
    }

    if (status === "refunded") {
      await safeNotify(
        updatedPayment.user_id,
        "payment_refunded",
        "Your payment has been refunded.",
        id,
      );
    }

    if (status === "disputed") {
      await safeNotify(
        updatedPayment.user_id,
        "payment_disputed",
        "Your payment status has been set to disputed.",
        id,
      );
    }

    res.json({
      message: `Payment moved to ${status}`,
      payment: updatedPayment,
    });
  }),
);

/**
 * Raise a dispute (authenticated; only payment owner)
 */
router.post(
  "/:id/dispute",
  verifyToken,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body;
    const raised_by = req.user.id;

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid payment id" });
    }

    const payment = await pool.query("SELECT * FROM payments WHERE id = $1", [
      id,
    ]);

    if (payment.rows.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }

    const pay = payment.rows[0];
    if (pay.user_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (pay.status !== "released") {
      return res.status(400).json({
        message: "Only released payments can be disputed",
      });
    }

    const existing = await pool.query(
      "SELECT id FROM disputes WHERE payment_id = $1 AND status = 'open'",
      [id],
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        message: "This payment already has an open dispute",
      });
    }

    const client = await pool.connect();
    let dispute;
    try {
      await client.query("BEGIN");

      const created = await client.query(
        `INSERT INTO disputes (payment_id, raised_by, reason)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [id, raised_by, reason ?? ""],
      );
      dispute = created.rows[0];

      await applyPaymentTransitionLedger(client, pay, "disputed", {
        idempotencyPrefix: `payment:${pay.id}:${pay.status}->disputed`,
      });

      await client.query("UPDATE payments SET status='disputed' WHERE id=$1", [id]);
      await client.query(
        `INSERT INTO notifications (user_id, type, message, related_id)
         VALUES ($1, $2, $3, $4)`,
        [pay.user_id, "dispute_opened", "A dispute has been opened on your payment.", id],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await safeNotify(
      pay.user_id,
      "dispute_opened",
      "A dispute has been opened on your payment.",
      id,
    );

    res.status(201).json({
      message: "Dispute raised successfully",
      dispute,
    });
  }),
);

export default router;
