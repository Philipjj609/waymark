/**
 * #88: server-authoritative figures used in the wrong temporal or financial context.
 * Production, 7 Nov: "You held 770.00 EUR (fictional) before paying" (real cash before: 800.00).
 */
import type { DomainEvent, LearnerId, WorldSnapshot } from "@fle/contracts";
import { createLearnerState } from "@fle/learning";
import { cmd, execute, fp30, PERSON, PHONE, playerCommand, RENT, snapshot } from "@fle/simulation";
import { describe, expect, it } from "vitest";
import {
  buildTutorContext,
  checkModelText,
  explainOutcome,
  FACTS_CHECK,
  FakeTutorProvider,
  factsText,
  type TutorContext,
} from "../src/index.js";

type Body = Parameters<typeof playerCommand>[2];
const eur = (major: number) => ({ amountMinor: major * 100, currency: "EUR" as const });
const learnerState = createLearnerState("lrn_semantic" as LearnerId);

function world(...bodies: Body[]): {
  ctx: TutorContext;
  snap: WorldSnapshot;
  events: DomainEvent[];
} {
  let state = fp30();
  const events: DomainEvent[] = [];
  bodies.forEach((body, i) => {
    const out = execute(state, playerCommand(state, cmd(i + 1), body));
    expect(out.result.status, JSON.stringify(out.result)).toBe("ACCEPTED");
    state = out.state;
    events.push(...out.events);
  });
  const snap = snapshot(state);
  return { ctx: buildTutorContext({ snapshot: snap, events, learnerState }), snap, events };
}

const to = (targetDay: number): Body => ({ kind: "ADVANCE_TIME", payload: { targetDay } });
const pay = (obligationId: string): Body =>
  ({ kind: "PAY_OBLIGATION", payload: { obligationId } }) as Body;
const defer = (obligationId: string): Body =>
  ({ kind: "DEFER_OBLIGATION", payload: { obligationId } }) as Body;
const buy = (label: string, major: number): Body =>
  ({ kind: "PURCHASE_ASSET", payload: { entityId: PERSON, label, cost: eur(major) } }) as Body;

/** The production case: day 8, phone bill paid, cash 800 -> 770, rent (550) due on day 10. */
const paidPhone = () => world(to(8), pay(PHONE));
/** Cash moved AFTER the decision: rent paid on day 10 (770 -> 220), salary on day 15 (-> 1120). */
const paidRentThenSalary = () => world(to(8), pay(PHONE), to(10), pay(RENT), to(15));
const deferredRent = () => world(to(8), pay(PHONE), to(10), defer(RENT));
const boughtBike = () => world(buy("Bicycle", 120));
const noDecision = () => world(to(3));

const codes = (text: string, ctx: TutorContext) => checkModelText(text, ctx).map((i) => i.code);

describe("authoritative decision context (#88)", () => {
  it("payment: cash before, after and now, the amount, the creditor and the next bill", () => {
    const { ctx } = paidPhone();
    expect(ctx.decision).toMatchObject({
      action: "PAY_OBLIGATION",
      obligationId: PHONE,
      day: 8,
      amountMinor: 3000,
      creditor: "Phone provider (fictional)",
      dueDay: 8,
      cashBeforeMinor: 80000,
      cashAfterMinor: 77000,
    });
    expect(ctx.cashMinor).toBe(77000);
    expect(ctx.nextBill).toEqual({
      obligationId: RENT,
      creditor: "Landlord (fictional)",
      amountMinor: 55000,
      remainingMinor: 55000,
      dueDay: 10,
    });
  });

  it("events after the decision move cash NOW but not the decision's before/after", () => {
    const { ctx } = paidRentThenSalary();
    expect(ctx.decision).toMatchObject({
      obligationId: RENT,
      cashBeforeMinor: 77000,
      cashAfterMinor: 22000,
      amountMinor: 55000,
    });
    expect(ctx.cashMinor).toBe(112000);
    expect(ctx.nextBill).toBeNull();
  });

  it("deferral: no cash change; the amount is what is still owed", () => {
    const { ctx } = deferredRent();
    expect(ctx.decision).toMatchObject({
      action: "DEFER_OBLIGATION",
      amountMinor: 55000,
      cashBeforeMinor: 77000,
      cashAfterMinor: 77000,
    });
    expect(ctx.nextBill?.obligationId).toBe(RENT);
  });

  it("purchase: cost and item label from the event", () => {
    const { ctx } = boughtBike();
    expect(ctx.decision).toMatchObject({
      action: "PURCHASE_ASSET",
      item: "Bicycle",
      amountMinor: 12000,
      cashBeforeMinor: 80000,
      cashAfterMinor: 68000,
      obligationId: null,
    });
  });
});

