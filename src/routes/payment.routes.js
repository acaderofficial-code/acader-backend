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
import {
  applyPaymentRefundLedger,
  applyPaymentTransitionLedger,
  syncWalletAvailableBalances,
} from "../services/ledger.service.js";

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

    const allowed = ["pending", "paid", "released"];
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
    if (payment.disputed === true) {
      return res.status(409).json({
        message: "Payment is under dispute",
      });
    }

    let escrow = payment.escrow;
    let companyUserId = null;
    let studentUserId = null;

    const parties = await pool.query(
      `
      SELECT c.user_id AS company_user_id, a.user_id AS student_user_id
      FROM payments pay
      LEFT JOIN companies c ON c.id = pay.company_id
      LEFT JOIN applications a ON a.id = pay.application_id
      WHERE pay.id = $1
      `,
      [id],
    );
    if (parties.rows.length > 0) {
      const parsedCompanyUserId = Number(parties.rows[0].company_user_id);
      const parsedStudentUserId = Number(parties.rows[0].student_user_id);
      if (Number.isInteger(parsedCompanyUserId) && parsedCompanyUserId > 0) {
        companyUserId = parsedCompanyUserId;
      }
      if (Number.isInteger(parsedStudentUserId) && parsedStudentUserId > 0) {
        studentUserId = parsedStudentUserId;
      }
    }

    const transitions = {
      pending: ["paid"],
      paid: ["released"],
      released: [],
      refunded: [],
    };

    const nextAllowed = transitions[currentStatus] ?? [];
    if (!nextAllowed.includes(status)) {
      return res.status(400).json({
        message: `Invalid transition: ${currentStatus} → ${status}`,
      });
    }

    if (status === "released") {
      const check = await pool.query(
        `
        SELECT p.status AS project_status, a.status AS application_status, a.user_id AS student_user_id
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
      const parsedStudentUserId = Number(check.rows[0].student_user_id);

      if (!Number.isInteger(parsedStudentUserId) || parsedStudentUserId <= 0) {
        return res.status(400).json({ message: "Invalid student for release" });
      }

      if (project_status !== "completed") {
        return res.status(400).json({ message: "Project not completed" });
      }

      if (application_status !== "accepted") {
        return res.status(400).json({ message: "Application not accepted" });
      }

      studentUserId = parsedStudentUserId;
    }

    if (status === "paid") escrow = true;
    if (status === "released") escrow = false;

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
        companyUserId: companyUserId ?? undefined,
        studentUserId: studentUserId ?? undefined,
        requireStudentUserId: status === "released",
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
      const recipientUserId = studentUserId ?? updatedPayment.user_id;
      await safeNotify(
        recipientUserId,
        "payment_released",
        "Your payment has been released to your wallet.",
        id,
      );

      const userResult = await pool.query(
        "SELECT email FROM users WHERE id = $1",
        [recipientUserId],
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
 * Refund a payment (admin only)
 * POST /api/payments/:id/refund
 */
router.post(
  "/:id/refund",
  verifyToken,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid payment id" });
    }

    const client = await pool.connect();
    let updatedPayment = null;
    let refundType = null;
    let companyUserId = null;
    let studentUserId = null;
    let previousStatus = null;

    try {
      await client.query("BEGIN");

      const paymentResult = await client.query(
        `
        SELECT
          pay.*,
          c.user_id AS company_user_id,
          a.user_id AS student_user_id
        FROM payments pay
        LEFT JOIN companies c ON c.id = pay.company_id
        LEFT JOIN applications a ON a.id = pay.application_id
        WHERE pay.id = $1
        FOR UPDATE OF pay
        `,
        [id],
      );

      if (paymentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Payment not found" });
      }

      const payment = paymentResult.rows[0];
      previousStatus = payment.status;
      companyUserId = Number(payment.company_user_id);
      studentUserId = Number(payment.student_user_id);

      if (payment.disputed === true) {
        await client.query("ROLLBACK");
        return res
          .status(409)
          .json({ message: "Refund blocked: payment is under dispute" });
      }

      if (payment.status === "refunded") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Payment is already refunded" });
      }

      if (payment.status === "withdrawn") {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: "Refund blocked: payment already withdrawn" });
      }

      if (!["paid", "released"].includes(payment.status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          message: "Refund is only allowed for paid or released payments",
        });
      }

      if (!Number.isInteger(companyUserId) || companyUserId <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid company for refund" });
      }

      const openDispute = await client.query(
        `SELECT id
         FROM disputes
         WHERE payment_id = $1
           AND status IN ('open', 'under_review')
         LIMIT 1`,
        [id],
      );

      if (openDispute.rows.length > 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: "Refund blocked: payment has an open dispute" });
      }

      if (payment.status === "released") {
        if (!Number.isInteger(studentUserId) || studentUserId <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "Invalid student for refund" });
        }

        const payoutActivity = await client.query(
          `
          SELECT id
          FROM withdrawals
          WHERE user_id = $1
            AND status IN ('processing', 'completed')
            AND created_at >= COALESCE($2::timestamp, '-infinity'::timestamp)
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [studentUserId, payment.released_at ?? payment.created_at ?? null],
        );

        if (payoutActivity.rows.length > 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            message:
              "Refund blocked: withdrawal activity detected after payment release",
          });
        }
      }

      const refundResult = await applyPaymentRefundLedger(client, payment, {
        idempotencyPrefix: `payment:${payment.id}:${payment.status}->refunded`,
        companyUserId,
        studentUserId:
          Number.isInteger(studentUserId) && studentUserId > 0
            ? studentUserId
            : undefined,
      });

      refundType = refundResult.refundType;

      if ((refundResult.walletUserIds ?? []).length > 0) {
        await syncWalletAvailableBalances(client, refundResult.walletUserIds);
      }

      const updateResult = await client.query(
        `
        UPDATE payments
        SET status = 'refunded',
            escrow = false,
            refunded_at = COALESCE(refunded_at, NOW())
        WHERE id = $1
        RETURNING *
        `,
        [id],
      );

      if (updateResult.rowCount !== 1) {
        throw new Error("Payment update failed");
      }

      updatedPayment = updateResult.rows[0];
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

    const companyRefundMessage = reason
      ? `Your payment has been refunded. Reason: ${reason}`
      : "Your payment has been refunded.";

    await safeNotify(companyUserId, "payment_refunded", companyRefundMessage, id);

    if (
      previousStatus === "released" &&
      Number.isInteger(studentUserId) &&
      studentUserId > 0 &&
      studentUserId !== companyUserId
    ) {
      const studentRefundMessage = reason
        ? `A payment linked to your work was refunded. Reason: ${reason}`
        : "A payment linked to your work was refunded.";

      await safeNotify(
        studentUserId,
        "payment_refunded",
        studentRefundMessage,
        id,
      );
    }

    res.json({
      message: "Payment refunded successfully",
      refund_type: refundType,
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

    const payment = await pool.query(
      `
      SELECT pay.*, a.user_id AS student_user_id
      FROM payments pay
      LEFT JOIN applications a ON a.id = pay.application_id
      WHERE pay.id = $1
      `,
      [id],
    );

    if (payment.rows.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }

    const pay = payment.rows[0];
    if (pay.user_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (pay.disputed === true || pay.status === "disputed") {
      return res.status(409).json({
        message: "Payment is already under dispute",
      });
    }

    if (pay.status === "withdrawn") {
      return res.status(400).json({
        message: "Withdrawn payments cannot be disputed",
      });
    }

    if (pay.status === "refunded") {
      return res.status(400).json({
        message: "Refunded payments cannot be disputed",
      });
    }

    if (!["paid", "released"].includes(pay.status)) {
      return res.status(400).json({
        message: "Only paid or released payments can be disputed",
      });
    }

    const existing = await pool.query(
      `SELECT id
       FROM disputes
       WHERE payment_id = $1
         AND status IN ('open', 'under_review')
       LIMIT 1`,
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
        `INSERT INTO disputes (payment_id, raised_by, reason, status, created_at)
         VALUES ($1, $2, $3, 'open', NOW())
         RETURNING *`,
        [id, raised_by, reason ?? ""],
      );
      dispute = created.rows[0];

      await client.query("UPDATE payments SET disputed = true WHERE id = $1", [id]);

      await client.query(
        `INSERT INTO notifications (user_id, type, message, related_id)
         VALUES ($1, $2, $3, $4)`,
        [
          pay.user_id,
          "dispute_opened",
          "A dispute has been opened on your payment and actions are now frozen.",
          id,
        ],
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
      "A dispute has been opened on your payment and actions are now frozen.",
      id,
    );

    const studentUserId = Number(pay.student_user_id);
    if (
      Number.isInteger(studentUserId) &&
      studentUserId > 0 &&
      studentUserId !== pay.user_id
    ) {
      await safeNotify(
        studentUserId,
        "dispute_opened",
        "A payment tied to your work is under dispute. Payout actions are frozen.",
        id,
      );
    }

    res.status(201).json({
      message: "Dispute raised successfully",
      dispute,
    });
  }),
);

export default router;
