/**
 * Run time (PLAY-002 §4). A simplified calendar so months are comparable: 7-day weeks, 4-week
 * months, 12-month years. Days start at 1 (contracts WorldDay). There is no wall clock anywhere.
 */
export const DAYS_PER_WEEK = 7;
export const WEEKS_PER_MONTH = 4;
export const DAYS_PER_MONTH = DAYS_PER_WEEK * WEEKS_PER_MONTH; // 28
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR; // 336
export const MAX_DAY = 100_000;
/** A run ends after ten years: long enough for a life chapter, short enough to replay quickly. */
export const RUN_HORIZON_DAY = DAYS_PER_YEAR * 10;

export interface Calendar {
  readonly day: number;
  /** 1-based. */
  readonly year: number;
  /** 1..12 */
  readonly month: number;
  /** 1..4 within the month */
  readonly week: number;
  /** 1..7, 1 = Monday */
  readonly dayOfWeek: number;
  /** 1..28 */
  readonly dayOfMonth: number;
  /** Months since the run began, 1-based (year 2 month 1 = 13). */
  readonly monthIndex: number;
}

export function calendar(day: number): Calendar {
  if (!Number.isInteger(day) || day < 1) throw new RangeError(`invalid day ${day}`);
  const d = day - 1;
  const monthIndex = Math.floor(d / DAYS_PER_MONTH) + 1;
  const dayOfMonth = (d % DAYS_PER_MONTH) + 1;
  return {
    day,
    year: Math.floor(d / DAYS_PER_YEAR) + 1,
    month: ((monthIndex - 1) % MONTHS_PER_YEAR) + 1,
    week: Math.floor((dayOfMonth - 1) / DAYS_PER_WEEK) + 1,
    dayOfWeek: (d % DAYS_PER_WEEK) + 1,
    dayOfMonth,
    monthIndex,
  };
}

export const isWeekStart = (day: number) => (day - 1) % DAYS_PER_WEEK === 0;
export const isMonthStart = (day: number) => (day - 1) % DAYS_PER_MONTH === 0;
export const isMonthEnd = (day: number) => day % DAYS_PER_MONTH === 0;
export const isYearEnd = (day: number) => day % DAYS_PER_YEAR === 0;

/** The day number of `dayOfMonth` in the month that contains `day`. */
export function dayInMonth(day: number, dayOfMonth: number): number {
  return day - calendar(day).dayOfMonth + dayOfMonth;
}

export function calendarLabel(day: number): string {
  const c = calendar(day);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][c.dayOfWeek - 1];
  return `Year ${c.year}, month ${c.month}, week ${c.week} (${weekday})`;
}
