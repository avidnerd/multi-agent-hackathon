import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInventoryClient, createTwinControlClient, withRetry, type InventoryClient, type TwinControlClient } from "@trip/clients";
import type { InventoryEvent } from "@trip/clients/contracts";
import { startTwin, type RunningTwin } from "../kit/twin-app";
import { unwrap } from "../testing";
import type { InventoryState } from "./model";
import { inventoryTwin } from "./twin";

const FLIGHT = "TW143-2026-10-09"; // departs 10:40 PDT = 17:40Z, lands 19:15Z
const priya = { memberId: "priya", name: "Priya" };
const dev = { memberId: "dev", name: "Dev" };
const CLIENT_TIMEOUT_MS = 400;

let twin: RunningTwin<InventoryState>;
let client: InventoryClient;
let control: TwinControlClient;

beforeEach(async () => {
  twin = await startTwin(inventoryTwin);
  client = createInventoryClient({ baseUrl: twin.url, timeoutMs: CLIENT_TIMEOUT_MS });
  control = createTwinControlClient("inventory", twin.url);
});

afterEach(async () => {
  await twin.close();
});

const seatsLeft = async (): Promise<number> => unwrap(await client.getFlight(FLIGHT)).seatsAvailable;
const passengers = (count: number) => Array.from({ length: count }, (_, i) => ({ memberId: `extra-${i}`, name: `Extra ${i}` }));

describe("inventory twin holds state", () => {
  it("decrements seats on booking, reads them back, and rejects an overbooking", async () => {
    expect(await seatsLeft()).toBe(12);
    unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya, dev] }, "book-1"));
    expect(await seatsLeft()).toBe(10);

    const overbook = await client.bookFlight({ flightId: FLIGHT, passengers: passengers(11) }, "book-2");
    expect(overbook).toMatchObject({ ok: false, error: { kind: "conflict", code: "insufficient_seats" } });
    expect(await seatsLeft()).toBe(10);
  });

  it("replays an idempotent write instead of booking twice", async () => {
    const first = unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "same-key"));
    const second = unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "same-key"));
    expect(second.bookingRef).toBe(first.bookingRef);
    expect(await seatsLeft()).toBe(11);
    expect(unwrap(await client.listCharges())).toHaveLength(1);
  });

  it("rejects a reused idempotency key carrying a different request", async () => {
    unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "reused"));
    const reuse = await client.bookFlight({ flightId: FLIGHT, passengers: [dev] }, "reused");
    expect(reuse).toMatchObject({ ok: false, error: { kind: "conflict", code: "idempotency_key_reused" } });
  });

  it("accepts the same booking again under a different key", async () => {
    // The twin, like most real systems, allows it. Preventing this is the agent's job and the eval checks it.
    unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "k-a"));
    unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "k-b"));
    expect(unwrap(await client.listFlightBookings())).toHaveLength(2);
  });

  it("fills a venue slot and rejects the party that does not fit", async () => {
    const at = "2026-10-09T22:00:00.000Z"; // beach club 15:00 PDT, 6 seats
    unwrap(await client.reserve({ venueId: "beach-club", at, guestIds: ["a", "b", "c", "d"] }, "r-1"));
    const full = await client.reserve({ venueId: "beach-club", at, guestIds: ["e", "f", "g"] }, "r-2");
    expect(full).toMatchObject({ ok: false, error: { code: "slot_full" } });
  });
});

describe("inventory twin faults", () => {
  it("rate_limit returns 429 with Retry-After, then recovers", async () => {
    unwrap(await control.armFault({ kind: "rate_limit", retryAfterSeconds: 2 }));
    expect(await client.getFlight(FLIGHT)).toEqual({ ok: false, error: { kind: "rate_limited", service: "inventory", retryAfterMs: 2000 } });
    expect((await client.getFlight(FLIGHT)).ok).toBe(true);
  });

  it("empty_200 applies the write but returns no body; a keyed retry recovers the booking", async () => {
    unwrap(await control.armFault({ kind: "empty_200", method: "POST" }));
    const blank = await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "empty-key");
    expect(blank).toMatchObject({ ok: false, error: { kind: "validation_failed", boundary: "api_response" } });
    expect(await seatsLeft()).toBe(11);

    const retried = unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "empty-key"));
    expect(retried.passengers[0]?.memberId).toBe("priya");
    expect(await seatsLeft()).toBe(11);
  });

  it("write_then_timeout commits the write and never answers; withRetry on the same key books exactly once", async () => {
    unwrap(await control.armFault({ kind: "write_then_timeout", method: "POST" }));
    const retries: string[] = [];
    const booking = await withRetry(() => client.bookFlight({ flightId: FLIGHT, passengers: [priya, dev] }, "timeout-key"), {
      sleep: async () => undefined,
      onRetry: (error) => retries.push(error.kind),
    });

    expect(booking.ok).toBe(true);
    expect(retries).toEqual(["timeout"]);
    expect(await seatsLeft()).toBe(10);
    const log = unwrap(await control.log());
    expect(log.filter((e) => e.method === "POST").map((e) => [e.status, e.fault])).toEqual([
      [null, "write_then_timeout"],
      [201, null],
    ]);
  });

  it("stale_read serves the state from before the last write", async () => {
    unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "stale-key"));
    unwrap(await control.armFault({ kind: "stale_read" }));
    expect(await seatsLeft()).toBe(12);
    expect(await seatsLeft()).toBe(11);
  });

  it("partial_batch fails the chosen items without writing them", async () => {
    unwrap(await control.armFault({ kind: "partial_batch", failIndices: [1] }));
    const results = unwrap(
      await client.bookFlights(
        { bookings: [{ flightId: FLIGHT, passengers: [priya] }, { flightId: FLIGHT, passengers: [dev] }, { flightId: "TW177-2026-10-09", passengers: [dev] }] },
        "batch-key",
      ),
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(unwrap(await client.listFlightBookings())).toHaveLength(2);
  });

  it("duplicate_webhook delivers every event in the next feed page twice", async () => {
    unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya, dev] }, "dup-key"));
    unwrap(await control.armFault({ kind: "duplicate_webhook" }));
    const duplicated = unwrap(await client.events(0));
    expect(duplicated.events.map((e) => e.seq)).toEqual([1, 1, 2, 2]);
    expect(unwrap(await client.events(0)).events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("slow delays the response by the configured time", async () => {
    unwrap(await control.armFault({ kind: "slow", delayMs: 150 }));
    const started = performance.now();
    expect((await client.getFlight(FLIGHT)).ok).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
  });
});

