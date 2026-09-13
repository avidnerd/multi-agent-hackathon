import type { CreateFlightBooking, FlightBooking } from "@trip/clients/contracts";
import {
  checkInClosesMs,
  checkInOpensMs,
  departureMs,
  emit,
  failure,
  flightById,
  HTTP,
  iso,
  nextRef,
  postCharge,
  seatsTaken,
  success,
  type FlightBookingRecord,
  type FlightRecord,
  type InventoryState,
  type Outcome,
} from "./model";
import { toFlightBooking } from "./views";

export function bookFlight(state: InventoryState, nowMs: number, request: CreateFlightBooking): Outcome<FlightBooking> {
  const flight = flightById(state, request.flightId);
  if (flight === undefined) return failure(HTTP.notFound, "not_found", `No flight ${request.flightId}`);
  if (flight.status !== "scheduled" || nowMs >= checkInClosesMs(flight)) {
    return failure(HTTP.conflict, "flight_closed", `${flight.flightNumber} is no longer taking bookings`);
  }
  const memberIds = request.passengers.map((p) => p.memberId);
  if (new Set(memberIds).size !== memberIds.length) return failure(HTTP.badRequest, "invalid_request", "A passenger is listed twice");

  const available = flight.seatsTotal - seatsTaken(state, flight.flightId);
  if (available < request.passengers.length) {
    return failure(HTTP.conflict, "insufficient_seats", `${available} seats left on ${flight.flightNumber}, ${request.passengers.length} requested`);
  }

  const booking: FlightBookingRecord = {
    bookingRef: nextRef(state, "FB"),
    flightId: flight.flightId,
    passengers: request.passengers.map((p) => ({ memberId: p.memberId, name: p.name, checkIn: "not_checked_in", willMiss: false })),
    fareCents: flight.fareCents,
    status: "confirmed",
    createdAt: iso(nowMs),
  };
  state.flightBookings.push(booking);
  for (const p of booking.passengers) {
    postCharge(state, nowMs, { memberId: p.memberId, bookingRef: booking.bookingRef, amountCents: flight.fareCents, merchant: `Twin Air ${flight.flightNumber}` });
  }
  return success(toFlightBooking(booking));
}

function findBooking(state: InventoryState, bookingRef: string): Outcome<{ booking: FlightBookingRecord; flight: FlightRecord }> {
  const booking = state.flightBookings.find((b) => b.bookingRef === bookingRef);
  if (booking === undefined) return failure(HTTP.notFound, "not_found", `No flight booking ${bookingRef}`);
  const flight = flightById(state, booking.flightId);
  if (flight === undefined) return failure(HTTP.notFound, "not_found", `Booking ${bookingRef} points at a missing flight`);
  return success({ booking, flight });
}

export function checkIn(state: InventoryState, nowMs: number, bookingRef: string, memberId: string): Outcome<FlightBooking> {
  const found = findBooking(state, bookingRef);
  if (!found.ok) return found;
  const { booking, flight } = found.value;
  if (booking.status === "cancelled") return failure(HTTP.conflict, "booking_cancelled", `Booking ${bookingRef} is cancelled`);
  const passenger = booking.passengers.find((p) => p.memberId === memberId);
  if (passenger === undefined) return failure(HTTP.notFound, "not_on_booking", `${memberId} is not on booking ${bookingRef}`);
  if (passenger.checkIn === "checked_in") return success(toFlightBooking(booking));
  if (flight.status !== "scheduled") return failure(HTTP.conflict, "flight_closed", `${flight.flightNumber} has ${flight.status}`);
  if (nowMs < checkInOpensMs(flight)) return failure(HTTP.conflict, "check_in_not_open", `Check-in opens at ${iso(checkInOpensMs(flight))}`);
  if (nowMs >= checkInClosesMs(flight)) return failure(HTTP.conflict, "check_in_closed", `Check-in closed at ${iso(checkInClosesMs(flight))}`);

  passenger.checkIn = "checked_in";
  emit(state, nowMs, { kind: "passenger_checked_in", bookingRef, flightId: flight.flightId, memberId });
  return success(toFlightBooking(booking));
}

