import { describe, expect, it } from "vitest";
import { CARDS } from "../src/content/cards.js";
import { SCENARIOS } from "../src/content/scenarios.js";
import { apply, type Command, type Effect, type RunState, startRun } from "../src/index.js";
import { systems } from "../src/systems/index.js";
import { isTemplateId, templates } from "../src/text.js";

/** The module actions content may use. Each is implemented by another work package. */
const ALLOWED_SYSTEM_ACTIONS = [
  "business.start",
  "credit.addLoan",
  "life.adjustRecurring",
  "cards.open",
] as const;

const KNOWN_CONCEPTS = new Set([
  "cpt_cash_balance",
  "cpt_obligation",
  "cpt_receivable",
  "cpt_invoice_vs_payment",
  "cpt_liquidity",
  "cpt_net_worth",
  "cpt_opportunity_cost",
  "cpt_emergency_fund",
  "cpt_interest",
  "cpt_credit_record",
  "cpt_working_capital",
  "cpt_margin",
  "cpt_fixed_costs",
  "cpt_recurring_revenue",
]);

/** Every effect in a list, including those inside CHANCE branches. */
function flatten(effects: readonly Effect[]): Effect[] {
  return effects.flatMap((e) =>
    e.kind === "CHANCE" ? [e, ...flatten(e.then), ...flatten(e.else ?? [])] : [e],
  );
}

const cardEffects = (card: (typeof CARDS)[number]) =>
  card.options.flatMap((o) => flatten(o.effects));

/** `{name}` placeholders in every variant of a template, or of literal text. */
function placeholders(idOrText: string): string[] {
  const variants = isTemplateId(idOrText) ? (templates()[idOrText] ?? []) : [idOrText];
  return variants.flatMap((v) =>
    [...v.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] as string),
  );
}

/** Slot names a card's text may use: its slots, their formatted twins, and "business". */
function usableSlots(card: (typeof CARDS)[number]): Set<string> {
  const names = new Set<string>();
  for (const name of Object.keys(card.slots ?? {})) {
    names.add(name);
    if (name.endsWith("Minor")) names.add(name.slice(0, -5));
  }
  if (card.businessType) names.add("business");
  return names;
}

