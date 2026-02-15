import dotenv from "dotenv";
dotenv.config(); // MUST be first

import app from "./app.js";

const PORT = process.env.PORT || 5050;
const HOST = process.env.HOST || "0.0.0.0";
const paystackKey = process.env.PAYSTACK_SECRET_KEY || "";
const databaseUrl = process.env.DATABASE_URL || "";

const keyFingerprint = (() => {
  if (!paystackKey) return "MISSING";
  if (paystackKey.length <= 8) return `${paystackKey[0]}***${paystackKey.at(-1)}`;
  return `${paystackKey.slice(0, 4)}...${paystackKey.slice(-4)}`;
})();

const dbFingerprint = (() => {
  if (!databaseUrl) return "MISSING";
  try {
    const parsed = new URL(databaseUrl);
    const dbName = parsed.pathname.replace(/^\//, "") || "(none)";
    return `${parsed.hostname}:${parsed.port || "5432"}/${dbName}`;
  } catch {
    return "INVALID_URL";
  }
})();

app.listen(PORT, HOST, () => {
  console.log(`🚀 Acader backend running on http://${HOST}:${PORT}`);
  console.log(`[startup] PAYSTACK_SECRET_KEY fingerprint: ${keyFingerprint}`);
  console.log(`[startup] DATABASE_URL target: ${dbFingerprint}`);
});
