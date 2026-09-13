import { AgentActionSchema, PLAN_ITEM_KINDS, type AgentAction, type Plan, type PlanItem } from "../domain";
import { downstreamOf } from "../plan-graph";
import { formatLocalTime, joinNames } from "./format";

const MS_PER_MINUTE = 60_000;
/** Time a person needs between landing or finishing one thing and starting the next. */
export const CONNECTION_BUFFER_MS = 30 * MS_PER_MINUTE;

export interface VenueSlot {
  readonly venueId: string;
  readonly startsAt: string;
  readonly seatsAvailable: number;
}

export interface CascadeContext {
  readonly now: string;
  readonly utcOffsetMinutes: number;
  readonly memberNames: Readonly<Record<string, string>>;
  readonly venueSlots: readonly VenueSlot[];
}

/** reschedule moves a squeezed item to a later slot when one exists; skip keeps times and drops whoever cannot make it. */
export type CascadePolicy = "reschedule" | "skip";

export interface CascadeInput {
  readonly plan: Plan;
  readonly rootId: string;
  /** The root item as it now stands (new times, fewer people). */
  readonly root: PlanItem;
  /** Items added by the repair, such as a replacement flight. Everything that depended on the root also depends on these. */
  readonly added: readonly PlanItem[];
  /** People who will not arrive at all under this repair. */
  readonly unreachable: ReadonlySet<string>;
  readonly policy: CascadePolicy;
  readonly actionPrefix: string;
}

export interface CascadeResult {
  readonly items: PlanItem[];
  readonly actions: AgentAction[];
  readonly changes: string[];
  readonly affectedItemIds: string[];
  readonly costDeltaCents: number;
}

const SQUEEZABLE: ReadonlySet<PlanItem["kind"]> = new Set<PlanItem["kind"]>(PLAN_ITEM_KINDS.filter((k) => k === "reservation" || k === "activity" || k === "transfer"));

/**
 * Walks the plan's dependency graph downstream of a changed item, in topological order. Each item
 * recomputes when each participant can actually be there from its own dependencies, which already
 * reflect upstream changes, so a delay that pushes one reservation later also pushes whatever
 * depends on that reservation.
 */
export function cascade(input: CascadeInput, context: CascadeContext): CascadeResult {
  const items = new Map<string, PlanItem>(input.plan.items.map((i) => [i.id, structuredClone(i)]));
  items.set(input.rootId, structuredClone(input.root));
  for (const added of input.added) {
    for (const item of items.values()) if (item.dependsOn.includes(input.rootId)) item.dependsOn.push(added.id);
    items.set(added.id, structuredClone(added));
  }

  const name = (id: string): string => context.memberNames[id] ?? id;
  const actions: AgentAction[] = [];
  const changes: string[] = [];
  const affected = new Set<string>([input.rootId, ...input.added.map((a) => a.id)]);
  let costDeltaCents = 0;

  const action = (kind: AgentAction["kind"], params: Record<string, unknown>, suffix: string, reason: string): void => {
    const id = `${input.actionPrefix}:${suffix}`;
    actions.push(AgentActionSchema.parse({ id, idempotencyKey: id, requestedAt: context.now, reason, kind, params }));
  };

  /**
   * The earliest a member can be at an item, from its dependencies as they now stand. A flight or
   * reservation the member is on frees them when it ends. A hotel counts from check-in, but no earlier
   * than the member reaches it. A dependency the member is not on still passes through whatever got
   * them there, so skipping one reservation does not make someone magically early for the next.
   */
  const readyAt = (item: PlanItem, memberId: string): number => {
    if (input.unreachable.has(memberId)) return Number.POSITIVE_INFINITY;
    let ready = Number.NEGATIVE_INFINITY;
    for (const depId of item.dependsOn) {
      const dep = items.get(depId);
      if (dep === undefined) continue;
      const upstream = readyAt(dep, memberId);
      const own = !dep.participants.includes(memberId) ? upstream : dep.kind === "hotel" ? Math.max(Date.parse(dep.startsAt), upstream) : Date.parse(dep.endsAt);
      ready = Math.max(ready, own);
    }
    return ready;
  };

  for (const id of downstreamOf([...items.values()], input.rootId)) {
    const item = items.get(id);
    if (item === undefined || !SQUEEZABLE.has(item.kind)) continue;

    const startMs = Date.parse(item.startsAt);
    const late = item.participants.filter((m) => readyAt(item, m) + CONNECTION_BUFFER_MS > startMs);
    if (late.length === 0) continue;
    affected.add(item.id);

    const reachable = item.participants.filter((m) => !input.unreachable.has(m));
    if (input.policy === "reschedule" && late.some((m) => !input.unreachable.has(m))) {
      const earliest = Math.max(...reachable.map((m) => readyAt(item, m))) + CONNECTION_BUFFER_MS;
      const [slot] = context.venueSlots
        .filter((s) => s.venueId === item.inventoryId && Date.parse(s.startsAt) >= earliest && s.seatsAvailable >= reachable.length)
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      if (slot !== undefined && reachable.length > 0) {
        const shift = Date.parse(slot.startsAt) - startMs;
        const perPerson = item.costCents / item.participants.length;
        costDeltaCents -= Math.round(perPerson * (item.participants.length - reachable.length));
        item.startsAt = new Date(startMs + shift).toISOString();
        item.endsAt = new Date(Date.parse(item.endsAt) + shift).toISOString();
        const droppedSome = reachable.length !== item.participants.length;
        item.costCents = Math.round(perPerson * reachable.length);
        item.participants = reachable;
        const when = formatLocalTime(item.startsAt, context.utcOffsetMinutes);
        changes.push(`Move ${item.title} to ${when}`);
        if (item.bookingRef !== null) {
          action("modify_reservation", { bookingRef: item.bookingRef, newAt: item.startsAt, guestIds: droppedSome ? reachable : null }, `move-${item.id}`, `Late arrival squeezes ${item.title}`);
        }
        continue;
      }
    }

    const remaining = item.participants.filter((m) => !late.includes(m));
    const perPerson = item.costCents / item.participants.length;
    if (remaining.length === 0) {
      items.delete(item.id);
      for (const other of items.values()) other.dependsOn = other.dependsOn.filter((d) => d !== item.id);
      costDeltaCents -= item.costCents;
      changes.push(`Cancel ${item.title}`);
      if (item.bookingRef !== null) action("cancel_booking", { bookingRef: item.bookingRef }, `cancel-${item.id}`, `Nobody can make ${item.title}`);
    } else {
      costDeltaCents -= Math.round(perPerson * late.length);
      item.costCents = Math.round(perPerson * remaining.length);
      item.participants = remaining;
      changes.push(`${joinNames(late.map(name))} ${late.length === 1 ? "skips" : "skip"} ${item.title}`);
      if (item.bookingRef !== null) {
        action("modify_reservation", { bookingRef: item.bookingRef, newAt: null, guestIds: remaining }, `shrink-${item.id}`, `${joinNames(late.map(name))} cannot make ${item.title}`);
      }
    }
  }

  const ordered = [...input.plan.items.map((i) => items.get(i.id)), ...input.added.map((a) => items.get(a.id))].filter((i): i is PlanItem => i !== undefined);
  return { items: ordered, actions, changes, affectedItemIds: [...affected], costDeltaCents };
}
