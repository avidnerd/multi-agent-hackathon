import { createHash } from "node:crypto";
import { err, mapResult, ok, type AppError, type Result } from "@trip/core";
import {
  FreeBusyResponseSchema,
  GoogleErrorBodySchema,
  GoogleEventListSchema,
  GoogleEventSchema,
  GoogleTokenResponseSchema,
  type GoogleEvent,
  type GoogleEventPatch,
  type GoogleEventWrite,
} from "./contracts";
import { httpRequest, type FetchLike } from "./http";
import type { CalendarAvailability, CalendarClient, CalendarEvent } from "./interfaces";
import { z } from "zod";

export interface GoogleCalendarConfig {
  readonly baseUrl: string;
  readonly calendarId: string;
  readonly accessToken: () => Promise<Result<string>>;
  readonly timeoutMs?: number;
}

const STATUS = { conflict: 409, gone: 410 } as const;
const TRIP_PROPERTY = "tripId";
const MAX_RESULTS = 250;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MS_PER_SECOND = 1_000;
/** Marks a 410 on delete so deleteEvent can treat "already gone" as success. */
const ALREADY_DELETED = "already_deleted";

/** sha256 hex is within Google's base32hex alphabet, so the key maps to a valid, stable event id. */
export const eventIdFromKey = (idempotencyKey: string): string => createHash("sha256").update(idempotencyKey).digest("hex");

function googleFailure(status: number, body: unknown, resource: string): AppError | null {
  const parsed = GoogleErrorBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const reason = parsed.data.error.errors?.[0]?.reason ?? null;
  if (status === STATUS.gone) return { kind: "conflict", service: "calendar", resource, code: ALREADY_DELETED, detail: parsed.data.error.message };
  if (status === STATUS.conflict) return { kind: "conflict", service: "calendar", resource, code: reason, detail: parsed.data.error.message };
  return null;
}

function toCalendarEvent(event: GoogleEvent): CalendarEvent {
  return {
    eventId: event.id,
    tripId: event.extendedProperties?.private?.[TRIP_PROPERTY] ?? null,
    summary: event.summary ?? "",
    startsAt: new Date(Date.parse(event.start.dateTime)).toISOString(),
    endsAt: new Date(Date.parse(event.end.dateTime)).toISOString(),
    attendeeEmails: event.attendees?.map((a) => a.email) ?? [],
    blocksTime: event.transparency !== "transparent",
    status: event.status,
  };
}

