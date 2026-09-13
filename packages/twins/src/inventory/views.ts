import type { Flight, FlightBooking, Hotel, HotelBooking, Reservation, Venue } from "@trip/clients/contracts";
import {
  arrivalMs,
  checkInClosesMs,
  checkInOpensMs,
  departureMs,
  iso,
  roomsTaken,
  seatsReserved,
  seatsTaken,
  type FlightBookingRecord,
  type FlightRecord,
  type HotelBookingRecord,
  type HotelRecord,
  type InventoryState,
  type ReservationRecord,
  type VenueRecord,
} from "./model";

export function toFlight(state: InventoryState, f: FlightRecord): Flight {
  return {
    flightId: f.flightId,
    flightNumber: f.flightNumber,
    origin: f.origin,
    destination: f.destination,
    scheduledDepartsAt: f.scheduledDepartsAt,
    departsAt: f.departedAt ?? iso(departureMs(f)),
    arrivesAt: iso(arrivalMs(f)),
    status: f.status === "scheduled" && f.delayMinutes > 0 ? "delayed" : f.status,
    seatsTotal: f.seatsTotal,
    seatsAvailable: Math.max(0, f.seatsTotal - seatsTaken(state, f.flightId)),
    fareCents: f.fareCents,
    checkInOpensAt: iso(checkInOpensMs(f)),
    checkInClosesAt: iso(checkInClosesMs(f)),
  };
}

export function toFlightBooking(b: FlightBookingRecord): FlightBooking {
  return {
    bookingRef: b.bookingRef,
    flightId: b.flightId,
    passengers: b.passengers.map(({ memberId, name, checkIn }) => ({ memberId, name, checkIn })),
    totalCents: b.fareCents * b.passengers.length,
    status: b.status,
    createdAt: b.createdAt,
  };
}

export function toHotel(state: InventoryState, h: HotelRecord): Hotel {
  const availability = Object.fromEntries(
    Object.entries(h.roomsPerNight).map(([night, total]) => [night, Math.max(0, total - roomsTaken(state, h.hotelId, night))]),
  );
  return { hotelId: h.hotelId, name: h.name, nightlyRateCents: h.nightlyRateCents, availability };
}

export function toHotelBooking(b: HotelBookingRecord): HotelBooking {
  return { ...b, guestIds: [...b.guestIds], checkedInGuestIds: [...b.checkedInGuestIds] };
}

export function toVenue(state: InventoryState, v: VenueRecord): Venue {
  return {
    venueId: v.venueId,
    name: v.name,
    pricePerPersonCents: v.pricePerPersonCents,
    slots: v.slots.map((s) => ({ at: s.at, seats: s.seats, seatsAvailable: Math.max(0, s.seats - seatsReserved(state, v.venueId, Date.parse(s.at), null)) })),
  };
}

export function toReservation(r: ReservationRecord): Reservation {
  return {
    bookingRef: r.bookingRef,
    venueId: r.venueId,
    at: r.at,
    guestIds: [...r.guestIds],
    partySize: r.guestIds.length,
    seatedGuestIds: [...r.seatedGuestIds],
    status: r.status,
    createdAt: r.createdAt,
  };
}
