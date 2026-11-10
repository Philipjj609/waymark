import type { Business, BusinessType, LeverValue, Minor, Refusal } from "../types.js";
import { YOU } from "../types.js";
import type { BusinessView, LeverView } from "../view-types.js";
import { euros, percentOf, type World } from "../world.js";
import { addBill } from "./bills-core.js";
import {
  BULK_DISCOUNT_PCT,
  BULK_UNITS,
  CLIENT_NAMES,
  defaultLevers,
  HELPER_HOURS,
  HELPER_WEEKLY_MINOR,
  HOURS_PER_DAY_OPEN,
  IMPLEMENTED,
  isMarketingLevel,
  JOB_HOURS,
  type LeverSpec,
  leverAllows,
  leverSpecs,
  MARKETING,
  type PriceLevel,
  SEASON_PCT,
  SERVICE_BASE_JOBS_X100,
  SERVICE_PRICE,
  SERVICE_TERMS_DEMAND_PCT,
  SPOIL_PCT,
  STALL_FEE_MINOR,
  STOCK_BASE_UNITS_X100,
  stockPriceDemandPct,
  stockPriceMinor,
  TERMS_DAYS,
  TYPE_LABEL,
  UNIT_COST_MINOR,
} from "./business-types.js";
import { issueInvoice } from "./invoices-core.js";
import type { EffectCtx, RunSystem } from "./types.js";

const refuse = (code: string, message: string): Refusal => ({ code, message });

// -- start -----------------------------------------------------------------------------------

interface StartParams {
  readonly type: BusinessType;
  readonly name: string;
  readonly capitalMinor: Minor;
  readonly fromOutside: boolean;
  /** Items already on the shelves when the shop opens (STOCK only), bought from the capital. */
  readonly openingStockUnits: number;
}

const TYPES: readonly string[] = ["SERVICE", "STOCK", "SUBSCRIPTION", "EQUIPMENT"];

/** Parse the loosely typed params of a SYSTEM effect. Null when they are not usable. */
function parseStart(params: Readonly<Record<string, unknown>>): StartParams | null {
  const { type, name, capitalMinor, fromOutside, openingStockUnits } = params;
  if (typeof type !== "string" || !TYPES.includes(type)) return null;
  if (typeof capitalMinor !== "number" || !Number.isInteger(capitalMinor) || capitalMinor < 1)
    return null;
  const cleaned = typeof name === "string" ? name.trim().slice(0, 40) : "";
  return {
    type: type as BusinessType,
    name: cleaned || "My business",
    capitalMinor,
    fromOutside: fromOutside === true,
    openingStockUnits:
      typeof openingStockUnits === "number" && Number.isInteger(openingStockUnits)
        ? Math.max(0, openingStockUnits)
        : 0,
  };
}