describe("deterministic facts block (#88)", () => {
  it("states the production case correctly: 800 before, 770 after, rent next", () => {
    expect(factsText(paidPhone().ctx)).toBe(
      "On day 8 you paid Phone provider (fictional) 30.00 EUR (fictional). " +
        "Your cash went from 800.00 EUR (fictional) to 770.00 EUR (fictional). Today is day 8. " +
        "Next bill: Landlord (fictional) is owed 550.00 EUR (fictional), due on day 10.",
    );
  });
  it("separates later changes from the decision, and says when nothing is owed", () => {
    expect(factsText(paidRentThenSalary().ctx)).toBe(
      "On day 10 you paid Landlord (fictional) 550.00 EUR (fictional). " +
        "Your cash went from 770.00 EUR (fictional) to 220.00 EUR (fictional). " +
        "Later events changed it again: today (day 15) you hold 1120.00 EUR (fictional). " +
        "No bills are still owed.",
    );
  });
  it("deferral and purchase", () => {
    expect(factsText(deferredRent().ctx)).toBe(
      "On day 10 you deferred the bill from Landlord (fictional) (550.00 EUR (fictional) still owed). " +
        "Your cash stayed at 770.00 EUR (fictional). Today is day 10. " +
        "Next bill: Landlord (fictional) is owed 550.00 EUR (fictional), overdue (it was due on day 10).",
    );
    expect(factsText(boughtBike().ctx)).toBe(
      "On day 1 you bought Bicycle for 120.00 EUR (fictional). " +
        "Your cash went from 800.00 EUR (fictional) to 680.00 EUR (fictional). Today is day 1. " +
        "Next bill: Phone provider (fictional) is owed 30.00 EUR (fictional), due on day 8.",
    );
  });
  it("without a decision: today, cash now and the next bill", () => {
    expect(factsText(noDecision().ctx)).toBe(
      "Today is day 3 and you hold 800.00 EUR (fictional). " +
        "Next bill: Phone provider (fictional) is owed 30.00 EUR (fictional), due on day 8.",
    );
  });
});

describe("temporal context of cash figures (#88)", () => {
  it("rejects the exact production sentence and its variants", () => {
    const { ctx } = paidPhone();
    for (const text of [
      "You held {{cash}} before paying.",
      "You held {{cash}} before paying. You paid {{decision.creditor}} {{decision.amount}}. Your cash balance is now {{cash}}.",
      "Before paying, you had {{cash}}.",
      "Before you paid {{decision.creditor}}, your cash was {{cash}}.",
      "Previously you had {{cash}}.",
      "You started with {{cash}}.",
      "Prior to the payment you held {{cash.now}}.",
      "You now have {{cash.before}}.",
      "You currently hold {{cash.before}}.",
      "After paying, you had {{cash.before}}.",
      "Paying left you with {{cash.before}}.",
      "Before paying you had {{cash.after}}.",
    ])
      expect(codes(text, ctx), text).toContain("TEMPORAL_MISMATCH");
  });

  it("accepts each moment in matching words", () => {
    const { ctx } = paidPhone();
    for (const text of [
      "Before paying you had {{cash.before}}.",
      "You had {{cash.before}} before paying, and now hold {{cash}}.",
      "Your cash went from {{cash.before}} to {{cash.after}}.",
      "Paying {{decision.creditor}} {{decision.amount}} left you with {{cash.after}}.",
      "Paying left you with {{cash}}.", // nothing changed since the decision, so after == now
      "You now hold {{cash}}.",
      "Your cash fell by {{cash.change}}.",
      "{{nextBill.creditor}} is still owed {{nextBill.remaining}}, due on {{nextBill.dueDay}}.",
      "First, think about how your cash compares with what you owe.",
    ])
      expect(codes(text, ctx), text).toEqual([]);
  });

  it("when cash moved after the decision, 'after' and 'now' are different figures", () => {
    const { ctx } = paidRentThenSalary();
    expect(codes("You now hold {{cash.after}}.", ctx)).toContain("TEMPORAL_MISMATCH");
    expect(codes("Paying left you with {{cash}}.", ctx)).toContain("TEMPORAL_MISMATCH");
    expect(codes("Paying left you with {{cash.after}}, and you now hold {{cash}}.", ctx)).toEqual(
      [],
    );
  });

  it("decision and next-bill placeholders need a decision and a bill still owed", () => {
    const none = noDecision().ctx;
    expect(codes("Before paying you had {{cash.before}}.", none)).toEqual(["NO_DECISION"]);
    expect(codes("You paid {{decision.amount}}.", none)).toEqual(["NO_DECISION"]);
    const settled = paidRentThenSalary().ctx;
    expect(codes("{{nextBill.creditor}} is next.", settled)).toEqual(["NO_NEXT_BILL"]);
    expect(codes("You bought {{decision.item}}.", paidPhone().ctx)).toEqual(["NO_DECISION"]);
  });
});

