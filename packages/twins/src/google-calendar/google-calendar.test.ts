import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "@trip/core";
import { createGoogleCalendarClient, createTwinControlClient, type CalendarClient, type CalendarEventInput, type TwinControlClient } from "@trip/clients";
import { TWIN_GOOGLE_ACCESS_TOKEN } from "@trip/clients/contracts";
import { startTwin, type RunningTwin } from "../kit/twin-app";
import { unwrap } from "../testing";
import { CalendarStateSchema, googleCalendarTwin, type CalendarState } from "./twin";

const CLIENT_TIMEOUT_MS = 400;
let twin: RunningTwin<CalendarState>;
let calendar: CalendarClient;
let control: TwinControlClient;

const hold = (overrides: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  idempotencyKey: "hold-trip1-2026-10-09",
  tripId: "trip1",
  summary: "San Diego hold",
  description: "Tentative dates",
  startsAt: "2026-10-09T15:00:00.000Z",
  endsAt: "2026-10-11T23:00:00.000Z",
  attendeeEmails: ["priya@example.com", "dev@example.com"],
  blocksTime: true,
  notifyAttendees: false,
  ...overrides,
});

beforeEach(async () => {
  twin = await startTwin(googleCalendarTwin);
  calendar = createGoogleCalendarClient({ baseUrl: twin.url, calendarId: "primary", accessToken: async () => ok(TWIN_GOOGLE_ACCESS_TOKEN), timeoutMs: CLIENT_TIMEOUT_MS });
  control = createTwinControlClient("calendar", twin.url);
});

afterEach(async () => {
  await twin.close();
});

const tripEvents = async () => unwrap(await calendar.listTripEvents({ tripId: "trip1", from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" }));

describe("google calendar twin", () => {
  it("creates, reads back and lists by trip; a repeated create with the same key returns the same event", async () => {
    const first = unwrap(await calendar.createEvent(hold()));
    expect(unwrap(await calendar.getEvent(first.eventId)).summary).toBe("San Diego hold");
    const again = unwrap(await calendar.createEvent(hold()));
    expect(again.eventId).toBe(first.eventId);
    expect(await tripEvents()).toHaveLength(1);
  });

  it("survives write_then_timeout without creating a duplicate event", async () => {
    unwrap(await control.armFault({ kind: "write_then_timeout", method: "POST" }));
    expect(await calendar.createEvent(hold())).toMatchObject({ ok: false, error: { kind: "timeout", retrySafe: true } });
    expect((await calendar.createEvent(hold())).ok).toBe(true);
    expect(await tripEvents()).toHaveLength(1);
  });

  it("accepts overlapping events like Google does, and freeBusy merges them; transparent holds are free", async () => {
    unwrap(await calendar.createEvent(hold({ idempotencyKey: "a", startsAt: "2026-10-09T15:00:00Z", endsAt: "2026-10-09T18:00:00Z" })));
    unwrap(await calendar.createEvent(hold({ idempotencyKey: "b", startsAt: "2026-10-09T17:00:00Z", endsAt: "2026-10-09T20:00:00Z" })));
    unwrap(await calendar.createEvent(hold({ idempotencyKey: "c", startsAt: "2026-10-10T15:00:00Z", endsAt: "2026-10-10T18:00:00Z", blocksTime: false })));
    const availability = unwrap(await calendar.freeBusy({ from: "2026-10-09T00:00:00Z", to: "2026-10-11T00:00:00Z", calendarIds: ["primary"] }));
    expect(availability.primary).toEqual({ busy: [{ start: "2026-10-09T15:00:00.000Z", end: "2026-10-09T20:00:00.000Z" }], unavailableReason: null });
  });

  it("reads a member's shared free/busy and marks an unshared calendar as unknown rather than free", async () => {
    unwrap(
      await control.injectEvent({
        kind: "member_calendar_shared",
        email: "priya@example.com",
        busy: [{ start: "2026-10-08T16:00:00Z", end: "2026-10-10T02:00:00Z" }],
      }),
    );
    const availability = unwrap(
      await calendar.freeBusy({ from: "2026-10-09T00:00:00Z", to: "2026-10-12T00:00:00Z", calendarIds: ["priya@example.com", "dev@example.com"] }),
    );
    expect(availability["priya@example.com"]).toEqual({ busy: [{ start: "2026-10-09T00:00:00.000Z", end: "2026-10-10T02:00:00.000Z" }], unavailableReason: null });
    expect(availability["dev@example.com"]).toEqual({ busy: [], unavailableReason: "notFound" });
  });

  it("moves an event, deletes it idempotently, and refuses to reuse a deleted event's key", async () => {
    const created = unwrap(await calendar.createEvent(hold({ notifyAttendees: true })));
    const moved = unwrap(await calendar.moveEvent(created.eventId, { startsAt: "2026-10-16T15:00:00Z", endsAt: "2026-10-18T23:00:00Z", notifyAttendees: true }));
    expect(moved.startsAt).toBe("2026-10-16T15:00:00.000Z");

    expect(unwrap(await calendar.deleteEvent(created.eventId, { notifyAttendees: true }))).toBeNull();
    expect(unwrap(await calendar.deleteEvent(created.eventId, { notifyAttendees: true }))).toBeNull();
    expect(await tripEvents()).toEqual([]);
    expect(await calendar.createEvent(hold())).toMatchObject({ ok: false, error: { code: "id_reused_after_delete" } });

    const state = CalendarStateSchema.parse(unwrap(await control.state()));
    expect(state.notifications.map((n) => n.change)).toEqual(["created", "updated", "cancelled"]);
  });

  it("rejects requests without a bearer token", async () => {
    const anonymous = createGoogleCalendarClient({ baseUrl: twin.url, calendarId: "primary", accessToken: async () => ok("") });
    expect(await anonymous.getEvent("abcde")).toMatchObject({ ok: false, error: { kind: "upstream_failed", status: 401 } });
  });
});
