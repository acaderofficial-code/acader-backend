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

const router = express.Router();

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
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: "Withdrawal blocked: you have a payment under dispute",
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
