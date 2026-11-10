import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { ProviderOperationId } from "@fle/contracts";
import { PayPalSandboxClient, SandboxCheckout } from "@fle/payments";
import {
  CheckoutService,
  createGuestWorld,
  newProviderCommandId,
  type SessionHash,
  submitPlayerCommand,
} from "@fle/server";
import { PERSON, PHONE, replay } from "@fle/simulation";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  connectPostgres,
  type Db,
  migrate,
  PgCheckoutQueue,
  PgOperationStore,
  PgWorldStore,
  schema,
} from "../src/index.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const OWNER = "a".repeat(64) as SessionHash;
const FOREIGN = "b".repeat(64) as SessionHash;
const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stateful provider stand-in: raw Orders-v2 responses, not application settlement decisions. */
class Provider {
  readonly tag = randomBytes(4).toString("hex").toUpperCase();
  orders = new Map<
    string,
    { id: string; status: string; purchase_units: Array<Record<string, unknown>>; links: unknown[] }
  >();
  keys = new Map<string, string>();
  creates = 0;
  captures = 0;
  reads = 0;
  loseCapture = false;
  failReads = 0;
  captureBarrier: (() => Promise<void>) | null = null;
  fetch: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/oauth2/token"))
      return response(200, { access_token: "fixture-token", expires_in: 3600 });
    if (path === "/v2/checkout/orders" && init?.method === "POST") {
      this.creates++;
      const key = new Headers(init.headers).get("paypal-request-id") ?? "";
      const existing = this.keys.get(key);
      if (existing) return response(200, this.orders.get(existing));
      const body = JSON.parse(String(init.body));
      const id = `ORDER${this.tag}${String(this.orders.size + 1).padStart(8, "0")}`;
      const order = {
        id,
        status: "CREATED",
        purchase_units: body.purchase_units,
        links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
      };
      this.orders.set(id, order);
      this.keys.set(key, id);
      return response(201, order);
    }
    const id = path.split("/")[4] ?? "";
    const order = this.orders.get(id);
    if (!order) return response(404, { name: "RESOURCE_NOT_FOUND" });
    if (path.endsWith("/capture")) {
      if (this.captureBarrier) await this.captureBarrier();
      if (order.status !== "APPROVED")
        return response(422, { details: [{ issue: "ORDER_NOT_APPROVED" }] });
      this.captures++;
      order.status = "COMPLETED";
      const unit = order.purchase_units[0];
      if (unit)
        unit.payments = {
          captures: [{ id: `CAP${id}`, status: "COMPLETED", amount: unit.amount }],
        };
      if (this.loseCapture) {
        this.loseCapture = false;
        throw new TypeError("lost provider response");
      }
      return response(201, order);
    }
    this.reads++;
    if (this.failReads > 0) {
      this.failReads--;
      throw new TypeError("read unavailable");
    }
    return response(200, order);
  };
}

