import { z } from "zod";
import { CentsSchema, IdSchema, IsoDateSchema, IsoDateTimeSchema } from "@trip/core";
import {
  ChargeSchema,
  InventoryEventSchema,
  PassengerCheckInSchema,
  type InventoryErrorCode,
  type InventoryEvent,
} from "@trip/clients/contracts";

export const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_HOUR = 60;
export const CHECK_IN_OPENS_BEFORE_MS = 24 * MINUTES_PER_HOUR * MS_PER_MINUTE;
export const CHECK_IN_CLOSES_BEFORE_MS = 45 * MS_PER_MINUTE;
export const HOTEL_CHECK_IN_LOCAL_TIME = "15:00";
export const HOTEL_CHECK_OUT_LOCAL_TIME = "11:00";

export const FlightRecordSchema = z.object({
  flightId: z.string(),
  flightNumber: z.string(),
  origin: z.string().length(3),
  destination: z.string().length(3),
  scheduledDepartsAt: IsoDateTimeSchema,
  durationMinutes: z.number().int().positive(),
  delayMinutes: z.number().int().nonnegative(),
  seatsTotal: z.number().int().positive(),
  fareCents: CentsSchema,
  status: z.enum(["scheduled", "departed", "arrived", "cancelled"]),
  departedAt: IsoDateTimeSchema.nullable(),
  arrivedAt: IsoDateTimeSchema.nullable(),
});
export type FlightRecord = z.infer<typeof FlightRecordSchema>;

const PassengerRecordSchema = z.object({
  memberId: IdSchema,
  name: z.string(),
  checkIn: PassengerCheckInSchema,
  /** Twin-only: set by an injected passenger_misses_flight. Never exposed through the API. */
  willMiss: z.boolean(),
});

export const FlightBookingRecordSchema = z.object({
  bookingRef: z.string(),
  flightId: z.string(),
  passengers: z.array(PassengerRecordSchema).min(1),
  fareCents: CentsSchema,
  status: z.enum(["confirmed", "cancelled"]),
  createdAt: IsoDateTimeSchema,
});
export type FlightBookingRecord = z.infer<typeof FlightBookingRecordSchema>;

export const HotelRecordSchema = z.object({
  hotelId: z.string(),
  name: z.string(),
  nightlyRateCents: CentsSchema,
  roomsPerNight: z.record(z.string(), z.number().int().nonnegative()),
});
export type HotelRecord = z.infer<typeof HotelRecordSchema>;

export const HotelBookingRecordSchema = z.object({
  bookingRef: z.string(),
  hotelId: z.string(),
  checkIn: IsoDateSchema,
  checkOut: IsoDateSchema,
  rooms: z.number().int().positive(),
  guestIds: z.array(IdSchema).min(1),
  checkedInGuestIds: z.array(IdSchema),
  totalCents: CentsSchema,
  status: z.enum(["confirmed", "checked_in", "cancelled"]),
  createdAt: IsoDateTimeSchema,
});
export type HotelBookingRecord = z.infer<typeof HotelBookingRecordSchema>;

export const VenueRecordSchema = z.object({
  venueId: z.string(),
  name: z.string(),
  pricePerPersonCents: CentsSchema,
  slots: z.array(z.object({ at: IsoDateTimeSchema, seats: z.number().int().positive() })),
});
export type VenueRecord = z.infer<typeof VenueRecordSchema>;

