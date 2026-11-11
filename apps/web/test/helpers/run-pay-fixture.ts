/**
 * Shared fixtures for the Run payment tests (#137 step 3): a database (PGlite, or real PostgreSQL
 * when TEST_DATABASE_URL is set), a fake PayPal Sandbox at the fetch level (so the REAL client,
 * SandboxCheckout and CheckoutService run), and a helper that plays a Run forward until a bill is
 * due and affordable. Nothing here leaves the machine.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "@fle/persistence";
import { connectPostgres, createPgCheckout, type Db, migrate, PgRunStore } from "@fle/persistence";
import { type Command, type RunState, YOU } from "@fle/run";
import type { CheckoutTarget, SessionHash } from "@fle/server";
import { drizzle } from "drizzle-orm/pglite";
import pg from "pg";
import { runCheckoutTarget } from "../../lib/run-checkout-target";
import {
  commandRun,
  createRun,
  loadRun,
  type SaveToken,
  setRunStoreForTests,
} from "../../lib/run-save";

export const OWNER = "a".repeat(64) as SessionHash;
export const FOREIGN = "b".repeat(64) as SessionHash;
export const ORIGIN = "http://localhost:3000";

export type Mode = "PGlite" | "PostgreSQL";
export const MODES: readonly Mode[] = ["PGlite", "PostgreSQL"];
export const skipMode = (mode: Mode) => mode === "PostgreSQL" && !process.env.TEST_DATABASE_URL;

/** A migrated database, one per suite; PostgreSQL gets its own throwaway database. */
export async function openDatabase(mode: Mode): Promise<{ db: Db; close: () => Promise<void> }> {
  if (mode === "PGlite") {
    const client = new PGlite();
    const db = drizzle(client) as unknown as Db;
    await migrate(db);
    return { db, close: () => client.close() };
  }
  const admin = process.env.TEST_DATABASE_URL as string;
  const name = `waymark_run_target_${randomBytes(6).toString("hex")}`;
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`CREATE DATABASE ${name}`);
  await a.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const conn = connectPostgres(url.toString());
  await migrate(conn.db);
  return {
    db: conn.db,
    close: async () => {
      await conn.pool.end();
      const b = new pg.Client({ connectionString: admin });
      await b.connect();
      await b.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await b.end();
    },
  };
}

// -- a fake PayPal Sandbox, behaving like the real one with the published test card --------------

/**
 * COMPLETED: what the real Sandbox did on 10 Nov 2026 (order 9A84822712263045A): a test-card order
 * comes back COMPLETED from create, and capture answers ORDER_ALREADY_CAPTURED. The others are
 * failure modes that must never settle anything wrongly.
 */
export type Behaviour = "COMPLETED" | "PENDING" | "VOIDED" | "WRONG_AMOUNT";

interface FakeOrder {
  id: string;
  status: string;
  unit: Record<string, unknown>;
  capture: { id: string; status: string; amount: unknown } | null;
}

export class FakePayPal {
  behaviour: Behaviour = "COMPLETED";
  /** Distinct orders created (an idempotent replay of a request id is not a new order). */
  creates = 0;
  captureCalls = 0;
  testCardCreates = 0;
  readonly orders = new Map<string, FakeOrder>();
  readonly byRequest = new Map<string, string>();

  private body(o: FakeOrder) {
    return {
      id: o.id,
      status: o.status,
      purchase_units: [
        {
          ...o.unit,
          ...(o.capture ? { payments: { captures: [o.capture] } } : {}),
        },
      ],
      links: [],
    };
  }

