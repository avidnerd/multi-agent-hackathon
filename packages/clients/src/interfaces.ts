import type { Result } from "@trip/core";
import type {
  BatchFlightBookingRequest,
  BatchItemResult,
  Charge,
  ClockView,
  CreateFlightBooking,
  CreateHotelBooking,
  CreateReservation,
  EventsPage,
  Flight,
  FlightBooking,
  Hotel,
  HotelBooking,
  ModifyReservation,
  Reservation,
  Venue,
} from "./contracts";

/**
 * One interface per external app. Real and twin modes share an implementation and differ only in
 * base URL and credentials, chosen once in createClients. Nothing downstream can tell them apart.
 */

export interface InventoryClient {
  clock(): Promise<Result<ClockView>>;
  searchFlights(query: { origin?: string; destination?: string; date?: string }): Promise<Result<Flight[]>>;
  getFlight(flightId: string): Promise<Result<Flight>>;
  bookFlight(request: CreateFlightBooking, idempotencyKey: string): Promise<Result<FlightBooking>>;
  bookFlights(request: BatchFlightBookingRequest, idempotencyKey: string): Promise<Result<BatchItemResult[]>>;
  listFlightBookings(): Promise<Result<FlightBooking[]>>;
  getFlightBooking(bookingRef: string): Promise<Result<FlightBooking>>;
  checkIn(bookingRef: string, memberId: string, idempotencyKey: string): Promise<Result<FlightBooking>>;
  cancelFlightBooking(bookingRef: string, idempotencyKey: string): Promise<Result<FlightBooking>>;
  listHotels(): Promise<Result<Hotel[]>>;
  bookHotel(request: CreateHotelBooking, idempotencyKey: string): Promise<Result<HotelBooking>>;
  listHotelBookings(): Promise<Result<HotelBooking[]>>;
  cancelHotelBooking(bookingRef: string, idempotencyKey: string): Promise<Result<HotelBooking>>;
  listVenues(): Promise<Result<Venue[]>>;
  reserve(request: CreateReservation, idempotencyKey: string): Promise<Result<Reservation>>;
  listReservations(): Promise<Result<Reservation[]>>;
  modifyReservation(bookingRef: string, change: ModifyReservation, idempotencyKey: string): Promise<Result<Reservation>>;
  cancelReservation(bookingRef: string, idempotencyKey: string): Promise<Result<Reservation>>;
  listCharges(): Promise<Result<Charge[]>>;
  events(afterSeq: number): Promise<Result<EventsPage>>;
}

export interface OutboundMessage {
  readonly to: string;
  readonly body: string;
}

export interface SentMessage {
  readonly externalId: string;
  readonly to: string;
  readonly sentAt: string;
}

export interface InboundMessage {
  readonly externalId: string;
  readonly from: string;
  /** Untrusted member text. */
  readonly body: string;
  readonly receivedAt: string;
}

export interface MessagingClient {
  readonly channel: "sms" | "imessage";
  /** Not idempotent at the provider. The dispatcher's executed-action record is what prevents a resend. */
  send(message: OutboundMessage): Promise<Result<SentMessage>>;
  /** Can return messages seen on an earlier poll. Callers dedupe on externalId. */
  listInbound(since: Date): Promise<Result<InboundMessage[]>>;
}

export interface CalendarEventInput {
  /** Derives the provider event id, so a retried create cannot make a second event. */
  readonly idempotencyKey: string;
  readonly tripId: string;
  readonly summary: string;
  readonly description: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly attendeeEmails: readonly string[];
  /** False for tentative holds that should not show the organizer as busy. */
  readonly blocksTime: boolean;
  readonly notifyAttendees: boolean;
}

export interface CalendarEvent {
  readonly eventId: string;
  readonly tripId: string | null;
  readonly summary: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly attendeeEmails: readonly string[];
  readonly blocksTime: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
}

export interface BusyInterval {
  readonly start: string;
  readonly end: string;
}

export interface CalendarClient {
  createEvent(input: CalendarEventInput): Promise<Result<CalendarEvent>>;
  getEvent(eventId: string): Promise<Result<CalendarEvent>>;
  listTripEvents(query: { tripId: string; from: string; to: string }): Promise<Result<CalendarEvent[]>>;
  moveEvent(eventId: string, change: { startsAt: string; endsAt: string; notifyAttendees: boolean }): Promise<Result<CalendarEvent>>;
  /** Succeeds if the event is already gone. */
  deleteEvent(eventId: string, options: { notifyAttendees: boolean }): Promise<Result<null>>;
  busyIntervals(query: { from: string; to: string }): Promise<Result<BusyInterval[]>>;
}
