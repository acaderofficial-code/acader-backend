import dotenv from "dotenv";
import crypto from "crypto";
import { Pool } from "pg";

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const url = "https://unenameled-deprecatingly-tasia.ngrok-free.dev/api/webhooks/paystack";

async function postEvent(reference, eventName, eventId) {
  const payload = JSON.stringify({
    id: eventId,
    event: eventName,
    data: {
      id: eventId,
      reference,
    },
  });

  const signature = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(payload)
    .digest("hex");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paystack-signature": signature,
    },
    body: payload,
  });

  const body = await res.text();
  const statusResult = await pool.query(
    "SELECT status, escrow FROM payments WHERE provider_ref = $1",
    [reference],
  );

  console.log(
    JSON.stringify({
      event: eventName,
      eventId,
      http: res.status,
      body,
      payment: statusResult.rows[0] ?? null,
    }),
  );
}

async function main() {
  const refResult = await pool.query(
    "SELECT provider_ref FROM payments WHERE provider_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  );
  const reference = refResult.rows[0]?.provider_ref;

  if (!reference) {
    throw new Error("No payment with provider_ref found");
  }

  console.log(`Using provider_ref: ${reference}`);

  const stamp = Date.now();
  await postEvent(reference, "charge.failed", `evt_charge_failed_${stamp}`);
  await postEvent(reference, "transfer.success", `evt_transfer_success_${stamp}`);
  await postEvent(reference, "transfer.failed", `evt_transfer_failed_${stamp}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
