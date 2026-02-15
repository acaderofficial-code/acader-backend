import express from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { verifyToken } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { safeNotify } from "../utils/notify.js";
import {
  markPaymentAsPaidByReference,
  verifyPaystackReference,
} from "../services/paystack.service.js";
import pool from "../config/db.js";

const router = express.Router();

/**
 * Initialize a Paystack transaction (authenticated)
 * Frontend calls POST /api/paystack/initialize
 */
router.post(
  "/initialize",
  verifyToken,
  asyncHandler(async (req, res) => {
    const {
      amount,
      email,
      company_id,
      project_id,
      application_id,
      callback_url,
    } = req.body ?? {};

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    const payerEmail = email ?? req.user?.email;
    if (!payerEmail) {
      return res.status(400).json({ message: "Email is required" });
    }

    const companyId = Number(company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      return res.status(400).json({ message: "company_id is required" });
    }

    const projectId =
      project_id === undefined || project_id === null
        ? null
        : Number(project_id);
    const applicationId =
      application_id === undefined || application_id === null
        ? null
        : Number(application_id);

    if (projectId !== null && (!Number.isInteger(projectId) || projectId <= 0)) {
      return res.status(400).json({ message: "Invalid project_id" });
    }
    if (
      applicationId !== null &&
      (!Number.isInteger(applicationId) || applicationId <= 0)
    ) {
      return res.status(400).json({ message: "Invalid application_id" });
    }

    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
      return res.status(500).json({ message: "PAYSTACK_SECRET_KEY is missing" });
    }

    const reference = uuidv4();
    const amountKobo = Math.round(numericAmount * 100);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: payerEmail,
        amount: amountKobo,
        reference,
        callback_url,
      },
      {
        headers: {
          Authorization: `Bearer ${secret}`,
        },
      },
    );

    if (!response.data?.status) {
      return res
        .status(400)
        .json({ message: "Failed to initialize Paystack transaction" });
    }

    const paystackData = response.data.data;

    // Create a pending payment record so verify/webhook can update it later
    const created = await pool.query(
      `INSERT INTO payments
       (user_id, company_id, project_id, application_id, amount, provider, provider_ref)
       VALUES ($1, $2, $3, $4, $5, 'paystack', $6)
       RETURNING *`,
      [
        req.user.id,
        companyId,
        projectId,
        applicationId,
        numericAmount,
        reference,
      ],
    );

    res.json({
      authorization_url: paystackData.authorization_url,
      access_code: paystackData.access_code,
      reference: paystackData.reference,
      payment: created.rows[0],
    });
  }),
);

/**
 * Verify a Paystack transaction (authenticated)
 * Frontend calls GET /api/paystack/verify/:reference
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

export default router;
