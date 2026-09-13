const MS_PER_MINUTE = 60_000;
const NOON_HOUR = 12;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const CENTS_PER_DOLLAR = 100;

const monthDay = (isoDate: string): { month: string; day: number } => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return { month: MONTHS[d.getUTCMonth()] ?? "", day: d.getUTCDate() };
};

/** "Oct 9", "Oct 9–11", "Oct 30–Nov 1". */
export function formatDateRange(startDate: string, endDate: string): string {
  const start = monthDay(startDate);
  const end = monthDay(endDate);
  if (startDate === endDate) return `${start.month} ${start.day}`;
  return start.month === end.month ? `${start.month} ${start.day}–${end.day}` : `${start.month} ${start.day}–${end.month} ${end.day}`;
}

export const formatDate = (isoDate: string): string => formatDateRange(isoDate, isoDate);

/** Wall-clock time at the destination, e.g. "3pm" or "10:30am". */
export function formatLocalTime(isoDateTime: string, utcOffsetMinutes: number): string {
  const local = new Date(Date.parse(isoDateTime) + utcOffsetMinutes * MS_PER_MINUTE);
  const hours = local.getUTCHours();
  const minutes = local.getUTCMinutes();
  const suffix = hours >= NOON_HOUR ? "pm" : "am";
  const hour12 = hours % NOON_HOUR || NOON_HOUR;
  return minutes === 0 ? `${hour12}${suffix}` : `${hour12}:${String(minutes).padStart(2, "0")}${suffix}`;
}

/** "HH:MM" at the destination, for comparing against time_floor constraints. */
export function localClock(isoDateTime: string, utcOffsetMinutes: number): string {
  return new Date(Date.parse(isoDateTime) + utcOffsetMinutes * MS_PER_MINUTE).toISOString().slice(11, 16);
}

export function localDateOf(isoDateTime: string, utcOffsetMinutes: number): string {
  return new Date(Date.parse(isoDateTime) + utcOffsetMinutes * MS_PER_MINUTE).toISOString().slice(0, 10);
}

/** "Dev", "Dev and Sam", "Dev, Sam and Ana". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export const formatDollars = (cents: number): string => `$${Math.round(cents / CENTS_PER_DOLLAR)}`;
