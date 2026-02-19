const BASE_URL = process.env.SMOKE_BASE_URL || "http://localhost:5050";
const ADMIN_BEARER_TOKEN = process.env.ADMIN_BEARER_TOKEN || "";

const ENDPOINTS = [
  { method: "GET", path: "/api/admin/stats" },
  { method: "GET", path: "/api/admin/fraud/reviews?status=PENDING" },
  { method: "GET", path: "/api/admin/fraud/reviews?status=ALL" },
  { method: "GET", path: "/api/admin/audit/risk/1?limit=5&offset=0" },
  { method: "GET", path: "/api/admin/audit/financial/verify" },
  { method: "GET", path: "/api/admin/audit/financial/events?limit=5&offset=0" },
  {
    method: "GET",
    path: "/api/admin/reports/reconciliation/logs?limit=5&offset=0",
  },
  {
    method: "GET",
    path: "/api/admin/reports/reconciliation/flags?resolved=all&limit=5&offset=0",
  },
  {
    method: "PATCH",
    path: "/api/admin/reports/reconciliation/flags/not-a-uuid/resolve",
  },
  { method: "GET", path: "/api/admin/reports/settlements?limit=5&offset=0" },
];

async function requestEndpoint({ method, path }, headers) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, { method, headers });
  } catch (err) {
    return {
      method,
      path,
      error: err.message || String(err),
    };
  }

  const raw = await res.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }

  return {
    method,
    path,
    status: res.status,
    body,
  };
}

async function runSuite(name, headers) {
  const results = [];
  for (const endpoint of ENDPOINTS) {
    const result = await requestEndpoint(endpoint, headers);
    results.push(result);
  }

  return { name, results };
}

async function main() {
  console.log(`[smoke] base_url=${BASE_URL}`);
  const suites = [];

  suites.push(await runSuite("no_auth", {}));
  suites.push(
    await runSuite("invalid_token", { Authorization: "Bearer invalid.token.value" }),
  );

  if (ADMIN_BEARER_TOKEN) {
    suites.push(
      await runSuite("admin_token", {
        Authorization: `Bearer ${ADMIN_BEARER_TOKEN}`,
      }),
    );
  } else {
    console.log(
      "[smoke] ADMIN_BEARER_TOKEN not set; skipping admin_token suite.",
    );
  }

  for (const suite of suites) {
    console.log(`\n=== ${suite.name} ===`);
    for (const item of suite.results) {
      if (item.error) {
        console.log(`${item.method} ${item.path}`);
        console.log(`ERROR: ${item.error}`);
        continue;
      }
      console.log(`${item.method} ${item.path}`);
      console.log(`STATUS: ${item.status}`);
      console.log(`BODY: ${JSON.stringify(item.body)}`);
    }
  }
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