function startBusiness(w: World, p: StartParams): void {
  if (!IMPLEMENTED.includes(p.type)) return;
  // Checked before an id is spent, so a failed start leaves no trace.
  if (!p.fromOutside && w.cash(YOU) < p.capitalMinor) return;
  const id = w.id("biz");
  const biz: Business = {
    id,
    type: p.type,
    name: p.name,
    openedDay: w.day,
    levers: defaultLevers(p.type),
    stockUnits: 0,
    reputation: 50,
    status: "OPEN",
    memory: {},
  };
  w.s.businesses.push(biz);
  if (p.fromOutside) {
    // A gift: the business gets owner capital, you get a stake you did not pay for.
    w.post(id, "Starting money (gift)", [
      ["ASSET:Cash", "DEBIT", p.capitalMinor],
      ["EQUITY:OwnerCapital", "CREDIT", p.capitalMinor],
    ]);
    w.post(YOU, "Stake in a gifted business", [
      ["ASSET:BusinessStake", "DEBIT", p.capitalMinor],
      ["REVENUE:Gifts", "CREDIT", p.capitalMinor],
    ]);
  } else {
    w.transfer(YOU, id, p.capitalMinor, "Starting money for a business");
  }
  w.recomputeCommitted();
  // Opening stock comes out of the business's own cash, never out of yours.
  const openingCost = p.type === "STOCK" ? restockCost(p.openingStockUnits) : 0;
  const stocked = openingCost > 0 && w.cash(id) >= openingCost;
  w.emit(
    "BUSINESS_STARTED",
    w.t(p.fromOutside ? "business.started.gift" : "business.started", {
      name: p.name,
      amount: euros(p.capitalMinor),
    }),
    {
      pocket: id,
      amountMinor: p.capitalMinor,
      refs: { businessId: id, type: p.type },
      concepts: ["cpt_cash_balance"],
    },
  );
  if (stocked) {
    w.post(id, "Opening stock", [
      ["ASSET:Stock", "DEBIT", openingCost],
      ["ASSET:Cash", "CREDIT", openingCost],
    ]);
    biz.stockUnits = p.openingStockUnits;
    refreshUnitCost(w, biz);
    // Not BUSINESS_RESTOCK: this is the scenario's setup, not a choice the player made.
    w.emit(
      "BUSINESS_STOCKED",
      w.t("business.stocked", {
        name: p.name,
        units: p.openingStockUnits,
        amount: euros(openingCost),
      }),
      { pocket: id, amountMinor: openingCost, refs: { businessId: id } },
    );
  }
}

// -- demand ----------------------------------------------------------------------------------

/** Multiply a demand figure by a list of percentages, one integer step at a time. */
function scale(x100: number, pcts: readonly number[]): number {
  let x = x100;
  for (const pct of pcts) x = Math.floor((x * pct) / 100);
  return x;
}

/** Whole customers from a figure in hundredths, rounded half up. */
const wholeOf = (x100: number) => Math.floor((x100 + 50) / 100);

/** Reputation 50 is the baseline; it moves demand between 40% and 150%. */
const reputationPct = (rep: number) => Math.max(40, Math.min(150, rep * 2));

function noisePct(w: World, b: Business): number {
  return w.rng(`demand:${b.id}:${w.day}`).int(80, 120);
}

const seasonPct = (w: World) => SEASON_PCT[w.cal.month - 1] ?? 100;

const str = (b: Business, id: string) => String(b.levers[id] ?? "");
const num = (b: Business, id: string) => {
  const v = b.levers[id];
  return typeof v === "number" ? v : 0;
};
const marketingOf = (b: Business) => {
  const v = b.levers.marketing;
  return isMarketingLevel(v) ? v : "OFF";
};

/** Reputation drifts slowly: a good week adds 1, a week that turns many people away takes 2. */
function reputationStep(demand: number, served: number): number {
  const lost = demand - served;
  if (demand > 0 && lost * 4 > demand) return -2;
  if (served > 0 && lost === 0) return 1;
  return 0;
}

interface WeekResult {
  revenueMinor: Minor;
  costsMinor: Minor;
  invoicedMinor: Minor;
  sold: number;
  demand: number;
  marketingMinor: Minor;
}

/** Pay this week's marketing from the business's cash. If it is short, marketing is skipped. */
function payMarketing(
  w: World,
  b: Business,
  type: "SERVICE" | "STOCK",
): { paid: Minor; on: boolean } {
  const level = marketingOf(b);
  const cost = MARKETING[type][level].costMinor;
  if (cost === 0) return { paid: 0, on: false };
  if (w.spend(b.id, "EXPENSE:Marketing", cost, "Marketing")) return { paid: cost, on: true };
  w.emit("BUSINESS_MARKETING_SKIPPED", w.t("business.marketing.skipped", { name: b.name }), {
    pocket: b.id,
    refs: { businessId: b.id },
  });
  return { paid: 0, on: false };
}

