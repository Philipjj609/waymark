import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { VerifiedProviderEventSchema, WorldIdSchema } from "@fle/contracts";
import { isRunOperation, type MatchedCaptureProof, type OperationRecord } from "@fle/payments";
import type { CheckoutTarget, SessionHash } from "@fle/server";
import { PHONE } from "@fle/simulation";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appendRunCommandsTx,
  connectPostgres,
  createPgCheckout,
  createRunCheckout,
  type Db,
  loadRunTx,
  migrate,
  PgCheckoutQueue,
  PgOperationStore,
  PgRunCheckoutGateway,
  PgRunStore,
  type SqlExecutor,
} from "../src/index.js";
import { checkoutFacts, checkoutWork, providerOperations } from "../src/schema.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const OWNER = "a".repeat(64) as SessionHash;
const FOREIGN = "b".repeat(64) as SessionHash;

class ProviderFixture {
  creates = 0;
  captures = 0;
  loseCapture = true;
  failReads = 0;
  createOutcomes: Array<"DECLINED" | "UNCERTAIN" | "CONFLICT"> = [];
  order: {
    id: string;
    status: string;
    purchase_units: Array<Record<string, unknown>>;
    links: unknown[];
  } | null = null;
  fetch: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const response = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/oauth2/token"))
      return response(200, { access_token: "fixture-token", expires_in: 3600 });
    if (path === "/v2/checkout/orders" && init?.method === "POST") {
      this.creates++;
      const outcome = this.createOutcomes.shift();
      if (outcome === "DECLINED")
        return response(422, { details: [{ issue: "INSTRUMENT_DECLINED" }] });
      if (outcome === "UNCERTAIN") throw new TypeError("lost create response");
      const body = JSON.parse(String(init.body));
      const id = `ORDER${randomBytes(8).toString("hex").toUpperCase()}`;
      this.order = {
        id,
        status: "CREATED",
        purchase_units: body.purchase_units,
        links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
      };
      if (outcome === "CONFLICT") {
        this.order.status = "COMPLETED";
        const unit = this.order.purchase_units[0];
        if (!unit) throw new Error("fixture purchase unit missing");
        unit.reference_id = "foreign-operation";
        unit.custom_id = "foreign-operation";
        unit.payments = {
          captures: [{ id: `CAP${id}`, status: "COMPLETED", amount: unit.amount }],
        };
      }
      return response(201, this.order);
    }
    if (!this.order) return response(404, { name: "RESOURCE_NOT_FOUND" });
    if (path.endsWith("/capture")) {
      this.captures++;
      this.order.status = "COMPLETED";
      const unit = this.order.purchase_units[0];
      if (!unit) throw new Error("fixture purchase unit missing");
      unit.payments = {
        captures: [{ id: `CAP${this.order.id}`, status: "COMPLETED", amount: unit.amount }],
      };
      if (this.loseCapture) {
        this.loseCapture = false;
        this.failReads = 1;
        throw new TypeError("lost provider response");
      }
      return response(201, this.order);
    }
    if (this.failReads-- > 0) throw new TypeError("provider lookup unavailable");
    return response(200, this.order);
  };
}

