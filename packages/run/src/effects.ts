import { addBill } from "./systems/bills-core.js";
import { systems } from "./systems/index.js";
import type { EffectCtx } from "./systems/types.js";
import type { Amount, Effect, PocketId, PocketRef } from "./types.js";
import { euros, type World } from "./world.js";

export function amountOf(a: Amount, ctx: EffectCtx): number {
  if (typeof a === "number") return a;
  const v = ctx.slots[a.slot];
  if (typeof v !== "number") throw new Error(`amount slot ${a.slot} is not a number`);
  return v;
}

export function pocketOf(ref: PocketRef, ctx: EffectCtx): PocketId {
  if (ref === "card") return ctx.pocket;
  return ref;
}

function systemHandler(action: string) {
  for (const sys of systems()) {
    const h = sys.effects?.[action];
    if (h) return h;
  }
  throw new Error(`no system handles effect ${action}`);
}

/**
 * Apply effects in order. Effects never make cash negative: a PAY that cannot be met becomes a
 * bill due in a week (you now owe it), which is what happens in life.
 */
export function applyEffects(w: World, effects: readonly Effect[], ctx: EffectCtx): void {
  for (const [i, e] of effects.entries()) applyEffect(w, e, { ...ctx, path: `${ctx.path}/${i}` });
}

function applyEffect(w: World, e: Effect, ctx: EffectCtx): void {
  const s = w.s;
  switch (e.kind) {
    case "PAY": {
      const pocket = pocketOf(e.pocket, ctx);
      const amount = amountOf(e.amount, ctx);
      if (w.spend(pocket, e.account, amount, e.memo)) {
        w.emit("PAID", w.t("core.paid", { memo: e.memo, amount: euros(amount) }), {
          pocket,
          amountMinor: amount,
        });
      } else {
        addBill(w, {
          pocket,
          kind: "OTHER",
          label: e.memo,
          payee: e.memo,
          amountMinor: amount,
          account: e.account,
          inDays: 7,
        });
      }
      return;
    }
    case "RECEIVE": {
      const pocket = pocketOf(e.pocket, ctx);
      const amount = amountOf(e.amount, ctx);
      if (e.inDays && e.inDays > 0) {
        w.schedule({
          inDays: e.inDays,
          effects: [{ kind: "RECEIVE", pocket, amount, account: e.account, memo: e.memo }],
          hidden: false,
          source: ctx.path,
          label: e.memo,
          pocket,
          direction: "IN",
          amountMinor: amount,
        });
        return;
      }
      w.earn(pocket, e.account, amount, e.memo);
      w.emit("RECEIVED", w.t("core.received", { memo: e.memo, amount: euros(amount) }), {
        pocket,
        amountMinor: amount,
      });
      return;
    }
    case "ADD_BILL":
      addBill(w, {
        pocket: pocketOf(e.pocket, ctx),
        kind: e.billKind,
        label: e.label,
        payee: e.payee,
        amountMinor: amountOf(e.amount, ctx),
        account: e.account,
        inDays: e.inDays,
        graceDays: e.graceDays,
        lateFeeMinor: e.lateFeeMinor,
      });
      return;
    case "SET_FLAG":
      s.flags[e.flag] = e.value;
      return;
    case "ADD_FLAG": {
      const v = s.flags[e.flag];
      s.flags[e.flag] = (typeof v === "number" ? v : 0) + e.by;
      return;
    }
    case "REPUTATION": {
      if (e.target === "card" && ctx.pocket !== "you") {
        const b = s.businesses.find((x) => x.id === ctx.pocket);
        if (b) b.reputation = w.clamp100(b.reputation + e.by);
      } else {
        s.person.reputation = w.clamp100(s.person.reputation + e.by);
      }
      return;
    }
    case "CREDIT_RECORD":
      s.person.creditRecord = w.clamp100(s.person.creditRecord + e.by);
      return;
    case "ADD_SKILL":
      if (!s.person.skills.includes(e.skill)) s.person.skills.push(e.skill);
      return;
    case "SET_JOB": {
      const p = s.person;
      p.jobId = e.jobId;
      p.jobLabel = e.jobId ? (e.label ?? p.jobLabel) : null;
      p.salaryMinor = e.jobId ? (e.salaryMinor ?? p.salaryMinor) : 0;
      p.jobHours = e.jobId ? (e.hours ?? p.jobHours) : 0;
      s.recurring = s.recurring.filter((r) => r.id !== "salary");
      if (e.jobId && p.salaryMinor > 0) {
        s.recurring.push({
          id: "salary",
          pocket: "you",
          label: p.jobLabel ?? "Pay",
          direction: "IN",
          amountMinor: p.salaryMinor,
          dayOfMonth: e.payDay ?? 25,
          account: "REVENUE:Wages",
          billKind: null,
          payee: null,
          graceDays: 0,
          lateFeeMinor: 0,
          autopay: true,
          untilDay: null,
        });
      }
      w.recomputeCommitted();
      return;
    }
    case "USE_HOURS":
      s.hours.used += e.hours;
      return;
    case "SCHEDULE_CARD":
      w.schedule({
        inDays: e.inDays,
        effects: [
          {
            kind: "SYSTEM",
            action: "cards.open",
            params: { cardId: e.cardId, pocket: ctx.pocket },
          },
        ],
        hidden: true,
        source: ctx.path,
      });
      return;
    case "CHANCE": {
      const roll = w.rng(`chance:${ctx.path}`).int(1, 100);
      applyEffects(w, roll <= e.percent ? e.then : (e.else ?? []), ctx);
      return;
    }
    case "NOTE":
      w.emit("NOTE", w.t(e.template, ctx.slots as Record<string, string | number>, ctx.path), {});
      return;
    case "SYSTEM":
      systemHandler(e.action)(w, e.params, ctx);
      return;
  }
}

/**
 * Why these effects cannot run right now, or null. Checks only what is certain before choosing:
 * top-level PAY totals per pocket and module blockers. CHANCE branches are not prechecked.
 */
export function blockerOf(w: World, effects: readonly Effect[], ctx: EffectCtx): string | null {
  const need = new Map<PocketId, number>();
  for (const [i, e] of effects.entries()) {
    if (e.kind === "PAY") {
      const p = pocketOf(e.pocket, ctx);
      need.set(p, (need.get(p) ?? 0) + amountOf(e.amount, ctx));
    }
    if (e.kind === "SYSTEM") {
      for (const sys of systems()) {
        const b = sys.effectBlocker?.[e.action];
        if (b) {
          const why = b(w, e.params, { ...ctx, path: `${ctx.path}/${i}` });
          if (why) return why;
        }
      }
    }
  }
  for (const [pocket, amount] of need) {
    if (w.cash(pocket) < amount) return `Needs ${euros(amount)} in cash.`;
  }
  return null;
}
