import { Ledger } from "@fle/domain";
import { isWeekStart, MAX_DAY } from "./clock.js";
import { scenario as scenarioById } from "./content/scenarios.js";
import { applyEffects } from "./effects.js";
import { systems } from "./systems/index.js";
import {
  type Command,
  type Refusal,
  RUN_RULES_VERSION,
  type RunEvent,
  type RunState,
  type Stop,
  YOU,
} from "./types.js";
import { World } from "./world.js";

/** Most stops kept at one pause; older ones are dropped (the feed still has everything). */
const MAX_STOPS = 12;
/** NEXT_STOP never runs more than a month without pausing (month end always pauses anyway). */
const MAX_DAYS_PER_ADVANCE = 28;

/** Plain parts are deep-copied; the ledger is immutable and shared. */
export function cloneState(s: RunState): RunState {
  // Keeps key order (ledger stays in place), so serialised states compare and hash equal.
  const copy = structuredClone({ ...s, ledger: null }) as unknown as { ledger: unknown };
  copy.ledger = s.ledger;
  return copy as RunState;
}

function beginDay(w: World): void {
  const due = w.s.scheduled.filter((x) => x.day <= w.day);
  if (due.length > 0) {
    w.s.scheduled = w.s.scheduled.filter((x) => x.day > w.day);
    for (const item of due)
      applyEffects(w, item.effects, { pocket: item.pocket, slots: {}, path: item.id });
  }
  for (const sys of systems()) sys.beginDay?.(w);
}

function endDay(w: World): void {
  for (const sys of systems()) sys.endDay?.(w);
}

/** A new run on day 1, morning: opening balances, the scenario's commitments, first cards. */
export function startRun(runId: string, seed: string, scenarioId: string): RunState {
  const sc = scenarioById(scenarioId);
  const s: RunState = {
    rulesVersion: RUN_RULES_VERSION,
    runId,
    scenarioId,
    seed,
    day: 1,
    person: {
      name: sc.person.name,
      jobId: sc.person.jobId,
      jobLabel: sc.person.jobLabel,
      salaryMinor: sc.person.salaryMinor,
      jobHours: sc.person.jobId ? sc.person.jobHours : 0,
      skills: [...sc.person.skills],
      reputation: sc.person.reputation,
      creditRecord: sc.person.creditRecord,
      workedStreak: 0,
      wornOutWeeks: 0,
    },
    hours: { budget: sc.hoursBudget, committed: 0, used: 0 },
    bills: [],
    invoices: [],
    loans: [],
    businesses: [],
    cards: [],
    cardHistory: {},
    flags: { ...(sc.flags ?? {}) },
    recurring: [],
    scheduled: [],
    events: [],
    stops: [],
    learning: { predictions: [], questions: [], answers: [], seen: {} },
    nextId: 1,
    ledger: Ledger.empty(),
    balances: {},
  };
  const w = new World(s);
  w.post(YOU, "Opening balance", [
    ["ASSET:Cash", "DEBIT", sc.cashMinor],
    ["EQUITY:Opening", "CREDIT", sc.cashMinor],
  ]);
  for (const r of sc.recurring) s.recurring.push({ ...r, id: w.id("rec"), untilDay: null });
  if (sc.person.jobId && sc.person.salaryMinor > 0) {
    s.recurring.push({
      id: "salary",
      pocket: YOU,
      label: sc.person.jobLabel ?? "Pay",
      direction: "IN",
      amountMinor: sc.person.salaryMinor,
      dayOfMonth: sc.person.payDay,
      account: "REVENUE:Wages",
      billKind: null,
      payee: null,
      graceDays: 0,
      lateFeeMinor: 0,
      autopay: true,
      untilDay: null,
    });
  }
  for (const sys of systems()) sys.init?.(w, sc);
  applyEffects(w, sc.start, { pocket: YOU, slots: {}, path: "start" });
  w.recomputeCommitted();
  beginDay(w);
  s.stops.unshift({ kind: "RUN_START", text: sc.title, ref: null });
  return s;
}

function handler(cmd: Command) {
  for (const sys of systems()) {
    const h = sys.commands?.[cmd.kind];
    if (h) return h as (w: World, c: Command) => Refusal | undefined;
  }
  return null;
}

function advance(w: World, mode: "NEXT_STOP" | "WEEK"): Refusal | undefined {
  if (w.day >= MAX_DAY) return { code: "RUN_OVER", message: "This run has reached its last day." };
  w.s.stops = [];
  for (let i = 0; i < MAX_DAYS_PER_ADVANCE && w.day < MAX_DAY; i++) {
    endDay(w);
    w.s.day += 1;
    beginDay(w);
    const stops = w.s.stops;
    if (mode === "NEXT_STOP" && stops.length > 0) break;
    if (
      mode === "WEEK" &&
      (isWeekStart(w.day) || stops.some((x) => x.kind === "MONTH_END" || x.kind === "YEAR_END"))
    )
      break;
  }
  if (w.s.stops.length > MAX_STOPS) w.s.stops = w.s.stops.slice(-MAX_STOPS);
  return undefined;
}

/** Drop stops about things already dealt with (a chosen card, a paid bill). */
function pruneStops(s: RunState): void {
  s.stops = s.stops.filter((x: Stop) => {
    if (!x.ref) return true;
    if (x.ref.startsWith("card_")) return s.cards.some((c) => c.id === x.ref);
    if (x.ref.startsWith("bill_"))
      return s.bills.some((b) => b.id === x.ref && b.status !== "PAID");
    return true;
  });
}

export interface ApplyResult {
  readonly state: RunState;
  readonly refusal: Refusal | null;
  /** Events this command produced. */
  readonly events: readonly RunEvent[];
}

/**
 * Apply one command in place. Only `apply` (which clones first) and `replay` (which owns its
 * state) call this. A refusal must leave the state unchanged; every handler checks before it acts.
 */
function applyInPlace(s: RunState, cmd: Command): ApplyResult {
  const before = s.events.length;
  const w = new World(s);
  let refusal: Refusal | undefined;
  if (cmd.kind === "ADVANCE") refusal = advance(w, cmd.mode);
  else {
    const h = handler(cmd);
    refusal = h
      ? h(w, cmd)
      : { code: "NOT_AVAILABLE", message: "That action is not available yet." };
    if (!refusal) pruneStops(s);
  }
  return { state: s, refusal: refusal ?? null, events: s.events.slice(before) };
}

/** Apply one command to a copy. On refusal the original state is returned untouched. */
export function apply(state: RunState, cmd: Command): ApplyResult {
  const draft = cloneState(state);
  const result = applyInPlace(draft, cmd);
  if (result.refusal) return { state, refusal: result.refusal, events: [] };
  return result;
}

export class ReplayError extends Error {}

/**
 * Rebuild a run from its start and its log of accepted commands. Deterministic: the same inputs
 * always give the same state. A command that is refused on replay means the log was tampered
 * with or the rules changed; that is an error, never silently skipped.
 */
export function replay(
  runId: string,
  seed: string,
  scenarioId: string,
  log: readonly Command[],
): RunState {
  const s = startRun(runId, seed, scenarioId);
  log.forEach((cmd, i) => {
    const r = applyInPlace(s, cmd);
    if (r.refusal)
      throw new ReplayError(`command ${i} (${cmd.kind}) refused on replay: ${r.refusal.code}`);
  });
  return s;
}
