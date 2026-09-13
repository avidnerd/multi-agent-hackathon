import type { Constraint, Hardness, Member, ObservedEvent, Plan, Provenance } from "../domain";

/** Shared test fixtures for the planning modules. San Diego is UTC-7 in October. */
export const PDT = -420;
export const RECORDED_AT = "2026-10-01T16:00:00.000Z";

export function member(id: string, name: string, overrides: Partial<Member> = {}): Member {
  return { id, name, phone: "+14155550100", email: null, optedOut: false, responseState: "complete", constraints: [], ledgerEntries: [], ...overrides };
}

export const said = (rawText: string): Provenance => ({ source: "stated", messageId: `msg-${rawText.length}`, rawText });
export const calendarBusy = (calendarId: string): Provenance => ({ source: "calendar_busy", calendarId, busyStart: RECORDED_AT, busyEnd: RECORDED_AT });

export function excludeDates(memberId: string, id: string, dates: string[], hardness: Hardness, provenance: Provenance): Constraint {
  return { id, memberId, kind: "date_exclusion", value: { dates }, hardness, provenance, recordedAt: RECORDED_AT };
}

export function budget(memberId: string, id: string, amountCents: number): Constraint {
  return { id, memberId, kind: "budget_ceiling", value: { amountCents, scope: "trip_total" }, hardness: "hard", provenance: said("I can't spend more than that"), recordedAt: RECORDED_AT };
}

export const NAMES: Readonly<Record<string, string>> = { priya: "Priya", dev: "Dev", sam: "Sam", ana: "Ana" };

/**
 * Outbound lands 12:15pm. Beach club 1pm depends on landing. Dinner 7pm depends on the hotel and on
 * the beach club, so a change to the beach club has to reach dinner. The return flight hangs off the hotel.
 */
export function samplePlan(): Plan {
  const trio = ["priya", "dev", "sam"];
  return {
    id: "plan-1",
    tripId: "trip-1",
    version: 1,
    items: [
      { id: "outbound", kind: "flight", title: "Flight TW143", startsAt: "2026-10-09T17:40:00.000Z", endsAt: "2026-10-09T19:15:00.000Z", costCents: 50_700, participants: trio, bookingRef: "FB00001", inventoryId: "TW143-2026-10-09", dependsOn: [] },
      { id: "hotel", kind: "hotel", title: "Harbor Row Hotel", startsAt: "2026-10-09T22:00:00.000Z", endsAt: "2026-10-11T18:00:00.000Z", costCents: 43_800, participants: trio, bookingRef: "HB00002", inventoryId: "harbor-row", dependsOn: ["outbound"] },
      { id: "beach", kind: "reservation", title: "Beach club cabana", startsAt: "2026-10-09T20:00:00.000Z", endsAt: "2026-10-09T21:30:00.000Z", costCents: 12_000, participants: trio, bookingRef: "RS00003", inventoryId: "beach-club", dependsOn: ["outbound"] },
      { id: "dinner", kind: "reservation", title: "Dinner at Tidewater", startsAt: "2026-10-10T02:00:00.000Z", endsAt: "2026-10-10T03:30:00.000Z", costCents: 16_500, participants: trio, bookingRef: "RS00004", inventoryId: "tidewater", dependsOn: ["hotel", "beach"] },
      { id: "return", kind: "flight", title: "Flight TW236", startsAt: "2026-10-11T20:45:00.000Z", endsAt: "2026-10-11T22:20:00.000Z", costCents: 50_700, participants: trio, bookingRef: "FB00005", inventoryId: "TW236-2026-10-11", dependsOn: ["hotel"] },
    ],
  };
}

type EventOf<K extends ObservedEvent["kind"]> = Extract<ObservedEvent, { kind: K }>;

export function observed<K extends ObservedEvent["kind"]>(id: string, planItemId: string, kind: K, payload: EventOf<K>["payload"], at = "2026-10-09T17:40:00.000Z"): ObservedEvent {
  // The generic keeps kind and payload paired at call sites; the union cannot express that pairing on its own.
  return { id, tripId: "trip-1", at, source: "twin", subject: { planItemId, memberId: null }, kind, payload } as EventOf<K>;
}
