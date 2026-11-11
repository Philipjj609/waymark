import { isMonthEnd, isWeekStart, isYearEnd } from "../clock.js";
import { euros, type World } from "../world.js";
import type { RunSystem } from "./types.js";

/** Cash below this in your own pocket pauses time once (PLAY-002 §4 stops). */
export const LOW_CASH_MINOR = 10_000;

/** Kernel time keeping: weekly hours, month and year ends, the low-cash warning. */
export const timeSystem: RunSystem = {
  id: "time",
  beginDay(w: World) {
    if (isWeekStart(w.day)) {
      w.s.hours.used = 0;
      w.recomputeCommitted();
    }
    const cash = w.cash("you");
    const warned = w.s.flags["core.lowCashWarned"] === true;
    if (cash < LOW_CASH_MINOR && !warned) {
      w.s.flags["core.lowCashWarned"] = true;
      w.stop("LOW_CASH", w.t("core.low.cash", { amount: euros(cash) }));
    } else if (cash >= LOW_CASH_MINOR * 2 && warned) {
      w.s.flags["core.lowCashWarned"] = false;
    }
  },
  endDay(w: World) {
    if (isMonthEnd(w.day)) {
      w.emit("MONTH_END", w.t("core.month.end", { month: w.cal.monthIndex }), {
        refs: { month: String(w.cal.monthIndex) },
      });
      w.stop(
        "MONTH_END",
        `Month ${w.cal.month} of year ${w.cal.year} is over.`,
        `m${w.cal.monthIndex}`,
      );
    }
    if (isYearEnd(w.day)) {
      w.emit("YEAR_END", w.t("core.year.end", { year: w.cal.year }), {
        refs: { year: String(w.cal.year) },
      });
      w.stop("YEAR_END", `Year ${w.cal.year} is over.`, `y${w.cal.year}`);
    }
  },
};
