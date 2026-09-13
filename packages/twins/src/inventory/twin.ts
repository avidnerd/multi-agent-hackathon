import type { Request, Response, Router } from "express";
import { z } from "zod";
import {
  BatchFlightBookingRequestSchema,
  CheckInRequestSchema,
  CreateFlightBookingSchema,
  CreateHotelBookingSchema,
  CreateReservationSchema,
  EVENTS_PAGE_MAX,
  FAULT_KINDS,
  InjectedInventoryEventSchema,
  ModifyReservationSchema,
  type BatchItemResult,
} from "@trip/clients/contracts";
import type { TwinDefinition, TwinRuntime } from "../kit/twin-app";
import { bookFlight, cancelFlightBooking, checkIn } from "./flights";
import { bookHotel, cancelHotelBooking, cancelReservation, modifyReservation, reserve } from "./lodging";
import { HTTP, InventoryStateSchema, localDate, success, type InventoryState, type Outcome } from "./model";
import { defaultInventorySeed, INVENTORY_DEFAULT_CLOCK } from "./seed";
import { advanceClock, applyInjectedEvent } from "./timeline";
import { toFlight, toFlightBooking, toHotel, toHotelBooking, toReservation, toVenue } from "./views";

const STATUS = { ok: 200, created: 201, unprocessable: 422 } as const;

const FlightQuerySchema = z.object({
  origin: z.string().optional(),
  destination: z.string().optional(),
  date: z.string().optional(),
});
const EventsQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().default(0) });

