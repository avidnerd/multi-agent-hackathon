import { iso, MS_PER_MINUTE, type FlightRecord, type InventoryState } from "./model";

/** Planning starts a week before the trip window, 09:00 in San Diego. */
export const INVENTORY_DEFAULT_CLOCK = new Date("2026-10-01T16:00:00Z");

const PDT_OFFSET_MINUTES = -420;
const MS_PER_DAY = 86_400_000;
const FIRST_DATE = "2026-10-08";
const DAYS = 12;

const FLIGHT_SEATS = 12;
const FLIGHT_MINUTES = 95;
const BASE_FARE_CENTS = 14_900;
const PEAK_DAY_SURCHARGE_CENTS = 6_000;
const LATER_DEPARTURE_STEP_CENTS = 1_000;
const FRIDAY = 5;
const SUNDAY = 0;

const OUTBOUND: ReadonlyArray<readonly [string, string]> = [["TW101", "07:05"], ["TW143", "10:40"], ["TW177", "16:15"], ["TW191", "19:30"]];
const RETURN: ReadonlyArray<readonly [string, string]> = [["TW202", "09:10"], ["TW236", "13:45"], ["TW258", "18:20"], ["TW284", "21:05"]];

const addDays = (date: string, days: number): string => iso(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).slice(0, 10);
const localMs = (date: string, time: string): number => Date.parse(`${date}T${time}:00Z`) - PDT_OFFSET_MINUTES * MS_PER_MINUTE;

function legs(date: string, origin: string, destination: string, schedule: ReadonlyArray<readonly [string, string]>): FlightRecord[] {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const peak = weekday === FRIDAY || weekday === SUNDAY;
  return schedule.map(([flightNumber, time], slot) => ({
    flightId: `${flightNumber}-${date}`,
    flightNumber,
    origin,
    destination,
    scheduledDepartsAt: iso(localMs(date, time)),
    durationMinutes: FLIGHT_MINUTES,
    delayMinutes: 0,
    seatsTotal: FLIGHT_SEATS,
    fareCents: BASE_FARE_CENTS + (peak ? PEAK_DAY_SURCHARGE_CENTS : 0) + slot * LATER_DEPARTURE_STEP_CENTS,
    status: "scheduled",
    departedAt: null,
    arrivedAt: null,
  }));
}

const slots = (dates: readonly string[], times: readonly string[], seats: number) =>
  dates.flatMap((d) => times.map((t) => ({ at: iso(localMs(d, t)), seats })));

/** San Francisco to San Diego, twelve days of flights, two hotels, three bookable venues. */
export function defaultInventorySeed(): InventoryState {
  const dates = Array.from({ length: DAYS }, (_, i) => addDays(FIRST_DATE, i));
  const rooms = (count: number) => Object.fromEntries(dates.map((d) => [d, count]));
  return {
    destinationAirport: "SAN",
    utcOffsetMinutes: PDT_OFFSET_MINUTES,
    flights: dates.flatMap((d) => [...legs(d, "SFO", "SAN", OUTBOUND), ...legs(d, "SAN", "SFO", RETURN)]),
    flightBookings: [],
    hotels: [
      { hotelId: "harbor-row", name: "Harbor Row Hotel", nightlyRateCents: 21_900, roomsPerNight: rooms(3) },
      { hotelId: "ocean-beach-guesthouse", name: "Ocean Beach Guesthouse", nightlyRateCents: 13_900, roomsPerNight: rooms(5) },
    ],
    hotelBookings: [],
    venues: [
      { venueId: "cove-kayak", name: "Cove kayak tour", pricePerPersonCents: 6_500, slots: slots(dates, ["09:00", "10:30", "12:00", "14:00"], 8) },
      { venueId: "beach-club", name: "Beach club cabana", pricePerPersonCents: 4_000, slots: slots(dates, ["10:30", "12:00", "15:00"], 6) },
      { venueId: "tidewater", name: "Dinner at Tidewater", pricePerPersonCents: 5_500, slots: slots(dates, ["19:00", "20:30"], 10) },
    ],
    reservations: [],
    charges: [],
    events: [],
    idempotency: {},
    counter: 0,
  };
}
