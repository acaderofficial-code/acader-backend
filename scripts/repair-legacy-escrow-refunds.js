import "dotenv/config";
import pool from "../src/config/db.js";
import {
  createDoubleEntry,
  syncWalletAvailableBalances,
} from "../src/services/ledger.service.js";
import { reconcileWalletById } from "../src/services/reconciliation.service.js";

const findLegacyRefundEscrowMismatches = async (client) => {
  const result = await client.query(
    `
    SELECT
      p.id AS payment_id,
      p.provider_ref AS reference,
      p.amount::numeric(12,2) AS payment_amount,
      c.user_id AS company_user_id,
      COALESCE(
        SUM(
          CASE
            WHEN le.direction = 'credit' THEN le.amount
            WHEN le.direction = 'debit' THEN -le.amount
            ELSE 0
          END
        ),
        0
      )::numeric(12,2) AS escrow_balance
    FROM payments p
    JOIN companies c ON c.id = p.company_id
    LEFT JOIN ledger_entries le
      ON le.reference = p.provider_ref
     AND le.user_id = c.user_id
     AND le.balance_type = 'escrow'
    WHERE p.status = 'refunded'
      AND p.provider_ref IS NOT NULL
      AND p.provider_ref <> ''
    GROUP BY p.id, p.provider_ref, p.amount, c.user_id
    HAVING COALESCE(
      SUM(
        CASE
          WHEN le.direction = 'credit' THEN le.amount
          WHEN le.direction = 'debit' THEN -le.amount
          ELSE 0
        END
      ),
      0
    ) < 0
    ORDER BY p.id ASC
    `,
  );

  return result.rows.map((row) => ({
    paymentId: Number(row.payment_id),
    reference: row.reference,
    paymentAmount: Number(row.payment_amount),
    companyUserId: Number(row.company_user_id),
    escrowBalance: Number(row.escrow_balance),
    shortfall: Math.abs(Number(row.escrow_balance)),
  }));
};

const resolveFlagsIfReconciled = async (walletId) => {
  const reconciliation = await reconcileWalletById(walletId);
  if (reconciliation.status !== "ok") {
    return { walletId, reconciliation, flagsResolved: 0 };
  }

  const updateResult = await pool.query(
    `
    UPDATE reconciliation_flags
    SET resolved = true
    WHERE wallet_id = $1
      AND resolved = false
    `,
    [walletId],
  );

  return {
    walletId,
    reconciliation,
    flagsResolved: updateResult.rowCount ?? 0,
  };
};

const run = async () => {
  const client = await pool.connect();
  const affectedUserIds = new Set();
  const appliedRepairs = [];

  try {
    await client.query("BEGIN");

    const candidates = await findLegacyRefundEscrowMismatches(client);
    if (candidates.length === 0) {
      await client.query("ROLLBACK");
      console.log("[repair] no legacy escrow mismatches found");
      return;
    }

    for (const candidate of candidates) {
      if (!Number.isInteger(candidate.companyUserId) || candidate.companyUserId <= 0) {
        throw new Error(
          `Invalid company user for payment ${candidate.paymentId}: ${candidate.companyUserId}`,
        );
      }

      const result = await createDoubleEntry(client, {
        amount: candidate.shortfall,
        reference: candidate.reference,
        idempotencyBase: `repair:payment:${candidate.paymentId}:legacy_escrow_backfill`,
        type: "escrow_backfill",
        debitUserId: null,
        debitBalanceType: "platform",
        creditUserId: candidate.companyUserId,
        creditBalanceType: "escrow",
      });

      appliedRepairs.push({
        ...candidate,
        applied: result.applied,
      });
      affectedUserIds.add(candidate.companyUserId);
    }

    await syncWalletAvailableBalances(client, [...affectedUserIds]);
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

  const walletRows = await pool.query(
    `
    SELECT id, user_id
    FROM wallets
    WHERE user_id = ANY($1::int[])
    ORDER BY id ASC
    `,
    [[...affectedUserIds]],
  );

  const flagResolution = [];
  for (const wallet of walletRows.rows) {
    const result = await resolveFlagsIfReconciled(Number(wallet.id));
    flagResolution.push({
      walletId: Number(wallet.id),
      userId: Number(wallet.user_id),
      status: result.reconciliation.status,
      availableExpected: result.reconciliation.available_expected,
      availableActual: result.reconciliation.available_actual,
      escrowExpected: result.reconciliation.escrow_expected,
      escrowActual: result.reconciliation.escrow_actual,
      flagsResolved: result.flagsResolved,
    });
  }

  console.log("[repair] applied repairs:", JSON.stringify(appliedRepairs, null, 2));
  console.log(
    "[repair] reconciliation status after repair:",
    JSON.stringify(flagResolution, null, 2),
  );
};

run()
  .catch((err) => {
    console.error("[repair] failed:", err.message);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