/** A fixed fee: paid from cash if possible, otherwise it becomes a bill you owe. */
function payFixed(
  w: World,
  b: Business,
  amountMinor: Minor,
  account: string,
  labelId: string,
  payee: string,
): void {
  if (w.spend(b.id, account, amountMinor, w.t(labelId))) return;
  const label = w.t(labelId);
  addBill(w, {
    pocket: b.id,
    kind: "SUPPLIER",
    label,
    payee,
    amountMinor,
    account,
    inDays: 3,
  });
  w.emit(
    "BUSINESS_FEE_BILLED",
    w.t("business.fee.billed", { name: b.name, label, amount: euros(amountMinor) }),
    { pocket: b.id, amountMinor, refs: { businessId: b.id } },
  );
}

/**
 * Jobs a week would bring at the business's settings. `noise` is the luck factor in percent: the
 * real week draws it from a hidden stream, the forecast passes 100 and so never touches luck.
 */
function serviceDemand(w: World, b: Business, marketingOn: boolean, noise: number): number {
  const price = SERVICE_PRICE[str(b, "price") as PriceLevel] ?? SERVICE_PRICE.STANDARD;
  return wholeOf(
    scale(SERVICE_BASE_JOBS_X100, [
      price.demandPct,
      marketingOn ? MARKETING.SERVICE[marketingOf(b)].demandPct : 100,
      SERVICE_TERMS_DEMAND_PCT[str(b, "terms")] ?? 100,
      reputationPct(b.reputation),
      seasonPct(w),
      noise,
    ]),
  );
}

/** Items a week would sell at the shop's settings, if the shelves were full (see serviceDemand). */
function stockDemand(w: World, b: Business, marketingOn: boolean, noise: number): number {
  const markup = num(b, "markup");
  return wholeOf(
    scale(STOCK_BASE_UNITS_X100, [
      stockPriceDemandPct(markup),
      marketingOn ? MARKETING.STOCK[marketingOf(b)].demandPct : 100,
      num(b, "daysOpen") * 25,
      reputationPct(b.reputation),
      seasonPct(w),
      noise,
    ]),
  );
}

function tradeService(w: World, b: Business): WeekResult {
  const m = payMarketing(w, b, "SERVICE");
  const price = SERVICE_PRICE[str(b, "price") as PriceLevel] ?? SERVICE_PRICE.STANDARD;
  const terms = str(b, "terms");
  const helper = b.levers.helper === true;

  const demand = serviceDemand(w, b, m.on, noisePct(w, b));
  const capacity = Math.floor((num(b, "hours") + (helper ? HELPER_HOURS : 0)) / JOB_HOURS);
  const jobs = Math.min(demand, capacity);

  let invoiced = 0;
  const revenue = jobs * price.minor;
  const termsDays = TERMS_DAYS[terms] ?? 0;
  if (jobs > 0 && termsDays === 0) {
    w.earn(b.id, "REVENUE:Sales", revenue, "Jobs paid on delivery");
  } else if (jobs > 0) {
    // Clients are billed in batches of up to two jobs, which keeps the feed readable.
    for (let done = 0, i = 0; done < jobs; i++) {
      const count = Math.min(2, jobs - done);
      const client =
        CLIENT_NAMES[w.rng(`client:${b.id}:${w.day}:${i}`).int(0, CLIENT_NAMES.length - 1)] ??
        "A client";
      issueInvoice(w, {
        pocket: b.id,
        client,
        label: w.t(count === 1 ? "business.job.one" : "business.job.many", { count }, `job:${i}`),
        amountMinor: count * price.minor,
        termsDays,
      });
      done += count;
    }
    invoiced = revenue;
  }

  let costs = m.paid;
  if (helper) {
    payFixed(w, b, HELPER_WEEKLY_MINOR, "EXPENSE:Helper", "business.bill.helper", "Your helper");
    costs += HELPER_WEEKLY_MINOR;
  }

  const lost = demand - jobs;
  if (lost > 0 && capacity < demand) {
    w.emit("BUSINESS_TURNED_AWAY", w.t("business.turnedaway", { name: b.name, count: lost }), {
      pocket: b.id,
      refs: { businessId: b.id },
    });
  }
  b.reputation = w.clamp100(b.reputation + reputationStep(demand, jobs));
  return {
    revenueMinor: revenue,
    costsMinor: costs,
    invoicedMinor: invoiced,
    sold: jobs,
    demand,
    marketingMinor: m.paid,
  };
}

