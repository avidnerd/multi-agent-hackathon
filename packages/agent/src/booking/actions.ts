import { createHash } from "node:crypto";
import { AgentActionSchema, localDateOf, topologicalOrder, type AgentAction, type Plan, type PlanItem } from "@trip/core";
import { roomsFor } from "../elicitation/pricing";

export interface PlannedAction {
  readonly planItemId: string;
  readonly action: AgentAction;
}

const ACTION_ID_HASH_CHARS = 8;
const shortHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, ACTION_ID_HASH_CHARS);

/**
 * Action ids carry the plan version, so an approval granted for one version of the plan cannot be spent
 * on the next. Idempotency keys carry the full plan id, so they stay unique across trips at the provider.
 */
const identity = (plan: Plan, suffix: string): { id: string; idempotencyKey: string } => ({
  id: `${shortHash(plan.id)}-v${plan.version}-${suffix}`,
  idempotencyKey: `${plan.id}:v${plan.version}:${suffix}`,
});

function bookingDraft(plan: Plan, item: PlanItem, utcOffsetMinutes: number, requestedAt: string): object | null {
  if (item.inventoryId === null) return null;
  const base = { ...identity(plan, `book-${item.id}`), requestedAt, reason: `Book ${item.title} for ${item.participants.length}` };
  switch (item.kind) {
    case "flight":
      return { ...base, kind: "book_flight", params: { flightId: item.inventoryId, memberIds: item.participants } };
    case "hotel":
      return {
        ...base,
        kind: "book_hotel",
        params: { hotelId: item.inventoryId, checkIn: localDateOf(item.startsAt, utcOffsetMinutes), checkOut: localDateOf(item.endsAt, utcOffsetMinutes), rooms: roomsFor(item.participants.length) },
      };
    case "reservation":
      return { ...base, kind: "book_reservation", params: { venueId: item.inventoryId, at: item.startsAt, partySize: item.participants.length } };
    case "activity":
    case "transfer":
      return null;
  }
}

/** Bookings in dependency order, then calendar events, which are written only once every booking reference exists. */
export function planActions(plan: Plan, utcOffsetMinutes: number, requestedAt: string): PlannedAction[] {
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const ordered = topologicalOrder(plan.items).flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  const bookings = ordered.flatMap((item) => {
    const draft = bookingDraft(plan, item, utcOffsetMinutes, requestedAt);
    return draft === null ? [] : [{ planItemId: item.id, action: AgentActionSchema.parse(draft) }];
  });
  const events = ordered.map((item) => ({
    planItemId: item.id,
    action: AgentActionSchema.parse({
      ...identity(plan, `calendar-${item.id}`),
      requestedAt,
      reason: `Put ${item.title} on the group's calendars`,
      kind: "write_calendar_event",
      params: { planItemId: item.id, attendeeIds: item.participants },
    }),
  }));
  const expenses = ordered.filter((item) => item.costCents > 0);
  const split =
    expenses.length === 0
      ? []
      : [
          {
            planItemId: expenses[0]?.id ?? "plan",
            action: AgentActionSchema.parse({
              ...identity(plan, "splitwise"),
              requestedAt,
              reason: "Record what everyone owes in Splitwise",
              kind: "record_expenses",
              params: { expenses: expenses.map((item) => ({ description: item.title, costCents: item.costCents, memberIds: item.participants })) },
            }),
          },
        ];
  return [...bookings, ...events, ...split];
}
