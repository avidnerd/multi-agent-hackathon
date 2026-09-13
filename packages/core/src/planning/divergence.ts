import type { Divergence, ObservedEvent, Plan, PlanItem, PlanItemSnapshot } from "../domain";

const MS_PER_MINUTE = 60_000;
/** Airlines call anything under 15 minutes on time. */
export const DELAY_TOLERANCE_MS = 15 * MS_PER_MINUTE;
export const MAJOR_DELAY_MS = 60 * MS_PER_MINUTE;

const SEVERITY_RANK: Readonly<Record<Divergence["severity"], number>> = { critical: 0, major: 1, minor: 2 };

const snapshot = (item: PlanItem): PlanItemSnapshot => ({
  startsAt: item.startsAt,
  endsAt: item.endsAt,
  participants: [...item.participants],
  costCents: item.costCents,
});

const hasDependents = (plan: Plan, itemId: string): boolean => plan.items.some((i) => i.dependsOn.includes(itemId));

/**
 * Compares observed events with the plan. Only events the monitor has attributed to a plan item
 * count. The result is recomputed from the full event history each time, so ids are stable and a
 * repeated or duplicated event cannot produce a second divergence.
 */
export function detectDivergence(plan: Plan, events: readonly ObservedEvent[], now: string): Divergence[] {
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const missing = new Map<string, Set<string>>();
  const delays = new Map<string, number>();
  const spend = new Map<string, Map<string, number>>();

  const addMissing = (itemId: string, memberIds: readonly string[]): void => {
    if (memberIds.length === 0) return;
    const set = missing.get(itemId) ?? new Set<string>();
    for (const m of memberIds) set.add(m);
    missing.set(itemId, set);
  };

  for (const event of events) {
    const item = event.subject.planItemId === null ? undefined : byId.get(event.subject.planItemId);
    if (item === undefined) continue;
    switch (event.kind) {
      case "passenger_missed_flight":
        if (item.participants.includes(event.payload.memberId)) addMissing(item.id, [event.payload.memberId]);
        break;
      case "flight_departed":
        addMissing(item.id, item.participants.filter((p) => !event.payload.boardedMemberIds.includes(p)));
        break;
      case "reservation_seated":
        addMissing(item.id, item.participants.filter((p) => !event.payload.seatedMemberIds.includes(p)));
        break;
      case "flight_delayed":
        delays.set(item.id, Date.parse(event.payload.newDepartsAt) - Date.parse(item.startsAt));
        break;
      case "charge_posted": {
        // Keyed by event id so a duplicated delivery of the same charge is counted once.
        const charges = spend.get(item.id) ?? new Map<string, number>();
        charges.set(event.id, event.payload.amountCents);
        spend.set(item.id, charges);
        break;
      }
      case "passenger_checked_in":
      case "flight_arrived":
      case "hotel_checked_in":
        break;
    }
  }

  const divergences: Divergence[] = [];
  const base = (item: PlanItem, kind: Divergence["kind"]) => ({
    id: `div-${item.id}-${kind}`,
    tripId: plan.tripId,
    planItemId: item.id,
    kind,
    detectedAt: now,
    repairOptions: [],
    selectedRepairId: null,
  });

  for (const [itemId, members] of missing) {
    const item = byId.get(itemId);
    if (item === undefined) continue;
    const severity = item.kind === "flight" ? (hasDependents(plan, itemId) ? "critical" : "major") : "minor";
    divergences.push({
      ...base(item, "participant_missing"),
      severity,
      expected: snapshot(item),
      observed: { ...snapshot(item), participants: item.participants.filter((p) => !members.has(p)) },
    });
  }

  for (const [itemId, delayMs] of delays) {
    const item = byId.get(itemId);
    if (item === undefined || delayMs <= DELAY_TOLERANCE_MS) continue;
    const newStart = Date.parse(item.startsAt) + delayMs;
    const newEnd = Date.parse(item.endsAt) + delayMs;
    const squeezes = plan.items.some((i) => i.dependsOn.includes(itemId) && i.kind !== "hotel" && Date.parse(i.startsAt) < newEnd);
    divergences.push({
      ...base(item, "time_shift"),
      severity: squeezes ? "critical" : delayMs >= MAJOR_DELAY_MS ? "major" : "minor",
      expected: snapshot(item),
      observed: { ...snapshot(item), startsAt: new Date(newStart).toISOString(), endsAt: new Date(newEnd).toISOString() },
    });
  }

  for (const [itemId, charges] of spend) {
    const item = byId.get(itemId);
    const total = [...charges.values()].reduce((a, b) => a + b, 0);
    if (item === undefined || total <= item.costCents) continue;
    divergences.push({ ...base(item, "overspend"), severity: "minor", expected: snapshot(item), observed: { ...snapshot(item), costCents: total } });
  }

  const order = (id: string): number => plan.items.findIndex((i) => i.id === id);
  return divergences.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || order(a.planItemId) - order(b.planItemId));
}
