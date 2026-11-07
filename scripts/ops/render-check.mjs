#!/usr/bin/env node
import { fail, loadEnv, runCheck, unset } from "./env.mjs";
// `pnpm render:check` (#28): READ-ONLY Render audit. Uses RENDER_API_KEY from the local .env
// (or the environment), issues GET requests only, never prints the key, and changes nothing.
// Reports the workspaces the key can see, every service and database with plan and region, and
// any drift from the owner-approved Waymark configuration (exit code 1 on drift).
import { classify } from "./render-drift.mjs";

const API = "https://api.render.com/v1";

await runCheck(async () => {
  const env = loadEnv();
  if (unset(env.RENDER_API_KEY)) fail("RENDER_API_KEY is not set in the local .env");
  const get = async (path) => {
    const out = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const url = `${API}${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${env.RENDER_API_KEY}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      }).catch((e) => fail(`network error: ${e.message}`));
      if (res.status === 401)
        fail("Render rejected the API key (401). Check it in Account Settings → API Keys.");
      if (!res.ok) fail(`Render API ${path} → HTTP ${res.status}`);
      const items = await res.json();
      out.push(...items);
      if (items.length < 100) break;
      cursor = items[items.length - 1]?.cursor;
    }
    return out;
  };

  const owners = await get("/owners");
  console.log(`✓ Render API key works (not printed). Workspaces visible to it: ${owners.length}`);
  for (const { owner } of owners) {
    console.log(
      `  - ${owner.name} (${owner.type}${owner.type === "user" ? `, 2FA ${owner.twoFactorAuthEnabled ? "on" : "OFF"}` : ""})`,
    );
  }
  if (owners.length > 1) {
    console.log(
      "  note: this key can see more than one workspace; a scoped key limited to one is safer.",
    );
  }

  const services = await get("/services?includePreviews=false");
  const postgres = await get("/postgres");
  const { rows, issues, estimatedUsd } = classify(services, postgres);
  console.log("\nResources:");
  for (const r of rows) {
    console.log(
      `  ${r.ours ? "*" : " "} ${String(r.kind).padEnd(12)} ${String(r.name).padEnd(24)} plan=${r.plan ?? "-"} region=${r.region ?? "-"} ${r.suspended === "suspended" ? "SUSPENDED" : ""}`,
    );
  }
  console.log("  (* = Waymark; others are listed for awareness only and are never touched)");
  console.log(`\nEstimated Waymark baseline: $${estimatedUsd.toFixed(2)}/month (approved: $13.30)`);
  if (issues.length) {
    console.log("\nDrift from the approved configuration:");
    for (const i of issues) console.log(`  ✗ ${i}`);
    process.exitCode = 1;
  } else {
    console.log("✓ Waymark resources match the approved configuration");
  }
  console.log(
    "Credit balance and invoices are not exposed by Render's API: check Billing in the dashboard.",
  );
});