/** Cost of `units` out of `of` on hand, taken from the books so rounding never strands cents. */
function stockValue(w: World, b: Business, units: number): Minor {
  const bal = w.balance(b.id, "ASSET:Stock");
  if (b.stockUnits <= 0 || units <= 0) return 0;
  if (units >= b.stockUnits) return bal;
  return Math.floor((bal * units) / b.stockUnits);
}

/** Keep the displayed average cost in step with what the books say the stock cost. */
function refreshUnitCost(w: World, b: Business): void {
  if (b.stockUnits > 0) {
    b.memory.unitCostMinor = Math.round(w.balance(b.id, "ASSET:Stock") / b.stockUnits);
  } else {
    b.memory.unitCostMinor ??= UNIT_COST_MINOR;
  }
}

function tradeStock(w: World, b: Business): WeekResult {
  const m = payMarketing(w, b, "STOCK");
  const markup = num(b, "markup");
  const unitPrice = stockPriceMinor(markup);

  const demand = stockDemand(w, b, m.on, noisePct(w, b));
  const sold = Math.min(demand, b.stockUnits);

  const revenue = sold * unitPrice;
  let costs = m.paid;
  if (sold > 0) {
    const cogs = stockValue(w, b, sold);
    w.earn(b.id, "REVENUE:Sales", revenue, "Shop sales");
    w.post(b.id, "Cost of goods sold", [
      ["EXPENSE:CostOfGoods", "DEBIT", cogs],
      ["ASSET:Stock", "CREDIT", cogs],
    ]);
    b.stockUnits -= sold;
    costs += cogs;
  }

  // A small share of what is left goes off every week.
  if (b.stockUnits > 0) {
    const spoilUnits = Math.min(b.stockUnits, Math.ceil((b.stockUnits * SPOIL_PCT) / 100));
    const spoilValue = stockValue(w, b, spoilUnits);
    w.post(b.id, "Stock that went off", [
      ["EXPENSE:Spoilage", "DEBIT", spoilValue],
      ["ASSET:Stock", "CREDIT", spoilValue],
    ]);
    b.stockUnits -= spoilUnits;
    costs += spoilValue;
    w.emit("BUSINESS_SPOILED", w.t("business.spoiled", { name: b.name, units: spoilUnits }), {
      pocket: b.id,
      amountMinor: spoilValue,
      refs: { businessId: b.id },
    });
  }
  refreshUnitCost(w, b);

  payFixed(w, b, STALL_FEE_MINOR, "EXPENSE:StallFee", "business.bill.stall", "The market");
  costs += STALL_FEE_MINOR;

  if (demand > sold) {
    w.emit("BUSINESS_SOLD_OUT", w.t("business.soldout", { name: b.name, count: demand - sold }), {
      pocket: b.id,
      refs: { businessId: b.id },
    });
  }
  b.reputation = w.clamp100(b.reputation + reputationStep(demand, sold));
  return {
    revenueMinor: revenue,
    costsMinor: costs,
    invoicedMinor: 0,
    sold,
    demand,
    marketingMinor: m.paid,
  };
}

/** The ref of the stop that points at a shop's stock row. */
export const stockRef = (b: Business): string => `business:${b.id}:stock`;

