import { z } from "zod";
import { CentsSchema, IdSchema, IsoDateSchema, IsoDateTimeSchema } from "@trip/core";

/**
 * The travel inventory API. There is no public airline or hotel API to mirror, so this contract
 * is ours; the twin is its only implementation. Writes require an Idempotency-Key header and
 * behave like Stripe's: a replay returns the stored response, a reused key with a different
 * body is rejected.
 */

export const INVENTORY_ERROR_CODES = [
  "insufficient_seats",
  "flight_closed",
  "check_in_not_open",
  "check_in_closed",
  "not_on_booking",
  "booking_cancelled",
  "already_cancelled",
  "already_checked_in",
  "no_availability",
  "slot_not_found",
  "slot_full",
  "reservation_closed",
  "idempotency_key_required",
  "idempotency_key_reused",
  "upstream_unavailable",
  "not_found",
  "invalid_request",
  "rate_limited",
  "internal",
] as const;
export type InventoryErrorCode = (typeof INVENTORY_ERROR_CODES)[number];

export const InventoryErrorSchema = z.object({ code: z.string(), message: z.string() });
export const InventoryErrorBodySchema = z.object({ error: InventoryErrorSchema });

// ---- Flights ----

export const FlightStatusSchema = z.enum(["scheduled", "delayed", "departed", "arrived", "cancelled"]);
export const FlightSchema = z.object({
  flightId: z.string(),
  flightNumber: z.string(),
  origin: z.string().length(3),
  destination: z.string().length(3),
  scheduledDepartsAt: IsoDateTimeSchema,
  departsAt: IsoDateTimeSchema,
  arrivesAt: IsoDateTimeSchema,
  status: FlightStatusSchema,
  seatsTotal: z.number().int().nonnegative(),
  seatsAvailable: z.number().int().nonnegative(),
  fareCents: CentsSchema,
  checkInOpensAt: IsoDateTimeSchema,
  checkInClosesAt: IsoDateTimeSchema,
});
export type Flight = z.infer<typeof FlightSchema>;
export const FlightListSchema = z.object({ flights: z.array(FlightSchema) });

export const PassengerCheckInSchema = z.enum(["not_checked_in", "checked_in", "boarded", "no_show"]);
export const PassengerSchema = z.object({ memberId: IdSchema, name: z.string(), checkIn: PassengerCheckInSchema });

export const FlightBookingSchema = z.object({
  bookingRef: z.string(),
  flightId: z.string(),
  passengers: z.array(PassengerSchema).min(1),
  totalCents: CentsSchema,
  status: z.enum(["confirmed", "cancelled"]),
  createdAt: IsoDateTimeSchema,
});
export type FlightBooking = z.infer<typeof FlightBookingSchema>;
export const FlightBookingListSchema = z.object({ bookings: z.array(FlightBookingSchema) });

export const CreateFlightBookingSchema = z.object({
  flightId: z.string().min(1),
  passengers: z.array(z.object({ memberId: IdSchema, name: z.string().min(1) })).min(1),
});
export type CreateFlightBooking = z.infer<typeof CreateFlightBookingSchema>;

export const BATCH_MAX_ITEMS = 10;
export const BatchFlightBookingRequestSchema = z.object({
  bookings: z.array(CreateFlightBookingSchema).min(1).max(BATCH_MAX_ITEMS),
});
export type BatchFlightBookingRequest = z.infer<typeof BatchFlightBookingRequestSchema>;

export const BatchItemResultSchema = z.discriminatedUnion("ok", [
  z.object({ index: z.number().int().nonnegative(), ok: z.literal(true), booking: FlightBookingSchema }),
  z.object({ index: z.number().int().nonnegative(), ok: z.literal(false), error: InventoryErrorSchema }),
]);
export type BatchItemResult = z.infer<typeof BatchItemResultSchema>;
export const BatchFlightBookingResponseSchema = z.object({ results: z.array(BatchItemResultSchema) });

export const CheckInRequestSchema = z.object({ memberId: IdSchema });

// ---- Hotels ----

export const HotelSchema = z.object({
  hotelId: z.string(),
  name: z.string(),
  nightlyRateCents: CentsSchema,
  /** Rooms still free, keyed by local night date. */
  availability: z.record(z.string(), z.number().int().nonnegative()),
});
export type Hotel = z.infer<typeof HotelSchema>;
export const HotelListSchema = z.object({ hotels: z.array(HotelSchema) });

