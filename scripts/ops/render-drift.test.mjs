import { describe, expect, it } from "vitest";
import { classify } from "./render-drift.mjs";

const web = (over = {}) => ({
  service: {
    name: "waymark-web",
    type: "web_service",
    suspended: "not_suspended",
    autoDeployTrigger: "off",
    serviceDetails: { plan: "starter", region: "frankfurt", numInstances: 1 },
    ...over,
  },
});
const db = (over = {}) => ({
  postgres: {
    name: "waymark-db",
    plan: "0.1c-256mb",
    region: "frankfurt",
    version: "17",
    diskSizeGB: 1,
    diskAutoscalingEnabled: false,
    highAvailabilityEnabled: false,
    readReplicas: [],
    ipAllowList: [],
    suspended: "not_suspended",
    ...over,
  },
});

describe("render:check drift classification (owner-approved config, 7 Nov)", () => {
  it("the approved pair is clean and costs $13.30", () => {
    const r = classify([web()], [db()]);
    expect(r.issues).toEqual([]);
    expect(r.estimatedUsd).toBe(13.3);
  });

  it("flags plan upgrades, storage growth, autoscaling, HA, replicas, region and auto-deploy", () => {
    const r = classify(
      [
        web({
          autoDeployTrigger: "commit",
          serviceDetails: { plan: "standard", region: "oregon", numInstances: 2 },
        }),
      ],
      [
        db({
          plan: "1c-2g",
          diskSizeGB: 15,
          diskAutoscalingEnabled: true,
          highAvailabilityEnabled: true,
          readReplicas: [{ id: "x" }],
        }),
      ],
    );
    const text = r.issues.join("\n");
    for (const s of [
      "plan standard",
      "region oregon",
      "2 instances",
      "autoDeployTrigger commit",
      "plan 1c-2g",
      "disk 15 GB",
      "autoscaling ON",
      "high availability",
      "read replica",
    ])
      expect(text).toContain(s);
  });

  it("reports missing resources and ignores (but lists) other projects' resources", () => {
    const other = {
      service: {
        name: "someone-else",
        type: "web_service",
        suspended: "not_suspended",
        serviceDetails: { plan: "pro", region: "oregon" },
      },
    };
    const r = classify([other], []);
    expect(r.issues).toEqual([
      "waymark-web: not found (not provisioned yet?)",
      "waymark-db: not found (not provisioned yet?)",
    ]);
    expect(r.rows.find((x) => x.name === "someone-else")?.ours).toBe(false);
    expect(r.estimatedUsd).toBe(0);
  });

  it("suspended resources do not count toward the monthly estimate", () => {
    expect(
      classify([web({ suspended: "suspended" })], [db({ suspended: "suspended" })]).estimatedUsd,
    ).toBe(0);
  });
});
