import pool from "../config/db.js";

const STATUS = {
  OK: "ok",
  MISMATCH: "mismatch",
};

const roundCurrency = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const isSameAmount = (a, b) => Math.abs(roundCurrency(a) - roundCurrency(b)) < 0.000001;

const formatAmount = (value) => roundCurrency(value).toFixed(2);

const normalizeWalletRow = (walletRow) => {
  const availableRaw =
    walletRow.available_balance ?? walletRow.balance ?? 0;
  const escrowRaw = walletRow.escrow_balance ?? 0;
  return {
    availableActual: roundCurrency(availableRaw),
    escrowActual: roundCurrency(escrowRaw),
  };
};

const computeExpectedFromLedger = async (client, userId) => {
  const result = await client.query(
    `
    SELECT
      COALESCE(
        SUM(
          CASE
            WHEN balance_type = 'available' AND direction = 'credit' THEN amount
            WHEN balance_type = 'available' AND direction = 'debit' THEN -amount
            ELSE 0
          END
        ),
        0
      )::numeric(12,2) AS available_expected,
      COALESCE(
        SUM(
          CASE
            WHEN balance_type = 'escrow' AND direction = 'credit' THEN amount
            WHEN balance_type = 'escrow' AND direction = 'debit' THEN -amount
            ELSE 0
          END
        ),
        0
      )::numeric(12,2) AS escrow_expected
    FROM ledger_entries
    WHERE user_id = $1
    `,
    [userId],
  );

  return {
    available_expected: roundCurrency(result.rows[0]?.available_expected ?? 0),
    escrow_expected: roundCurrency(result.rows[0]?.escrow_expected ?? 0),
  };
};

export const rebuildWalletFromLedger = async (walletId, options = {}) => {
  const db = options.client ?? pool;

  const walletResult = await db.query(
    `
    SELECT id, user_id
    FROM wallets
    WHERE id = $1
    `,
    [walletId],
  );

  if (walletResult.rows.length === 0) {
    const err = new Error("Wallet not found");
    err.status = 404;
    throw err;
  }

  const wallet = walletResult.rows[0];
  const userId = Number(wallet.user_id);
  if (!Number.isInteger(userId) || userId <= 0) {
    const err = new Error("Wallet has invalid user_id");
    err.status = 400;
    throw err;
  }

  const expected = await computeExpectedFromLedger(db, userId);
  return {
    walletId: Number(wallet.id),
    userId,
    ...expected,
  };
};

export const reconcileWalletById = async (walletId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const walletResult = await client.query(
      `
      SELECT id, user_id, balance, available_balance, escrow_balance
      FROM wallets
      WHERE id = $1
      FOR UPDATE
      `,
      [walletId],
    );

    if (walletResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return { walletId, status: "missing_wallet" };
    }

    const wallet = walletResult.rows[0];
    const userId = Number(wallet.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error("Wallet has invalid user_id");
    }

    const expected = await computeExpectedFromLedger(client, userId);
    const { availableActual, escrowActual } = normalizeWalletRow(wallet);

    const availableMatches = isSameAmount(expected.available_expected, availableActual);
    const escrowMatches = isSameAmount(expected.escrow_expected, escrowActual);
    const status = availableMatches && escrowMatches ? STATUS.OK : STATUS.MISMATCH;

    await client.query(
      `
      INSERT INTO reconciliation_logs
        (wallet_id, available_expected, available_actual, escrow_expected, escrow_actual, status)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      `,
      [
        wallet.id,
        expected.available_expected,
        availableActual,
        expected.escrow_expected,
        escrowActual,
        status,
      ],
    );

    if (status === STATUS.MISMATCH) {
      const reason =
        `available_expected=${formatAmount(expected.available_expected)},` +
        ` available_actual=${formatAmount(availableActual)},` +
        ` escrow_expected=${formatAmount(expected.escrow_expected)},` +
        ` escrow_actual=${formatAmount(escrowActual)}`;

      const unresolved = await client.query(
        `
        SELECT id
        FROM reconciliation_flags
        WHERE wallet_id = $1 AND resolved = false
        LIMIT 1
        `,
        [wallet.id],
      );

      if (unresolved.rows.length === 0) {
        await client.query(
          `
          INSERT INTO reconciliation_flags (wallet_id, reason, resolved)
          VALUES ($1, $2, false)
          `,
          [wallet.id, reason],
        );
      }

      console.error("⚠️ WALLET MISMATCH DETECTED");
      console.error(`walletId: ${wallet.id}`);
      console.error(`available_expected: ${formatAmount(expected.available_expected)}`);
      console.error(`available_actual: ${formatAmount(availableActual)}`);
      console.error(`escrow_expected: ${formatAmount(expected.escrow_expected)}`);
      console.error(`escrow_actual: ${formatAmount(escrowActual)}`);
    }

    await client.query("COMMIT");

    return {
      walletId: Number(wallet.id),
      userId,
      status,
      available_expected: expected.available_expected,
      available_actual: availableActual,
      escrow_expected: expected.escrow_expected,
      escrow_actual: escrowActual,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    console.error("[reconciliation] wallet reconciliation failed", {
      walletId,
      error: err.message,
    });
    return { walletId, status: "error", error: err.message };
  } finally {
    client.release();
  }
};

export const runDailyReconciliation = async () => {
  const walletsResult = await pool.query("SELECT id FROM wallets ORDER BY id ASC");
  const walletIds = walletsResult.rows.map((row) => Number(row.id));

  const summary = {
    totalWallets: walletIds.length,
    ok: 0,
    mismatch: 0,
    error: 0,
  };

  for (const walletId of walletIds) {
    const result = await reconcileWalletById(walletId);
    if (result.status === STATUS.OK) summary.ok += 1;
    else if (result.status === STATUS.MISMATCH) summary.mismatch += 1;
    else summary.error += 1;
  }

  console.log("[reconciliation] daily run complete", summary);
  return summary;
};
