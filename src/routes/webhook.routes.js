import express from "express";
import crypto from "crypto";
import pool from "../config/db.js";
import { applyPaymentTransitionLedger } from "../services/ledger.service.js";

const router = express.Router();

/**
 * Paystack Webhook
 * POST /api/webhooks/paystack
 */
router.post("/paystack", async (req, res) => {
  const requestId = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();
  const isRawBuffer = Buffer.isBuffer(req.body);

  console.log(`[${requestId}] webhook received`, {
    method: req.method,
    path: req.originalUrl,
    isRawBuffer,
    bodyType: typeof req.body,
    bodyLength: isRawBuffer ? req.body.length : undefined,
  });

  // 1) Verify signature using raw request body only.
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers["x-paystack-signature"];

  if (!secret || !signature) {
    console.error(`[${requestId}] missing secret or signature`);
    return res.sendStatus(200);
  }

  if (!isRawBuffer) {
    console.error(
      `[${requestId}] req.body is not Buffer. Check express.raw() middleware order/path.`,
    );
    return res.sendStatus(200);
  }

  const rawBody = req.body;
  const expectedHash = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");
  const receivedHash = String(signature);
  const signatureMatched = expectedHash === receivedHash;

  console.log(`[${requestId}] signature verification`, {
    matched: signatureMatched,
    receivedPrefix: receivedHash.slice(0, 12),
    expectedPrefix: expectedHash.slice(0, 12),
  });

  if (!signatureMatched) {
    console.error(`[${requestId}] invalid Paystack signature`);
    return res.sendStatus(200);
  }

  // 2) Parse raw JSON payload.
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
    console.log(`[${requestId}] payload parsed`, {
      event: event?.event,
      reference: event?.data?.reference,
      eventId: event?.id ?? event?.data?.id ?? null,
    });
  } catch (err) {
    console.error(`[${requestId}] invalid JSON payload`);
    return res.sendStatus(200);
  }

  const eventName = event?.event ?? null;
  const reference = event?.data?.reference ?? null;
  const eventId =
    event?.id ??
    `${eventName ?? "unknown"}:${event?.data?.id ?? reference ?? Date.now()}`;

  console.log(`Webhook received: ${eventName ?? "unknown"}`);

  // 3) Persist webhook event first for forensics + idempotency lock.
  try {
    console.log(`[${requestId}] inserting webhook_events (forensic + idempotency)`);
    const lockResult = await pool.query(
      `INSERT INTO webhook_events (
         provider,
         event_id,
         event,
         event_type,
         reference,
         payload,
         received_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [
        "paystack",
        eventId,
        eventName,
        eventName,
        reference,
        JSON.stringify(event),
      ],
    );

    console.log(`[${requestId}] webhook_events insert result`, {
      rowCount: lockResult.rowCount,
      eventId,
    });

    if (lockResult.rowCount === 0) {
      console.log(`[${requestId}] duplicate event ignored`, { eventId });
      return res.sendStatus(200);
    }
  } catch (insertErr) {
    console.error(`[${requestId}] failed to persist webhook_events`, insertErr.message);
    return res.sendStatus(200);
  }

  const supportedEvents = [
    "charge.success",
    "charge.failed",
    "charge.dispute.create",
    "transfer.success",
    "transfer.failed",
    "refund.processed",
  ];
  const isSupportedEvent = supportedEvents.includes(eventName);

  console.log(`[${requestId}] event support check`, {
    event: eventName,
    isSupportedEvent,
  });

  if (!isSupportedEvent) {
    return res.sendStatus(200);
  }

  if (!reference) {
    console.error(`[${requestId}] missing reference`);
    return res.sendStatus(200);
  }

  const statusByEvent = {
    "charge.success": "paid",
    "charge.failed": "failed",
    "charge.dispute.create": "disputed",
    "transfer.success": "released",
    "transfer.failed": "transfer_failed",
    "refund.processed": "refunded",
  };

  const nextStatus = statusByEvent[eventName];
  let updatedPayment = null;

  // 4) Critical write path: payment status update in isolated transaction.
  try {
    const client = await pool.connect();
    try {
      console.log(`[${requestId}] tx begin`);
      await client.query("BEGIN");

      console.log(`[${requestId}] selecting payment by provider_ref`);
      const paymentResult = await client.query(
        `SELECT p.*, a.user_id AS student_user_id, c.user_id AS company_user_id
         FROM payments p
         LEFT JOIN applications a ON a.id = p.application_id
         LEFT JOIN companies c ON c.id = p.company_id
         WHERE p.provider_ref = $1
         FOR UPDATE OF p`,
        [reference],
      );

      if (paymentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        console.error(`[${requestId}] payment not found`, { reference });
        return res.sendStatus(200);
      }

      const payment = paymentResult.rows[0];

      // Only release escrow from a paid state.
      if (eventName === "transfer.success" && payment.status !== "paid") {
        await client.query("ROLLBACK");
        console.error(`[${requestId}] transfer.success ignored: payment not in paid state`, {
          paymentId: payment.id,
          currentStatus: payment.status,
          reference,
        });
        return res.sendStatus(200);
      }

      if (eventName === "transfer.success") {
        const studentUserId = Number(payment.student_user_id);
        if (!Number.isInteger(studentUserId) || studentUserId <= 0) {
          await client.query("ROLLBACK");
          console.error(
            `[${requestId}] transfer.success ignored: missing student user mapping`,
            { paymentId: payment.id, applicationId: payment.application_id, reference },
          );
          return res.sendStatus(200);
        }
      }

      let disputeId = null;
      if (eventName === "charge.dispute.create") {
        const reason =
          event?.data?.reason ??
          event?.data?.message ??
          "Charge dispute opened by provider";

        console.log(`[${requestId}] inserting dispute`, {
          paymentId: payment.id,
          reason,
        });

        const disputeInsert = await client.query(
          `INSERT INTO disputes (payment_id, raised_by, reason, status, created_at)
           VALUES ($1, $2, $3, 'open', NOW())
           RETURNING id`,
          [payment.id, payment.user_id, reason],
        );

        disputeId = disputeInsert.rows[0]?.id ?? null;
      }

      await applyPaymentTransitionLedger(client, payment, nextStatus, {
        idempotencyPrefix: `payment:${payment.id}:${payment.status}->${nextStatus}`,
        companyUserId: payment.company_user_id ?? undefined,
        studentUserId: payment.student_user_id ?? undefined,
        requireStudentUserId: eventName === "transfer.success",
      });

      const escrow =
        nextStatus === "paid"
          ? true
          : nextStatus === "released" ||
              nextStatus === "failed" ||
              nextStatus === "refunded"
            ? false
            : payment.escrow;
      const shouldSetPaidAt = nextStatus === "paid";
      const shouldSetReleasedAt = nextStatus === "released";
      const shouldSetRefundedAt = nextStatus === "refunded";
      const releasedByRaw = event?.data?.metadata?.released_by;
      const releasedBy =
        typeof releasedByRaw === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          releasedByRaw,
        )
          ? releasedByRaw
          : null;

      console.log(`[${requestId}] updating payment`, {
        paymentId: payment.id,
        fromStatus: payment.status,
        toStatus: nextStatus,
        escrow,
      });

      const updateResult = await client.query(
        `UPDATE payments
         SET status = $1,
             escrow = $2,
             paid_at = CASE WHEN $4 THEN NOW() ELSE paid_at END,
             released_at = CASE WHEN $5 THEN NOW() ELSE released_at END,
             released_by = CASE WHEN $5 THEN $6::uuid ELSE released_by END,
             refunded_at = CASE WHEN $7 THEN NOW() ELSE refunded_at END
         WHERE id = $3
         RETURNING id, user_id, status, escrow`,
        [
          nextStatus,
          escrow,
          payment.id,
          shouldSetPaidAt,
          shouldSetReleasedAt,
          releasedBy,
          shouldSetRefundedAt,
        ],
      );

      // Hard assertion so silent failures are impossible.
      if (updateResult.rowCount !== 1) {
        throw new Error("Payment update failed");
      }

      const updatedRow = updateResult.rows[0] ?? {};
      const transferRecipientId =
        eventName === "transfer.success" ? Number(payment.student_user_id) : null;
      const notificationUserId =
        Number.isInteger(transferRecipientId) && transferRecipientId > 0
          ? transferRecipientId
          : updatedRow.user_id;

      updatedPayment = {
        ...updatedRow,
        dispute_id: disputeId,
        notification_user_id: notificationUserId,
      };

      await client.query("COMMIT");
      console.log(`[${requestId}] tx committed`, {
        reference,
        eventId,
        status: updatedPayment?.status,
        durationMs: Date.now() - start,
      });

      if (eventName === "transfer.success") {
        console.log(`Escrow released for ${reference}`);
      }

      if (eventName === "refund.processed") {
        console.log(`Payment refunded: ${reference}`);
      }

      if (eventName === "charge.dispute.create") {
        console.log(`Dispute opened: ${reference}`);
      }

      console.log(`Processed ${eventName} for ${reference}`);
    } catch (txErr) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      console.error(`[${requestId}] tx rolled back`, { error: txErr.message });
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`[${requestId}] webhook DB processing error`, err.message);
    return res.sendStatus(200);
  }

  // 5) Non-critical side effects: notification must never rollback payment update.
  const notificationUserId = updatedPayment?.notification_user_id ?? updatedPayment?.user_id;
  if (notificationUserId) {
    const notificationByEvent = {
      "charge.success": {
        title: "Payment successful",
        message: "Your payment was received and placed in escrow.",
        type: "payment_paid",
      },
      "charge.failed": {
        title: "Payment failed",
        message: "Your payment attempt failed.",
        type: "payment_failed",
      },
      "charge.dispute.create": {
        title: "Dispute opened",
        message: "A dispute has been opened on this payment.",
        type: "payment_disputed",
      },
      "transfer.success": {
        title: "Transfer successful",
        message: "Your transfer was completed successfully.",
        type: "transfer_success",
      },
      "transfer.failed": {
        title: "Transfer failed",
        message: "Your transfer attempt failed.",
        type: "transfer_failed",
      },
      "refund.processed": {
        title: "Refund processed",
        message: "Your payment has been refunded.",
        type: "payment_refunded",
      },
    };

    const n = notificationByEvent[eventName];
    if (n) {
      try {
        console.log(`[${requestId}] inserting notification`);
        await pool.query(
          `INSERT INTO notifications (user_id, title, message, type, related_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            notificationUserId,
            n.title,
            n.message,
            n.type,
            eventName === "charge.dispute.create"
              ? updatedPayment.dispute_id ?? updatedPayment.id
              : updatedPayment.id,
          ],
        );
        console.log(`[${requestId}] notification inserted`);
      } catch (notifyErr) {
        console.error(`[${requestId}] notification insert failed`, notifyErr.message);
      }
    }
  }

  return res.sendStatus(200);
});

export default router;
