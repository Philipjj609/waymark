// Pure classification for `pnpm render:check` (#28). No I/O: takes the API's resource lists and
// returns what matches the owner-approved configuration (7 Nov 2026) and what doesn't.

/** Owner-approved Waymark resources (the ONLY authorized billable configuration). */
export const APPROVED = Object.freeze({
  web: { name: "waymark-web", plans: ["0.5c-512mb", "starter"], region: "frankfurt", usd: 7 },
  db: {
    name: "waymark-db",
    plans: ["0.1c-256mb", "basic_256mb"],
    region: "frankfurt",
    version: "17",
    diskSizeGB: 1,
    usd: 6,
    storageUsdPerGb: 0.3,
  },
});

/**
 * @param {Array<{service: any}>} services  GET /v1/services items
 * @param {Array<{postgres: any}>} postgres GET /v1/postgres items
 */
export function classify(services, postgres) {
  const issues = [];
  const rows = [];
  let estimatedUsd = 0;

  for (const { service: s } of services) {
    const d = s.serviceDetails ?? {};
    const ours = s.name === APPROVED.web.name;
    rows.push({
      kind: s.type,
      name: s.name,
      plan: d.plan,
      region: d.region,
      suspended: s.suspended,
      ours,
    });
    if (!ours) continue;
    if (s.type !== "web_service") issues.push(`${s.name}: type ${s.type}, expected web_service`);
    if (!APPROVED.web.plans.includes(d.plan))
      issues.push(`${s.name}: plan ${d.plan} is not approved`);
    if (d.region !== APPROVED.web.region) issues.push(`${s.name}: region ${d.region}`);
    if ((d.numInstances ?? 1) > 1)
      issues.push(`${s.name}: ${d.numInstances} instances (1 approved)`);
    if (d.autoscaling?.enabled) issues.push(`${s.name}: autoscaling enabled (not approved)`);
    if (s.autoDeployTrigger && s.autoDeployTrigger !== "off")
      issues.push(`${s.name}: autoDeployTrigger ${s.autoDeployTrigger} (expected off)`);
    if (s.suspended !== "suspended") estimatedUsd += APPROVED.web.usd;
  }

  for (const { postgres: p } of postgres) {
    const ours = p.name === APPROVED.db.name;
    rows.push({
      kind: "postgres",
      name: p.name,
      plan: p.plan,
      region: p.region,
      suspended: p.suspended,
      ours,
    });
    if (!ours) continue;
    if (!APPROVED.db.plans.includes(p.plan))
      issues.push(`${p.name}: plan ${p.plan} is not approved`);
    if (p.region !== APPROVED.db.region) issues.push(`${p.name}: region ${p.region}`);
    if (String(p.version) !== APPROVED.db.version) issues.push(`${p.name}: version ${p.version}`);
    if (p.diskSizeGB !== undefined && p.diskSizeGB > APPROVED.db.diskSizeGB)
      issues.push(`${p.name}: disk ${p.diskSizeGB} GB (1 GB approved)`);
    if (p.diskAutoscalingEnabled)
      issues.push(`${p.name}: disk autoscaling ON (could grow storage cost)`);
    if (p.highAvailabilityEnabled) issues.push(`${p.name}: high availability ON (not approved)`);
    if ((p.readReplicas ?? []).length)
      issues.push(`${p.name}: ${p.readReplicas.length} read replica(s)`);
    if ((p.ipAllowList ?? []).length) issues.push(`${p.name}: external IP allow list is not empty`);
    if (p.suspended !== "suspended")
      estimatedUsd +=
        APPROVED.db.usd + (p.diskSizeGB ?? APPROVED.db.diskSizeGB) * APPROVED.db.storageUsdPerGb;
  }

  const ourNames = new Set([APPROVED.web.name, APPROVED.db.name]);
  for (const name of ourNames) {
    if (!rows.some((r) => r.name === name))
      issues.push(`${name}: not found (not provisioned yet?)`);
  }
  const dupes = rows.filter((r) => r.ours).map((r) => r.name);
  for (const name of ourNames) {
    if (dupes.filter((n) => n === name).length > 1)
      issues.push(`${name}: more than one resource with this name`);
  }
  return { rows, issues, estimatedUsd: Math.round(estimatedUsd * 100) / 100 };
}
