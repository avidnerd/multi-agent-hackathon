import type { z } from "zod";
import { mapResult, type AppError } from "@trip/core";
import {
  BatchFlightBookingResponseSchema,
  ChargeListSchema,
  ClockViewSchema,
  EventsPageSchema,
  FlightBookingListSchema,
  FlightBookingSchema,
  FlightListSchema,
  FlightSchema,
  HotelBookingListSchema,
  HotelBookingSchema,
  HotelListSchema,
  InventoryErrorBodySchema,
  ReservationListSchema,
  ReservationSchema,
  VenueListSchema,
} from "./contracts";
import { httpRequest, type FetchLike } from "./http";
import type { InventoryClient } from "./interfaces";

export interface InventoryClientConfig {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

const STATUS = { notFound: 404, conflict: 409, unprocessable: 422 } as const;

function inventoryFailure(status: number, body: unknown, resource: string): AppError | null {
  const parsed = InventoryErrorBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const { code, message } = parsed.data.error;
  if (status === STATUS.notFound) return { kind: "not_found", service: "inventory", resource: `${resource} (${message})` };
  if (status === STATUS.conflict || status === STATUS.unprocessable) {
    return { kind: "conflict", service: "inventory", resource, code, detail: message };
  }
  return { kind: "upstream_failed", service: "inventory", status, detail: `${code}: ${message}` };
}

const enc = encodeURIComponent;

export function createInventoryClient(config: InventoryClientConfig, fetchImpl: FetchLike = fetch): InventoryClient {
  const get = <T>(path: string, schema: z.ZodType<T>, resource: string) =>
    httpRequest(fetchImpl, {
      service: "inventory",
      method: "GET",
      url: `${config.baseUrl}${path}`,
      schema,
      resource,
      timeoutMs: config.timeoutMs,
      mapFailure: (status, body) => inventoryFailure(status, body, resource),
    });

  const write = <T>(method: "POST" | "PATCH", path: string, body: unknown, idempotencyKey: string, schema: z.ZodType<T>, resource: string) =>
    httpRequest(fetchImpl, {
      service: "inventory",
      method,
      url: `${config.baseUrl}${path}`,
      headers: { "idempotency-key": idempotencyKey },
      body: { kind: "json", value: body },
      retrySafeOnTimeout: true,
      schema,
      resource,
      timeoutMs: config.timeoutMs,
      mapFailure: (status, responseBody) => inventoryFailure(status, responseBody, resource),
    });

  return {
    clock: () => get("/v1/clock", ClockViewSchema, "clock"),
    searchFlights: async (query) => {
      const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
      return mapResult(await get(`/v1/flights?${params}`, FlightListSchema, "flights"), (r) => r.flights);
    },
    getFlight: (flightId) => get(`/v1/flights/${enc(flightId)}`, FlightSchema, `flight ${flightId}`),
    bookFlight: (request, key) => write("POST", "/v1/flight-bookings", request, key, FlightBookingSchema, `booking on ${request.flightId}`),
    bookFlights: async (request, key) =>
      mapResult(await write("POST", "/v1/flight-bookings/batch", request, key, BatchFlightBookingResponseSchema, "batch booking"), (r) => r.results),
    listFlightBookings: async () => mapResult(await get("/v1/flight-bookings", FlightBookingListSchema, "flight bookings"), (r) => r.bookings),
    getFlightBooking: (ref) => get(`/v1/flight-bookings/${enc(ref)}`, FlightBookingSchema, `flight booking ${ref}`),
    checkIn: (ref, memberId, key) =>
      write("POST", `/v1/flight-bookings/${enc(ref)}/check-in`, { memberId }, key, FlightBookingSchema, `check-in for ${memberId} on ${ref}`),
    cancelFlightBooking: (ref, key) => write("POST", `/v1/flight-bookings/${enc(ref)}/cancel`, {}, key, FlightBookingSchema, `flight booking ${ref}`),
    listHotels: async () => mapResult(await get("/v1/hotels", HotelListSchema, "hotels"), (r) => r.hotels),
    bookHotel: (request, key) => write("POST", "/v1/hotel-bookings", request, key, HotelBookingSchema, `hotel booking at ${request.hotelId}`),
    listHotelBookings: async () => mapResult(await get("/v1/hotel-bookings", HotelBookingListSchema, "hotel bookings"), (r) => r.bookings),
    cancelHotelBooking: (ref, key) => write("POST", `/v1/hotel-bookings/${enc(ref)}/cancel`, {}, key, HotelBookingSchema, `hotel booking ${ref}`),
    listVenues: async () => mapResult(await get("/v1/venues", VenueListSchema, "venues"), (r) => r.venues),
    reserve: (request, key) => write("POST", "/v1/reservations", request, key, ReservationSchema, `reservation at ${request.venueId}`),
    listReservations: async () => mapResult(await get("/v1/reservations", ReservationListSchema, "reservations"), (r) => r.reservations),
    modifyReservation: (ref, change, key) => write("PATCH", `/v1/reservations/${enc(ref)}`, change, key, ReservationSchema, `reservation ${ref}`),
    cancelReservation: (ref, key) => write("POST", `/v1/reservations/${enc(ref)}/cancel`, {}, key, ReservationSchema, `reservation ${ref}`),
    listCharges: async () => mapResult(await get("/v1/charges", ChargeListSchema, "charges"), (r) => r.charges),
    events: (afterSeq) => get(`/v1/events?after=${afterSeq}`, EventsPageSchema, "event feed"),
  };
}