describe("financial context: obligation identity, settled bills, actions (#88)", () => {
  it("rejects one bill's figure next to another bill's creditor", () => {
    const { ctx } = paidPhone();
    for (const text of [
      `{{bill:${PHONE}.creditor}} is owed {{bill:${RENT}.remaining}}.`,
      "You paid {{decision.creditor}} {{nextBill.amount}}.",
      "{{nextBill.creditor}} is due on {{decision.dueDay}}.",
      `{{bill:${RENT}.creditor}} was paid {{decision.amount}}.`,
    ])
      expect(codes(text, ctx), text).toContain("OBLIGATION_MISMATCH");
    expect(
      codes(
        "You paid {{decision.creditor}} {{decision.amount}}, and {{nextBill.creditor}} is owed {{nextBill.remaining}}.",
        ctx,
      ),
    ).toEqual([]);
  });

  it("rejects a settled bill described as owed, and .amount where .remaining is owed", () => {
    const { ctx } = paidPhone();
    expect(codes("{{decision.creditor}} is still owed {{decision.amount}}.", ctx)).toContain(
      "SETTLED_AS_OWED",
    );
    expect(codes(`{{bill:${PHONE}.creditor}} is owed {{bill:${PHONE}.amount}}.`, ctx)).toContain(
      "SETTLED_AS_OWED",
    );
    expect(codes("You owe {{cash}}.", ctx)).toContain("MISPLACED_FIGURE");
  });

  it("rejects action words that contradict what happened to that bill", () => {
    const paid = paidPhone().ctx;
    expect(codes("You deferred {{decision.creditor}}.", paid)).toContain("ACTION_MISMATCH");
    expect(codes(`You paid {{bill:${RENT}.creditor}}.`, paid)).toContain("ACTION_MISMATCH");
    expect(codes("You bought {{decision.creditor}}.", paid)).toContain("ACTION_MISMATCH");
    const deferred = deferredRent().ctx;
    expect(codes("You paid {{decision.creditor}} {{decision.amount}}.", deferred)).toContain(
      "ACTION_MISMATCH",
    );
    expect(codes("You have not paid {{decision.creditor}} yet.", deferred)).toEqual([]);
    expect(codes("You deferred {{decision.creditor}}.", deferred)).toEqual([]);
    expect(
      codes("You bought {{decision.item}} for {{decision.amount}}.", boughtBike().ctx),
    ).toEqual([]);
  });

  it("rejects the wrong direction of a cash change", () => {
    expect(codes("Your cash rose by {{cash.change}}.", paidPhone().ctx)).toContain(
      "DIRECTION_MISMATCH",
    );
    expect(codes("Your cash fell by {{cash.change}}.", deferredRent().ctx)).toContain(
      "DIRECTION_MISMATCH",
    );
  });

  it("rejects a cash figure in a clause that is not about the learner's cash", () => {
    const { ctx } = paidPhone();
    expect(codes("Your rent is {{cash}}.", ctx)).toContain("MISPLACED_FIGURE");
    expect(codes("{{nextBill.creditor}} is owed {{cash}}.", ctx)).toContain("MISPLACED_FIGURE");
  });
});

