import type { CreateHotelBooking, CreateReservation, HotelBooking, ModifyReservation, Reservation } from "@trip/clients/contracts";
import {
  emit,
  failure,
  HOTEL_CHECK_IN_LOCAL_TIME,
  HOTEL_CHECK_OUT_LOCAL_TIME,
  HTTP,
  iso,
  isPresent,
  localToUtcMs,
  nextRef,
  nightsBetween,
  postCharge,
  roomsTaken,
  seatsReserved,
  success,
  type HotelBookingRecord,
  type InventoryState,
  type Outcome,
  type ReservationRecord,
} from "./model";
import { toHotelBooking, toReservation } from "./views";

export function bookHotel(state: InventoryState, nowMs: number, request: CreateHotelBooking): Outcome<HotelBooking> {
  const hotel = state.hotels.find((h) => h.hotelId === request.hotelId);
  if (hotel === undefined) return failure(HTTP.notFound, "not_found", `No hotel ${request.hotelId}`);
  const nights = nightsBetween(request.checkIn, request.checkOut);
  if (nights.length === 0) return failure(HTTP.badRequest, "invalid_request", "checkOut must be after checkIn");
  if (nowMs >= localToUtcMs(state, request.checkIn, HOTEL_CHECK_IN_LOCAL_TIME)) {
    return failure(HTTP.conflict, "no_availability", `Check-in on ${request.checkIn} has already passed`);
  }
  for (const night of nights) {
    const free = (hotel.roomsPerNight[night] ?? 0) - roomsTaken(state, hotel.hotelId, night);
    if (free < request.rooms) return failure(HTTP.conflict, "no_availability", `${hotel.name} has ${Math.max(0, free)} rooms on ${night}`);
  }

  const booking: HotelBookingRecord = {
    bookingRef: nextRef(state, "HB"),
    hotelId: hotel.hotelId,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    rooms: request.rooms,
    guestIds: [...request.guestIds],
    checkedInGuestIds: [],
    totalCents: hotel.nightlyRateCents * nights.length * request.rooms,
    status: "confirmed",
    createdAt: iso(nowMs),
  };
  state.hotelBookings.push(booking);
  postCharge(state, nowMs, { memberId: booking.guestIds[0] ?? null, bookingRef: booking.bookingRef, amountCents: booking.totalCents, merchant: hotel.name });
  return success(toHotelBooking(booking));
}

export function cancelHotelBooking(state: InventoryState, bookingRef: string): Outcome<HotelBooking> {
  const booking = state.hotelBookings.find((b) => b.bookingRef === bookingRef);
  if (booking === undefined) return failure(HTTP.notFound, "not_found", `No hotel booking ${bookingRef}`);
  if (booking.status === "cancelled") return failure(HTTP.conflict, "already_cancelled", `Booking ${bookingRef} is already cancelled`);
  if (booking.status === "checked_in") return failure(HTTP.conflict, "already_checked_in", `Booking ${bookingRef} is checked in`);
  booking.status = "cancelled";
  return success(toHotelBooking(booking));
}

export const hotelCheckInMs = (state: InventoryState, booking: HotelBookingRecord): number =>
  localToUtcMs(state, booking.checkIn, HOTEL_CHECK_IN_LOCAL_TIME);

export function checkInHotel(state: InventoryState, booking: HotelBookingRecord, atMs: number): void {
  booking.status = "checked_in";
  booking.checkedInGuestIds = booking.guestIds.filter((g) => isPresent(state, g, atMs));
  if (booking.checkedInGuestIds.length > 0) {
    emit(state, atMs, { kind: "hotel_checked_in", bookingRef: booking.bookingRef, guestIds: [...booking.checkedInGuestIds] });
  }
}

export function lateHotelCheckIn(state: InventoryState, memberId: string, atMs: number): void {
  for (const booking of state.hotelBookings) {
    if (booking.status !== "checked_in" || !booking.guestIds.includes(memberId) || booking.checkedInGuestIds.includes(memberId)) continue;
    if (atMs >= localToUtcMs(state, booking.checkOut, HOTEL_CHECK_OUT_LOCAL_TIME)) continue;
    booking.checkedInGuestIds.push(memberId);
    emit(state, atMs, { kind: "hotel_checked_in", bookingRef: booking.bookingRef, guestIds: [memberId] });
  }
}

