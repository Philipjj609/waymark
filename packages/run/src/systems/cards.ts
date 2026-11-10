import { isWeekStart } from "../clock.js";
import { holds } from "../conditions.js";
import { CARDS as CONTENT_CARDS } from "../content/cards.js";
import { applyEffects, blockerOf } from "../effects.js";
import type { CardDef, CardOption, OpenCard, PocketId, Refusal } from "../types.js";
import { euros, type World } from "../world.js";
import { systems } from "./index.js";
import type { RunSystem } from "./types.js";

/** Most cards open at once. More would bury the player. */
export const MAX_OPEN_CARDS = 4;

let registry: ReadonlyMap<string, CardDef> | null = null;

/** Every card: authored content plus cards modules contribute. Ids must be unique. */
export function allCards(): ReadonlyMap<string, CardDef> {
  if (registry) return registry;
  const map = new Map<string, CardDef>();
  for (const c of [...CONTENT_CARDS, ...systems().flatMap((s) => s.cards ?? [])]) {
    if (map.has(c.id)) throw new Error(`duplicate card id ${c.id}`);
    map.set(c.id, c);
  }
  registry = map;
  return map;
}

export function cardDef(cardId: string): CardDef {
  const def = allCards().get(cardId);
  if (!def) throw new Error(`unknown card ${cardId}`);
  return def;
}

/** Which pocket a card would act on, or null when it cannot open now. */
function pocketFor(w: World, def: CardDef): PocketId | null {
  if (!def.businessType) return "you";
  const b = w.s.businesses.find((x) => x.status === "OPEN" && x.type === def.businessType);
  return b ? b.id : null;
}

export function openCard(w: World, def: CardDef, pocket: PocketId): OpenCard {
  const id = w.id("card");
  const slots: Record<string, number | string> = {};
  for (const [name, spec] of Object.entries(def.slots ?? {})) {
    const rng = w.rng(`slot:${id}:${name}`);
    if (spec.kind === "RANGE") {
      const step = spec.step ?? 1;
      const steps = Math.floor((spec.max - spec.min) / step);
      slots[name] = spec.min + rng.int(0, steps) * step;
    } else {
      slots[name] = spec.from[rng.int(0, spec.from.length - 1)] as string;
    }
  }
  // Money slots end in "Minor"; templates get a formatted twin without the suffix.
  for (const [name, v] of Object.entries({ ...slots })) {
    if (name.endsWith("Minor") && typeof v === "number") slots[name.slice(0, -5)] = euros(v);
  }
  const business = w.s.businesses.find((b) => b.id === pocket);
  if (business) slots.business = business.name;
  const card: OpenCard = {
    id,
    cardId: def.id,
    openedDay: w.day,
    expiresDay: w.day + def.expiresInDays,
    pocket,
    slots,
    title: w.t(def.title, slots, `${id}:title`),
    body: w.t(def.body, slots, `${id}:body`),
  };
  w.s.cards.push(card);
  const h = w.s.cardHistory[def.id] ?? { lastDay: 0, times: 0 };
  w.s.cardHistory[def.id] = { lastDay: w.day, times: h.times + 1 };
  w.emit("CARD_OPENED", card.title, {
    pocket,
    refs: { cardId: def.id, card: id },
    concepts: def.concepts ?? [],
  });
  w.stop("NEW_CARD", card.title, id);
  return card;
}

function eligibleNow(w: World, def: CardDef): PocketId | null {
  if (def.draw !== "WEEKLY") return null;
  if (w.s.cards.some((c) => c.cardId === def.id)) return null;
  const h = w.s.cardHistory[def.id];
  if (h && w.day - h.lastDay < def.cooldownDays) return null;
  if (h && def.maxTimes !== undefined && h.times >= def.maxTimes) return null;
  const pocket = pocketFor(w, def);
  if (!pocket) return null;
  return holds(w, def.eligible, pocket) ? pocket : null;
}

