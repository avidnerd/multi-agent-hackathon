import { PlanSchema, type CandidateOption, type Member, type Plan, type PlanItem } from "../domain";
import { err, ok, type Result } from "../errors";
import { localClock } from "./format";

const MS_PER_MINUTE = 60_000;

export interface FlightChoice {
  readonly flightId: string;
  readonly flightNumber: string;
  readonly departsAt: string;
  readonly arrivesAt: string;
  readonly farePerPersonCents: number;
}

export interface HotelChoice {
  readonly hotelId: string;
  readonly name: string;
  readonly checkInAt: string;
  readonly checkOutAt: string;
  readonly totalCents: number;
}

export interface VenueChoice {
  readonly venueId: string;
  readonly name: string;
  /** Matched against activity_preference constraints, e.g. "kayaking". */
  readonly activity: string;
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly pricePerPersonCents: number;
}

export interface PlanSelection {
  readonly outbound: FlightChoice;
  readonly hotel: HotelChoice;
  readonly venues: readonly VenueChoice[];
  readonly return: FlightChoice;
}

export interface BuildPlanInput {
  readonly tripId: string;
  readonly planId: string;
  readonly version: number;
  readonly option: CandidateOption;
  readonly members: readonly Member[];
  readonly selection: PlanSelection;
  readonly utcOffsetMinutes: number;
}

export interface BuiltPlan {
  readonly plan: Plan;
  /** Soft constraints the plan bends and venues it had to leave people out of. Surfaced to the organizer at the gate. */
  readonly warnings: readonly string[];
}

export const PLAN_ITEM_IDS = { outbound: "outbound", hotel: "hotel", return: "return" } as const;

function flightItem(id: string, flight: FlightChoice, participants: string[], dependsOn: string[]): PlanItem {
  return {
    id,
    kind: "flight",
    title: `Flight ${flight.flightNumber}`,
    startsAt: flight.departsAt,
    endsAt: flight.arrivesAt,
    costCents: flight.farePerPersonCents * participants.length,
    participants,
    bookingRef: null,
    inventoryId: flight.flightId,
    dependsOn,
  };
}

/** Why a member cannot join a venue, or null. Hard constraints exclude; soft ones only warn. */
function venueExclusion(member: Member, venue: VenueChoice, utcOffsetMinutes: number): { hard: boolean; reason: string } | null {
  for (const c of member.constraints) {
    const avoids = c.kind === "activity_preference" && c.value.stance === "avoids" && c.value.activity.toLowerCase() === venue.activity.toLowerCase();
    const tooEarly =
      c.kind === "time_floor" && (c.value.appliesTo === "any" || c.value.appliesTo === "reservation") && localClock(venue.startsAt, utcOffsetMinutes) < c.value.earliest;
    if (avoids) return { hard: c.hardness === "hard", reason: `${member.name} avoids ${venue.activity}` };
    if (tooEarly && c.kind === "time_floor") return { hard: c.hardness === "hard", reason: `${venue.name} starts before ${member.name}'s ${c.value.earliest}` };
  }
  return null;
}

/**
 * Turns a chosen option into a dependency graph. Every venue depends on the outbound flight, since
 * nobody can make it before landing; venues after hotel check-in also depend on the hotel; the
 * return flight depends on the hotel. Repair cascades along exactly these edges.
 */
export function buildPlan(input: BuildPlanInput): Result<BuiltPlan> {
  const { selection, option } = input;
  const travellers = input.members.filter((m) => option.feasibleFor.includes(m.id));
  if (travellers.length === 0) return err({ kind: "internal", detail: `option ${option.id} has nobody it works for` });

  const everyone = travellers.map((m) => m.id);
  const warnings: string[] = [];
  const items: PlanItem[] = [
    flightItem(PLAN_ITEM_IDS.outbound, selection.outbound, everyone, []),
    {
      id: PLAN_ITEM_IDS.hotel,
      kind: "hotel",
      title: selection.hotel.name,
      startsAt: selection.hotel.checkInAt,
      endsAt: selection.hotel.checkOutAt,
      costCents: selection.hotel.totalCents,
      participants: everyone,
      bookingRef: null,
      inventoryId: selection.hotel.hotelId,
      dependsOn: [PLAN_ITEM_IDS.outbound],
    },
  ];

  selection.venues.forEach((venue, index) => {
    const participants = travellers.filter((m) => {
      const exclusion = venueExclusion(m, venue, input.utcOffsetMinutes);
      if (exclusion !== null) warnings.push(exclusion.hard ? `${exclusion.reason}, so they're left out` : `${exclusion.reason}, but it's a soft preference`);
      return exclusion === null || !exclusion.hard;
    });
    if (participants.length === 0) {
      warnings.push(`Nobody can join ${venue.name}, so it's dropped`);
      return;
    }
    const startsMs = Date.parse(venue.startsAt);
    if (startsMs < Date.parse(selection.outbound.arrivesAt)) warnings.push(`${venue.name} starts before the flight lands`);
    items.push({
      id: `venue-${index + 1}-${venue.venueId}`,
      kind: "reservation",
      title: venue.name,
      startsAt: venue.startsAt,
      endsAt: new Date(startsMs + venue.durationMinutes * MS_PER_MINUTE).toISOString(),
      costCents: venue.pricePerPersonCents * participants.length,
      participants: participants.map((m) => m.id),
      bookingRef: null,
      inventoryId: venue.venueId,
      dependsOn: startsMs >= Date.parse(selection.hotel.checkInAt) ? [PLAN_ITEM_IDS.outbound, PLAN_ITEM_IDS.hotel] : [PLAN_ITEM_IDS.outbound],
    });
  });

  items.push(flightItem(PLAN_ITEM_IDS.return, selection.return, everyone, [PLAN_ITEM_IDS.hotel]));

  const parsed = PlanSchema.safeParse({ id: input.planId, tripId: input.tripId, version: input.version, items });
  if (!parsed.success) return err({ kind: "validation_failed", boundary: "user_input", issues: parsed.error.issues.map((i) => i.message) });
  return ok({ plan: parsed.data, warnings: [...new Set(warnings)] });
}