describe("previously reported word-list evasions (#88 review of #86)", () => {
  const { ctx } = paidPhone();
  const cases: Array<[string, string]> = [
    ["sev​en days to go", "INVISIBLE_CHARACTER"],
    ["sev​en days to go", "NUMBER_WORD"],
    ["sev́en days to go", "NUMBER_WORD"],
    ["ѕeven days to go", "NON_LATIN_SCRIPT"],
    ["On the fifth day it is due.", "NUMBER_WORD"],
    ["On the second day of the month it is due.", "NUMBER_WORD"],
    ["You spent twice as much.", "NUMBER_WORD"],
    ["Rent costs double that.", "NUMBER_WORD"],
    ["A quarter of your cash.", "NUMBER_WORD"],
    ["Ten percent of it.", "NUMBER_WORD"],
    ["Most of it, about %.", "NUMBER_WORD"],
    ["Wait dos días.", "NUMBER_WORD"],
    ["It cost you pesos.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
    ["Pay in yuan.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
    ["Many rupees.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
    ["Pay ACME LTD soon.", "UNSOURCED_NAME"],
    ["Pay Acme Ltd soon.", "UNSOURCED_NAME"],
  ];
  for (const [text, code] of cases)
    it(`${JSON.stringify(text)} -> ${code}`, () => expect(codes(text, ctx)).toContain(code));

  it("ordinary prose with accents and 'first' passes", () => {
    expect(
      codes("First, compare your cash with what is owed. A café visit is a choice.", ctx),
    ).toEqual([]);
  });
});

describe("end to end: invalid explanations fall back safely (#88)", () => {
  const run = (behavior: "valid" | "temporal-misuse" | "obligation-mismatch") => {
    const { snap, events } = paidPhone();
    const provider = new FakeTutorProvider([behavior]);
    return explainOutcome({ snapshot: snap, events, learnerState, provider }).then((lesson) => ({
      lesson,
      provider,
    }));
  };

  it("the production misuse is repaired once, then replaced by facts + reviewed content", async () => {
    const { lesson, provider } = await run("temporal-misuse");
    expect(provider.calls).toHaveLength(2);
    expect(lesson.validation.status).toBe("FALLBACK_REVIEWED");
    expect(lesson.validation.checks).toContain(FACTS_CHECK);
    expect(lesson.validation.checks.join(" ")).toContain("TEMPORAL_MISMATCH");
    const text = JSON.stringify(lesson.blocks);
    expect(text).not.toContain("You held");
    expect(lesson.blocks[0]).toEqual({
      type: "text",
      markdown: expect.stringContaining(
        "Your cash went from 800.00 EUR (fictional) to 770.00 EUR (fictional).",
      ),
    });
    // The repair request told the model what was wrong.
    expect(provider.calls[1]?.user).toContain("TEMPORAL_MISMATCH");
  });

  it("a mismatched obligation falls back too", async () => {
    const { lesson } = await run("obligation-mismatch");
    expect(lesson.validation.status).toBe("FALLBACK_REVIEWED");
    expect(lesson.validation.checks.join(" ")).toContain("OBLIGATION_MISMATCH");
  });

  it("a valid lesson: facts block first, then the model's interpretation", async () => {
    const { lesson } = await run("valid");
    expect(lesson.validation.status).toBe("VALIDATED");
    expect(lesson.validation.checks[0]).toBe(FACTS_CHECK);
    expect(lesson.blocks[0]).toEqual({ type: "text", markdown: factsText(paidPhone().ctx) });
    expect(JSON.stringify(lesson.blocks[1])).toContain(
      "Before your decision you had 800.00 EUR (fictional); afterwards you had 770.00 EUR (fictional).",
    );
  });
});