function weeklyDraw(w: World): void {
  const rng = w.rng(`draw:${w.day}`);
  const roll = rng.int(1, 10);
  let count = roll <= 3 ? 0 : roll <= 8 ? 1 : 2;
  if (w.day === 1) count = Math.max(count, 1);
  const pool = [...allCards().values()]
    .map((def) => ({ def, pocket: eligibleNow(w, def) }))
    .filter((x): x is { def: CardDef; pocket: PocketId } => x.pocket !== null && x.def.weight > 0);
  while (count > 0 && pool.length > 0 && w.s.cards.length < MAX_OPEN_CARDS) {
    const total = pool.reduce((a, x) => a + x.def.weight, 0);
    let pick = rng.int(1, total);
    let index = 0;
    while (index < pool.length - 1 && pick > (pool[index]?.def.weight ?? 0)) {
      pick -= pool[index]?.def.weight ?? 0;
      index += 1;
    }
    const [chosen] = pool.splice(index, 1);
    if (chosen) openCard(w, chosen.def, chosen.pocket);
    count -= 1;
  }
}

export interface OptionStatus {
  readonly available: boolean;
  readonly why: string | null;
}

export function optionStatus(w: World, card: OpenCard, option: CardOption): OptionStatus {
  if (!holds(w, option.requires, card.pocket))
    return { available: false, why: "Not possible for you right now." };
  if (option.hours && w.freeHours() < option.hours) {
    return { available: false, why: `Needs ${option.hours} free hours this week.` };
  }
  const why = blockerOf(w, option.effects, {
    pocket: card.pocket,
    slots: card.slots,
    path: `${card.id}/${option.id}`,
  });
  return why ? { available: false, why } : { available: true, why: null };
}

export function optionLabel(w: World, card: OpenCard, option: CardOption): string {
  return w.t(option.label, card.slots, `${card.id}:${option.id}`);
}

function resolve(w: World, card: OpenCard, option: CardOption, expired: boolean): void {
  w.s.cards = w.s.cards.filter((c) => c.id !== card.id);
  if (option.hours) w.s.hours.used += option.hours;
  const def = cardDef(card.cardId);
  w.emit(
    expired ? "CARD_EXPIRED" : "CARD_CHOSEN",
    expired
      ? w.t("core.card.expired", { title: card.title })
      : `${card.title}: ${optionLabel(w, card, option)}`,
    {
      pocket: card.pocket,
      refs: { cardId: card.cardId, card: card.id, optionId: option.id },
      concepts: def.concepts ?? [],
    },
  );
  applyEffects(w, option.effects, {
    pocket: card.pocket,
    slots: card.slots,
    path: `${card.id}/${option.id}`,
  });
}

const refuse = (code: string, message: string): Refusal => ({ code, message });

export const cardsSystem: RunSystem = {
  id: "cards",
  beginDay(w) {
    for (const card of [...w.s.cards]) {
      if (card.expiresDay < w.day) {
        const def = cardDef(card.cardId);
        const option =
          def.options.find((o) => o.id === def.onExpire) ?? def.options[def.options.length - 1];
        if (option && optionStatus(w, card, option).available) resolve(w, card, option, true);
        else {
          w.s.cards = w.s.cards.filter((c) => c.id !== card.id);
          w.emit("CARD_EXPIRED", w.t("core.card.expired", { title: card.title }), {
            refs: { cardId: card.cardId, card: card.id },
          });
        }
      } else if (card.expiresDay === w.day) {
        w.stop("CARD_EXPIRING", `Last day to decide: ${card.title}`, card.id);
      }
    }
    if (isWeekStart(w.day)) weeklyDraw(w);
  },
  commands: {
    CHOOSE(w, cmd) {
      const card = w.s.cards.find((c) => c.id === cmd.cardId);
      if (!card) return refuse("UNKNOWN_CARD", "That choice is no longer open.");
      const option = cardDef(card.cardId).options.find((o) => o.id === cmd.optionId);
      if (!option) return refuse("UNKNOWN_OPTION", "That option does not exist.");
      const status = optionStatus(w, card, option);
      if (!status.available)
        return refuse("OPTION_UNAVAILABLE", status.why ?? "Not possible right now.");
      resolve(w, card, option, false);
      return undefined;
    },
  },
  effects: {
    "cards.open": (w, params) => {
      const def = cardDef(String(params.cardId));
      const pocket = def.businessType ? pocketFor(w, def) : String(params.pocket ?? "you");
      if (pocket && w.s.cards.length < MAX_OPEN_CARDS + 2) openCard(w, def, pocket);
    },
  },
};