describe("cards", () => {
  it("has a deck of about thirty or more, with unique ids", () => {
    const ids = CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CARDS.length).toBeGreaterThanOrEqual(30);
  });

  it("every card has options with valid, unique ids and sane numbers", () => {
    for (const card of CARDS) {
      expect(card.options.length, card.id).toBeGreaterThanOrEqual(1);
      const optionIds = card.options.map((o) => o.id);
      expect(new Set(optionIds).size, card.id).toBe(optionIds.length);
      for (const id of optionIds) expect(id, card.id).toMatch(/^[a-z0-9_]+$/);
      if (card.onExpire) expect(optionIds, card.id).toContain(card.onExpire);
      expect(card.weight, card.id).toBeGreaterThan(0);
      expect(Number.isInteger(card.cooldownDays), card.id).toBe(true);
      expect(card.expiresInDays, card.id).toBeGreaterThan(0);
      for (const o of card.options) {
        if (o.hours !== undefined) expect(Number.isInteger(o.hours), card.id).toBe(true);
      }
    }
  });

  it("slots are well formed and every amount refers to a slot or an integer", () => {
    for (const card of CARDS) {
      for (const [name, spec] of Object.entries(card.slots ?? {})) {
        if (spec.kind !== "RANGE") continue;
        expect(name.endsWith("Minor"), `${card.id}.${name}`).toBe(true);
        expect(Number.isInteger(spec.min) && Number.isInteger(spec.max), card.id).toBe(true);
        expect(spec.min, card.id).toBeGreaterThan(0);
        expect(spec.max, card.id).toBeGreaterThanOrEqual(spec.min);
        expect(spec.step ?? 1, card.id).toBeGreaterThan(0);
      }
      for (const e of cardEffects(card)) {
        if (e.kind !== "PAY" && e.kind !== "RECEIVE" && e.kind !== "ADD_BILL") continue;
        if (typeof e.amount === "number") {
          expect(Number.isInteger(e.amount) && e.amount > 0, card.id).toBe(true);
        } else {
          expect(Object.keys(card.slots ?? {}), `${card.id} amount`).toContain(e.amount.slot);
        }
        if (e.kind !== "ADD_BILL")
          expect(e.account, card.id).toMatch(/^(EXPENSE|REVENUE|ASSET):[A-Z][A-Za-z0-9]*$/);
      }
    }
  });

  it("a business card names a business type and uses its own pocket", () => {
    for (const card of CARDS.filter((c) => c.businessType)) {
      for (const e of cardEffects(card)) {
        if (e.kind === "PAY" || e.kind === "RECEIVE") expect(e.pocket, card.id).toBe("card");
      }
    }
  });

  it("every template a card references exists, and every {slot} it uses is available", () => {
    const all = templates();
    for (const card of CARDS) {
      const refs = [card.title, card.body, ...card.options.map((o) => o.label)];
      const usable = usableSlots(card);
      for (const ref of refs) {
        if (isTemplateId(ref)) {
          expect(all[ref], `${card.id}: missing template ${ref}`).toBeDefined();
          expect(all[ref]?.length ?? 0, ref).toBeGreaterThanOrEqual(1);
          expect(all[ref]?.length ?? 0, ref).toBeLessThanOrEqual(3);
        }
        for (const name of placeholders(ref)) {
          expect(
            usable.has(name),
            `${card.id}: ${ref} uses {${name}} but the card has no such slot`,
          ).toBe(true);
        }
      }
    }
  });

  it("every template id in the content file is used by a card or a NOTE", () => {
    // Keeps the text file honest: no orphaned wording that nobody can ever see.
    const used = new Set<string>();
    for (const card of CARDS) {
      used.add(card.title);
      used.add(card.body);
      for (const o of card.options) used.add(o.label);
      for (const e of cardEffects(card)) if (e.kind === "NOTE") used.add(e.template);
    }
    for (const id of Object.keys(templates()).filter((k) => k.startsWith("card."))) {
      expect(used.has(id), `unused template ${id}`).toBe(true);
    }
  });

  it("template text is plain: no placeholders left unbalanced, no float-looking money", () => {
    for (const [id, variants] of Object.entries(templates())) {
      if (!id.startsWith("card.")) continue;
      for (const v of variants) {
        expect(v.split("{").length, id).toBe(v.split("}").length);
        expect(v, id).not.toMatch(/\d\.\d{3,}/);
        expect(v.trim(), id).toBe(v);
      }
    }
  });

  it("only allowed SYSTEM actions are used, with the params their owners expect", () => {
    for (const card of CARDS) {
      for (const e of cardEffects(card)) {
        if (e.kind !== "SYSTEM") continue;
        expect(ALLOWED_SYSTEM_ACTIONS as readonly string[], `${card.id}: ${e.action}`).toContain(
          e.action,
        );
        if (e.action === "credit.addLoan") {
          expect(["FRIEND", "FAMILY", "BANK", "CARD", "PAYDAY"]).toContain(e.params.lender);
          expect(Number.isInteger(e.params.amountMinor), card.id).toBe(true);
        }
        if (e.action === "business.start") {
          expect(["SERVICE", "STOCK"]).toContain(e.params.type);
          expect(Number.isInteger(e.params.capitalMinor), card.id).toBe(true);
        }
        if (e.action === "life.adjustRecurring") {
          expect(e.params.billKind, card.id).toBe("RENT");
          expect(Number.isInteger(e.params.amountMinor), card.id).toBe(true);
        }
      }
    }
  });

  it("every SCHEDULE_CARD target exists and can be triggered", () => {
    const ids = new Set(CARDS.map((c) => c.id));
    for (const card of CARDS) {
      for (const e of cardEffects(card)) {
        if (e.kind !== "SCHEDULE_CARD") continue;
        expect(ids.has(e.cardId), `${card.id} schedules ${e.cardId}`).toBe(true);
        expect(e.inDays, card.id).toBeGreaterThan(0);
      }
    }
    // A TRIGGERED card nobody schedules could never be seen.
    const scheduled = new Set(
      CARDS.flatMap((c) => cardEffects(c))
        .concat(SCENARIOS.flatMap((s) => flatten(s.start)))
        .flatMap((e) => (e.kind === "SCHEDULE_CARD" ? [e.cardId] : [])),
    );
    for (const card of CARDS.filter((c) => c.draw === "TRIGGERED"))
      expect(scheduled.has(card.id), `${card.id} is never scheduled`).toBe(true);
  });

  it("only known concepts are tagged", () => {
    for (const card of CARDS)
      for (const c of card.concepts ?? [])
        expect(KNOWN_CONCEPTS.has(c), `${card.id}: ${c}`).toBe(true);
  });

  it("poorer and richer players both get real choices", () => {
    const weeklyFor = (min: number | undefined, max: number | undefined) =>
      CARDS.filter(
        (c) =>
          c.draw === "WEEKLY" &&
          !c.businessType &&
          c.eligible.every((cond) => {
            if (cond.kind !== "CASH" || cond.pocket !== "you") return true;
            if (min !== undefined && cond.max !== undefined && cond.max < min) return false;
            if (max !== undefined && cond.min !== undefined && cond.min > max) return false;
            return true;
          }),
      );
    // Someone with €50 can still earn, borrow carefully or sell things; someone with €5,000 can
    // invest. Neither group is left with only the other's cards.
    expect(weeklyFor(undefined, 5_000).length).toBeGreaterThanOrEqual(8);
    expect(weeklyFor(500_000, undefined).length).toBeGreaterThanOrEqual(8);
    expect(CARDS.some((c) => c.id === "payday-flyer")).toBe(true);
    expect(CARDS.some((c) => c.id === "stall-offer")).toBe(true);
  });
});