export function createGoogleCalendarClient(config: GoogleCalendarConfig, fetchImpl: FetchLike = fetch): CalendarClient {
  const calendarUrl = `${config.baseUrl}/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}`;

  async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, schema: z.ZodType<T>, resource: string, body?: unknown): Promise<Result<T>> {
    const token = await config.accessToken();
    if (!token.ok) return token;
    return httpRequest(fetchImpl, {
      service: "calendar",
      method,
      url,
      headers: { authorization: `Bearer ${token.value}` },
      body: body === undefined ? undefined : { kind: "json", value: body },
      // Event ids are derived from idempotency keys, so a resent create hits 409 instead of duplicating.
      retrySafeOnTimeout: true,
      schema,
      resource,
      timeoutMs: config.timeoutMs,
      mapFailure: (status, responseBody) => googleFailure(status, responseBody, resource),
    });
  }

  const getEvent = async (eventId: string): Promise<Result<CalendarEvent>> =>
    mapResult(await call("GET", `${calendarUrl}/events/${eventId}`, GoogleEventSchema, `event ${eventId}`), toCalendarEvent);

  return {
    getEvent,

    createEvent: async (input) => {
      const eventId = eventIdFromKey(input.idempotencyKey);
      const write: GoogleEventWrite = {
        id: eventId,
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.startsAt },
        end: { dateTime: input.endsAt },
        attendees: input.attendeeEmails.map((email) => ({ email })),
        transparency: input.blocksTime ? "opaque" : "transparent",
        extendedProperties: { private: { [TRIP_PROPERTY]: input.tripId } },
      };
      const sendUpdates = input.notifyAttendees ? "all" : "none";
      const created = await call("POST", `${calendarUrl}/events?sendUpdates=${sendUpdates}`, GoogleEventSchema, `event ${input.summary}`, write);
      if (created.ok) return ok(toCalendarEvent(created.value));
      if (created.error.kind !== "conflict") return created;

      // 409: an earlier attempt already created it. Return that event unless it has since been deleted.
      const existing = await getEvent(eventId);
      if (existing.ok && existing.value.status === "cancelled") {
        return err({ kind: "conflict", service: "calendar", resource: `event ${input.summary}`, code: "id_reused_after_delete", detail: "this idempotency key belongs to a deleted event" });
      }
      return existing;
    },

    listTripEvents: async ({ tripId, from, to }) => {
      const params = new URLSearchParams({
        timeMin: from,
        timeMax: to,
        singleEvents: "true",
        maxResults: String(MAX_RESULTS),
        privateExtendedProperty: `${TRIP_PROPERTY}=${tripId}`,
      });
      return mapResult(await call("GET", `${calendarUrl}/events?${params}`, GoogleEventListSchema, `events for ${tripId}`), (list) =>
        list.items.map(toCalendarEvent),
      );
    },

    moveEvent: async (eventId, change) => {
      const patch: GoogleEventPatch = { start: { dateTime: change.startsAt }, end: { dateTime: change.endsAt } };
      const sendUpdates = change.notifyAttendees ? "all" : "none";
      return mapResult(
        await call("PATCH", `${calendarUrl}/events/${eventId}?sendUpdates=${sendUpdates}`, GoogleEventSchema, `event ${eventId}`, patch),
        toCalendarEvent,
      );
    },

    deleteEvent: async (eventId, { notifyAttendees }) => {
      const sendUpdates = notifyAttendees ? "all" : "none";
      const result = await call("DELETE", `${calendarUrl}/events/${eventId}?sendUpdates=${sendUpdates}`, z.null(), `event ${eventId}`);
      if (!result.ok && result.error.kind === "conflict" && result.error.code === ALREADY_DELETED) return ok(null);
      return result;
    },

    freeBusy: async ({ from, to, calendarIds }) => {
      const body = { timeMin: from, timeMax: to, items: calendarIds.map((id) => ({ id })) };
      const result = await call("POST", `${config.baseUrl}/calendar/v3/freeBusy`, FreeBusyResponseSchema, "free/busy", body);
      return mapResult(result, (r) =>
        Object.fromEntries(
          calendarIds.map((id): [string, CalendarAvailability] => {
            const entry = r.calendars[id];
            if (entry === undefined) return [id, { busy: [], unavailableReason: "missing from response" }];
            const reason = entry.errors?.[0]?.reason ?? null;
            const busy = entry.busy.map((b) => ({ start: new Date(Date.parse(b.start)).toISOString(), end: new Date(Date.parse(b.end)).toISOString() }));
            return [id, { busy, unavailableReason: reason }];
          }),
        ),
      );
    },
  };
}

export interface GoogleOAuthConfig {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

/** Exchanges the organizer's refresh token for access tokens, caching until shortly before expiry. */
export function createGoogleTokenProvider(config: GoogleOAuthConfig, fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
  let cached: { token: string; expiresAtMs: number } | null = null;
  return async (): Promise<Result<string>> => {
    if (cached !== null && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now()) return ok(cached.token);
    const result = await httpRequest(fetchImpl, {
      service: "calendar",
      method: "POST",
      url: config.tokenUrl,
      body: {
        kind: "form",
        value: { client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: "refresh_token" },
      },
      schema: GoogleTokenResponseSchema,
      resource: "OAuth access token",
    });
    if (!result.ok) return result;
    cached = { token: result.value.access_token, expiresAtMs: now() + result.value.expires_in * MS_PER_SECOND };
    return ok(cached.token);
  };
}
