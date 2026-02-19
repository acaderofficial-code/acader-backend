import pool from "../config/db.js";

const normalizeReportDate = (value) => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid reportDate. Use YYYY-MM-DD.");
  }

  return date.toISOString().slice(0, 10);
};

export const generateDailySettlementReport = async (reportDateInput) => {
  const reportDate = normalizeReportDate(reportDateInput);

  const ledgerAgg = await pool.query(
    `
    SELECT
      COALESCE(SUM(
        CASE
          WHEN direction = 'credit'
           AND balance_type = 'escrow'
           AND type IN ('deposit', 'escrow_hold')
          THEN amount
          ELSE 0
        END
      ), 0)::numeric(14,2) AS escrow_inflow,
      COALESCE(SUM(
        CASE
          WHEN direction = 'credit'
           AND balance_type = 'available'
           AND type = 'release'
          THEN amount
          ELSE 0
        END
      ), 0)::numeric(14,2) AS released_to_students,
      COALESCE(SUM(
        CASE
          WHEN direction = 'credit'
           AND balance_type = 'available'
           AND type IN ('refund', 'refund_escrow', 'refund_released')
          THEN amount
          ELSE 0
        END
      ), 0)::numeric(14,2) AS refunded_to_companies,
      COALESCE(SUM(
        CASE
          WHEN direction = 'debit'
           AND balance_type = 'available'
           AND type IN ('withdrawal', 'withdrawal_hold')
          THEN amount
          ELSE 0
        END
      ), 0)::numeric(14,2) AS withdrawals,
      COALESCE(SUM(
        CASE
          WHEN direction = 'credit'
           AND type = 'platform_fee'
          THEN amount
          ELSE 0
        END
      ), 0)::numeric(14,2) AS platform_fees
    FROM ledger_entries
    WHERE created_at >= $1::date
      AND created_at < ($1::date + INTERVAL '1 day')
    `,
    [reportDate],
  );

  const totals = await pool.query(
    `
    SELECT
      COALESCE(SUM(available_balance), 0)::numeric(14,2) AS system_available_total,
      COALESCE(SUM(escrow_balance), 0)::numeric(14,2) AS system_escrow_total
    FROM wallets
    `,
  );

  const aggregates = ledgerAgg.rows[0];
  const systemTotals = totals.rows[0];

  const insertResult = await pool.query(
    `
    INSERT INTO settlement_reports (
      report_date,
      escrow_inflow,
      released_to_students,
      refunded_to_companies,
      withdrawals,
      platform_fees,
      system_available_total,
      system_escrow_total
    )
    VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (report_date) DO NOTHING
    RETURNING *
    `,
    [
      reportDate,
      aggregates.escrow_inflow,
      aggregates.released_to_students,
      aggregates.refunded_to_companies,
      aggregates.withdrawals,
      aggregates.platform_fees,
      systemTotals.system_available_total,
      systemTotals.system_escrow_total,
    ],
  );

  let inserted = insertResult.rowCount === 1;
  let report = insertResult.rows[0] ?? null;

  if (!report) {
    const existing = await pool.query(
      "SELECT * FROM settlement_reports WHERE report_date = $1::date",
      [reportDate],
    );
    report = existing.rows[0] ?? null;
    inserted = false;
  }

  console.log(`📊 Daily Settlement Report Generated for: ${reportDate}`);

  return {
    inserted,
    reportDate,
    report,
  };
};