export const HotelBookingSchema = z.object({
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
export type HotelBooking = z.infer<typeof HotelBookingSchema>;
export const HotelBookingListSchema = z.object({ bookings: z.array(HotelBookingSchema) });

export const CreateHotelBookingSchema = z.object({
  hotelId: z.string().min(1),
  checkIn: IsoDateSchema,
  checkOut: IsoDateSchema,
  rooms: z.number().int().positive(),
  guestIds: z.array(IdSchema).min(1),
});
export type CreateHotelBooking = z.infer<typeof CreateHotelBookingSchema>;

// ---- Venues and reservations ----

export const VenueSchema = z.object({
  venueId: z.string(),
  name: z.string(),
  pricePerPersonCents: CentsSchema,
  slots: z.array(z.object({ at: IsoDateTimeSchema, seats: z.number().int().positive(), seatsAvailable: z.number().int().nonnegative() })),
});
export type Venue = z.infer<typeof VenueSchema>;
export const VenueListSchema = z.object({ venues: z.array(VenueSchema) });

export const ReservationSchema = z.object({
  bookingRef: z.string(),
  venueId: z.string(),
  at: IsoDateTimeSchema,
  guestIds: z.array(IdSchema).min(1),
  partySize: z.number().int().positive(),
  seatedGuestIds: z.array(IdSchema),
  status: z.enum(["booked", "seated", "no_show", "cancelled"]),
  createdAt: IsoDateTimeSchema,
});
export type Reservation = z.infer<typeof ReservationSchema>;
export const ReservationListSchema = z.object({ reservations: z.array(ReservationSchema) });

export const CreateReservationSchema = z.object({
  venueId: z.string().min(1),
  at: IsoDateTimeSchema,
  guestIds: z.array(IdSchema).min(1),
});
export type CreateReservation = z.infer<typeof CreateReservationSchema>;

export const ModifyReservationSchema = z
  .object({ at: IsoDateTimeSchema.optional(), guestIds: z.array(IdSchema).min(1).optional() })
  .refine((m) => m.at !== undefined || m.guestIds !== undefined, "change at least one of at or guestIds");
export type ModifyReservation = z.infer<typeof ModifyReservationSchema>;

// ---- Spend ----

export const ChargeSchema = z.object({
  chargeId: z.string(),
  memberId: IdSchema.nullable(),
  bookingRef: z.string().nullable(),
  amountCents: CentsSchema.positive(),
  merchant: z.string(),
  at: IsoDateTimeSchema,
});
export type Charge = z.infer<typeof ChargeSchema>;
export const ChargeListSchema = z.object({ charges: z.array(ChargeSchema) });

// ---- Event feed ----

const envelope = { seq: z.number().int().positive(), at: IsoDateTimeSchema };

export const InventoryEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("flight_delayed"), flightId: z.string(), newDepartsAt: IsoDateTimeSchema }),
  z.object({ ...envelope, kind: z.literal("flight_cancelled"), flightId: z.string() }),
  z.object({
    ...envelope,
    kind: z.literal("flight_departed"),
    flightId: z.string(),
    boardedMemberIds: z.array(IdSchema),
    noShowMemberIds: z.array(IdSchema),
  }),
  z.object({ ...envelope, kind: z.literal("flight_arrived"), flightId: z.string() }),
  z.object({ ...envelope, kind: z.literal("passenger_checked_in"), bookingRef: z.string(), flightId: z.string(), memberId: IdSchema }),
  z.object({ ...envelope, kind: z.literal("hotel_checked_in"), bookingRef: z.string(), guestIds: z.array(IdSchema).min(1) }),
  z.object({ ...envelope, kind: z.literal("reservation_seated"), bookingRef: z.string(), seatedGuestIds: z.array(IdSchema).min(1) }),
  z.object({ ...envelope, kind: z.literal("reservation_no_show"), bookingRef: z.string() }),
  z.object({
    ...envelope,
    kind: z.literal("reservation_modified"),
    bookingRef: z.string(),
    newAt: IsoDateTimeSchema,
    guestIds: z.array(IdSchema).min(1),
  }),
  z.object({
    ...envelope,
    kind: z.literal("charge_posted"),
    chargeId: z.string(),
    memberId: IdSchema.nullable(),
    amountCents: CentsSchema.positive(),
    merchant: z.string(),
  }),
]);
export type InventoryEvent = z.infer<typeof InventoryEventSchema>;

export const EventsPageSchema = z.object({ events: z.array(InventoryEventSchema), lastSeq: z.number().int().nonnegative() });
export type EventsPage = z.infer<typeof EventsPageSchema>;
export const EVENTS_PAGE_MAX = 200;

// ---- Twin-only: real-world occurrences injected through POST /_twin/event ----

export const InjectedInventoryEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flight_delayed"), flightId: z.string(), delayMinutes: z.number().int().positive() }),
  z.object({ kind: z.literal("flight_cancelled"), flightId: z.string() }),
  /** The passenger will not board even if checked in. Shows up as a no_show at departure. */
  z.object({ kind: z.literal("passenger_misses_flight"), bookingRef: z.string(), memberId: IdSchema }),
  z.object({ kind: z.literal("reservation_no_show"), bookingRef: z.string() }),
  z.object({ kind: z.literal("charge_posted"), memberId: IdSchema, amountCents: CentsSchema.positive(), merchant: z.string().min(1) }),
]);
export type InjectedInventoryEvent = z.infer<typeof InjectedInventoryEventSchema>;
