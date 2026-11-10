/**
 * Money and time as words. Amounts are integer euro cents and are only FORMATTED or PARSED here,
 * never computed with floats (invariant 1). All of it is practice money.
 */

/** 125050 -> "€1,250.50", 120000 -> "€1,200", -500 -> "−€5". */
export function euros(minor: number): string {
  const sign = minor < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = abs % 100;
  return `${sign}€${whole}${cents ? `.${cents.toString().padStart(2, "0")}` : ""}`;
}

/**
 * "250", "250.5", "€1,250.50" -> cents. Null when it is not a plain amount. Parsed from the
 * digits themselves so no float ever touches the value.
 */
export function parseEuros(text: string, allowNegative = false): number | null {
  const cleaned = text
    .trim()
    .replace(/^([-−]?)€/, "$1")
    .replaceAll(",", "")
    .replaceAll(" ", "");
  const m = /^([-−])?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  if (m[1] && !allowNegative) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

export const plural = (n: number, one: string, many: string = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Days until something happens, in words. Negative means it already did. */
export function inDaysText(n: number): string {
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n > 1) return `in ${n} days`;
  return n === -1 ? "1 day ago" : `${-n} days ago`;
}

/** A card's deadline: 0 means today is the last day. */
export function daysLeftText(n: number): string {
  if (n <= 0) return "Last day today";
  return `${plural(n, "day")} left`;
}

/** "cpt_cash_balance" -> "cash balance": the concept ids are drafts, so show them as plain words. */
export function conceptWords(id: string): string {
  return id.replace(/^cpt_/, "").replaceAll("_", " ");
}
