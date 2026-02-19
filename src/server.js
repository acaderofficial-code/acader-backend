import dotenv from "dotenv";
dotenv.config(); // MUST be first

import app from "./app.js";
import { startReconciliationJob } from "./jobs/reconciliation.job.js";
import { startSettlementJob } from "./jobs/settlement.job.js";

const PORT = process.env.PORT || 5050;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 Acader backend running on http://${HOST}:${PORT}`);
  startReconciliationJob();
  startSettlementJob();
});
