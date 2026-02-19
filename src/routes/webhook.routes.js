import express from "express";
import crypto from "crypto";
import pool from "../config/db.js";
import {
  applyPaymentTransitionLedger,
  releaseWithdrawalHold,
  settleWithdrawal,
} from "../services/ledger.service.js";
import { refreshRiskProfilesForUsers } from "../services/fraud/risk_profile.js";
import {
  enqueueFraudReview,
  FRAUD_REVIEW_REASON,
  getUserRiskScore,
  getWalletRestriction,
} from "../services/fraud/review_queue.js";
import {
  createRiskAuditLog,
  RISK_AUDIT_ACTION,
} from "../services/fraud/risk_audit.js";
import {
  appendFinancialEventLog,
  FINANCIAL_EVENT_TYPE,
} from "../services/financial_event_log.service.js";

const router = express.Router();

const processWithdrawalTransferWebhook = async ({
  requestId,
  eventName,
  reference,
  event,
}) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const withdrawalResult = await client.query(
      `SELECT *
       FROM withdrawals
       WHERE provider_ref = $1
       FOR UPDATE`,
      [reference],
    );

    if (withdrawalResult.rows.length === 0) {
      await client.query("ROLLBACK");
      console.error(`[${requestId}] withdrawal not found`, { reference });
      return;
    }

    const withdrawal = withdrawalResult.rows[0];

    if (withdrawal.status !== "processing") {
      await client.query("ROLLBACK");
      console.log(`[${requestId}] withdrawal transfer ignored for non-processing status`, {
        withdrawalId: withdrawal.id,
        status: withdrawal.status,
        event: eventName,
      });
      return;
    }

    const transferCode = event?.data?.transfer_code ?? null;

    if (eventName === "transfer.success") {
      await settleWithdrawal(client, withdrawal);

      const updated = await client.query(
        `UPDATE withdrawals
         SET status = 'completed',
             processed_at = NOW(),
             failure_reason = NULL,
             transfer_code = COALESCE($1, transfer_code)
         WHERE id = $2
         RETURNING *`,
        [transferCode, withdrawal.id],
      );

      await client.query("COMMIT");
      console.log(`[${requestId}] withdrawal completed`, {
        withdrawalId: withdrawal.id,
        reference,
      });

      try {
        await pool.query(
          `INSERT INTO notifications (user_id, title, message, type, related_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            withdrawal.user_id,
            "Withdrawal completed",
            "Your withdrawal transfer was completed successfully.",
            "withdrawal_completed",
            updated.rows[0]?.id ?? withdrawal.id,
          ],
        );
      } catch (notifyErr) {
        console.error(`[${requestId}] withdrawal success notification failed`, notifyErr.message);
      }
      return;
    }

    const failureReason =
      event?.data?.gateway_response ??
      event?.data?.status ??
      event?.data?.message ??
      "Transfer failed";

    await releaseWithdrawalHold(client, withdrawal, {
      reversalType: "withdrawal_reversal",
      idempotencySuffix: "reverse",
    });

    const updated = await client.query(
      `UPDATE withdrawals
       SET status = 'failed',
           processed_at = NOW(),
           failure_reason = COALESCE($1, failure_reason, 'Transfer failed'),
           transfer_code = COALESCE($2, transfer_code)
       WHERE id = $3
       RETURNING *`,
      [failureReason, transferCode, withdrawal.id],
    );

    await client.query("COMMIT");
    console.log(`[${requestId}] withdrawal failed and reversed`, {
      withdrawalId: withdrawal.id,
      reference,
    });

    try {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type, related_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          withdrawal.user_id,
          "Withdrawal failed",
          "Your withdrawal failed and funds were returned to your wallet.",
          "withdrawal_failed",
          updated.rows[0]?.id ?? withdrawal.id,
        ],
      );
    } catch (notifyErr) {
      console.error(`[${requestId}] withdrawal failure notification failed`, notifyErr.message);
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
};

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

  const isWithdrawalTransferEvent =
    (eventName === "transfer.success" || eventName === "transfer.failed") &&
    typeof reference === "string" &&
    reference.startsWith("withdrawal_");

  if (isWithdrawalTransferEvent) {
    try {
      await processWithdrawalTransferWebhook({
        requestId,
        eventName,
        reference,
        event,
      });
    } catch (withdrawalErr) {
      console.error(`[${requestId}] withdrawal webhook processing error`, withdrawalErr.message);
    }
    return res.sendStatus(200);
  }

  const statusByEvent = {
    "charge.success": "paid",
    "charge.failed": "failed",
    "transfer.success": "released",
    "transfer.failed": "transfer_failed",
    "refund.processed": "refunded",
  };

  const nextStatus = statusByEvent[eventName] ?? null;
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

      if (payment.disputed === true && eventName !== "charge.dispute.create") {
        await client.query("ROLLBACK");
        console.log(`[${requestId}] payment event ignored due to active dispute`, {
          paymentId: payment.id,
          reference,
          event: eventName,
        });
        return res.sendStatus(200);
      }

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

        const restriction = await getWalletRestriction(studentUserId, { client });
        if (restriction) {
          await client.query("ROLLBACK");
          try {
            await createRiskAuditLog({
              userId: studentUserId,
              actionType: RISK_AUDIT_ACTION.ESCROW_RELEASE_REJECTED,
              reason: "STUDENT_RESTRICTED",
              relatedPaymentId: payment.id,
            });
            await appendFinancialEventLog({
              eventType: FINANCIAL_EVENT_TYPE.ESCROW_RELEASE_REJECTED,
              userId: studentUserId,
              paymentId: payment.id,
              eventPayload: {
                reason: "STUDENT_RESTRICTED",
                source: "paystack_webhook",
                restriction_reason: restriction.reason ?? null,
              },
            });
          } catch (auditErr) {
            console.error("[risk_audit] webhook release rejection log failed", auditErr.message);
          }
          console.error(`[${requestId}] transfer.success blocked: student restricted`, {
            paymentId: payment.id,
            studentUserId,
            restrictionReason: restriction.reason,
          });
          return res.sendStatus(200);
        }
      }

      let disputeId = null;
      if (eventName === "charge.dispute.create") {
        const reason =
          event?.data?.reason ??
          event?.data?.message ??
          "Charge dispute opened by provider";

        console.log(`[${requestId}] opening dispute`, {
          paymentId: payment.id,
          reason,
        });

        const existingDispute = await client.query(
          `
          SELECT id
          FROM disputes
          WHERE payment_id = $1
            AND status IN ('open', 'under_review')
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [payment.id],
        );

        if (existingDispute.rows.length > 0) {
          disputeId = existingDispute.rows[0].id;
        } else {
          const disputeInsert = await client.query(
            `INSERT INTO disputes (payment_id, raised_by, reason, status, created_at)
             VALUES ($1, $2, $3, 'open', NOW())
             RETURNING id`,
            [payment.id, payment.user_id, reason],
          );

          disputeId = disputeInsert.rows[0]?.id ?? null;
        }

        const paymentDisputeUpdate = await client.query(
          `
          UPDATE payments
          SET disputed = true
          WHERE id = $1
          RETURNING id, user_id, status, escrow, disputed
          `,
          [payment.id],
        );

        const riskScore = await getUserRiskScore(payment.user_id, { client });
        await enqueueFraudReview(
          {
            userId: payment.user_id,
            paymentId: payment.id,
            riskScore,
            reason: FRAUD_REVIEW_REASON.DISPUTE_OPENED,
          },
          { client },
        );
        await createRiskAuditLog(
          {
            userId: payment.user_id,
            actionType: RISK_AUDIT_ACTION.DISPUTE_OPENED,
            reason: "PAYSTACK_DISPUTE_WEBHOOK",
            riskScore,
            relatedPaymentId: payment.id,
          },
          { client },
        );
        await appendFinancialEventLog(
          {
            eventType: FINANCIAL_EVENT_TYPE.DISPUTE_OPENED,
            userId: payment.user_id,
            paymentId: payment.id,
            disputeId,
            eventPayload: {
              reason,
              source: "paystack_webhook",
            },
          },
          { client },
        );
        const disputeStudentUserId = Number(payment.student_user_id);
        if (
          Number.isInteger(disputeStudentUserId) &&
          disputeStudentUserId > 0 &&
          disputeStudentUserId !== payment.user_id
        ) {
          await createRiskAuditLog(
            {
              userId: disputeStudentUserId,
              actionType: RISK_AUDIT_ACTION.DISPUTE_OPENED,
              reason: "PAYSTACK_DISPUTE_WEBHOOK",
              relatedPaymentId: payment.id,
            },
            { client },
          );
          await appendFinancialEventLog(
            {
              eventType: FINANCIAL_EVENT_TYPE.DISPUTE_OPENED,
              userId: disputeStudentUserId,
              paymentId: payment.id,
              disputeId,
              eventPayload: {
                reason,
                source: "paystack_webhook",
              },
            },
            { client },
          );
        }

        updatedPayment = {
          ...(paymentDisputeUpdate.rows[0] ?? {}),
          dispute_id: disputeId,
          notification_user_id: payment.user_id,
        };

        await client.query("COMMIT");
        console.log(`[${requestId}] dispute gate activated`, {
          paymentId: payment.id,
          disputeId,
        });

        await refreshRiskProfilesForUsers([
          Number(payment.user_id),
          Number(payment.student_user_id),
        ]);

        try {
          await pool.query(
            `INSERT INTO notifications (user_id, title, message, type, related_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              payment.user_id,
              "Dispute opened",
              "A dispute has been opened on this payment and actions are now frozen.",
              "payment_disputed",
              disputeId ?? payment.id,
            ],
          );
        } catch (notifyErr) {
          console.error(`[${requestId}] dispute notification failed`, notifyErr.message);
        }

        console.log(`Dispute opened: ${reference}`);
        console.log(`Processed ${eventName} for ${reference}`);
        return res.sendStatus(200);
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
      if (eventName === "transfer.success") {
        await appendFinancialEventLog(
          {
            eventType: FINANCIAL_EVENT_TYPE.ESCROW_RELEASED,
            userId: notificationUserId,
            paymentId: payment.id,
            eventPayload: {
              source: "paystack_webhook",
              reference,
              amount: payment.amount,
            },
          },
          { client },
        );
        await createRiskAuditLog(
          {
            userId: notificationUserId,
            actionType: RISK_AUDIT_ACTION.ESCROW_RELEASE_APPROVED,
            reason: "PAYSTACK_TRANSFER_SUCCESS",
            relatedPaymentId: payment.id,
          },
          { client },
        );
      }

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
