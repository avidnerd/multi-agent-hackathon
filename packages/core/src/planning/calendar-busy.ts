import type { Constraint, DateWindow, Member } from "../domain";
import { datesInclusive } from "./dates";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const WAKING_DAY = { start: "08:00", end: "22:00" } as const;
/** Half a waking day. A dentist appointment should not look like a conflict; a work offsite should. */
export const BUSY_DAY_THRESHOLD_MS = 7 * MS_PER_HOUR;

export interface BusyBlock {
  readonly start: string;
  readonly end: string;
}

/** Window dates whose waking hours are mostly busy. Blocks are assumed merged, as free/busy returns them. */
export function busyDates(busy: readonly BusyBlock[], window: DateWindow, utcOffsetMinutes: number): string[] {
  return datesInclusive(window.earliestStart, window.latestEnd).filter((date) => {
    const dayStart = Date.parse(`${date}T${WAKING_DAY.start}:00Z`) - utcOffsetMinutes * MS_PER_MINUTE;
    const dayEnd = Date.parse(`${date}T${WAKING_DAY.end}:00Z`) - utcOffsetMinutes * MS_PER_MINUTE;
    const overlapMs = busy.reduce((sum, b) => sum + Math.max(0, Math.min(dayEnd, Date.parse(b.end)) - Math.max(dayStart, Date.parse(b.start))), 0);
    return overlapMs >= BUSY_DAY_THRESHOLD_MS;
  });
}

/** One soft constraint per busy date, so the agent can ask about a specific day. */
export function calendarConstraints(member: Member, calendarId: string, busy: readonly BusyBlock[], window: DateWindow, utcOffsetMinutes: number, recordedAt: string): Constraint[] {
  return busyDates(busy, window, utcOffsetMinutes).map((date) => ({
    id: `cal-${member.id}-${date}`,
    memberId: member.id,
    kind: "date_exclusion",
    value: { dates: [date] },
    hardness: "soft",
    provenance: { source: "calendar_busy", calendarId, busyStart: recordedAt, busyEnd: recordedAt },
    recordedAt,
  }));
}
