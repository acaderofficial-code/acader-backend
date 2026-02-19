import cron from "node-cron";
import { generateDailySettlementReport } from "../services/settlement.service.js";

let settlementTask = null;
let started = false;

const getYesterdayDateString = () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().slice(0, 10);
};

const runSettlementForDate = async (source, reportDate) => {
  try {
    const result = await generateDailySettlementReport(reportDate);
    console.log("[settlement] report run complete", {
      source,
      reportDate: result.reportDate,
      inserted: result.inserted,
    });
  } catch (err) {
    console.error("[settlement] report run failed", {
      source,
      reportDate,
      error: err.message,
    });
  }
};

export const startSettlementJob = () => {
  if (started) {
    return settlementTask;
  }

  settlementTask = cron.schedule("5 2 * * *", async () => {
    const reportDate = getYesterdayDateString();
    await runSettlementForDate("cron-2:05am", reportDate);
  });

  started = true;
  console.log(
    "[settlement] scheduled daily settlement report generation at 02:05 server time",
  );

  if (process.env.SETTLEMENT_RUN_ON_STARTUP === "true") {
    const reportDate = getYesterdayDateString();
    runSettlementForDate("startup", reportDate).catch((err) => {
      console.error("[settlement] startup run failed", err.message);
    });
  }

  return settlementTask;
};