function weekly(w: World, b: Business): void {
  const r = b.type === "SERVICE" ? tradeService(w, b) : tradeStock(w, b);
  const profit = r.revenueMinor - r.costsMinor;
  b.memory = {
    ...b.memory,
    lastRevenue: r.revenueMinor,
    lastCosts: r.costsMinor,
    lastProfit: profit,
    lastSold: r.sold,
    lastDemand: r.demand,
    lastInvoiced: r.invoicedMinor,
    lastMarketing: r.marketingMinor,
  };
  const slots = {
    name: b.name,
    sales: euros(r.revenueMinor),
    costs: euros(r.costsMinor),
    count: r.sold,
  };
  const id =
    r.sold === 0
      ? "business.week.quiet"
      : b.type === "SERVICE"
        ? "business.week.service"
        : "business.week.stock";
  w.emit("BUSINESS_WEEK", w.t(id, slots, `week:${b.id}`), {
    pocket: b.id,
    amountMinor: profit,
    refs: { businessId: b.id },
    concepts: ["cpt_profit_vs_cash"],
  });

  // A shop that would not cover last week's sales pauses time so you can restock. The ref points
  // at the shop's stock row, so the page can take you there.
  if (b.type === "STOCK" && r.sold > 0 && b.stockUnits < r.sold) {
    w.stop(
      "STOCK_OUT",
      w.t("business.stockout", { name: b.name, units: b.stockUnits, sold: r.sold }),
      stockRef(b),
    );
  } else if (b.type === "STOCK" && b.stockUnits === 0 && w.cash(b.id) >= UNIT_COST_MINOR) {
    w.stop("STOCK_OUT", w.t("business.shelves.empty"), stockRef(b));
  }
}

// -- commands --------------------------------------------------------------------------------

function openBusiness(w: World, id: string): Business | null {
  return w.s.businesses.find((b) => b.id === id && b.status === "OPEN") ?? null;
}

function setLever(
  w: World,
  cmd: { businessId: string; lever: string; value: LeverValue },
): Refusal | undefined {
  const b = openBusiness(w, cmd.businessId);
  if (!b) return refuse("UNKNOWN_BUSINESS", "There is no open business like that.");
  const spec = leverSpecs(b.type).find((x) => x.id === cmd.lever);
  if (!spec) return refuse("UNKNOWN_LEVER", "That setting does not exist for this business.");
  if (!leverAllows(spec, cmd.value)) return refuse("BAD_VALUE", "That value is not allowed.");
  b.levers[spec.id] = cmd.value;
  // The shop's hours follow its days open, so the kernel counts them with everything else.
  if (b.type === "STOCK" && spec.id === "daysOpen")
    b.levers.hours = (cmd.value as number) * HOURS_PER_DAY_OPEN;
  w.recomputeCommitted();
  return undefined;
}

export function restockCost(units: number): Minor {
  const total = units * UNIT_COST_MINOR;
  return units >= BULK_UNITS ? total - percentOf(total, BULK_DISCOUNT_PCT) : total;
}

function restock(w: World, cmd: { businessId: string; units: number }): Refusal | undefined {
  const b = openBusiness(w, cmd.businessId);
  if (!b) return refuse("UNKNOWN_BUSINESS", "There is no open business like that.");
  if (b.type !== "STOCK") return refuse("NO_STOCK", "This business does not hold stock.");
  const cost = restockCost(cmd.units);
  if (w.cash(b.id) < cost)
    return refuse("NOT_ENOUGH_CASH", `The business needs ${euros(cost)} in cash for that.`);
  w.post(b.id, "Bought stock", [
    ["ASSET:Stock", "DEBIT", cost],
    ["ASSET:Cash", "CREDIT", cost],
  ]);
  b.stockUnits += cmd.units;
  refreshUnitCost(w, b);
  const saved = cmd.units * UNIT_COST_MINOR - cost;
  w.emit(
    "BUSINESS_RESTOCK",
    w.t(saved > 0 ? "business.restock.bulk" : "business.restock", {
      name: b.name,
      units: cmd.units,
      amount: euros(cost),
      saved: euros(saved),
    }),
    {
      pocket: b.id,
      amountMinor: cost,
      refs: { businessId: b.id },
      concepts: ["cpt_inventory"],
    },
  );
  return undefined;
}