for (const mode of ["PGlite", "PostgreSQL"] as const) {
  describe.skipIf(mode === "PostgreSQL" && !process.env.TEST_DATABASE_URL)(
    `durable checkout on ${mode}`,
    () => {
      let db: Db;
      let close: () => Promise<void>;
      beforeAll(async () => {
        if (mode === "PGlite") {
          const client = new PGlite();
          db = drizzle(client);
          close = () => client.close();
        } else {
          const name = `waymark_checkout_${randomBytes(6).toString("hex")}`;
          const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
          await admin.connect();
          await admin.query(`CREATE DATABASE ${name}`);
          await admin.end();
          const url = new URL(process.env.TEST_DATABASE_URL as string);
          url.pathname = `/${name}`;
          const connection = connectPostgres(url.toString());
          db = connection.db;
          close = async () => {
            await connection.pool.end();
            const cleanup = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
            await cleanup.connect();
            await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
            await cleanup.end();
          };
        }
        await migrate(db);
      });
      afterAll(async () => close?.());

      async function setup() {
        const worlds = new PgWorldStore(db);
        const queue = new PgCheckoutQueue(db);
        const operations = new PgOperationStore(db);
        const provider = new Provider();
        const client = new PayPalSandboxClient({
          clientId: "fixture-id",
          clientSecret: "fixture-secret",
          fetch: provider.fetch,
          maxAttempts: 1,
          allowedReturnOrigins: ["http://localhost:3000"],
        });
        const checkout = new SandboxCheckout(client, operations);
        const service = new CheckoutService(
          worlds,
          queue,
          checkout,
          client,
          "http://localhost:3000",
        );
        const created = await createGuestWorld(worlds, OWNER);
        const world = created.worldId;
        const player = async (kind: string, payload: unknown, id: string = randomUUID()) => {
          const state = await worlds.load(world, OWNER);
          return submitPlayerCommand(worlds, OWNER, {
            schemaVersion: "sim.command.v1",
            commandId: id,
            worldId: world,
            expectedWorldVersion: state?.version,
            kind,
            payload,
          });
        };
        await player("ADVANCE_TIME", { targetDay: 8 });
        const begin = await player("START_PROVIDER_CHECKOUT", { obligationId: PHONE });
        expect(begin.ok && begin.result.status).toBe("ACCEPTED");
        const state = await worlds.load(world, OWNER);
        const op = state?.reservations[PHONE]?.operationId as ProviderOperationId;
        return {
          worlds,
          queue,
          operations,
          provider,
          client,
          checkout,
          service,
          world,
          op,
          player,
        };
      }

      async function assertPaid(t: Awaited<ReturnType<typeof setup>>) {
        const state = await new PgWorldStore(db).load(t.world, OWNER);
        expect(state?.obligations[PHONE]?.state).toBe("SETTLED");
        expect(
          state?.events.filter(
            (e) => e.eventType === "OBLIGATION_SETTLED" && e.payload.obligationId === PHONE,
          ),
        ).toHaveLength(1);
        for (const journal of state?.ledger.all ?? []) {
          const totals = new Map<string, bigint>();
          for (const line of journal.lines)
            totals.set(
              line.amount.currency,
              (totals.get(line.amount.currency) ?? 0n) +
                BigInt(line.amount.amountMinor) * (line.direction === "DEBIT" ? 1n : -1n),
            );
          expect([...totals.values()].every((total) => total === 0n)).toBe(true);
        }
        const history = await t.worlds.history(t.world);
        expect(history && replay(history.config, history.commands).headHash).toBe(state?.headHash);
        expect(
          history?.commands
            .filter((c) => c.origin === "VERIFIED_EXTERNAL")
            .every((c) => c.commandId[14] === "8"),
        ).toBe(true);
      }

      it("reserves and schedules atomically; approval alone never settles, GET-verified capture posts once", async () => {
        const t = await setup();
        const before = await t.worlds.load(t.world, OWNER);
        expect(await t.operations.get(t.op)).toMatchObject({
          worldId: t.world,
          createState: "NOT_STARTED",
          captureState: "NOT_STARTED",
        });
        expect((await t.queue.read(t.op))?.action).toBe("CREATE");
        expect(t.provider.creates).toBe(0);
        await t.service.run(t.op, true);
        const record = await t.operations.get(t.op);
        const order = t.provider.orders.get(record?.paypalOrderId ?? "");
        if (!order) throw new Error("fixture order missing");
        order.status = "APPROVED";
        await t.service.request(OWNER, t.world, t.op, "RECONCILE");
        expect((await t.worlds.load(t.world, OWNER))?.obligations[PHONE]?.state).toBe("DUE");
        // Approval readback must leave the checkout eligible for its first explicit capture.
        await t.service.request(OWNER, t.world, t.op, "CAPTURE");
        await assertPaid(t);
        const paid = await t.worlds.load(t.world, OWNER);
        expect(paid?.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor).toBe(
          (before?.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor ?? 0) - 3000,
        );
        await t.service.request(OWNER, t.world, t.op, "CAPTURE");
        await t.service.request(OWNER, t.world, t.op, "RECONCILE");
        expect(t.provider.captures).toBe(1);
        await assertPaid(t);
      });

      it("foreign sessions cannot inspect or trigger provider operations; reserved server IDs cannot be preclaimed", async () => {
        const t = await setup();
        expect(await t.service.status(FOREIGN, t.world, t.op)).toBeNull();
        expect(await t.service.request(FOREIGN, t.world, t.op, "CAPTURE")).toBeNull();
        expect(t.provider.creates + t.provider.captures + t.provider.reads).toBe(0);
        const refused = await t.player("ADVANCE_TIME", { targetDay: 9 }, newProviderCommandId());
        expect(refused.ok).toBe(false);
      });

      it("capture wins the cancel race; no database lock is held during provider I/O", async () => {
        const t = await setup();
        await t.service.run(t.op, true);
        const record = await t.operations.get(t.op);
        const order = t.provider.orders.get(record?.paypalOrderId ?? "");
        if (!order) throw new Error("fixture order missing");
        order.status = "APPROVED";
        let release = () => {};
        let reached = () => {};
        const arrived = new Promise<void>((r) => {
          reached = r;
        });
        t.provider.captureBarrier = () =>
          new Promise<void>((r) => {
            release = r;
            reached();
          });
        const capture = t.service.request(OWNER, t.world, t.op, "CAPTURE");
        await arrived;
        try {
          const cancel = await t.player("REQUEST_CHECKOUT_CANCEL", { obligationId: PHONE });
          expect(cancel.ok).toBe(false);
          expect((await t.worlds.load(t.world, OWNER))?.reservations[PHONE]?.cancelRequested).toBe(
            false,
          );
        } finally {
          release();
        }
        await capture;
        await assertPaid(t);
      });

      it("cancel first forbids capture and releases only after a verified terminal order", async () => {
        const t = await setup();
        await t.service.run(t.op, true);
        expect((await t.player("REQUEST_CHECKOUT_CANCEL", { obligationId: PHONE })).ok).toBe(true);
        expect((await t.service.request(OWNER, t.world, t.op, "CAPTURE"))?.accepted).toBe(false);
        await t.service.run(t.op, true);
        expect((await t.worlds.load(t.world, OWNER))?.reservations[PHONE]).toBeDefined();
        const record = await t.operations.get(t.op);
        const order = t.provider.orders.get(record?.paypalOrderId ?? "");
        if (order) order.status = "VOIDED";
        await t.service.run(t.op, true);
        expect((await t.worlds.load(t.world, OWNER))?.reservations[PHONE]).toBeUndefined();
        expect(t.provider.captures).toBe(0);
      });

      it("a lost capture response survives restart and reconciles without another capture call", async () => {
        const t = await setup();
        await t.service.run(t.op, true);
        const record = await t.operations.get(t.op);
        const order = t.provider.orders.get(record?.paypalOrderId ?? "");
        if (!order) throw new Error("fixture order missing");
        order.status = "APPROVED";
        t.provider.loseCapture = true;
        t.provider.failReads = 1;
        await t.service.request(OWNER, t.world, t.op, "CAPTURE");
        expect((await t.worlds.load(t.world, OWNER))?.reservations[PHONE]).toBeDefined();
        const restarted = new CheckoutService(
          new PgWorldStore(db),
          new PgCheckoutQueue(db),
          new SandboxCheckout(t.client, new PgOperationStore(db)),
          t.client,
          "http://localhost:3000",
        );
        await restarted.request(OWNER, t.world, t.op, "RECONCILE");
        expect(t.provider.captures).toBe(1);
        await assertPaid(t);
      });

      it("recovers a known uncharged order after its first GET fails", async () => {
        const t = await setup();
        t.provider.failReads = 1;
        await t.service.run(t.op, true);
        expect((await t.queue.read(t.op))?.phase).toBe("RECONCILING");
        await t.service.run(t.op, true);
        expect((await t.queue.read(t.op))?.phase).toBe("IN_FLIGHT");
        const record = await t.operations.get(t.op);
        const order = t.provider.orders.get(record?.paypalOrderId ?? "");
        if (!order) throw new Error("fixture order missing");
        order.status = "APPROVED";
        expect((await t.service.request(OWNER, t.world, t.op, "CAPTURE"))?.accepted).toBe(true);
        await assertPaid(t);
        expect(t.provider.creates).toBe(1);
      });

      it("an expired capture lease recovers by GET and never repeats the capture", async () => {
        const t = await setup();
        await t.service.run(t.op, true);
        await t.queue.request(OWNER, t.world, t.op, "CAPTURE");
        const abandoned = await t.queue.lease(t.op, true);
        expect(abandoned?.action).toBe("CAPTURE");
        await db
          .update(schema.checkoutWork)
          .set({ leaseUntil: sql`now() - interval '1 second'` })
          .where(eq(schema.checkoutWork.operationId, t.op));
        await t.service.run(t.op, true);
        expect(t.provider.captures).toBe(0);
        expect((await t.queue.read(t.op))?.phase).toBe("IN_FLIGHT");
      });

      it("does not finish a previously captured operation with an unknown refund total", async () => {
        const t = await setup();
        await t.service.run(t.op, true);
        const record = await t.operations.get(t.op);
        const order = t.provider.orders.get(record?.paypalOrderId ?? "");
        if (!order) throw new Error("fixture order missing");
        order.status = "APPROVED";
        await t.service.request(OWNER, t.world, t.op, "CAPTURE");
        const unit = order.purchase_units[0];
        if (unit)
          unit.payments = {
            captures: [{ id: `CAP${order.id}`, status: "REFUNDED", amount: unit.amount }],
          };
        await t.service.request(OWNER, t.world, t.op, "RECONCILE");
        expect((await t.queue.read(t.op))?.phase).toBe("RECONCILING");
        await assertPaid(t);
      });
    },
  );
}