describe("inventory twin clock", () => {
  const kinds = (events: readonly InventoryEvent[]) => events.map((e) => e.kind);

  it("opens check-in 24h out, closes it 45 minutes out, and departs the flight on time", async () => {
    const booking = unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya, dev] }, "clock-book"));

    expect(await client.checkIn(booking.bookingRef, "priya", "ci-early")).toMatchObject({ ok: false, error: { code: "check_in_not_open" } });
    unwrap(await control.setClock("2026-10-08T18:00:00Z"));
    unwrap(await client.checkIn(booking.bookingRef, "priya", "ci-priya"));
    unwrap(await control.setClock("2026-10-09T17:00:00Z"));
    expect(await client.checkIn(booking.bookingRef, "dev", "ci-dev")).toMatchObject({ ok: false, error: { code: "check_in_closed" } });

    unwrap(await control.setClock("2026-10-09T17:41:00Z"));
    expect(unwrap(await client.getFlight(FLIGHT)).status).toBe("departed");
    const after = unwrap(await client.getFlightBooking(booking.bookingRef));
    expect(after.passengers.map((p) => [p.memberId, p.checkIn])).toEqual([["priya", "boarded"], ["dev", "no_show"]]);

    const departed = unwrap(await client.events(0)).events.find((e) => e.kind === "flight_departed" && e.flightId === FLIGHT);
    expect(departed).toMatchObject({ boardedMemberIds: ["priya"], noShowMemberIds: ["dev"], at: "2026-10-09T17:40:00.000Z" });

    unwrap(await control.advanceClock(120));
    expect(unwrap(await client.getFlight(FLIGHT)).status).toBe("arrived");
  });

  it("an injected missed flight turns a checked-in passenger into a no-show at departure", async () => {
    const booking = unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya, dev] }, "miss-book"));
    unwrap(await control.setClock("2026-10-09T08:00:00Z"));
    unwrap(await client.checkIn(booking.bookingRef, "priya", "miss-ci-1"));
    unwrap(await client.checkIn(booking.bookingRef, "dev", "miss-ci-2"));
    unwrap(await control.injectEvent({ kind: "passenger_misses_flight", bookingRef: booking.bookingRef, memberId: "dev" }));

    unwrap(await control.setClock("2026-10-09T18:00:00Z"));
    const after = unwrap(await client.getFlightBooking(booking.bookingRef));
    expect(after.passengers.find((p) => p.memberId === "dev")?.checkIn).toBe("no_show");
  });

  it("a delay moves departure, and downstream reservations seat only the people who arrived", async () => {
    const booking = unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya, dev] }, "delay-book"));
    const table = unwrap(await client.reserve({ venueId: "beach-club", at: "2026-10-09T22:00:00Z", guestIds: ["priya", "dev", "sam"] }, "delay-table"));
    unwrap(await control.setClock("2026-10-09T08:00:00Z"));
    unwrap(await client.checkIn(booking.bookingRef, "priya", "d-ci-1"));
    unwrap(await client.checkIn(booking.bookingRef, "dev", "d-ci-2"));
    unwrap(await control.injectEvent({ kind: "flight_delayed", flightId: FLIGHT, delayMinutes: 90 }));
    unwrap(await control.injectEvent({ kind: "passenger_misses_flight", bookingRef: booking.bookingRef, memberId: "dev" }));

    unwrap(await control.setClock("2026-10-09T17:41:00Z"));
    expect(unwrap(await client.getFlight(FLIGHT)).status).toBe("delayed");
    unwrap(await control.setClock("2026-10-09T23:00:00Z"));

    // Every seeded flight departs on the clock, booked or not, so narrow the feed to this trip.
    const events = unwrap(await client.events(0)).events.filter(
      (e) => e.kind !== "charge_posted" && e.kind !== "passenger_checked_in" && (!("flightId" in e) || e.flightId === FLIGHT),
    );
    expect(kinds(events)).toEqual([
      "flight_delayed",
      "flight_departed",
      "flight_arrived",
      "reservation_seated",
    ]);
    const seated = unwrap(await client.listReservations()).find((r) => r.bookingRef === table.bookingRef);
    expect(seated?.seatedGuestIds).toEqual(["priya", "sam"]);
  });

  it("refuses to move the clock backwards", async () => {
    unwrap(await control.setClock("2026-10-05T00:00:00Z"));
    expect(await control.setClock("2026-10-02T00:00:00Z")).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });

  it("reset restores the seed and clears faults", async () => {
    unwrap(await client.bookFlight({ flightId: FLIGHT, passengers: [priya] }, "reset-book"));
    unwrap(await control.armFault({ kind: "rate_limit", count: 5 }));
    unwrap(await control.reset());
    expect(await seatsLeft()).toBe(12);
  });
});