function slotAt(state: InventoryState, venueId: string, at: string): Outcome<{ seats: number; name: string }> {
  const venue = state.venues.find((v) => v.venueId === venueId);
  if (venue === undefined) return failure(HTTP.notFound, "not_found", `No venue ${venueId}`);
  const slot = venue.slots.find((s) => Date.parse(s.at) === Date.parse(at));
  if (slot === undefined) return failure(HTTP.notFound, "slot_not_found", `${venue.name} has no slot at ${at}`);
  return success({ seats: slot.seats, name: venue.name });
}

export function reserve(state: InventoryState, nowMs: number, request: CreateReservation): Outcome<Reservation> {
  const slot = slotAt(state, request.venueId, request.at);
  if (!slot.ok) return slot;
  const atMs = Date.parse(request.at);
  if (atMs <= nowMs) return failure(HTTP.conflict, "reservation_closed", `The ${request.at} slot has passed`);
  const free = slot.value.seats - seatsReserved(state, request.venueId, atMs, null);
  if (free < request.guestIds.length) {
    return failure(HTTP.conflict, "slot_full", `${slot.value.name} has ${free} seats at ${request.at}, ${request.guestIds.length} requested`);
  }
  const reservation: ReservationRecord = {
    bookingRef: nextRef(state, "RS"),
    venueId: request.venueId,
    at: iso(atMs),
    guestIds: [...request.guestIds],
    seatedGuestIds: [],
    status: "booked",
    noShow: false,
    createdAt: iso(nowMs),
  };
  state.reservations.push(reservation);
  return success(toReservation(reservation));
}

function openReservation(state: InventoryState, nowMs: number, bookingRef: string): Outcome<ReservationRecord> {
  const reservation = state.reservations.find((r) => r.bookingRef === bookingRef);
  if (reservation === undefined) return failure(HTTP.notFound, "not_found", `No reservation ${bookingRef}`);
  if (reservation.status !== "booked" || Date.parse(reservation.at) <= nowMs) {
    return failure(HTTP.conflict, "reservation_closed", `Reservation ${bookingRef} is ${reservation.status} and can no longer change`);
  }
  return success(reservation);
}

export function modifyReservation(state: InventoryState, nowMs: number, bookingRef: string, change: ModifyReservation): Outcome<Reservation> {
  const found = openReservation(state, nowMs, bookingRef);
  if (!found.ok) return found;
  const reservation = found.value;
  const at = change.at ?? reservation.at;
  const guestIds = change.guestIds ?? reservation.guestIds;
  const slot = slotAt(state, reservation.venueId, at);
  if (!slot.ok) return slot;
  const atMs = Date.parse(at);
  if (atMs <= nowMs) return failure(HTTP.conflict, "reservation_closed", `The ${at} slot has passed`);
  const free = slot.value.seats - seatsReserved(state, reservation.venueId, atMs, bookingRef);
  if (free < guestIds.length) return failure(HTTP.conflict, "slot_full", `${slot.value.name} has ${free} seats at ${at}`);

  reservation.at = iso(atMs);
  reservation.guestIds = [...guestIds];
  emit(state, nowMs, { kind: "reservation_modified", bookingRef, newAt: reservation.at, guestIds: [...guestIds] });
  return success(toReservation(reservation));
}

export function cancelReservation(state: InventoryState, nowMs: number, bookingRef: string): Outcome<Reservation> {
  const found = openReservation(state, nowMs, bookingRef);
  if (!found.ok) return found;
  found.value.status = "cancelled";
  return success(toReservation(found.value));
}

export function markReservationNoShow(state: InventoryState, nowMs: number, bookingRef: string): Outcome<Reservation> {
  const found = openReservation(state, nowMs, bookingRef);
  if (!found.ok) return found;
  found.value.noShow = true;
  return success(toReservation(found.value));
}

export function seatReservation(state: InventoryState, reservation: ReservationRecord): void {
  const atMs = Date.parse(reservation.at);
  const present = reservation.noShow ? [] : reservation.guestIds.filter((g) => isPresent(state, g, atMs));
  if (present.length === 0) {
    reservation.status = "no_show";
    emit(state, atMs, { kind: "reservation_no_show", bookingRef: reservation.bookingRef });
    return;
  }
  reservation.status = "seated";
  reservation.seatedGuestIds = present;
  emit(state, atMs, { kind: "reservation_seated", bookingRef: reservation.bookingRef, seatedGuestIds: [...present] });
  const venue = state.venues.find((v) => v.venueId === reservation.venueId);
  for (const guest of present) {
    postCharge(state, atMs, { memberId: guest, bookingRef: reservation.bookingRef, amountCents: venue?.pricePerPersonCents ?? 0, merchant: venue?.name ?? reservation.venueId });
  }
}
