import axios from "axios";
import pool from "../config/db.js";

export const verifyPaystackReference = async (reference) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    const err = new Error("PAYSTACK_SECRET_KEY is not configured");
    err.status = 500;
    throw err;
  }

  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    {
      headers: {
        Authorization: `Bearer ${secret}`,
      },
    },
  );

  const payload = response.data;
  if (!payload?.status || payload?.data?.status !== "success") {
    const err = new Error("Payment not successful");
    err.status = 400;
    throw err;
  }

  return payload.data;
};

export const markPaymentAsPaidByReference = async (
  reference,
  options = {},
) => {
  const { enforceUserId } = options;

  const existing = await pool.query(
    "SELECT * FROM payments WHERE provider_ref = $1",
    [reference],
  );

  if (existing.rows.length === 0) {
    const err = new Error("Payment record not found");
    err.status = 404;
    throw err;
  }

  const payment = existing.rows[0];
  if (enforceUserId && payment.user_id !== enforceUserId) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  if (payment.status === "paid" || payment.status === "released") {
    return { payment, updated: false };
  }

  const updated = await pool.query(
    `UPDATE payments
     SET status = 'paid', escrow = true, paid_at = COALESCE(paid_at, NOW())
     WHERE id = $1
     RETURNING *`,
    [payment.id],
  );

  console.log("💰 Escrow locked for payment:", reference);

  return { payment: updated.rows[0], updated: true };
};
