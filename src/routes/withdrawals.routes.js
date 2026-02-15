import express from "express";
import pool from "../config/db.js";
import { safeNotify } from "../utils/notify.js";
import { verifyToken } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/admin.js";
import { asyncHandler } from "../utils/asyncHandler.js";

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

      const wallet = await client.query(
        "SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE",
        [user_id],
      );

      if (wallet.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Wallet not found" });
      }

      const balance = Number(wallet.rows[0].balance);
      if (balance < normalizedAmount) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Insufficient balance" });
      }

      const withdrawal = await client.query(
        `INSERT INTO withdrawals (user_id, amount, bank_name, account_number)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [user_id, normalizedAmount, bank_name, account_number],
      );

      await client.query(
        "UPDATE wallets SET balance = balance - $1 WHERE user_id = $2",
        [normalizedAmount, user_id],
      );

      createdWithdrawal = withdrawal.rows[0];
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
    const { status } = req.body;
    const id = parseInt(req.params.id, 10);

    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid withdrawal id" });
    }

    const allowed = ["approved", "rejected"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

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

      if (status === "rejected") {
        await client.query(
          "UPDATE wallets SET balance = balance + $1 WHERE user_id = $2",
          [withdrawal.amount, withdrawal.user_id],
        );
      }

      const updatedResult = await client.query(
        `UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2 RETURNING *`,
        [status, id],
      );

      updated = updatedResult.rows[0];
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (status === "approved") {
      await safeNotify(
        withdrawal.user_id,
        "withdrawal_approved",
        "Your withdrawal has been approved and is being processed.",
        updated.id,
      );
    }
    if (status === "rejected") {
      await safeNotify(
        withdrawal.user_id,
        "withdrawal_rejected",
        "Your withdrawal was rejected and funds returned.",
        updated.id,
      );
    }

    res.json({
      message: `Withdrawal ${status}`,
      withdrawal: updated,
    });
  }),
);

export default router;