function closeBusiness(w: World, cmd: { businessId: string }): Refusal | undefined {
  const b = openBusiness(w, cmd.businessId);
  if (!b) return refuse("NOT_OPEN", "That business is not open.");
  const cash = w.cash(b.id);
  if (cash > 0) w.transfer(b.id, YOU, cash, "Closing a business");
  const stock = w.balance(b.id, "ASSET:Stock");
  w.post(b.id, "Stock written off", [
    ["EXPENSE:StockWriteOff", "DEBIT", stock],
    ["ASSET:Stock", "CREDIT", stock],
  ]);
  b.stockUnits = 0;
  b.status = "CLOSED";
  w.recomputeCommitted();
  w.emit(
    "BUSINESS_CLOSED",
    w.t(cash > 0 ? "business.closed" : "business.closed.empty", {
      name: b.name,
      amount: euros(cash),
    }),
    { pocket: b.id, amountMinor: cash, refs: { businessId: b.id } },
  );
  return undefined;
}

// -- system ----------------------------------------------------------------------------------

/** R3 (#115): business types, levers, restock, weekly trading. */
export const businessSystem: RunSystem = {
  id: "business",
  endDay(w) {
    // Trading is settled on the last day of each week, in the order businesses were opened.
    if (w.cal.dayOfWeek !== 7) return;
    for (const b of w.s.businesses) if (b.status === "OPEN") weekly(w, b);
  },
  commands: {
    SET_LEVER: setLever,
    RESTOCK: restock,
    CLOSE_BUSINESS: closeBusiness,
  },
  effects: {
    "business.start": (w, params, _ctx: EffectCtx) => {
      const p = parseStart(params);
      if (!p) throw new Error("business.start needs type, name and capitalMinor");
      startBusiness(w, p);
    },
  },
  effectBlocker: {
    "business.start": (w, params) => {
      const p = parseStart(params);
      if (!p || !IMPLEMENTED.includes(p.type)) return "Coming later.";
      if (!p.fromOutside && w.cash(YOU) < p.capitalMinor)
        return `Needs ${euros(p.capitalMinor)} in cash.`;
      return null;
    },
  },
  templates: {
    "business.stocked": [
      "{name} opens with {units} items on the shelves, bought with {amount} of the starting money. When they run low, you can buy more.",
      "The shelves at {name} start with {units} items, bought for {amount} from the starting money. Buy more when they run low.",
    ],
    "business.shelves.empty": ["The shelves are empty. Buy stock to open."],
    "business.forecast.service": [
      "At these settings: about {jobs} jobs a week, about {sales} in sales, about {profit} after costs.",
    ],
    "business.forecast.stock": [
      "At these settings: about {count} items sold a week, about {sales} in sales, about {profit} after costs.",
    ],
    "business.forecast.hours": [
      "You have hours for {capacity} jobs a week, but about {demand} would come. More hours or a helper would let you take them.",
    ],
    "business.forecast.terms": [
      "Clients pay about {days} days after the work, so the cash comes later than the sales.",
    ],
    "business.forecast.stock.empty": [
      "The shelves are empty, so nothing sells until you buy stock.",
    ],
    "business.forecast.stock.left": [
      "Your {units} items on the shelves last about {weeks} weeks at this pace.",
    ],
    "business.forecast.stock.short": [
      "Your {units} items on the shelves cover less than one week at this pace.",
    ],
    "business.started": [
      "You opened {name} with {amount} of your own money.",
      "{name} is open. You put in {amount}.",
    ],
    "business.started.gift": [
      "{name} is open. A relative gave you {amount} to start it.",
      "A relative backed you with {amount}, and {name} is open.",
    ],
    "business.week.service": [
      "{name} finished {count} jobs this week. Sales {sales}, costs {costs}.",
      "This week {name} did {count} jobs. Sales were {sales} and costs were {costs}.",
    ],
    "business.week.stock": [
      "{name} sold {count} items this week. Sales {sales}, costs {costs}.",
      "This week {name} sold {count} items. Sales were {sales} and costs were {costs}.",
    ],
    "business.week.quiet": [
      "{name} had a quiet week with no sales. Costs came to {costs}.",
      "Nothing sold at {name} this week. Costs came to {costs}.",
    ],
    "business.turnedaway": [
      "{name} turned away {count} jobs. There were not enough hours.",
      "{count} customers could not be served at {name}. There were not enough hours.",
    ],
    "business.soldout": [
      "{name} ran out of stock and missed {count} sales.",
      "{count} shoppers left {name} empty-handed. The shelves were bare.",
    ],
    "business.stockout": [
      "{name} has {units} items left. Last week it sold {sold}.",
      "Stock is low at {name}: {units} left, and {sold} sold last week.",
    ],
    "business.spoiled": [
      "{units} items at {name} went off.",
      "{name} lost {units} items to spoilage.",
    ],
    "business.marketing.skipped": [
      "{name} could not pay for marketing this week, so it was skipped.",
      "There was not enough cash for marketing at {name}. It was skipped this week.",
    ],
    "business.fee.billed": [
      "{name} did not have cash for {label}. It is now a bill of {amount}.",
      "{label} at {name} could not be paid in cash, so it became a bill of {amount}.",
    ],
    "business.restock": [
      "{name} bought {units} items for {amount}.",
      "You restocked {name} with {units} items for {amount}.",
    ],
    "business.restock.bulk": [
      "{name} bought {units} items for {amount}. The bulk price saved {saved}.",
      "You restocked {name} with {units} items for {amount}. Buying in bulk saved {saved}.",
    ],
    "business.closed": [
      "You closed {name}. {amount} came back to you.",
      "{name} is closed. You took out the {amount} that was left.",
    ],
    "business.closed.empty": [
      "You closed {name}. There was no cash left to take out.",
      "{name} is closed. Nothing was left to take out.",
    ],
    "business.job.one": ["one job"],
    "business.job.many": ["{count} jobs"],
    "business.bill.helper": ["Helper pay"],
    "business.bill.stall": ["Stall fee"],
  },
};

