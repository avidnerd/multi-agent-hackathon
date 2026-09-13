import { err, ok, type AgentAction, type AgentActionKind, type JsonValue, type Plan, type PlanItem, type Result } from "@trip/core";
import type { ActionHandler } from "../dispatcher";
import type { AgentDeps } from "../elicitation/agent";
import type { ElicitationSession } from "../elicitation/session";

export type HandlerDeps = Pick<AgentDeps, "calendar" | "inventory" | "messaging">;

const mismatch = (expected: AgentActionKind, action: AgentAction): Result<never> => err({ kind: "internal", detail: `${expected} handler received ${action.kind}` });

export function stringField(value: JsonValue, field: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const found = value[field];
  return typeof found === "string" ? found : null;
}

/**
 * The only code that performs external writes for planning and booking. Handlers are reached exclusively
 * through the dispatcher, which applies the approval gate and idempotency record before calling them.
 * `refs` is filled in as bookings land so calendar events can cite their booking reference.
 */
export function createPlanHandlers(deps: HandlerDeps, session: ElicitationSession, plan: Plan | null, refs: ReadonlyMap<string, string>): Partial<Record<AgentActionKind, ActionHandler>> {
  const { trip } = session;
  const member = (id: string) => trip.members.find((m) => m.id === id);
  const planItem = (matches: (item: PlanItem) => boolean): PlanItem | undefined => plan?.items.find(matches);
  const missingItem = (what: string): Result<never> => err({ kind: "not_found", service: "inventory", resource: `plan item for ${what}` });

  return {
    place_calendar_hold: async (action) => {
      if (action.kind !== "place_calendar_hold") return mismatch("place_calendar_hold", action);
      const { title, startsAt, endsAt } = action.params;
      const created = await deps.calendar.createEvent({ idempotencyKey: action.idempotencyKey, tripId: trip.id, summary: title, description: action.reason, startsAt, endsAt, attendeeEmails: [], blocksTime: false, notifyAttendees: false });
      return created.ok ? ok({ eventId: created.value.eventId }) : created;
    },

    release_calendar_hold: async (action) => {
      if (action.kind !== "release_calendar_hold") return mismatch("release_calendar_hold", action);
      const deleted = await deps.calendar.deleteEvent(action.params.holdId, { notifyAttendees: false });
      return deleted.ok ? ok({ released: action.params.holdId }) : deleted;
    },

    book_flight: async (action) => {
      if (action.kind !== "book_flight") return mismatch("book_flight", action);
      const passengers = action.params.memberIds.map((id) => ({ memberId: id, name: member(id)?.name ?? id }));
      const booked = await deps.inventory.bookFlight({ flightId: action.params.flightId, passengers }, action.idempotencyKey);
      return booked.ok ? ok({ bookingRef: booked.value.bookingRef, totalCents: booked.value.totalCents }) : booked;
    },

    book_hotel: async (action) => {
      if (action.kind !== "book_hotel") return mismatch("book_hotel", action);
      const { hotelId, checkIn, checkOut, rooms } = action.params;
      const guests = planItem((i) => i.kind === "hotel" && i.inventoryId === hotelId)?.participants;
      if (guests === undefined) return missingItem(`hotel ${hotelId}`);
      const booked = await deps.inventory.bookHotel({ hotelId, checkIn, checkOut, rooms, guestIds: guests }, action.idempotencyKey);
      return booked.ok ? ok({ bookingRef: booked.value.bookingRef, totalCents: booked.value.totalCents }) : booked;
    },

    book_reservation: async (action) => {
      if (action.kind !== "book_reservation") return mismatch("book_reservation", action);
      const { venueId, at } = action.params;
      const guests = planItem((i) => i.kind === "reservation" && i.inventoryId === venueId && Date.parse(i.startsAt) === Date.parse(at))?.participants;
      if (guests === undefined) return missingItem(`${venueId} at ${at}`);
      const booked = await deps.inventory.reserve({ venueId, at, guestIds: guests }, action.idempotencyKey);
      return booked.ok ? ok({ bookingRef: booked.value.bookingRef }) : booked;
    },

    write_calendar_event: async (action) => {
      if (action.kind !== "write_calendar_event") return mismatch("write_calendar_event", action);
      const item = planItem((i) => i.id === action.params.planItemId);
      if (item === undefined) return missingItem(action.params.planItemId);
      const emails = action.params.attendeeIds.flatMap((id) => {
        const email = member(id)?.email;
        return email === null || email === undefined ? [] : [email];
      });
      const ref = refs.get(item.id);
      const created = await deps.calendar.createEvent({
        idempotencyKey: action.idempotencyKey,
        tripId: trip.id,
        summary: item.title,
        description: ref === undefined ? `Part of the ${trip.destination} plan` : `Booking ${ref}`,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        attendeeEmails: emails,
        blocksTime: true,
        notifyAttendees: emails.length > 0,
      });
      return created.ok ? ok({ eventId: created.value.eventId }) : created;
    },

    send_sms: async (action) => {
      if (action.kind !== "send_sms") return mismatch("send_sms", action);
      const to = member(action.params.memberId);
      if (to === undefined) return err({ kind: "not_found", service: "messaging", resource: `member ${action.params.memberId}` });
      const sent = await deps.messaging.send({ to: to.phone, body: action.params.body });
      if (!sent.ok) return sent;
      session.messages.push({ id: `out-${sent.value.externalId}`, tripId: trip.id, memberId: to.id, channel: deps.messaging.channel, direction: "outbound", body: action.params.body, externalId: sent.value.externalId, at: sent.value.sentAt });
      return ok({ externalId: sent.value.externalId });
    },
  };
}