export function cancelFlightBooking(state: InventoryState, bookingRef: string): Outcome<FlightBooking> {
  const found = findBooking(state, bookingRef);
  if (!found.ok) return found;
  const { booking, flight } = found.value;
  if (booking.status === "cancelled") return failure(HTTP.conflict, "already_cancelled", `Booking ${bookingRef} is already cancelled`);
  if (flight.status !== "scheduled") return failure(HTTP.conflict, "flight_closed", `${flight.flightNumber} has ${flight.status}`);
  // Fares are non-refundable, which is why cancel_booking is classed irreversible.
  booking.status = "cancelled";
  return success(toFlightBooking(booking));
}

export function departFlight(state: InventoryState, flight: FlightRecord): void {
  const atMs = departureMs(flight);
  flight.status = "departed";
  flight.departedAt = iso(atMs);
  const boarded: string[] = [];
  const noShow: string[] = [];
  for (const booking of state.flightBookings) {
    if (booking.flightId !== flight.flightId || booking.status !== "confirmed") continue;
    for (const p of booking.passengers) {
      if (p.checkIn === "checked_in" && !p.willMiss) {
        p.checkIn = "boarded";
        boarded.push(p.memberId);
      } else {
        p.checkIn = "no_show";
        noShow.push(p.memberId);
      }
    }
  }
  emit(state, atMs, { kind: "flight_departed", flightId: flight.flightId, boardedMemberIds: boarded, noShowMemberIds: noShow });
}

/** Returns the members who landed, so hotel check-in can pick up late arrivals. */
export function arriveFlight(state: InventoryState, flight: FlightRecord, atMs: number): string[] {
  flight.status = "arrived";
  flight.arrivedAt = iso(atMs);
  emit(state, atMs, { kind: "flight_arrived", flightId: flight.flightId });
  return state.flightBookings
    .filter((b) => b.flightId === flight.flightId && b.status === "confirmed")
    .flatMap((b) => b.passengers.filter((p) => p.checkIn === "boarded").map((p) => p.memberId));
}

export function delayFlight(state: InventoryState, nowMs: number, flightId: string, minutes: number): Outcome<FlightRecord> {
  const flight = flightById(state, flightId);
  if (flight === undefined) return failure(HTTP.notFound, "not_found", `No flight ${flightId}`);
  if (flight.status !== "scheduled") return failure(HTTP.conflict, "flight_closed", `${flight.flightNumber} has ${flight.status}`);
  flight.delayMinutes += minutes;
  emit(state, nowMs, { kind: "flight_delayed", flightId, newDepartsAt: iso(departureMs(flight)) });
  return success(flight);
}

export function cancelFlight(state: InventoryState, nowMs: number, flightId: string): Outcome<FlightRecord> {
  const flight = flightById(state, flightId);
  if (flight === undefined) return failure(HTTP.notFound, "not_found", `No flight ${flightId}`);
  if (flight.status !== "scheduled") return failure(HTTP.conflict, "flight_closed", `${flight.flightNumber} has ${flight.status}`);
  flight.status = "cancelled";
  emit(state, nowMs, { kind: "flight_cancelled", flightId });
  return success(flight);
}

export function markMissed(state: InventoryState, bookingRef: string, memberId: string): Outcome<FlightBooking> {
  const found = findBooking(state, bookingRef);
  if (!found.ok) return found;
  const { booking, flight } = found.value;
  const passenger = booking.passengers.find((p) => p.memberId === memberId);
  if (passenger === undefined) return failure(HTTP.notFound, "not_on_booking", `${memberId} is not on booking ${bookingRef}`);
  if (flight.status !== "scheduled") return failure(HTTP.conflict, "flight_closed", `${flight.flightNumber} has ${flight.status}`);
  passenger.willMiss = true;
  return success(toFlightBooking(booking));
}
