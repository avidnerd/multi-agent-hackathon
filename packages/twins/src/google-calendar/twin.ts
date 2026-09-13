import type { Request, Response, Router } from "express";
import { z } from "zod";
import { IsoDateTimeSchema } from "@trip/core";
import {
  FreeBusyRequestSchema,
  GoogleEventPatchSchema,
  GoogleEventSchema,
  GoogleEventWriteSchema,
  type GoogleEvent,
} from "@trip/clients/contracts";
import type { TwinDefinition, TwinRuntime } from "../kit/twin-app";

const NotificationSchema = z.object({
  eventId: z.string(),
  recipients: z.array(z.string()),
  change: z.enum(["created", "updated", "cancelled"]),
  at: IsoDateTimeSchema,
});

export const CalendarStateSchema = z.object({
  organizerEmail: z.email(),
  events: z.array(GoogleEventSchema),
  /** Invite emails Google would have sent. Evidence for why calendar writes are classed irreversible. */
  notifications: z.array(NotificationSchema),
  counter: z.number().int().nonnegative(),
});
export type CalendarState = z.infer<typeof CalendarStateSchema>;

const STATUS = { ok: 200, noContent: 204, badRequest: 400, unauthorized: 401, notFound: 404, conflict: 409, gone: 410 } as const;
const REASONS: Readonly<Record<string, string>> = {
  not_found: "notFound",
  duplicate: "duplicate",
  deleted: "deleted",
  invalid_request: "invalid",
  time_range_empty: "timeRangeEmpty",
  rate_limited: "rateLimitExceeded",
  unauthorized: "required",
  internal: "backendError",
};
const GENERATED_ID_DIGITS = 10;
const DEFAULT_MAX_RESULTS = 250;
const MAX_RESULTS_LIMIT = 2500;

const seed = (): CalendarState => ({ organizerEmail: "organizer@example.com", events: [], notifications: [], counter: 0 });

const ListQuerySchema = z.object({
  timeMin: z.string().optional(),
  timeMax: z.string().optional(),
  privateExtendedProperty: z.union([z.string(), z.array(z.string())]).optional(),
  showDeleted: z.enum(["true", "false"]).optional(),
  maxResults: z.coerce.number().int().positive().max(MAX_RESULTS_LIMIT).default(DEFAULT_MAX_RESULTS),
});