describe("scenarios", () => {
  it("ids are unique and the four starting points exist", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(["first-flat", "side-studio", "the-stall", "fresh-start"]),
    );
  });

  it("numbers are integers, positive where they should be, and costs are realistic", () => {
    for (const s of SCENARIOS) {
      const p = s.person;
      for (const n of [
        s.cashMinor,
        s.hoursBudget,
        p.salaryMinor,
        p.jobHours,
        p.payDay,
        p.reputation,
        p.creditRecord,
      ])
        expect(Number.isInteger(n), s.id).toBe(true);
      expect(s.cashMinor, s.id).toBeGreaterThan(0);
      expect(s.hoursBudget, s.id).toBeGreaterThan(p.jobHours);
      expect(p.reputation >= 0 && p.reputation <= 100, s.id).toBe(true);
      expect(p.creditRecord >= 0 && p.creditRecord <= 100, s.id).toBe(true);
      expect(p.payDay >= 1 && p.payDay <= 28, s.id).toBe(true);
      if (p.jobId) {
        expect(p.salaryMinor, s.id).toBeGreaterThan(0);
        expect(p.jobHours, s.id).toBeGreaterThan(0);
      } else {
        expect(p.salaryMinor, s.id).toBe(0);
      }
      expect(s.teaches.length, s.id).toBeGreaterThan(0);
      for (const c of s.teaches) expect(KNOWN_CONCEPTS.has(c), `${s.id}: ${c}`).toBe(true);
      const kinds = s.recurring.map((r) => r.billKind);
      for (const k of ["RENT", "PHONE", "FOOD"] as const) expect(kinds, s.id).toContain(k);
      for (const r of s.recurring) {
        expect(Number.isInteger(r.amountMinor) && r.amountMinor > 0, `${s.id}: ${r.label}`).toBe(
          true,
        );
        expect(r.dayOfMonth >= 1 && r.dayOfMonth <= 28, s.id).toBe(true);
        expect(r.lateFeeMinor >= 0 && Number.isInteger(r.lateFeeMinor), s.id).toBe(true);
      }
      for (const e of flatten(s.start)) {
        if (e.kind === "SYSTEM")
          expect(ALLOWED_SYSTEM_ACTIONS as readonly string[], s.id).toContain(e.action);
        if (e.kind === "SCHEDULE_CARD")
          expect(
            CARDS.some((c) => c.id === e.cardId),
            s.id,
          ).toBe(true);
      }
    }
  });

  it("each scenario's rent notice cards match the rent it actually pays", () => {
    for (const s of SCENARIOS) {
      const rent = s.recurring.find((r) => r.billKind === "RENT")?.amountMinor ?? 0;
      for (const card of CARDS.filter((c) => c.id === `rent-notice-${s.id}`)) {
        const next = card.options
          .flatMap((o) => flatten(o.effects))
          .flatMap((e) => (e.kind === "SYSTEM" ? [Number(e.params.amountMinor)] : []));
        for (const n of next) expect(n, s.id).toBeGreaterThan(rent);
      }
    }
  });

  it("the studio, stall and starting-debt scenarios begin as described", () => {
    const by = (id: string) => SCENARIOS.find((s) => s.id === id);
    const studio = by("side-studio");
    expect(studio?.person.skills).toContain("design");
    expect(
      studio?.start.some((e) => e.kind === "SCHEDULE_CARD" && e.cardId === "studio-idea"),
    ).toBe(true);
    const stall = by("the-stall");
    expect(stall?.person.jobId).toBeNull();
    expect(stall?.flags?.["credit.family"]).toBe(true);
    const fresh = by("fresh-start");
    expect(fresh?.person.creditRecord).toBe(35);
    expect(
      fresh?.start.some(
        (e) =>
          e.kind === "SYSTEM" && e.action === "credit.addLoan" && e.params.startingDebt === true,
      ),
    ).toBe(true);
  });
});

// -- playthroughs -------------------------------------------------------------------------------

const handled = (action: string) => systems().some((s) => s.effects?.[action]);

