import cron from "node-cron";
import { runDailyReconciliation } from "../services/reconciliation.service.js";

let reconciliationTask = null;
let started = false;

const runScheduledReconciliation = async (source) => {
  const startedAt = new Date().toISOString();
  console.log(`[reconciliation] run started (${source}) at ${startedAt}`);
  try {
    const summary = await runDailyReconciliation();
    console.log("[reconciliation] run succeeded", { source, summary });
  } catch (err) {
    console.error("[reconciliation] run failed", {
      source,
      error: err.message,
    });
  }
};

export const startReconciliationJob = () => {
  if (started) {
    return reconciliationTask;
  }

  reconciliationTask = cron.schedule("0 2 * * *", async () => {
    await runScheduledReconciliation("cron-2am");
  });

  started = true;
  console.log(
    "[reconciliation] scheduled daily ledger-wallet reconciliation at 02:00 server time",
  );

  if (process.env.RECONCILIATION_RUN_ON_STARTUP === "true") {
    runScheduledReconciliation("startup").catch((err) => {
      console.error("[reconciliation] startup run failed", err.message);
    });
  }

  return reconciliationTask;
};
