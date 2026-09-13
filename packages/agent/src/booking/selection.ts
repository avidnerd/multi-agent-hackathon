import { addDays, datesInclusive, err, localDateOf, ok, type CandidateOption, type FlightChoice, type PlanSelection, type Result, type VenueChoice } from "@trip/core";
import type { Flight, Hotel, Venue } from "@trip/clients/contracts";
import { roomsFor } from "../elicitation/pricing";

const MS_PER_MINUTE = 60_000;
export const HOTEL_CHECK_IN_LOCAL = "15:00";
export const HOTEL_CHECK_OUT_LOCAL = "11:00";

/** Something the organizer wants on the plan, e.g. the 10:30 beach club on day two. */
export interface ActivityRequest {
  readonly venueId: string;
  /** Matched against activity_preference constraints. */
  readonly activity: string;
  /** 0 is the day the group flies in. */
  readonly dayOffset: number;
  /** "HH:MM" at the destination. */
  readonly localTime: string;
  readonly durationMinutes: number;
}

export interface SelectionInput {
  readonly option: CandidateOption;
  readonly flights: readonly Flight[];
  readonly hotels: readonly Hotel[];
  readonly venues: readonly Venue[];
  readonly originAirport: string;
  readonly destinationAirport: string;
  readonly utcOffsetMinutes: number;
  readonly groupSize: number;
  readonly activities: readonly ActivityRequest[];
}

const localToUtcIso = (date: string, time: string, utcOffsetMinutes: number): string =>
  new Date(Date.parse(`${date}T${time}:00Z`) - utcOffsetMinutes * MS_PER_MINUTE).toISOString();

const cheapest = <T>(items: readonly T[], price: (item: T) => number): T | undefined => [...items].sort((a, b) => price(a) - price(b))[0];

const toChoice = (flight: Flight): FlightChoice => ({
  flightId: flight.flightId,
  flightNumber: flight.flightNumber,
  departsAt: flight.departsAt,
  arrivesAt: flight.arrivesAt,
  farePerPersonCents: flight.fareCents,
});

/**
 * Picks concrete inventory for an option using the same rule the quoted price used (cheapest flights and
 * hotel with room for everyone), so the plan the organizer approves costs what the group was told.
 */
export function selectInventory(input: SelectionInput): Result<PlanSelection> {
  const { option, groupSize, utcOffsetMinutes } = input;
  const flightOn = (from: string, to: string, date: string) =>
    cheapest(
      input.flights.filter((f) => f.origin === from && f.destination === to && f.status === "scheduled" && f.seatsAvailable >= groupSize && localDateOf(f.scheduledDepartsAt, utcOffsetMinutes) === date),
      (f) => f.fareCents,
    );
  const outbound = flightOn(input.originAirport, input.destinationAirport, option.startDate);
  const back = flightOn(input.destinationAirport, input.originAirport, option.endDate);
  if (outbound === undefined || back === undefined) {
    return err({ kind: "not_found", service: "inventory", resource: `flights with ${groupSize} seats for ${option.startDate} to ${option.endDate}` });
  }

  const rooms = roomsFor(groupSize);
  const nights = datesInclusive(option.startDate, addDays(option.endDate, -1));
  const hotel = cheapest(input.hotels.filter((h) => nights.every((n) => (h.availability[n] ?? 0) >= rooms)), (h) => h.nightlyRateCents);
  if (hotel === undefined) return err({ kind: "not_found", service: "inventory", resource: `a hotel with ${rooms} rooms every night from ${option.startDate}` });

  const venues: VenueChoice[] = [];
  for (const activity of input.activities) {
    const date = addDays(option.startDate, activity.dayOffset);
    if (date > option.endDate) {
      return err({ kind: "validation_failed", boundary: "user_input", issues: [`${activity.venueId} is on day ${activity.dayOffset + 1} of a trip that ends ${option.endDate}`] });
    }
    const at = localToUtcIso(date, activity.localTime, utcOffsetMinutes);
    const venue = input.venues.find((v) => v.venueId === activity.venueId);
    const slot = venue?.slots.find((s) => Date.parse(s.at) === Date.parse(at));
    if (venue === undefined || slot === undefined) return err({ kind: "not_found", service: "inventory", resource: `${activity.venueId} slot at ${activity.localTime} on ${date}` });
    if (slot.seatsAvailable < groupSize) {
      return err({ kind: "conflict", service: "inventory", resource: `${venue.name} at ${activity.localTime} on ${date}`, code: "slot_full", detail: `${slot.seatsAvailable} seats left, ${groupSize} needed` });
    }
    venues.push({ venueId: venue.venueId, name: venue.name, activity: activity.activity, startsAt: slot.at, durationMinutes: activity.durationMinutes, pricePerPersonCents: venue.pricePerPersonCents });
  }

  return ok({
    outbound: toChoice(outbound),
    hotel: {
      hotelId: hotel.hotelId,
      name: hotel.name,
      checkInAt: localToUtcIso(option.startDate, HOTEL_CHECK_IN_LOCAL, utcOffsetMinutes),
      checkOutAt: localToUtcIso(option.endDate, HOTEL_CHECK_OUT_LOCAL, utcOffsetMinutes),
      totalCents: hotel.nightlyRateCents * nights.length * rooms,
    },
    venues,
    return: toChoice(back),
  });
}
