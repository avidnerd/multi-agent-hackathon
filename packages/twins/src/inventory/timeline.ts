import { AppFailure } from "@trip/core";
import type { InjectedInventoryEvent } from "@trip/clients/contracts";
import { arriveFlight, cancelFlight, delayFlight, departFlight, markMissed } from "./flights";
import { checkInHotel, hotelCheckInMs, lateHotelCheckIn, markReservationNoShow, seatReservation } from "./lodging";
import { arrivalMs, departureMs, postCharge, success, type InventoryState, type Outcome } from "./model";

/** A clock jump larger than any seeded schedule could need. Hitting it means a transition failed to change state. */
const MAX_TRANSITIONS = 10_000;

/** Tie-break for transitions at the same instant: a flight must land before the hotel or table it feeds. */
const RANK = { departure: 0, arrival: 1, hotelCheckIn: 2, reservation: 3 } as const;

interface Transition {
  readonly atMs: number;
  readonly rank: number;
  readonly apply: () => void;
}

function pendingTransitions(state: InventoryState, fromMs: number, toMs: number): Transition[] {
  const within = (ms: number): boolean => ms > fromMs && ms <= toMs;
  const pending: Transition[] = [];

  for (const flight of state.flights) {
    const departs = departureMs(flight);
    const arrives = arrivalMs(flight);
    if (flight.status === "scheduled" && within(departs)) {
      pending.push({ atMs: departs, rank: RANK.departure, apply: () => departFlight(state, flight) });
    } else if (flight.status === "departed" && within(arrives)) {
      pending.push({
        atMs: arrives,
        rank: RANK.arrival,
        apply: () => {
          for (const memberId of arriveFlight(state, flight, arrives)) lateHotelCheckIn(state, memberId, arrives);
        },
      });
    }
  }
  for (const booking of state.hotelBookings) {
    const at = hotelCheckInMs(state, booking);
    if (booking.status === "confirmed" && within(at)) {
      pending.push({ atMs: at, rank: RANK.hotelCheckIn, apply: () => checkInHotel(state, booking, at) });
    }
  }
  for (const reservation of state.reservations) {
    const at = Date.parse(reservation.at);
    if (reservation.status === "booked" && within(at)) {
      pending.push({ atMs: at, rank: RANK.reservation, apply: () => seatReservation(state, reservation) });
    }
  }
  return pending;
}

/** Applies every time-triggered transition in (fromMs, toMs] in chronological order. */
export function advanceClock(state: InventoryState, fromMs: number, toMs: number): void {
  for (let applied = 0; applied < MAX_TRANSITIONS; applied += 1) {
    const [next] = pendingTransitions(state, fromMs, toMs).sort((a, b) => a.atMs - b.atMs || a.rank - b.rank);
    if (next === undefined) return;
    next.apply();
  }
  throw new AppFailure({ kind: "internal", detail: `clock advance exceeded ${MAX_TRANSITIONS} transitions` });
}

export function applyInjectedEvent(state: InventoryState, nowMs: number, event: InjectedInventoryEvent): Outcome<unknown> {
  switch (event.kind) {
    case "flight_delayed":
      return delayFlight(state, nowMs, event.flightId, event.delayMinutes);
    case "flight_cancelled":
      return cancelFlight(state, nowMs, event.flightId);
    case "passenger_misses_flight":
      return markMissed(state, event.bookingRef, event.memberId);
    case "reservation_no_show":
      return markReservationNoShow(state, nowMs, event.bookingRef);
    case "charge_posted":
      postCharge(state, nowMs, { memberId: event.memberId, bookingRef: null, amountCents: event.amountCents, merchant: event.merchant });
      return success(state.charges.at(-1) ?? null);
  }
}
