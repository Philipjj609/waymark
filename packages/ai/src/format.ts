/** Integer-only money formatting for lesson text: 5500 -> "55.00 EUR" (no floats, invariant 1). */
export function formatMinorForLesson(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}
