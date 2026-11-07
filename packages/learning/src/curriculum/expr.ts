import { formatMinor } from "../bridge.js";
import type { Derived, Expr, MoneyParam, Params } from "./types.js";

/** Content error: thrown only for malformed curriculum data, never for learner input. */
export class CurriculumError extends Error {
  override readonly name = "CurriculumError";
}

/** Evaluate integer money arithmetic. All operands must be money params of one currency. */
export function evaluate(expr: Expr, params: Params): MoneyParam {
  if ("param" in expr) {
    const p = params[expr.param];
    if (!p) throw new CurriculumError(`unknown param "${expr.param}"`);
    if (p.kind !== "money") throw new CurriculumError(`param "${expr.param}" is not money`);
    return p;
  }
  const operands =
    "sum" in expr ? expr.sum : "minus" in expr ? [expr.minus[0], expr.minus[1]] : expr.max;
  if (operands.length === 0) throw new CurriculumError("empty expression");
  const values = operands.map((e) => evaluate(e, params));
  const currency = values[0]?.currency ?? "EUR";
  if (values.some((v) => v.currency !== currency))
    throw new CurriculumError("mixed currencies in one expression");
  const amounts = values.map((v) => v.amountMinor);
  let amountMinor: number;
  if ("sum" in expr) amountMinor = amounts.reduce((a, b) => a + b, 0);
  else if ("minus" in expr) amountMinor = (amounts[0] ?? 0) - (amounts[1] ?? 0);
  else amountMinor = Math.max(...amounts);
  if (!Number.isSafeInteger(amountMinor)) throw new CurriculumError("unsafe integer result");
  return { kind: "money", amountMinor, currency };
}

/** Params plus derived values, in order (each derived value may use earlier ones). */
export function withDerived(params: Params, derived: readonly Derived[] = []): Params {
  let out: Params = params;
  for (const d of derived) {
    if (out[d.name]) throw new CurriculumError(`derived "${d.name}" shadows a param`);
    out = { ...out, [d.name]: evaluate(d.expr, out) };
  }
  return out;
}

const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;

export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

/**
 * Render a template. Money renders with the bridge's integer-only formatter, days as
 * "day N", so every figure on screen comes from typed data (invariant 1).
 */
export function renderTemplate(template: string, params: Params): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const p = params[name];
    if (!p) throw new CurriculumError(`template references unknown param "${name}"`);
    return p.kind === "money" ? formatMinor(p.amountMinor, p.currency) : `day ${p.day}`;
  });
}

/** Every param name an expression reads. */
export function exprParams(expr: Expr): string[] {
  if ("param" in expr) return [expr.param];
  const ops = "sum" in expr ? expr.sum : "minus" in expr ? [...expr.minus] : expr.max;
  return ops.flatMap(exprParams);
}