for (const mode of ["PGlite", "PostgreSQL"] as const) {
  describe.skipIf(mode === "PostgreSQL" && !process.env.TEST_DATABASE_URL)(
    `shared Run checkout transaction on ${mode}`,
    () => {
      let db: Db;
      let close: () => Promise<void>;
      beforeAll(async () => {
        if (mode === "PGlite") {
          const client = new PGlite();
          db = drizzle(client);
          close = () => client.close();
        } else {
          const name = `waymark_run_checkout_${randomBytes(6).toString("hex")}`;
          const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
          await admin.connect();
          await admin.query(`CREATE DATABASE ${name}`);
          await admin.end();
          const url = new URL(process.env.TEST_DATABASE_URL as string);
          url.pathname = `/${name}`;
          const conn = connectPostgres(url.toString());
          db = conn.db;
          close = async () => {
            await conn.pool.end();
            const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
            await admin.connect();
            await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
            await admin.end();
          };
        }
        await migrate(db);
      });
      afterAll(async () => close?.());

      async function setup() {
        const runId = `run_${randomBytes(8).toString("hex")}`;
        await new PgRunStore(db).create({
          runId,
          owner: OWNER,
          scenarioId: "fixture",
          rulesVersion: "fixture.v1",
          headHash: "genesis",
        });
        let failReserve = false;
        let failCommit = false;
        let failRelease = false;
        let commits = 0;
        const append = async (tx: SqlExecutor, command: unknown) => {
          const record = await loadRunTx(tx, runId, { forUpdate: true });
          if (!record) throw new Error("missing fixture Run");
          const out = await appendRunCommandsTx(
            tx,
            runId,
            record.version,
            [{ command, origin: "SERVER", requestId: null }],
            `fixture-${record.version + 1}`,
          );
          if (!out.ok) throw new Error("fixture conflict");
        };
        // A deliberately small target tests transaction ownership, not Run economics.
        // Actual replay, funds and ledger assertions belong to the real Run adapter tests.
        const target: CheckoutTarget<SqlExecutor> = {
          async reserve(tx, _owner, ref, operationId, expectedVersion) {
            const head = await loadRunTx(tx, runId, { forUpdate: true });
            if (head?.version !== expectedVersion) throw new Error("stale Run");
            await append(tx, { kind: "RESERVE_EXTERNAL", billId: ref.billId, operationId });
            if (failReserve) throw new Error("fault after reservation");
            return { amountMinor: 3000, currency: "EUR" };
          },
          async bind() {},
          async releaseUncreated(tx, _owner, record) {
            const head = await loadRunTx(tx, runId, { forUpdate: true });
            if (
              head?.commands.some((input) => {
                const c = input as { kind: string; operationId: string };
                return c.kind === "RELEASE_EXTERNAL" && c.operationId === record.operationId;
              })
            )
              return;
            await append(tx, {
              kind: "RELEASE_EXTERNAL",
              operationId: record.operationId,
            });
            if (failRelease) throw new Error("fault after reservation release");
          },
          async commitVerifiedFact(tx, _owner, record, proof) {
            commits++;
            await append(tx, {
              kind: "SETTLE_EXTERNAL",
              operationId: record.operationId,
              captureId: proof.providerEventId,
            });
            if (failCommit) throw new Error("fault after settlement append");
          },
          async reconcile(tx, owner, record) {
            const state = await target.status(tx, owner, record);
            return { terminal: state.settled, open: false, confirmed: state.settled };
          },
          async status(tx, _owner, record) {
            const run = await loadRunTx(tx, runId);
            const settlement = run?.commands.find((input) => {
              const c = input as { kind: string; operationId: string; captureId?: string };
              return c.kind === "SETTLE_EXTERNAL" && c.operationId === record.operationId;
            }) as { captureId: string } | undefined;
            return {
              version: run?.version ?? 0,
              settled: !!settlement,
              captureId: settlement?.captureId ?? null,
              needsAttention: false,
            };
          },
        };
        const ref = { kind: "RUN" as const, runId, billId: "bill-fixture" };
        const start = () => createRunCheckout(db, target, OWNER, ref, 0);
        const operations = new PgOperationStore(db);
        const queue = new PgCheckoutQueue(db);
        const gateway = new PgRunCheckoutGateway(db, target);
        const releaseTokens = new Map<string, string>();
        const releaseUncreated = async (input: OperationRecord, owner = OWNER) => {
          let token = releaseTokens.get(input.operationId);
          if (!token) {
            const lease = await queue.lease(input.operationId, true);
            if (!lease) throw new Error("fixture release lease unavailable");
            token = lease.token;
            releaseTokens.set(input.operationId, token);
          }
          return gateway.releaseUncreated(owner, input, token);
        };
        const prepare = async () => {
          const operationId = await start();
          const before = await operations.get(operationId);
          if (!before) throw new Error("missing fixture operation");
          await operations.update(operationId, (r) => ({
            ...r,
            paypalOrderId: `ORDER${randomBytes(6).toString("hex")}`,
            createState: "CONFIRMED",
          }));
          await db
            .update(checkoutWork)
            .set({ action: "RECONCILE" })
            .where(eq(checkoutWork.operationId, operationId));
          const record = await operations.get(operationId);
          if (!record?.paypalOrderId) throw new Error("missing fixture order");
          const proof: MatchedCaptureProof = {
            provider: "PAYPAL_SANDBOX",
            eventType: "CAPTURE_COMPLETED",
            providerEventId: `CAP${randomBytes(6).toString("hex")}`,
            operationId,
            orderId: record.paypalOrderId,
            amount: record.expected,
            verification: {
              method: "ORDER_LOOKUP",
              verifiedAt: "2026-11-10T12:00:00.000Z",
              evidenceRef: "fixture:server-read",
            },
          };
          return { operationId, record, staleRecord: before, proof };
        };
        return {
          runId,
          ref,
          target,
          start,
          prepare,
          operations,
          queue,
          gateway,
          releaseUncreated,
          failReserve: (value: boolean) => {
            failReserve = value;
          },
          failCommit: (value: boolean) => {
            failCommit = value;
          },
          failRelease: (value: boolean) => {
            failRelease = value;
          },
          commits: () => commits,
        };
      }

      it("six concurrent starts and a restarted caller reuse one authoritative reservation and operation", async () => {
        const t = await setup();
        const ids = await Promise.all(Array.from({ length: 6 }, () => t.start()));
        expect(new Set(ids).size).toBe(1);
        expect(await createRunCheckout(db, t.target, OWNER, t.ref, 0)).toBe(ids[0]);
        const rows = await db
          .select()
          .from(providerOperations)
          .where(eq(providerOperations.runId, t.runId));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          targetKind: "RUN",
          worldId: null,
          obligationId: null,
          billId: t.ref.billId,
        });
        expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(1);
        const operationId = ids[0];
        if (!operationId) throw new Error("missing concurrent start result");
        expect((await t.queue.read(operationId))?.action).toBe("CREATE");
      });

      it("reservation and payment scheduling roll back together on a target failure", async () => {
        const t = await setup();
        t.failReserve(true);
        await expect(t.start()).rejects.toThrow("fault after reservation");
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(0);
        expect(
          await db.select().from(providerOperations).where(eq(providerOperations.runId, t.runId)),
        ).toHaveLength(0);
        t.failReserve(false);
        await t.start();
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(1);
      });

      it("settlement append and fact-applied marker recover atomically after a crash", async () => {
        const t = await setup();
        const p = await t.prepare();
        await t.queue.remember(p.proof);
        t.failCommit(true);
        await expect(t.gateway.commitVerifiedFact(OWNER, p.staleRecord, p.proof)).rejects.toThrow(
          "fault after settlement append",
        );
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(1);
        expect(await t.queue.facts(p.operationId)).toHaveLength(1);
        t.failCommit(false);
        const recovered = new PgRunCheckoutGateway(db, t.target);
        await recovered.commitVerifiedFact(OWNER, p.staleRecord, p.proof);
        await recovered.commitVerifiedFact(OWNER, p.record, p.proof);
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(2);
        expect(await t.queue.facts(p.operationId)).toHaveLength(0);
        expect(t.commits()).toBe(2); // one rolled-back attempt, one committed effect
        const [fact] = await db
          .select()
          .from(checkoutFacts)
          .where(eq(checkoutFacts.operationId, p.operationId));
        expect(fact?.applied).toBe(1);
      });

      it("a capture cannot be rebound to another Run or acknowledged outside its atomic gateway", async () => {
        const a = await setup();
        const b = await setup();
        const paid = await a.prepare();
        const other = await b.prepare();
        await a.queue.remember(paid.proof);
        await expect(
          b.queue.remember({
            ...paid.proof,
            operationId: other.operationId,
            orderId: other.proof.orderId,
          }),
        ).rejects.toThrow("provider fact binding conflict");
        await expect(b.gateway.commitVerifiedFact(OWNER, other.record, paid.proof)).rejects.toThrow(
          "Run capture binding mismatch",
        );
        await expect(a.queue.applied(paid.proof)).rejects.toThrow(
          "Run facts require atomic target commit",
        );
        // A World-shaped wrapper must not bypass the canonical Run target check.
        const disguised = VerifiedProviderEventSchema.parse({
          schemaVersion: "provider.event.v1",
          ...paid.proof,
          mapping: { worldId: WorldIdSchema.parse(`wld_${"c".repeat(32)}`), obligationId: PHONE },
        });
        await expect(a.queue.applied(disguised)).rejects.toThrow();
        expect(await a.queue.facts(paid.operationId)).toHaveLength(1);
        expect((await new PgRunStore(db).load(a.runId))?.version).toBe(1);
        expect((await new PgRunStore(db).load(b.runId))?.version).toBe(1);
        expect(await b.queue.facts(other.operationId)).toHaveLength(0);
      });

      it("Run ownership and World APIs cannot be bypassed with an operation identifier", async () => {
        const t = await setup();
        const p = await t.prepare();
        expect(isRunOperation(p.record)).toBe(true);
        await expect(createRunCheckout(db, t.target, FOREIGN, t.ref, 0)).rejects.toThrow(
          "Run checkout unavailable",
        );
        expect(await t.queue.authorizedRun(FOREIGN, t.runId, p.operationId)).toBeNull();
        expect(await t.queue.requestRun(FOREIGN, t.runId, p.operationId, "CAPTURE")).toBe(false);
        expect(
          await t.queue.authorized(
            OWNER,
            WorldIdSchema.parse(`wld_${"c".repeat(32)}`),
            p.operationId,
          ),
        ).toBeNull();
        await expect(t.gateway.bind(FOREIGN, p.record)).rejects.toThrow("Run checkout unavailable");
      });

      it("capture and cancel serialize; uncertain capture cannot be cancelled or released", async () => {
        const t = await setup();
        const p = await t.prepare();
        const race = await Promise.all([
          t.queue.requestRun(OWNER, t.runId, p.operationId, "CAPTURE"),
          t.queue.requestRun(OWNER, t.runId, p.operationId, "CANCEL"),
        ]);
        expect(race.filter(Boolean)).toHaveLength(1);
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(1);
        await t.operations.update(p.operationId, (r) => ({ ...r, captureState: "UNCERTAIN" }));
        await db
          .update(checkoutWork)
          .set({ phase: "RECONCILING", action: "RECONCILE", leaseToken: null, leaseUntil: null })
          .where(eq(checkoutWork.operationId, p.operationId));
        expect(await t.queue.requestRun(OWNER, t.runId, p.operationId, "CANCEL")).toBe(false);
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(1);
      });

      it("a definitive create decline releases promptly and once, survives restart, and permits a new attempt", async () => {
        const t = await setup();
        const provider = new ProviderFixture();
        provider.createOutcomes = ["DECLINED"];
        const config = {
          clientId: "fixture-id",
          clientSecret: "fixture-secret",
          fetch: provider.fetch,
          maxAttempts: 1,
          returnOrigin: "http://localhost:3000",
        };
        const runtime = createPgCheckout(db, config, t.target);
        const operation = await runtime.startRun(OWNER, t.ref, 0);
        await runtime.service.run(operation, true);
        expect(await runtime.service.statusRun(OWNER, t.runId, operation)).toMatchObject({
          phase: "FINISHED",
          settled: false,
          orderId: null,
          captureId: null,
        });
        expect((await t.operations.get(operation))?.createState).toBe("REFUSED");
        const history = await new PgRunStore(db).load(t.runId);
        expect(history?.commands).toHaveLength(2);
        expect(history?.commands[1]).toMatchObject({
          kind: "RELEASE_EXTERNAL",
          operationId: operation,
        });
        expect(provider.creates).toBe(1);
        expect(provider.captures).toBe(0);
        const restarted = createPgCheckout(db, config, t.target);
        await restarted.service.run(operation, true);
        expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(2);
        const next = await restarted.startRun(OWNER, t.ref, 2);
        expect(next).not.toBe(operation);
        await restarted.service.run(operation, true);
        expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(3);
        expect(provider.creates).toBe(1);
      });

      it.each(["UNCERTAIN", "PENDING", "STARTED", "CONFIRMED"] as const)(
        "a no-order %s create remains reserved",
        async (createState) => {
          const t = await setup();
          const operation = await t.start();
          const input = await t.operations.update(operation, (r) => ({ ...r, createState }));
          expect(await t.releaseUncreated(input)).toBe(false);
          expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(1);
          expect((await t.queue.read(operation))?.phase).not.toBe("FINISHED");
        },
      );

      it.each([
        "UNCERTAIN",
        "PENDING",
        "STARTED",
        "CONFIRMED",
        "REFUSED",
        "CAPTURED_ELSEWHERE",
      ] as const)(
        "a refused create with %s capture evidence cannot release",
        async (captureState) => {
          const t = await setup();
          const operation = await t.start();
          const input = await t.operations.update(operation, (r) => ({
            ...r,
            createState: "REFUSED",
            lastResult: "DECLINED:INSTRUMENT_DECLINED",
            captureState,
          }));
          expect(await t.releaseUncreated(input)).toBe(false);
          expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(1);
        },
      );

      it("a clean refusal after an uncertain create does not erase uncertainty or release the hold", async () => {
        const t = await setup();
        const provider = new ProviderFixture();
        provider.createOutcomes = ["UNCERTAIN", "DECLINED"];
        const runtime = createPgCheckout(
          db,
          {
            clientId: "fixture-id",
            clientSecret: "fixture-secret",
            fetch: provider.fetch,
            maxAttempts: 1,
            returnOrigin: "http://localhost:3000",
          },
          t.target,
        );
        const operation = await runtime.startRun(OWNER, t.ref, 0);
        await runtime.service.run(operation, true);
        await runtime.service.run(operation, true);
        expect(provider.creates).toBe(2);
        expect((await t.operations.get(operation))?.createState).toBe("UNCERTAIN");
        expect((await t.queue.read(operation))?.phase).toBe("RECONCILING");
        expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(1);
      });

      it("known orders or any durable fact prevent uncreated release", async () => {
        const known = await setup();
        const p = await known.prepare();
        const input = await known.operations.update(p.operationId, (r) => ({
          ...r,
          createState: "REFUSED",
          lastResult: "DECLINED:INSTRUMENT_DECLINED",
        }));
        expect(await known.releaseUncreated(input)).toBe(false);
        expect((await new PgRunStore(db).load(known.runId))?.version).toBe(1);

        const unknown = await setup();
        const op = await unknown.start();
        const record = await unknown.operations.update(op, (r) => ({
          ...r,
          createState: "REFUSED",
          lastResult: "DECLINED:INSTRUMENT_DECLINED",
        }));
        // Defensive storage boundary: even an inconsistent/legacy fact must prevent release.
        await db.insert(checkoutFacts).values({
          operationId: op,
          eventType: "CAPTURE_COMPLETED",
          eventId: `CAP${randomBytes(6).toString("hex")}`,
          payload: { legacy: "unresolved provider evidence" },
        });
        expect(await unknown.releaseUncreated(record)).toBe(false);
        expect((await new PgRunStore(db).load(unknown.runId))?.version).toBe(1);
      });

      it("uncreated release and finished job roll back together, and only the owner may retry", async () => {
        const t = await setup();
        const operation = await t.start();
        const input = await t.operations.update(operation, (r) => ({
          ...r,
          createState: "REFUSED",
          lastResult: "DECLINED:INSTRUMENT_DECLINED",
        }));
        await expect(t.releaseUncreated(input, FOREIGN)).rejects.toThrow(
          "Run checkout unavailable",
        );
        t.failRelease(true);
        await expect(t.releaseUncreated(input)).rejects.toThrow("fault after reservation release");
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(1);
        expect((await t.queue.read(operation))?.phase).toBe("IN_FLIGHT");
        t.failRelease(false);
        expect(await t.releaseUncreated(input)).toBe(true);
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(2);
        expect((await t.queue.read(operation))?.phase).toBe("FINISHED");
      });

      it("expired and replaced creation leases cannot release a reservation", async () => {
        const t = await setup();
        const operation = await t.start();
        const input = await t.operations.update(operation, (r) => ({
          ...r,
          createState: "REFUSED",
          lastResult: "DECLINED:INSTRUMENT_DECLINED",
        }));
        const old = await t.queue.lease(operation, true);
        if (!old) throw new Error("fixture lease missing");
        await db
          .update(checkoutWork)
          .set({ leaseUntil: sql`now() - interval '1 second'` })
          .where(eq(checkoutWork.operationId, operation));
        expect(await t.gateway.releaseUncreated(OWNER, input, old.token)).toBe(false);
        const current = await t.queue.lease(operation, true);
        if (!current) throw new Error("fixture replacement lease missing");
        expect(current.token).not.toBe(old.token);
        expect(await t.gateway.releaseUncreated(OWNER, input, old.token)).toBe(false);
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(1);
        expect(await t.gateway.releaseUncreated(OWNER, input, current.token)).toBe(true);
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(2);
      });

      it.each(["expired", "cleared"] as const)(
        "a started create with a %s lease stays uncertain after a declined retry",
        async (leaseState) => {
          const t = await setup();
          const operation = await t.start();
          const abandoned = await t.queue.lease(operation, true);
          if (!abandoned) throw new Error("fixture lease missing");
          await t.operations.update(operation, (r) => ({
            ...r,
            createState: "STARTED",
            createStartedAt: Date.now(),
          }));
          await db
            .update(checkoutWork)
            .set(
              leaseState === "expired"
                ? { leaseUntil: sql`now() - interval '1 second'` }
                : { leaseToken: null, leaseUntil: null },
            )
            .where(eq(checkoutWork.operationId, operation));
          const provider = new ProviderFixture();
          provider.createOutcomes = ["DECLINED"];
          const runtime = createPgCheckout(
            db,
            {
              clientId: "fixture-id",
              clientSecret: "fixture-secret",
              fetch: provider.fetch,
              maxAttempts: 1,
              returnOrigin: "http://localhost:3000",
            },
            t.target,
          );
          await runtime.service.run(operation, true);
          expect(provider.creates).toBe(1);
          expect((await t.operations.get(operation))?.createState).toBe("UNCERTAIN");
          expect((await t.queue.read(operation))?.phase).toBe("RECONCILING");
          expect((await new PgRunStore(db).load(t.runId))?.version).toBe(1);
        },
      );

      it.each([
        null,
        "CONFLICT",
        "CONFLICT:ORDER_MISMATCH",
        "UNKNOWN",
        "NOT_SENT:configuration",
        "DECLINED_BUT_UNKNOWN",
      ] as const)("a refused state with unproven result %s cannot release", async (lastResult) => {
        const t = await setup();
        const operation = await t.start();
        const input = await t.operations.update(operation, (r) => ({
          ...r,
          createState: "REFUSED",
          lastResult,
        }));
        expect(await t.releaseUncreated(input)).toBe(false);
        expect((await new PgRunStore(db).load(t.runId))?.version).toBe(1);
        expect((await t.queue.read(operation))?.phase).not.toBe("FINISHED");
      });

      it("a conflicting create response containing a completed capture never releases its reservation", async () => {
        const t = await setup();
        const provider = new ProviderFixture();
        provider.createOutcomes = ["CONFLICT"];
        const runtime = createPgCheckout(
          db,
          {
            clientId: "fixture-id",
            clientSecret: "fixture-secret",
            fetch: provider.fetch,
            maxAttempts: 1,
            returnOrigin: "http://localhost:3000",
          },
          t.target,
        );
        const operation = await runtime.startRun(OWNER, t.ref, 0);
        await runtime.service.run(operation, true);
        expect(provider.order?.status).toBe("COMPLETED");
        expect(await t.operations.get(operation)).toMatchObject({
          createState: "REFUSED",
          paypalOrderId: null,
          lastResult: "CONFLICT",
        });
        expect((await t.queue.read(operation))?.phase).toBe("RECONCILING");
        expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(1);
      });

      it("the unified coordinator recovers a lost capture and failed lookup after restart without another order or capture", async () => {
        const t = await setup();
        const provider = new ProviderFixture();
        const config = {
          clientId: "fixture-id",
          clientSecret: "fixture-secret",
          fetch: provider.fetch,
          maxAttempts: 1,
          returnOrigin: "http://localhost:3000",
        };
        const original = createPgCheckout(db, config, t.target);
        const operation = await original.startRun(OWNER, t.ref, 0);
        await original.service.run(operation, true);
        expect((await original.service.statusRun(OWNER, t.runId, operation))?.phase).toBe(
          "IN_FLIGHT",
        );
        if (!provider.order) throw new Error("fixture order not created");
        provider.order.status = "APPROVED";
        const requests = await Promise.all([
          original.service.requestRun(OWNER, t.runId, operation, "CAPTURE"),
          original.service.requestRun(OWNER, t.runId, operation, "CAPTURE"),
        ]);
        expect(requests.filter((r) => r?.accepted)).toHaveLength(1);
        // A concurrent rejected request can briefly lock the work row while the accepted
        // request's immediate worker skips it. Drain only the still-queued capture intent;
        // reconciling here instead would consume the deliberately lost-response fixture.
        if ((await original.queue.read(operation))?.action === "CAPTURE")
          await original.service.run(operation, false);
        expect(provider.creates).toBe(1);
        expect(provider.captures).toBe(1);
        expect((await original.service.statusRun(OWNER, t.runId, operation))?.settled).toBe(false);
        expect((await original.queue.read(operation))?.phase).toBe("RECONCILING");
        const restarted = createPgCheckout(db, config, t.target);
        expect(await restarted.startRun(OWNER, t.ref, 0)).toBe(operation);
        await restarted.service.requestRun(OWNER, t.runId, operation, "RECONCILE");
        expect(await restarted.service.statusRun(OWNER, t.runId, operation)).toMatchObject({
          settled: true,
          phase: "FINISHED",
          captureId: `CAP${provider.order.id}`,
          realm: "PAYPAL_SANDBOX",
          expected: { amountMinor: 3000, currency: "EUR" },
        });
        await restarted.service.requestRun(OWNER, t.runId, operation, "CAPTURE");
        await restarted.service.requestRun(OWNER, t.runId, operation, "RECONCILE");
        expect(provider.creates).toBe(1);
        expect(provider.captures).toBe(1);
        expect(t.commits()).toBe(1);
        expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(2);
        expect(await restarted.queue.facts(operation)).toHaveLength(0);
      });

      if (mode === "PostgreSQL")
        it("a contended work row preserves capture intent until a later worker resumes it once", async () => {
          const t = await setup();
          const provider = new ProviderFixture();
          const runtime = createPgCheckout(
            db,
            {
              clientId: "fixture-id",
              clientSecret: "fixture-secret",
              fetch: provider.fetch,
              maxAttempts: 1,
              returnOrigin: "http://localhost:3000",
            },
            t.target,
          );
          const operation = await runtime.startRun(OWNER, t.ref, 0);
          await runtime.service.run(operation, true);
          if (!provider.order) throw new Error("fixture order not created");
          provider.order.status = "APPROVED";
          expect(await runtime.queue.requestRun(OWNER, t.runId, operation, "CAPTURE")).toBe(true);
          await db.transaction(async (tx) => {
            await tx
              .select()
              .from(checkoutWork)
              .where(eq(checkoutWork.operationId, operation))
              .for("update");
            await runtime.service.run(operation, false);
            expect(provider.captures).toBe(0);
          });
          expect(await runtime.queue.read(operation)).toMatchObject({
            action: "CAPTURE",
            phase: "CAPTURING",
          });
          await runtime.service.run(operation, false);
          expect(provider.captures).toBe(1);
          expect((await runtime.queue.read(operation))?.phase).toBe("RECONCILING");
          await runtime.service.requestRun(OWNER, t.runId, operation, "RECONCILE");
          await runtime.service.requestRun(OWNER, t.runId, operation, "CAPTURE");
          expect(await runtime.service.statusRun(OWNER, t.runId, operation)).toMatchObject({
            phase: "FINISHED",
            settled: true,
          });
          expect(provider.creates).toBe(1);
          expect(provider.captures).toBe(1);
          expect(t.commits()).toBe(1);
          expect((await new PgRunStore(db).load(t.runId))?.commands).toHaveLength(2);
        });
    },
  );
}