const toMs = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function registerRoutes(router: Router, twin: TwinRuntime<CalendarState>): void {
  const authorized = (req: Request, res: Response): boolean => {
    const [scheme, token] = (req.get("authorization") ?? "").split(" ");
    if (scheme === "Bearer" && token !== undefined && token.length > 0) return true;
    twin.sendError(res, STATUS.unauthorized, "unauthorized", "Request is missing required authentication credential.");
    return false;
  };

  const ownsCalendar = (res: Response, calendarId: string | undefined): boolean => {
    if (calendarId === "primary" || calendarId === twin.current().organizerEmail) return true;
    twin.sendError(res, STATUS.notFound, "not_found", "Not Found");
    return false;
  };

  const guard = (req: Request, res: Response, calendarId: string | undefined): boolean => authorized(req, res) && ownsCalendar(res, calendarId);

  const notify = (state: CalendarState, event: GoogleEvent, change: "created" | "updated" | "cancelled", req: Request): void => {
    const recipients = event.attendees?.map((a) => a.email) ?? [];
    if (req.query.sendUpdates === "all" && recipients.length > 0) {
      state.notifications.push({ eventId: event.id, recipients, change, at: twin.now().toISOString() });
    }
  };

  const findEvent = (req: Request, res: Response, eventId: string | undefined): GoogleEvent | null => {
    const event = twin.read(req).events.find((e) => e.id === eventId);
    if (event !== undefined) return event;
    twin.sendError(res, STATUS.notFound, "not_found", "Not Found");
    return null;
  };

  router.post("/calendar/v3/calendars/:calendarId/events", (req, res) => {
    if (!guard(req, res, req.params.calendarId)) return;
    const parsed = GoogleEventWriteSchema.safeParse(req.body);
    if (!parsed.success) return twin.sendError(res, STATUS.badRequest, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid value");
    const input = parsed.data;
    if (!(toMs(input.end.dateTime, 0) > toMs(input.start.dateTime, Infinity))) {
      return twin.sendError(res, STATUS.badRequest, "time_range_empty", "The specified time range is empty.");
    }
    if (input.id !== undefined && twin.current().events.some((e) => e.id === input.id)) {
      return twin.sendError(res, STATUS.conflict, "duplicate", "The requested identifier already exists.");
    }
    const event = twin.write((state) => {
      state.counter += 1;
      const now = twin.now().toISOString();
      const id = input.id ?? String(state.counter).padStart(GENERATED_ID_DIGITS, "0");
      const created: GoogleEvent = {
        kind: "calendar#event",
        id,
        etag: `"${state.counter}"`,
        status: "confirmed",
        htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
        created: now,
        updated: now,
        summary: input.summary,
        description: input.description,
        start: input.start,
        end: input.end,
        attendees: input.attendees?.map((a) => ({ email: a.email, responseStatus: "needsAction" as const })),
        transparency: input.transparency ?? "opaque",
        extendedProperties: input.extendedProperties,
        sequence: 0,
      };
      state.events.push(created);
      notify(state, created, "created", req);
      return created;
    });
    res.status(STATUS.ok).json(event);
  });

  router.get("/calendar/v3/calendars/:calendarId/events", (req, res) => {
    if (!guard(req, res, req.params.calendarId)) return;
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) return twin.sendError(res, STATUS.badRequest, "invalid_request", parsed.error.message);
    const q = parsed.data;
    const minMs = toMs(q.timeMin, -Infinity);
    const maxMs = toMs(q.timeMax, Infinity);
    const props = (q.privateExtendedProperty === undefined ? [] : [q.privateExtendedProperty].flat()).map((p) => p.split("="));
    const items = twin
      .read(req)
      .events.filter((e) => q.showDeleted === "true" || e.status !== "cancelled")
      .filter((e) => toMs(e.end.dateTime, 0) > minMs && toMs(e.start.dateTime, 0) < maxMs)
      .filter((e) => props.every(([key = "", value = ""]) => e.extendedProperties?.private?.[key] === value))
      .sort((a, b) => toMs(a.start.dateTime, 0) - toMs(b.start.dateTime, 0))
      .slice(0, q.maxResults);
    res.json({ kind: "calendar#events", items });
  });

  router.get("/calendar/v3/calendars/:calendarId/events/:eventId", (req, res) => {
    if (!guard(req, res, req.params.calendarId)) return;
    const event = findEvent(req, res, req.params.eventId);
    if (event !== null) res.json(event);
  });

  router.patch("/calendar/v3/calendars/:calendarId/events/:eventId", (req, res) => {
    if (!guard(req, res, req.params.calendarId)) return;
    const existing = findEvent(req, res, req.params.eventId);
    if (existing === null) return;
    if (existing.status === "cancelled") return twin.sendError(res, STATUS.gone, "deleted", "Resource has been deleted");
    const parsed = GoogleEventPatchSchema.safeParse(req.body);
    if (!parsed.success) return twin.sendError(res, STATUS.badRequest, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid value");
    const start = parsed.data.start ?? existing.start;
    const end = parsed.data.end ?? existing.end;
    if (!(toMs(end.dateTime, 0) > toMs(start.dateTime, Infinity))) {
      return twin.sendError(res, STATUS.badRequest, "time_range_empty", "The specified time range is empty.");
    }
    const updated = twin.write((state) => {
      const event = state.events.find((e) => e.id === existing.id);
      if (event === undefined) return existing;
      Object.assign(event, parsed.data, { start, end, updated: twin.now().toISOString(), sequence: event.sequence + 1 });
      notify(state, event, "updated", req);
      return event;
    });
    res.json(updated);
  });

  router.delete("/calendar/v3/calendars/:calendarId/events/:eventId", (req, res) => {
    if (!guard(req, res, req.params.calendarId)) return;
    const existing = findEvent(req, res, req.params.eventId);
    if (existing === null) return;
    if (existing.status === "cancelled") return twin.sendError(res, STATUS.gone, "deleted", "Resource has been deleted");
    twin.write((state) => {
      const event = state.events.find((e) => e.id === existing.id);
      if (event === undefined) return;
      event.status = "cancelled";
      event.updated = twin.now().toISOString();
      notify(state, event, "cancelled", req);
    });
    res.status(STATUS.noContent).send();
  });

  router.post("/calendar/v3/freeBusy", (req, res) => {
    if (!authorized(req, res)) return;
    const parsed = FreeBusyRequestSchema.safeParse(req.body);
    if (!parsed.success) return twin.sendError(res, STATUS.badRequest, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid value");
    const { timeMin, timeMax, items } = parsed.data;
    const minMs = toMs(timeMin, -Infinity);
    const maxMs = toMs(timeMax, Infinity);
    const state = twin.read(req);
    // Only confirmed, opaque events make someone busy. Overlapping events merge into one busy block.
    const busy = mergeIntervals(
      state.events
        .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent")
        .map((e): [number, number] => [Math.max(minMs, toMs(e.start.dateTime, 0)), Math.min(maxMs, toMs(e.end.dateTime, 0))])
        .filter(([start, end]) => end > start),
    ).map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
    const calendars = Object.fromEntries(
      items.map(({ id }) =>
        id === "primary" || id === state.organizerEmail ? [id, { busy }] : [id, { busy: [], errors: [{ domain: "global", reason: "notFound" }] }],
      ),
    );
    res.json({ kind: "calendar#freeBusy", timeMin, timeMax, calendars });
  });
}

export const googleCalendarTwin: TwinDefinition<CalendarState> = {
  name: "google-calendar",
  // No duplicate_webhook (we do not subscribe to push notifications) and no partial_batch (we do not use the batch endpoint).
  supportedFaults: ["empty_200", "write_then_timeout", "rate_limit", "stale_read", "slow"],
  stateSchema: CalendarStateSchema,
  seed,
  defaultClock: new Date("2026-10-01T16:00:00Z"),
  errorBody: (status, code, message) => ({
    error: { code: status, message, errors: [{ domain: "global", reason: REASONS[code] ?? code, message }] },
  }),
  routes: registerRoutes,
};
