import pool from "../config/db.js";
import { refreshRiskProfilesForUsers } from "./fraud/risk_profile.js";

const DIRECTION = {
  CREDIT: "credit",
  DEBIT: "debit",
};

const BALANCE_TYPE = {
  AVAILABLE: "available",
  ESCROW: "escrow",
  LOCKED: "locked",
  PLATFORM: "platform",
  REVENUE: "revenue",
  PAYOUT: "payout",
};

const REFUND_TYPE = {
  ESCROW: "escrow_refund",
  RELEASED: "released_refund",
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

const getAcaderSystemUserId = () => {
  const parsed = Number(process.env.ACADER_SYSTEM_USER_ID);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("ACADER_SYSTEM_USER_ID must be a positive integer");
  }
  return parsed;
};

const uniqueInts = (values) =>
  [...new Set(values.filter((v) => Number.isInteger(v) && v > 0))];

const computeReleaseSplitAmounts = (grossAmount) => {
  const feePercent = getPlatformFeePercent();
  if (feePercent <= 0) {
    throw new Error("PLATFORM_FEE_PERCENT must be greater than 0 for release");
  }

  const feeAmount = roundToCurrency((grossAmount * feePercent) / 100);
  if (feeAmount <= 0) {
    throw new Error("Computed platform fee must be greater than 0");
  }
  if (feeAmount >= grossAmount) {
    throw new Error("Computed platform fee must be less than gross amount");
  }

  const studentNetAmount = roundToCurrency(grossAmount - feeAmount);
  if (studentNetAmount <= 0) {
    throw new Error("Computed student net amount must be greater than 0");
  }

  const delta = roundToCurrency(grossAmount - (studentNetAmount + feeAmount));
  if (Math.abs(delta) > 0.000001) {
    throw new Error("Release split invariant failed: gross != net + fee");
  }

  return {
    feeAmount,
    studentNetAmount,
  };
};

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
    INSERT INTO wallets (user_id, balance, available_balance, escrow_balance)
    SELECT x.user_id, 0, 0, 0
    FROM unnest($1::int[]) AS x(user_id)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [ids],
  );

  await client.query(
    `
    UPDATE wallets w
    SET balance = COALESCE(calc.available_balance, 0),
        available_balance = COALESCE(calc.available_balance, 0),
        escrow_balance = COALESCE(calc.escrow_balance, 0)
    FROM (
      SELECT x.user_id,
             COALESCE(SUM(
               CASE
                 WHEN le.balance_type = 'available' AND le.direction = 'credit' THEN le.amount
                 WHEN le.balance_type = 'available' AND le.direction = 'debit' THEN -le.amount
                 ELSE 0
               END
             ), 0) AS available_balance,
             COALESCE(SUM(
               CASE
                 WHEN le.balance_type = 'escrow' AND le.direction = 'credit' THEN le.amount
                 WHEN le.balance_type = 'escrow' AND le.direction = 'debit' THEN -le.amount
                 ELSE 0
               END
             ), 0) AS escrow_balance
      FROM unnest($1::int[]) AS x(user_id)
      LEFT JOIN ledger_entries le
        ON le.user_id = x.user_id
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

export const applyPaymentRefundLedger = async (
  client,
  payment,
  options = {},
) => {
  if (!payment) {
    throw new Error("payment is required");
  }

  const fromStatus = payment.status;
  if (!["paid", "released"].includes(fromStatus)) {
    throw new Error("Refund is only supported for paid or released payments");
  }

  const amount = toPositiveAmount(payment.amount);
  const reference = payment.provider_ref ?? `payment:${payment.id}`;
  const idempotencyPrefix =
    options.idempotencyPrefix ?? `payment:${payment.id}:${fromStatus}->refunded`;

  const companyUserRaw = options.companyUserId ?? payment.company_user_id;
  const companyUserId = Number(companyUserRaw);
  if (!Number.isInteger(companyUserId) || companyUserId <= 0) {
    throw new Error("Invalid company user id for payment refund");
  }

  if (fromStatus === "paid") {
    const result = await createDoubleEntry(client, {
      amount,
      reference,
      idempotencyBase: `${idempotencyPrefix}:escrow_refund`,
      type: "refund_escrow",
      debitUserId: companyUserId,
      debitBalanceType: BALANCE_TYPE.ESCROW,
      creditUserId: companyUserId,
      creditBalanceType: BALANCE_TYPE.AVAILABLE,
    });
    const walletUserIds = [companyUserId];
    await refreshRiskProfilesForUsers(walletUserIds, { client });

    return {
      applied: result.applied,
      refundType: REFUND_TYPE.ESCROW,
      walletUserIds,
    };
  }

  const studentUserRaw = options.studentUserId ?? payment.student_user_id;
  const studentUserId = Number(studentUserRaw);
  if (!Number.isInteger(studentUserId) || studentUserId <= 0) {
    throw new Error("Invalid student user id for released refund");
  }

  const revenueResult = await client.query(
    `
    SELECT
      user_id,
      COALESCE(SUM(
        CASE
          WHEN direction = 'credit' THEN amount
          WHEN direction = 'debit' THEN -amount
          ELSE 0
        END
      ), 0) AS revenue_balance
    FROM ledger_entries
    WHERE reference = $1
      AND balance_type = 'revenue'
    GROUP BY user_id
    ORDER BY revenue_balance DESC
    LIMIT 1
    `,
    [reference],
  );

  const revenueUserId = Number(revenueResult.rows[0]?.user_id);
  const revenueBalance = Number(revenueResult.rows[0]?.revenue_balance ?? 0);
  const revenueDebitAmount = roundToCurrency(
    Math.min(amount, Math.max(revenueBalance, 0)),
  );
  const studentDebitAmount = roundToCurrency(amount - revenueDebitAmount);

  if (studentDebitAmount < 0 || revenueDebitAmount < 0) {
    throw new Error("Invalid released refund split");
  }

  const debitTotal = roundToCurrency(studentDebitAmount + revenueDebitAmount);
  if (Math.abs(debitTotal - amount) > 0.000001) {
    throw new Error("Released refund invariant failed: debit != credit");
  }

  const studentAvailableBalance = await getUserBalanceByType(
    client,
    studentUserId,
    BALANCE_TYPE.AVAILABLE,
  );

  if (studentAvailableBalance + 0.000001 < studentDebitAmount) {
    throw new Error("Insufficient student available balance for released refund");
  }

  const entries = [];

  if (studentDebitAmount > 0) {
    entries.push(
      await createLedgerEntry(client, {
        userId: studentUserId,
        amount: studentDebitAmount,
        direction: DIRECTION.DEBIT,
        balanceType: BALANCE_TYPE.AVAILABLE,
        type: "refund_reversal",
        reference,
        idempotencyKey: `${idempotencyPrefix}:refund_reversal:student_debit`,
      }),
    );
  }

  if (revenueDebitAmount > 0) {
    if (!Number.isInteger(revenueUserId) || revenueUserId <= 0) {
      throw new Error("Missing platform revenue owner for released refund");
    }

    entries.push(
      await createLedgerEntry(client, {
        userId: revenueUserId,
        amount: revenueDebitAmount,
        direction: DIRECTION.DEBIT,
        balanceType: BALANCE_TYPE.REVENUE,
        type: "refund_released",
        reference,
        idempotencyKey: `${idempotencyPrefix}:refund_released:revenue_debit`,
      }),
    );
  }

  entries.push(
    await createLedgerEntry(client, {
      userId: companyUserId,
      amount,
      direction: DIRECTION.CREDIT,
      balanceType: BALANCE_TYPE.AVAILABLE,
      type: "refund_released",
      reference,
      idempotencyKey: `${idempotencyPrefix}:refund_released:company_credit`,
    }),
  );

  const insertStates = [...new Set(entries.map((entry) => entry.inserted))];
  if (insertStates.length > 1) {
    throw new Error(
      "Ledger idempotency mismatch: released refund insert states are inconsistent",
    );
  }

  const walletUserIds = [companyUserId, studentUserId];
  await refreshRiskProfilesForUsers(walletUserIds, { client });

  return {
    applied: insertStates[0] ?? false,
    refundType: REFUND_TYPE.RELEASED,
    walletUserIds,
  };
};

export const applyPaymentPartialRefundLedger = async (
  client,
  payment,
  options = {},
) => {
  if (!payment) {
    throw new Error("payment is required");
  }

  if (payment.status !== "released") {
    throw new Error("Partial refund is only supported for released payments");
  }

  const partialAmount = toPositiveAmount(options.partialAmount);
  const totalAmount = toPositiveAmount(payment.amount);
  if (partialAmount >= totalAmount) {
    throw new Error("Partial refund amount must be less than payment amount");
  }

  const companyUserRaw = options.companyUserId ?? payment.company_user_id;
  const companyUserId = Number(companyUserRaw);
  if (!Number.isInteger(companyUserId) || companyUserId <= 0) {
    throw new Error("Invalid company user id for partial refund");
  }

  const studentUserRaw = options.studentUserId ?? payment.student_user_id;
  const studentUserId = Number(studentUserRaw);
  if (!Number.isInteger(studentUserId) || studentUserId <= 0) {
    throw new Error("Invalid student user id for partial refund");
  }

  const studentAvailableBalance = await getUserBalanceByType(
    client,
    studentUserId,
    BALANCE_TYPE.AVAILABLE,
  );

  if (studentAvailableBalance + 0.000001 < partialAmount) {
    throw new Error("Insufficient student available balance for partial refund");
  }

  const reference = payment.provider_ref ?? `payment:${payment.id}`;
  const idempotencyPrefix =
    options.idempotencyPrefix ??
    `payment:${payment.id}:${payment.status}->partial_refund:${partialAmount}`;

  const result = await createDoubleEntry(client, {
    amount: partialAmount,
    reference,
    idempotencyBase: `${idempotencyPrefix}:partial_refund`,
    type: "partial_refund",
    debitUserId: studentUserId,
    debitBalanceType: BALANCE_TYPE.AVAILABLE,
    creditUserId: companyUserId,
    creditBalanceType: BALANCE_TYPE.AVAILABLE,
  });

  const walletUserIds = [companyUserId, studentUserId];
  await refreshRiskProfilesForUsers(walletUserIds, { client });

  return {
    applied: result.applied,
    refundType: "partial_refund",
    refundedAmount: partialAmount,
    walletUserIds,
  };
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

  const ensureStudentRecipient = (required = false) => {
    if ((required || options.requireStudentUserId) && !hasExplicitStudentUserId) {
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

  const applyReleaseWithPlatformFee = async ({
    kind,
    debitUserId,
    debitBalanceType,
    studentUserId: creditStudentUserId,
  }) => {
    if (!Number.isInteger(debitUserId) || debitUserId <= 0) {
      throw new Error("Invalid debit user id for release transition");
    }
    if (!Number.isInteger(creditStudentUserId) || creditStudentUserId <= 0) {
      throw new Error("Invalid student user id for release transition");
    }

    const { feeAmount, studentNetAmount } = computeReleaseSplitAmounts(amount);
    const revenueUserId = getAcaderSystemUserId();
    const releaseBase = `${idempotencyPrefix}:${kind}`;

    const escrowDebit = await createLedgerEntry(client, {
      userId: debitUserId,
      amount,
      direction: DIRECTION.DEBIT,
      balanceType: debitBalanceType,
      type: "release",
      reference,
      idempotencyKey: `${releaseBase}:escrow_debit`,
    });

    const studentCredit = await createLedgerEntry(client, {
      userId: creditStudentUserId,
      amount: studentNetAmount,
      direction: DIRECTION.CREDIT,
      balanceType: BALANCE_TYPE.AVAILABLE,
      type: "release",
      reference,
      idempotencyKey: `${releaseBase}:student_credit`,
    });

    const revenueCredit = await createLedgerEntry(client, {
      userId: revenueUserId,
      amount: feeAmount,
      direction: DIRECTION.CREDIT,
      balanceType: BALANCE_TYPE.REVENUE,
      type: "platform_fee",
      reference,
      idempotencyKey: `${releaseBase}:platform_fee_credit`,
    });

    if (
      escrowDebit.inserted !== studentCredit.inserted ||
      escrowDebit.inserted !== revenueCredit.inserted
    ) {
      throw new Error(
        "Ledger idempotency mismatch: release split insert states are inconsistent",
      );
    }

    return {
      applied: escrowDebit.inserted,
      escrowDebit: escrowDebit.row,
      studentCredit: studentCredit.row,
      revenueCredit: revenueCredit.row,
      feeAmount,
      studentNetAmount,
    };
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
      walletUserIds.push(companyUserId);
      break;
    case "paid->released":
      ensureStudentRecipient(true);
      result = await applyReleaseWithPlatformFee({
        kind: "release",
        debitUserId: companyUserId,
        debitBalanceType: BALANCE_TYPE.ESCROW,
        studentUserId,
      });
      walletUserIds.push(companyUserId, studentUserId);
      break;
    case "released->disputed":
      ensureStudentRecipient(true);
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
      walletUserIds.push(companyUserId);
      break;
    case "disputed->released":
      ensureStudentRecipient(true);
      ensureDisputedFundsOwner();
      result = await applyReleaseWithPlatformFee({
        kind: "dispute_release",
        debitUserId: disputedFundsUserId,
        debitBalanceType: BALANCE_TYPE.LOCKED,
        studentUserId,
      });
      walletUserIds.push(disputedFundsUserId, studentUserId);
      break;
    case "paid->refunded":
      result = await applyPaymentRefundLedger(client, payment, {
        idempotencyPrefix,
        companyUserId,
        studentUserId,
      });
      walletUserIds.push(...(result.walletUserIds ?? []));
      break;
    case "released->refunded":
      result = await applyPaymentRefundLedger(client, payment, {
        idempotencyPrefix,
        companyUserId,
        studentUserId,
      });
      walletUserIds.push(...(result.walletUserIds ?? []));
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
    await refreshRiskProfilesForUsers(walletUserIds, { client });
  }

  return { applied: result.applied, walletUserIds };
};

export const createWithdrawalHold = async (client, withdrawal) => {
  const amount = toPositiveAmount(withdrawal.amount);
  const userId = withdrawal.user_id;
  const reference = `withdrawal_${withdrawal.id}`;
  const result = await createDoubleEntry(client, {
    amount,
    type: "withdrawal_hold",
    reference,
    idempotencyBase: `withdrawal:${withdrawal.id}:hold`,
    debitUserId: userId,
    debitBalanceType: BALANCE_TYPE.AVAILABLE,
    creditUserId: userId,
    creditBalanceType: BALANCE_TYPE.LOCKED,
  });

  await syncWalletAvailableBalances(client, [userId]);
  await refreshRiskProfilesForUsers([userId], { client });
  return result;
};

export const releaseWithdrawalHold = async (
  client,
  withdrawal,
  options = {},
) => {
  const {
    reversalType = "withdrawal_reversal",
    idempotencySuffix = "reverse",
  } = options;
  const amount = toPositiveAmount(withdrawal.amount);
  const userId = withdrawal.user_id;
  const reference = `withdrawal_${withdrawal.id}`;
  const result = await createDoubleEntry(client, {
    amount,
    type: reversalType,
    reference,
    idempotencyBase: `withdrawal:${withdrawal.id}:${idempotencySuffix}`,
    debitUserId: userId,
    debitBalanceType: BALANCE_TYPE.LOCKED,
    creditUserId: userId,
    creditBalanceType: BALANCE_TYPE.AVAILABLE,
  });

  await syncWalletAvailableBalances(client, [userId]);
  await refreshRiskProfilesForUsers([userId], { client });
  return result;
};

export const settleWithdrawal = async (client, withdrawal) => {
  const amount = toPositiveAmount(withdrawal.amount);
  const result = await createDoubleEntry(client, {
    amount,
    type: "withdrawal_complete",
    reference: `withdrawal_${withdrawal.id}`,
    idempotencyBase: `withdrawal:${withdrawal.id}:complete`,
    debitUserId: withdrawal.user_id,
    debitBalanceType: BALANCE_TYPE.LOCKED,
    creditUserId: withdrawal.user_id,
    creditBalanceType: BALANCE_TYPE.PAYOUT,
  });
  await refreshRiskProfilesForUsers([withdrawal.user_id], { client });
  return result;
};

export const BALANCE_TYPES = BALANCE_TYPE;
export const REFUND_TYPES = REFUND_TYPE;