// -- panel -----------------------------------------------------------------------------------

function leverView(spec: LeverSpec, b: Business): LeverView {
  const base = { id: spec.id, label: spec.label, help: spec.help };
  const v = b.levers[spec.id];
  switch (spec.kind) {
    case "CHOICE":
      return { ...base, kind: "CHOICE", value: String(v ?? ""), options: spec.options };
    case "RANGE":
      return {
        ...base,
        kind: "RANGE",
        value: typeof v === "number" ? v : spec.min,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        unit: spec.unit,
      };
    case "TOGGLE":
      return { ...base, kind: "TOGGLE", value: v === true };
  }
}

/**
 * What the current settings would bring in an average week: the same demand rules as the real
 * week with the luck factor fixed at 100%, so it never reads (or hints at) a hidden stream.
 * Marketing is assumed to be paid. Rounded wording only ("about"); the real week varies.
 */
export function forecastLines(w: World, b: Business): string[] {
  if (b.status !== "OPEN") return [];
  if (b.type === "SERVICE") {
    const price = SERVICE_PRICE[str(b, "price") as PriceLevel] ?? SERVICE_PRICE.STANDARD;
    const helper = b.levers.helper === true;
    const demand = serviceDemand(w, b, true, 100);
    const capacity = Math.floor((num(b, "hours") + (helper ? HELPER_HOURS : 0)) / JOB_HOURS);
    const jobs = Math.min(demand, capacity);
    const sales = jobs * price.minor;
    const costs = MARKETING.SERVICE[marketingOf(b)].costMinor + (helper ? HELPER_WEEKLY_MINOR : 0);
    const lines = [
      w.t("business.forecast.service", {
        jobs,
        sales: euros(sales),
        profit: euros(sales - costs),
      }),
    ];
    if (capacity < demand) {
      lines.push(w.t("business.forecast.hours", { capacity, demand }));
    }
    const days = TERMS_DAYS[str(b, "terms")] ?? 0;
    if (days > 0 && jobs > 0) lines.push(w.t("business.forecast.terms", { days }));
    return lines;
  }
  if (b.type === "STOCK") {
    const unitPrice = stockPriceMinor(num(b, "markup"));
    const unitCost = b.memory.unitCostMinor ?? UNIT_COST_MINOR;
    const count = stockDemand(w, b, true, 100);
    const sales = count * unitPrice;
    const costs = count * unitCost + MARKETING.STOCK[marketingOf(b)].costMinor + STALL_FEE_MINOR;
    const lines = [
      w.t("business.forecast.stock", {
        count,
        sales: euros(sales),
        profit: euros(sales - costs),
      }),
    ];
    if (b.stockUnits === 0) lines.push(w.t("business.forecast.stock.empty"));
    else if (b.stockUnits < count)
      lines.push(w.t("business.forecast.stock.short", { units: b.stockUnits }));
    else
      lines.push(
        w.t("business.forecast.stock.left", {
          units: b.stockUnits,
          weeks: Math.max(1, Math.floor(b.stockUnits / Math.max(1, count))),
        }),
      );
    return lines;
  }
  return [];
}

