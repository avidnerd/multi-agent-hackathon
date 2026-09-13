import { addDays, datesInclusive, localDateOf, type DateWindow, type OptionPricing } from "@trip/core";
import type { Flight, Hotel } from "@trip/clients/contracts";

export interface PricingInput {
  readonly flights: readonly Flight[];
  readonly hotels: readonly Hotel[];
  readonly originAirport: string;
  readonly destinationAirport: string;
  readonly window: DateWindow;
  readonly groupSize: number;
  readonly utcOffsetMinutes: number;
}

const GUESTS_PER_ROOM = 2;

const cheapest = <T>(items: readonly T[], price: (item: T) => number): T | undefined =>
  [...items].sort((a, b) => price(a) - price(b))[0];

/**
 * Per-person cost of starting the trip on each date: cheapest outbound and return flights with
 * enough seats for the whole group, plus the cheapest hotel with enough rooms every night, split evenly.
 * A start with no workable flight or hotel is absent, which removes it from the option space.
 */
export function pricingFromInventory(input: PricingInput): Record<string, OptionPricing> {
  const { window, groupSize } = input;
  const rooms = Math.ceil(groupSize / GUESTS_PER_ROOM);
  const bookable = (from: string, to: string, date: string) =>
    input.flights.filter((f) => f.origin === from && f.destination === to && f.status === "scheduled" && f.seatsAvailable >= groupSize && localDateOf(f.scheduledDepartsAt, input.utcOffsetMinutes) === date);

  const pricing: Record<string, OptionPricing> = {};
  for (const start of datesInclusive(window.earliestStart, addDays(window.latestEnd, -(window.tripDays - 1)))) {
    const end = addDays(start, window.tripDays - 1);
    const nights = datesInclusive(start, addDays(end, -1));
    const outbound = cheapest(bookable(input.originAirport, input.destinationAirport, start), (f) => f.fareCents);
    const back = cheapest(bookable(input.destinationAirport, input.originAirport, end), (f) => f.fareCents);
    const hotel = cheapest(
      input.hotels.filter((h) => nights.every((n) => (h.availability[n] ?? 0) >= rooms)),
      (h) => h.nightlyRateCents,
    );
    if (outbound === undefined || back === undefined || hotel === undefined) continue;
    const lodgingPerNightPerPerson = Math.round((hotel.nightlyRateCents * rooms) / groupSize);
    pricing[start] = {
      perPersonCents: outbound.fareCents + back.fareCents + lodgingPerNightPerPerson * nights.length,
      lodgingPerNightPerPersonCents: lodgingPerNightPerPerson,
    };
  }
  return pricing;
}