export const ReservationRecordSchema = z.object({
  bookingRef: z.string(),
  venueId: z.string(),
  at: IsoDateTimeSchema,
  guestIds: z.array(IdSchema).min(1),
  seatedGuestIds: z.array(IdSchema),
  status: z.enum(["booked", "seated", "no_show", "cancelled"]),
  /** Twin-only: set by an injected reservation_no_show. */
  noShow: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type ReservationRecord = z.infer<typeof ReservationRecordSchema>;

const IdempotencyRecordSchema = z.object({ fingerprint: z.string(), status: z.number().int(), body: z.unknown() });

export const InventoryStateSchema = z.object({
  destinationAirport: z.string().length(3),
  /** Destination's offset from UTC. Local dates and times (hotel nights, 15:00 check-in) resolve against it. */
  utcOffsetMinutes: z.number().int(),
  flights: z.array(FlightRecordSchema),
  flightBookings: z.array(FlightBookingRecordSchema),
  hotels: z.array(HotelRecordSchema),
  hotelBookings: z.array(HotelBookingRecordSchema),
  venues: z.array(VenueRecordSchema),
  reservations: z.array(ReservationRecordSchema),
  charges: z.array(ChargeSchema),
  events: z.array(InventoryEventSchema),
  idempotency: z.record(z.string(), IdempotencyRecordSchema),
  counter: z.number().int().nonnegative(),
});
export type InventoryState = z.infer<typeof InventoryStateSchema>;

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly code: InventoryErrorCode; readonly message: string };

export const success = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const failure = (status: number, code: InventoryErrorCode, message: string): Outcome<never> => ({ ok: false, status, code, message });

export const HTTP = { badRequest: 400, notFound: 404, conflict: 409 } as const;

export const iso = (ms: number): string => new Date(ms).toISOString();

export const departureMs = (f: FlightRecord): number => Date.parse(f.scheduledDepartsAt) + f.delayMinutes * MS_PER_MINUTE;
export const arrivalMs = (f: FlightRecord): number =>
  f.arrivedAt !== null ? Date.parse(f.arrivedAt) : departureMs(f) + f.durationMinutes * MS_PER_MINUTE;
export const checkInOpensMs = (f: FlightRecord): number => departureMs(f) - CHECK_IN_OPENS_BEFORE_MS;
export const checkInClosesMs = (f: FlightRecord): number => departureMs(f) - CHECK_IN_CLOSES_BEFORE_MS;

export function localToUtcMs(state: InventoryState, date: string, time: string): number {
  return Date.parse(`${date}T${time}:00Z`) - state.utcOffsetMinutes * MS_PER_MINUTE;
}

export function localDate(state: InventoryState, ms: number): string {
  return iso(ms + state.utcOffsetMinutes * MS_PER_MINUTE).slice(0, 10);
}

export function nightsBetween(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  for (let ms = Date.parse(`${checkIn}T00:00:00Z`); ms < Date.parse(`${checkOut}T00:00:00Z`); ms += MS_PER_DAY) {
    nights.push(iso(ms).slice(0, 10));
  }
  return nights;
}

export function nextRef(state: InventoryState, prefix: string): string {
  state.counter += 1;
  return `${prefix}${String(state.counter).padStart(5, "0")}`;
}

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;

export function emit(state: InventoryState, atMs: number, event: WithoutEnvelope<InventoryEvent>): void {
  const seq = (state.events.at(-1)?.seq ?? 0) + 1;
  state.events.push(InventoryEventSchema.parse({ ...event, seq, at: iso(atMs) }));
}

export function postCharge(
  state: InventoryState,
  atMs: number,
  charge: { memberId: string | null; bookingRef: string | null; amountCents: number; merchant: string },
): void {
  if (charge.amountCents <= 0) return;
  const chargeId = nextRef(state, "CH");
  state.charges.push({ chargeId, ...charge, at: iso(atMs) });
  emit(state, atMs, { kind: "charge_posted", chargeId, memberId: charge.memberId, amountCents: charge.amountCents, merchant: charge.merchant });
}

export const flightById = (state: InventoryState, flightId: string): FlightRecord | undefined =>
  state.flights.find((f) => f.flightId === flightId);

export function seatsTaken(state: InventoryState, flightId: string): number {
  return state.flightBookings
    .filter((b) => b.flightId === flightId && b.status === "confirmed")
    .reduce((sum, b) => sum + b.passengers.length, 0);
}

export function roomsTaken(state: InventoryState, hotelId: string, night: string): number {
  return state.hotelBookings
    .filter((b) => b.hotelId === hotelId && b.status !== "cancelled" && b.checkIn <= night && night < b.checkOut)
    .reduce((sum, b) => sum + b.rooms, 0);
}

export function seatsReserved(state: InventoryState, venueId: string, atMs: number, excludeRef: string | null): number {
  return state.reservations
    .filter((r) => r.venueId === venueId && r.bookingRef !== excludeRef && (r.status === "booked" || r.status === "seated") && Date.parse(r.at) === atMs)
    .reduce((sum, r) => sum + r.guestIds.length, 0);
}

/**
 * Whether a member is physically at the destination at a moment. Members with no inbound flight
 * booked are assumed to be there already; otherwise they must have boarded a flight that has landed.
 */
export function isPresent(state: InventoryState, memberId: string, atMs: number): boolean {
  const inbound = state.flightBookings.filter(
    (b) => b.status === "confirmed" && b.passengers.some((p) => p.memberId === memberId) && flightById(state, b.flightId)?.destination === state.destinationAirport,
  );
  if (inbound.length === 0) return true;
  return inbound.some((b) => {
    const flight = flightById(state, b.flightId);
    const passenger = b.passengers.find((p) => p.memberId === memberId);
    return flight?.status === "arrived" && passenger?.checkIn === "boarded" && arrivalMs(flight) <= atMs;
  });
}