  /** Move an existing order on (e.g. a pending capture completes, or an order is voided). */
  update(orderId: string, change: (o: FakeOrder) => void) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("fake order missing");
    change(o);
  }

  get all(): FakeOrder[] {
    return [...this.orders.values()];
  }

  fetch: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/oauth2/token")) {
      return reply(200, { access_token: "fixture-token", expires_in: 3600 });
    }
    const headers = new Headers(init?.headers);
    if (path === "/v2/checkout/orders" && init?.method === "POST") {
      const requestId = headers.get("PayPal-Request-Id") ?? "";
      const known = this.byRequest.get(requestId);
      const existing = known ? this.orders.get(known) : undefined;
      if (existing) return reply(200, this.body(existing));
      const body = JSON.parse(String(init.body));
      if (body.payment_source?.card) this.testCardCreates++;
      this.creates++;
      const id = `ORDER${randomBytes(8).toString("hex").toUpperCase()}`;
      const unit = body.purchase_units[0] as { amount: { value: string; currency_code: string } };
      const wrong = { ...unit.amount, value: "0.01" };
      const order: FakeOrder = {
        id,
        status:
          this.behaviour === "VOIDED"
            ? "VOIDED"
            : this.behaviour === "PENDING"
              ? "APPROVED"
              : "COMPLETED",
        unit,
        capture:
          this.behaviour === "VOIDED"
            ? null
            : {
                id: `CAP${id}`,
                status: this.behaviour === "PENDING" ? "PENDING" : "COMPLETED",
                amount: this.behaviour === "WRONG_AMOUNT" ? wrong : unit.amount,
              },
      };
      this.orders.set(id, order);
      this.byRequest.set(requestId, id);
      return reply(201, this.body(order));
    }
    const orderId = path.split("/")[4] ?? "";
    const order = this.orders.get(orderId);
    if (!order) return reply(404, { name: "RESOURCE_NOT_FOUND" });
    if (path.endsWith("/capture")) {
      this.captureCalls++;
      return reply(422, {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
      });
    }
    return reply(200, this.body(order));
  };
}

// -- the Run side ---------------------------------------------------------------------------------

export const cashOf = (s: RunState) => s.balances[YOU]?.["ASSET:Cash"] ?? 0;
const ADVANCE: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

/** Every journal in every pocket balances (assets + expenses = liabilities + equity + revenue). */
export function booksBalance(state: RunState): boolean {
  for (const accounts of Object.values(state.balances)) {
    let debit = 0;
    let credit = 0;
    for (const [account, v] of Object.entries(accounts)) {
      if (account.startsWith("ASSET:") || account.startsWith("EXPENSE:")) debit += v;
      else credit += v;
    }
    if (debit !== credit) return false;
  }
  return true;
}

export interface Payable {
  save: SaveToken;
  billId: string;
  amountMinor: number;
}

/** Plays a fresh Run forward until a bill in your pocket is due AND your fictional cash covers it. */
export async function withPayableBill(owner: string = OWNER): Promise<Payable> {
  for (let attempt = 0; attempt < 12; attempt++) {
    let { save } = await createRun(owner, "first-flat");
    for (let i = 0; i < 60; i++) {
      const loaded = await loadRun(owner, save);
      if (!loaded.ok) throw new Error("run not loadable");
      const bill = loaded.state.bills.find(
        (b) =>
          b.pocket === YOU &&
          (b.status === "DUE" || b.status === "LATE") &&
          !b.reservedBy &&
          b.amountMinor <= cashOf(loaded.state) &&
          b.amountMinor > 0,
      );
      if (bill) return { save, billId: bill.id, amountMinor: bill.amountMinor };
      const next = await commandRun(owner, save, ADVANCE, randomUUID());
      if (!next.ok) break;
      save = next.save;
    }
  }
  throw new Error("no payable bill found while playing forward");
}

/** The runtime the app would build: the REAL coordinator and client, the Run adapter, a fake PayPal. */
export function buildRuntime(
  db: Db,
  fake: FakePayPal,
  target: CheckoutTarget<SqlExecutor> = runCheckoutTarget,
) {
  return createPgCheckout(
    db,
    {
      clientId: "fixture-id",
      clientSecret: "fixture-secret",
      fetch: fake.fetch,
      maxAttempts: 1,
      returnOrigin: ORIGIN,
      testCard: true,
    },
    target,
  );
}

/** Use this database for the Run log too, and forget cached states. */
export function useRunStore(db: Db): PgRunStore {
  const store = new PgRunStore(db);
  setRunStoreForTests(store);
  return store;
}