function registerRoutes(router: Router, twin: TwinRuntime<InventoryState>): void {
  const nowMs = (): number => twin.now().getTime();

  const respond = <T>(res: Response, outcome: Outcome<T>, status: number): void => {
    if (outcome.ok) res.status(status).json(outcome.value);
    else twin.sendError(res, outcome.status, outcome.code, outcome.message);
  };

  const parse = <T>(res: Response, schema: z.ZodType<T>, input: unknown): T | null => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    twin.sendError(res, HTTP.badRequest, "invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
    return null;
  };

  /** Stripe-style idempotency. Only successful outcomes are stored, so a failed write can be retried once conditions change. */
  const idempotent = (req: Request, res: Response, run: (state: InventoryState) => Outcome<unknown>, successStatus: number): void => {
    const key = req.get("idempotency-key");
    if (key === undefined || key.length === 0) {
      twin.sendError(res, HTTP.badRequest, "idempotency_key_required", "Writes need an Idempotency-Key header");
      return;
    }
    const fingerprint = `${req.method} ${req.path} ${JSON.stringify(req.body ?? null)}`;
    const stored = twin.current().idempotency[key];
    if (stored !== undefined) {
      if (stored.fingerprint !== fingerprint) {
        twin.sendError(res, STATUS.unprocessable, "idempotency_key_reused", `Idempotency-Key ${key} was already used for a different request`);
        return;
      }
      res.set("Idempotent-Replayed", "true");
      res.status(stored.status).json(stored.body);
      return;
    }
    const outcome = twin.write((state) => {
      const result = run(state);
      if (result.ok) state.idempotency[key] = { fingerprint, status: successStatus, body: structuredClone(result.value) };
      return result;
    });
    respond(res, outcome, successStatus);
  };

  router.get("/v1/clock", (_req, res) => {
    res.json({ now: twin.now().toISOString() });
  });

  router.get("/v1/flights", (req, res) => {
    const query = parse(res, FlightQuerySchema, req.query);
    if (query === null) return;
    const state = twin.read(req);
    const flights = state.flights
      .filter((f) => (query.origin === undefined || f.origin === query.origin) && (query.destination === undefined || f.destination === query.destination))
      .filter((f) => query.date === undefined || localDate(state, Date.parse(f.scheduledDepartsAt)) === query.date)
      .map((f) => toFlight(state, f));
    res.json({ flights });
  });

  router.get("/v1/flights/:flightId", (req, res) => {
    const state = twin.read(req);
    const flight = state.flights.find((f) => f.flightId === req.params.flightId);
    if (flight === undefined) return twin.sendError(res, HTTP.notFound, "not_found", `No flight ${req.params.flightId}`);
    res.json(toFlight(state, flight));
  });

  router.post("/v1/flight-bookings/batch", (req, res) => {
    const body = parse(res, BatchFlightBookingRequestSchema, req.body);
    if (body === null) return;
    idempotent(
      req,
      res,
      (state) => {
        const partial = twin.takeFault("partial_batch", req);
        const results = body.bookings.map((item, index): BatchItemResult => {
          if (partial?.failIndices.includes(index)) {
            return { index, ok: false, error: { code: "upstream_unavailable", message: "The booking provider did not confirm this item" } };
          }
          const booked = bookFlight(state, nowMs(), item);
          return booked.ok ? { index, ok: true, booking: booked.value } : { index, ok: false, error: { code: booked.code, message: booked.message } };
        });
        return success({ results });
      },
      STATUS.ok,
    );
  });

  router.post("/v1/flight-bookings", (req, res) => {
    const body = parse(res, CreateFlightBookingSchema, req.body);
    if (body === null) return;
    idempotent(req, res, (state) => bookFlight(state, nowMs(), body), STATUS.created);
  });

  router.get("/v1/flight-bookings", (req, res) => {
    res.json({ bookings: twin.read(req).flightBookings.map(toFlightBooking) });
  });

  router.get("/v1/flight-bookings/:bookingRef", (req, res) => {
    const booking = twin.read(req).flightBookings.find((b) => b.bookingRef === req.params.bookingRef);
    if (booking === undefined) return twin.sendError(res, HTTP.notFound, "not_found", `No flight booking ${req.params.bookingRef}`);
    res.json(toFlightBooking(booking));
  });

  router.post("/v1/flight-bookings/:bookingRef/check-in", (req, res) => {
    const body = parse(res, CheckInRequestSchema, req.body);
    if (body === null) return;
    idempotent(req, res, (state) => checkIn(state, nowMs(), req.params.bookingRef, body.memberId), STATUS.ok);
  });

  router.post("/v1/flight-bookings/:bookingRef/cancel", (req, res) => {
    idempotent(req, res, (state) => cancelFlightBooking(state, req.params.bookingRef), STATUS.ok);
  });

  router.get("/v1/hotels", (req, res) => {
    const state = twin.read(req);
    res.json({ hotels: state.hotels.map((h) => toHotel(state, h)) });
  });

  router.post("/v1/hotel-bookings", (req, res) => {
    const body = parse(res, CreateHotelBookingSchema, req.body);
    if (body === null) return;
    idempotent(req, res, (state) => bookHotel(state, nowMs(), body), STATUS.created);
  });

  router.get("/v1/hotel-bookings", (req, res) => {
    res.json({ bookings: twin.read(req).hotelBookings.map(toHotelBooking) });
  });

  router.post("/v1/hotel-bookings/:bookingRef/cancel", (req, res) => {
    idempotent(req, res, (state) => cancelHotelBooking(state, req.params.bookingRef), STATUS.ok);
  });

  router.get("/v1/venues", (req, res) => {
    const state = twin.read(req);
    res.json({ venues: state.venues.map((v) => toVenue(state, v)) });
  });

  router.post("/v1/reservations", (req, res) => {
    const body = parse(res, CreateReservationSchema, req.body);
    if (body === null) return;
    idempotent(req, res, (state) => reserve(state, nowMs(), body), STATUS.created);
  });

  router.get("/v1/reservations", (req, res) => {
    res.json({ reservations: twin.read(req).reservations.map(toReservation) });
  });

  router.patch("/v1/reservations/:bookingRef", (req, res) => {
    const body = parse(res, ModifyReservationSchema, req.body);
    if (body === null) return;
    idempotent(req, res, (state) => modifyReservation(state, nowMs(), req.params.bookingRef, body), STATUS.ok);
  });

  router.post("/v1/reservations/:bookingRef/cancel", (req, res) => {
    idempotent(req, res, (state) => cancelReservation(state, nowMs(), req.params.bookingRef), STATUS.ok);
  });

  router.get("/v1/charges", (req, res) => {
    res.json({ charges: twin.read(req).charges });
  });

  router.get("/v1/events", (req, res) => {
    const query = parse(res, EventsQuerySchema, req.query);
    if (query === null) return;
    const page = twin.read(req).events.filter((e) => e.seq > query.after).slice(0, EVENTS_PAGE_MAX);
    const lastSeq = page.at(-1)?.seq ?? query.after;
    // duplicate_webhook on a polled feed: every event in the page is delivered twice.
    const duplicated = twin.takeFault("duplicate_webhook", req) !== null;
    res.json({ events: duplicated ? page.flatMap((e) => [e, e]) : page, lastSeq });
  });
}

export const inventoryTwin: TwinDefinition<InventoryState> = {
  name: "inventory",
  supportedFaults: FAULT_KINDS,
  stateSchema: InventoryStateSchema,
  seed: defaultInventorySeed,
  defaultClock: INVENTORY_DEFAULT_CLOCK,
  errorBody: (_status, code, message) => ({ error: { code, message } }),
  routes: registerRoutes,
  onClockAdvance: advanceClock,
  injectEvent: (twin, raw) => {
    const parsed = InjectedInventoryEventSchema.safeParse(raw);
    if (!parsed.success) return { status: HTTP.badRequest, body: { error: { code: "invalid_request", message: parsed.error.message } } };
    const outcome = twin.write((state) => applyInjectedEvent(state, twin.now().getTime(), parsed.data));
    return outcome.ok
      ? { status: STATUS.ok, body: { applied: parsed.data.kind } }
      : { status: outcome.status, body: { error: { code: outcome.code, message: outcome.message } } };
  },
};
