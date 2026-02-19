import pool from "../config/db.js";
import { generateEventHash } from "../utils/hashEvent.js";

export const FINANCIAL_EVENT_TYPE = {
  ESCROW_FUNDED: "ESCROW_FUNDED",
  ESCROW_RELEASED: "ESCROW_RELEASED",
  ESCROW_RELEASE_REJECTED: "ESCROW_RELEASE_REJECTED",
  REFUND_PROCESSED: "REFUND_PROCESSED",
  WITHDRAWAL_REQUESTED: "WITHDRAWAL_REQUESTED",
  WITHDRAWAL_APPROVED: "WITHDRAWAL_APPROVED",
  WITHDRAWAL_REJECTED: "WITHDRAWAL_REJECTED",
  DISPUTE_OPENED: "DISPUTE_OPENED",
  DISPUTE_RESOLVED: "DISPUTE_RESOLVED",
  LEDGER_ENTRY_CREATED: "LEDGER_ENTRY_CREATED",
  PLATFORM_FEE_DEDUCTED: "PLATFORM_FEE_DEDUCTED",
  WALLET_RESTRICTED: "WALLET_RESTRICTED",
};

const GENESIS_HASH = "GENESIS";
const CHAIN_LOCK_KEY = 20260220;

const parseOptionalInt = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

const normalizePayload = (payload) =>
  payload && typeof payload === "object" ? payload : {};

export const appendFinancialEventLog = async (params, options = {}) => {
  const {
    eventType,
    userId = null,
    paymentId = null,
    withdrawalId = null,
    disputeId = null,
    eventPayload = {},
  } = params ?? {};

  if (!eventType || typeof eventType !== "string") {
    throw new Error("eventType is required for financial event log");
  }

  const hasExternalClient = Boolean(options.client);
  const client = options.client ?? (await pool.connect());

  try {
    if (!hasExternalClient) {
      await client.query("BEGIN");
    }

    await client.query("SELECT pg_advisory_xact_lock($1)", [CHAIN_LOCK_KEY]);

    const previousResult = await client.query(
      `
      SELECT current_hash
      FROM financial_event_log
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      `,
    );

    const previousHash = previousResult.rows[0]?.current_hash ?? GENESIS_HASH;
    const normalizedPayload = normalizePayload(eventPayload);
    const currentHash = generateEventHash(normalizedPayload, previousHash);

    const insertResult = await client.query(
      `
      INSERT INTO financial_event_log (
        event_type,
        user_id,
        payment_id,
        withdrawal_id,
        dispute_id,
        event_payload,
        previous_hash,
        current_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      RETURNING *
      `,
      [
        eventType,
        parseOptionalInt(userId),
        parseOptionalInt(paymentId),
        parseOptionalInt(withdrawalId),
        parseOptionalInt(disputeId),
        JSON.stringify(normalizedPayload),
        previousHash,
        currentHash,
      ],
    );

    if (!hasExternalClient) {
      await client.query("COMMIT");
    }

    return insertResult.rows[0] ?? null;
  } catch (err) {
    if (!hasExternalClient) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback error
      }
    }
    throw err;
  } finally {
    if (!hasExternalClient) {
      client.release();
    }
  }
};

export const verifyFinancialEventChain = async () => {
  const result = await pool.query(
    `
    SELECT *
    FROM financial_event_log
    ORDER BY created_at ASC, id ASC
    `,
  );

  let expectedPreviousHash = GENESIS_HASH;
  for (const row of result.rows) {
    if (row.previous_hash !== expectedPreviousHash) {
      return {
        status: "CHAIN_BROKEN",
        checked_events: result.rows.length,
        broken_at_id: row.id,
        reason: "PREVIOUS_HASH_MISMATCH",
      };
    }

    const expectedCurrentHash = generateEventHash(
      row.event_payload ?? {},
      row.previous_hash,
    );
    if (row.current_hash !== expectedCurrentHash) {
      return {
        status: "CHAIN_BROKEN",
        checked_events: result.rows.length,
        broken_at_id: row.id,
        reason: "CURRENT_HASH_MISMATCH",
      };
    }

    expectedPreviousHash = row.current_hash;
  }

  return {
    status: "CHAIN_VALID",
    checked_events: result.rows.length,
    latest_hash: expectedPreviousHash,
  };
};
