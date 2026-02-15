import pool from "../config/db.js";

const DIRECTION = {
  CREDIT: "credit",
  DEBIT: "debit",
};

const BALANCE_TYPE = {
  AVAILABLE: "available",
  ESCROW: "escrow",
  LOCKED: "locked",
  PLATFORM: "platform",
};

const toPositiveAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be a positive number");
  }
  return amount;
};

const roundToCurrency = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const getPlatformFeePercent = () => {
  const parsed = Number(process.env.PLATFORM_FEE_PERCENT ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(parsed, 100);
};

const uniqueInts = (values) =>
  [...new Set(values.filter((v) => Number.isInteger(v) && v > 0))];

export const createLedgerEntry = async (client, entry) => {
  const {
    userId = null,
    amount,
    direction,
    balanceType,
    type,
    reference = null,
    idempotencyKey,
  } = entry;

  const normalizedAmount = toPositiveAmount(amount);
  if (!idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  const result = await client.query(
    `INSERT INTO ledger_entries
       (user_id, amount, direction, balance_type, type, reference, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, user_id, amount, direction, balance_type, type, reference, idempotency_key, created_at`,
    [
      userId,
      normalizedAmount,
      direction,
      balanceType,
      type ?? null,
      reference,
      idempotencyKey,
    ],
  );

  return {
    inserted: result.rowCount === 1,
    row: result.rows[0] ?? null,
  };
};

export const createDoubleEntry = async (client, params) => {
  const {
    amount,
    debitUserId = null,
    debitBalanceType,
    creditUserId = null,
    creditBalanceType,
    type,
    reference = null,
    idempotencyBase,
    debitType = type,
    creditType = type,
  } = params;

  if (!idempotencyBase) {
    throw new Error("idempotencyBase is required");
  }

  const normalizedAmount = toPositiveAmount(amount);

  const debit = await createLedgerEntry(client, {
    userId: debitUserId,
    amount: normalizedAmount,
    direction: DIRECTION.DEBIT,
    balanceType: debitBalanceType,
    type: debitType,
    reference,
    idempotencyKey: `${idempotencyBase}:debit`,
  });

  const credit = await createLedgerEntry(client, {
    userId: creditUserId,
    amount: normalizedAmount,
    direction: DIRECTION.CREDIT,
    balanceType: creditBalanceType,
    type: creditType,
    reference,
    idempotencyKey: `${idempotencyBase}:credit`,
  });

  if (debit.inserted !== credit.inserted) {
    throw new Error(
      "Ledger idempotency mismatch: one side inserted while the other did not",
    );
  }

  return {
    applied: debit.inserted && credit.inserted,
    debit: debit.row,
    credit: credit.row,
  };
};

export const syncWalletAvailableBalances = async (client, userIds) => {
  const ids = uniqueInts(userIds);
  if (ids.length === 0) {
    return;
  }

  await client.query(
    `
    INSERT INTO wallets (user_id, balance)
    SELECT x.user_id, 0
    FROM unnest($1::int[]) AS x(user_id)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [ids],
  );

  await client.query(
    `
    UPDATE wallets w
    SET balance = COALESCE(calc.available_balance, 0)
    FROM (
      SELECT x.user_id,
             COALESCE(SUM(
               CASE
                 WHEN le.direction = 'credit' THEN le.amount
                 WHEN le.direction = 'debit' THEN -le.amount
                 ELSE 0
               END
             ), 0) AS available_balance
      FROM unnest($1::int[]) AS x(user_id)
      LEFT JOIN ledger_entries le
        ON le.user_id = x.user_id
       AND le.balance_type = 'available'
      GROUP BY x.user_id
    ) calc
    WHERE w.user_id = calc.user_id
    `,
    [ids],
  );
};

export const getUserBalanceByType = async (
  client,
  userId,
  balanceType = BALANCE_TYPE.AVAILABLE,
) => {
  const result = await client.query(
    `
    SELECT COALESCE(
      SUM(
        CASE
          WHEN direction = 'credit' THEN amount
          WHEN direction = 'debit' THEN -amount
          ELSE 0
        END
      ),
      0
    ) AS balance
    FROM ledger_entries
    WHERE user_id = $1 AND balance_type = $2
    `,
    [userId, balanceType],
  );

  return Number(result.rows[0]?.balance ?? 0);
};

export const applyPaymentTransitionLedger = async (
  client,
  payment,
  nextStatus,
  options = {},
) => {
  if (!payment) {
    throw new Error("payment is required");
  }

  const fromStatus = payment.status;
  if (fromStatus === nextStatus) {
    return { applied: false, walletUserIds: [] };
  }

  const amount = toPositiveAmount(payment.amount);
  const reference = payment.provider_ref ?? `payment:${payment.id}`;
  const idempotencyPrefix =
    options.idempotencyPrefix ?? `payment:${payment.id}:${fromStatus}->${nextStatus}`;
  const companyUserRaw = options.companyUserId ?? payment.company_user_id;
  const companyUserId = Number(companyUserRaw);
  if (!Number.isInteger(companyUserId) || companyUserId <= 0) {
    throw new Error("Invalid company user id for payment ledger transition");
  }

  const studentUserRaw = options.studentUserId ?? payment.student_user_id;
  const parsedStudentUserId = Number(studentUserRaw);
  const hasExplicitStudentUserId =
    Number.isInteger(parsedStudentUserId) && parsedStudentUserId > 0;
  const studentUserId = hasExplicitStudentUserId ? parsedStudentUserId : null;
  const disputedFundsUserId =
    payment.escrow === true ? companyUserId : studentUserId;

  const ensureStudentRecipient = () => {
    if (options.requireStudentUserId && !hasExplicitStudentUserId) {
      throw new Error("Student user id is required for this transition");
    }
  };
  const ensureDisputedFundsOwner = () => {
    if (!Number.isInteger(disputedFundsUserId) || disputedFundsUserId <= 0) {
      throw new Error("Invalid disputed funds owner for payment ledger transition");
    }
  };
  const walletUserIds = [];

  const run = async (config) => {
    const result = await createDoubleEntry(client, {
      amount,
      reference,
      idempotencyBase: `${idempotencyPrefix}:${config.kind}`,
      type: config.type,
      debitType: config.debitType ?? config.type,
      creditType: config.creditType ?? config.type,
      debitUserId: config.debitUserId,
      debitBalanceType: config.debitBalanceType,
      creditUserId: config.creditUserId,
      creditBalanceType: config.creditBalanceType,
    });
    return result;
  };

  const applyPlatformFee = async (feePayerUserId) => {
    if (!Number.isInteger(feePayerUserId) || feePayerUserId <= 0) {
      return false;
    }

    const feePercent = getPlatformFeePercent();
    if (feePercent <= 0) {
      return false;
    }

    const feeAmount = roundToCurrency((amount * feePercent) / 100);
    if (feeAmount <= 0) {
      return false;
    }

    await createDoubleEntry(client, {
      amount: feeAmount,
      reference,
      idempotencyBase: `${idempotencyPrefix}:platform_fee`,
      type: "fee",
      debitUserId: feePayerUserId,
      debitBalanceType: BALANCE_TYPE.AVAILABLE,
      creditUserId: null,
      creditBalanceType: BALANCE_TYPE.PLATFORM,
    });

    return true;
  };

  let result = { applied: false };

  switch (`${fromStatus}->${nextStatus}`) {
    case "pending->paid":
      result = await run({
        kind: "escrow_hold",
        type: "escrow_hold",
        debitUserId: null,
        debitBalanceType: BALANCE_TYPE.PLATFORM,
        creditUserId: companyUserId,
        creditBalanceType: BALANCE_TYPE.ESCROW,
      });
      break;
    case "paid->released":
      ensureStudentRecipient();
      result = await run({
        kind: "release",
        type: "release",
        debitUserId: companyUserId,
        debitBalanceType: BALANCE_TYPE.ESCROW,
        creditUserId: studentUserId,
        creditBalanceType: BALANCE_TYPE.AVAILABLE,
      });
      await applyPlatformFee(studentUserId);
      walletUserIds.push(companyUserId, studentUserId);
      break;
    case "released->disputed":
      ensureStudentRecipient();
      result = await run({
        kind: "dispute_hold",
        type: "dispute_hold",
        debitUserId: studentUserId,
        debitBalanceType: BALANCE_TYPE.AVAILABLE,
        creditUserId: studentUserId,
        creditBalanceType: BALANCE_TYPE.LOCKED,
      });
      walletUserIds.push(studentUserId);
      break;
    case "paid->disputed":
      result = await run({
        kind: "dispute_hold",
        type: "dispute_hold",
        debitUserId: companyUserId,
        debitBalanceType: BALANCE_TYPE.ESCROW,
        creditUserId: companyUserId,
        creditBalanceType: BALANCE_TYPE.LOCKED,
      });
      break;
    case "disputed->released":
      ensureStudentRecipient();
      ensureDisputedFundsOwner();
      result = await run({
        kind: "dispute_release",
        type: "release",
        debitUserId: disputedFundsUserId,
        debitBalanceType: BALANCE_TYPE.LOCKED,
        creditUserId: studentUserId,
        creditBalanceType: BALANCE_TYPE.AVAILABLE,
      });
      await applyPlatformFee(studentUserId);
      walletUserIds.push(disputedFundsUserId, studentUserId);
      break;
    case "paid->refunded":
      result = await run({
        kind: "refund",
        type: "refund",
        debitUserId: companyUserId,
        debitBalanceType: BALANCE_TYPE.ESCROW,
        creditUserId: null,
        creditBalanceType: BALANCE_TYPE.PLATFORM,
      });
      break;
    case "released->refunded":
      ensureStudentRecipient();
      result = await run({
        kind: "refund",
        type: "refund",
        debitUserId: studentUserId,
        debitBalanceType: BALANCE_TYPE.AVAILABLE,
        creditUserId: null,
        creditBalanceType: BALANCE_TYPE.PLATFORM,
      });
      walletUserIds.push(studentUserId);
      break;
    case "disputed->refunded":
      ensureDisputedFundsOwner();
      result = await run({
        kind: "refund",
        type: "refund",
        debitUserId: disputedFundsUserId,
        debitBalanceType: BALANCE_TYPE.LOCKED,
        creditUserId: null,
        creditBalanceType: BALANCE_TYPE.PLATFORM,
      });
      break;
    default:
      return { applied: false, walletUserIds: [] };
  }

  if (walletUserIds.length > 0) {
    await syncWalletAvailableBalances(client, walletUserIds);
  }

  return { applied: result.applied, walletUserIds };
};

export const createWithdrawalHold = async (client, withdrawal) => {
  const amount = toPositiveAmount(withdrawal.amount);
  const userId = withdrawal.user_id;
  const result = await createDoubleEntry(client, {
    amount,
    type: "withdrawal_hold",
    reference: `withdrawal:${withdrawal.id}`,
    idempotencyBase: `withdrawal:${withdrawal.id}:hold`,
    debitUserId: userId,
    debitBalanceType: BALANCE_TYPE.AVAILABLE,
    creditUserId: userId,
    creditBalanceType: BALANCE_TYPE.LOCKED,
  });

  await syncWalletAvailableBalances(client, [userId]);
  return result;
};

export const releaseWithdrawalHold = async (client, withdrawal) => {
  const amount = toPositiveAmount(withdrawal.amount);
  const userId = withdrawal.user_id;
  const result = await createDoubleEntry(client, {
    amount,
    type: "withdrawal_release",
    reference: `withdrawal:${withdrawal.id}`,
    idempotencyBase: `withdrawal:${withdrawal.id}:release`,
    debitUserId: userId,
    debitBalanceType: BALANCE_TYPE.LOCKED,
    creditUserId: userId,
    creditBalanceType: BALANCE_TYPE.AVAILABLE,
  });

  await syncWalletAvailableBalances(client, [userId]);
  return result;
};

export const settleWithdrawal = async (client, withdrawal) => {
  const amount = toPositiveAmount(withdrawal.amount);
  return createDoubleEntry(client, {
    amount,
    type: "withdrawal",
    reference: `withdrawal:${withdrawal.id}`,
    idempotencyBase: `withdrawal:${withdrawal.id}:settle`,
    debitUserId: withdrawal.user_id,
    debitBalanceType: BALANCE_TYPE.LOCKED,
    creditUserId: null,
    creditBalanceType: BALANCE_TYPE.PLATFORM,
  });
};

export const BALANCE_TYPES = BALANCE_TYPE;
