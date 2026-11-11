import type { CardDef, Command, CommandKind, PocketId, Refusal, ScenarioDef } from "../types.js";
import type { World } from "../world.js";

/** What an effect handler knows about where it fired. */
export interface EffectCtx {
  /** The pocket "card" refers to. */
  readonly pocket: PocketId;
  /** Slot values of the card being resolved (empty outside cards). */
  readonly slots: Readonly<Record<string, number | string>>;
  /** Unique path of this effect, used to name RNG streams (e.g. "card_12/opt/0"). */
  readonly path: string;
}

/**
 * A rule module (PLAY-002 §11). Systems run in the fixed order of SYSTEMS. All hooks mutate the
 * draft through `w` only. A command handler returns a Refusal (and must then have changed
 * nothing) or undefined on success.
 */
export interface RunSystem {
  readonly id: string;
  /** Once, when a run starts, after opening balances and before the scenario's start effects. */
  init?(w: World, scenario: ScenarioDef): void;
  /** Morning: before the player acts on `w.day`. Week, month and year starts are checked here. */
  beginDay?(w: World): void;
  /** Evening of `w.day`: the day's business happens. Month and year ends are checked here. */
  endDay?(w: World): void;
  readonly commands?: {
    readonly [K in CommandKind]?: (
      w: World,
      cmd: Extract<Command, { kind: K }>,
    ) => Refusal | undefined;
  };
  /** Handlers for `{kind: "SYSTEM", action}` effects, keyed by action ("business.start"). */
  readonly effects?: Readonly<
    Record<string, (w: World, params: Readonly<Record<string, unknown>>, ctx: EffectCtx) => void>
  >;
  /** Authored text templates this module uses (ids like "life.rent.late"). */
  readonly templates?: Readonly<Record<string, readonly string[]>>;
  /** Cards this module contributes (e.g. credit offers). */
  readonly cards?: readonly CardDef[];
  /**
   * Optional precheck for SYSTEM effects in a card option, so unavailable options are shown as
   * such instead of failing. Return a reason when the effect could not apply now.
   */
  readonly effectBlocker?: Readonly<
    Record<
      string,
      (w: World, params: Readonly<Record<string, unknown>>, ctx: EffectCtx) => string | null
    >
  >;
}