/** The panel figures for one business (R7's view uses it). */
export function businessPanel(
  w: World,
  b: Business,
): Pick<BusinessView, "typeLabel" | "levers" | "stock" | "lastWeek" | "forecast"> {
  const m = b.memory;
  const lastWeek: { label: string; value: string }[] = [];
  if (m.lastRevenue !== undefined) {
    lastWeek.push({ label: "Sales", value: euros(m.lastRevenue ?? 0) });
    if (b.type === "SERVICE") {
      lastWeek.push({ label: "Jobs done", value: String(m.lastSold ?? 0) });
      const turned = (m.lastDemand ?? 0) - (m.lastSold ?? 0);
      if (turned > 0) lastWeek.push({ label: "Jobs turned away", value: String(turned) });
      if ((m.lastInvoiced ?? 0) > 0)
        lastWeek.push({ label: "Billed, not yet paid", value: euros(m.lastInvoiced ?? 0) });
    } else {
      lastWeek.push({ label: "Items sold", value: String(m.lastSold ?? 0) });
      const missed = (m.lastDemand ?? 0) - (m.lastSold ?? 0);
      if (missed > 0) lastWeek.push({ label: "Sales missed", value: String(missed) });
    }
    if ((m.lastMarketing ?? 0) > 0)
      lastWeek.push({ label: "Marketing", value: euros(m.lastMarketing ?? 0) });
    lastWeek.push({ label: "Costs", value: euros(m.lastCosts ?? 0) });
    lastWeek.push({ label: "Profit", value: euros(m.lastProfit ?? 0) });
  }
  const sold = m.lastSold ?? 0;
  return {
    typeLabel: TYPE_LABEL[b.type],
    levers: leverSpecs(b.type).map((s) => leverView(s, b)),
    stock:
      b.type === "STOCK"
        ? {
            units: b.stockUnits,
            unitCostMinor: m.unitCostMinor ?? UNIT_COST_MINOR,
            weeksLeft: sold > 0 ? Math.floor(b.stockUnits / sold) : null,
          }
        : null,
    lastWeek,
    forecast: forecastLines(w, b),
  };
}