/** True when every SYSTEM effect in the list has a handler, so applying it cannot throw. */
const runnable = (effects: readonly Effect[]) =>
  flatten(effects).every((e) => e.kind !== "SYSTEM" || handled(e.action));

const sumBalances = (s: RunState) => {
  for (const [pocket, accounts] of Object.entries(s.balances)) {
    let debit = 0;
    let credit = 0;
    for (const [acct, v] of Object.entries(accounts)) {
      if (acct.startsWith("ASSET:") || acct.startsWith("EXPENSE:")) debit += v;
      else credit += v;
    }
    expect(debit, `books of ${pocket}`).toBe(credit);
  }
};

const cashOk = (s: RunState) => {
  for (const [pocket, accounts] of Object.entries(s.balances))
    expect(accounts["ASSET:Cash"] ?? 0, `cash of ${pocket} on day ${s.day}`).toBeGreaterThanOrEqual(
      0,
    );
};

/**
 * A plain bot: pays what is due, takes the first available option of each open card, otherwise
 * advances. It skips options whose module effects are not implemented yet, so the content can be
 * exercised before every work package has landed.
 */
function play(scenarioId: string, seed: string, days: number) {
  let state = startRun("run_content", seed, scenarioId);
  const opened = new Set<string>();
  let guard = 0;
  while (state.day < days && guard++ < 20_000) {
    for (const c of state.cards) opened.add(c.cardId);
    let cmd: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };
    const due = state.bills.find(
      (b) =>
        (b.status === "DUE" || b.status === "LATE") &&
        (state.balances[b.pocket]?.["ASSET:Cash"] ?? 0) >= b.amountMinor,
    );
    if (due) cmd = { kind: "PAY_BILL", billId: due.id };
    else {
      for (const card of state.cards) {
        const def = CARDS.find((c) => c.id === card.cardId);
        const option = def?.options.find((o) => {
          if (!runnable(o.effects)) return false;
          const probe = apply(state, { kind: "CHOOSE", cardId: card.id, optionId: o.id });
          return probe.refusal === null;
        });
        if (option) {
          cmd = { kind: "CHOOSE", cardId: card.id, optionId: option.id };
          break;
        }
      }
    }
    const r = apply(state, cmd);
    if (r.refusal) throw new Error(`${cmd.kind} refused on day ${state.day}: ${r.refusal.code}`);
    state = r.state;
    cashOk(state);
  }
  for (const c of state.cards) opened.add(c.cardId);
  for (const e of state.events) if (e.refs.cardId) opened.add(e.refs.cardId);
  return { state, opened };
}

describe("playthroughs", () => {
  it("first-flat plays two years: books balance, cash never negative, many cards appear", () => {
    const { state, opened } = play("first-flat", "content-seed-1", 336 * 2 + 2);
    expect(state.day).toBeGreaterThan(336 * 2);
    sumBalances(state);
    expect(state.events.some((e) => e.kind === "YEAR_END")).toBe(true);
    // Reported so a content author can see which cards a plain run actually reaches.
    console.info(`first-flat opened ${opened.size} cards: ${[...opened].sort().join(", ")}`);
    expect(opened.size).toBeGreaterThanOrEqual(8);
  });

  it("different seeds give different lives", () => {
    const a = play("first-flat", "content-seed-A", 120).state;
    const b = play("first-flat", "content-seed-B", 120).state;
    expect(a.events.map((e) => e.text).join("|")).not.toBe(b.events.map((e) => e.text).join("|"));
  });

  for (const s of SCENARIOS.filter((x) => x.id !== "first-flat")) {
    const needs = flatten(s.start).flatMap((e) => (e.kind === "SYSTEM" ? [e.action] : []));
    const missing = needs.filter((a) => !handled(a));
    const run = missing.length === 0;
    it.skipIf(!run)(
      `${s.id} plays one year without errors${run ? "" : ` (skipped: no handler yet for ${missing.join(", ")})`}`,
      () => {
        const { state, opened } = play(s.id, `content-${s.id}`, 336 + 2);
        sumBalances(state);
        console.info(`${s.id} opened ${opened.size} cards: ${[...opened].sort().join(", ")}`);
      },
    );
  }

  it("the studio offer appears on day two for the side-studio scenario", () => {
    // The card is scheduled for tomorrow, so it must be open once a day has passed.
    const s = startRun("run_studio", "studio-seed", "side-studio");
    const next = apply(s, { kind: "ADVANCE", mode: "NEXT_STOP" }).state;
    expect(next.day).toBe(2);
    expect(next.cardHistory["studio-idea"]?.times).toBe(1);
  });
});
