import { describe, expect, it } from "vitest";
import { reversibilityOf, type Divergence, type Plan } from "../domain";
import { detectDivergence } from "./divergence";
import { NAMES, observed, PDT, samplePlan } from "./fixtures";
import { repairPlan, type RepairContext } from "./repair";

const NOW = "2026-10-09T17:45:00.000Z";

const context: RepairContext = {
  now: NOW,
  utcOffsetMinutes: PDT,
  memberNames: NAMES,
  // TW177 leaves 4:15pm and lands 5:50pm, five and a half hours after the group.
  alternativeFlights: [
    { flightId: "TW191-2026-10-09", flightNumber: "TW191", departsAt: "2026-10-10T02:30:00.000Z", arrivesAt: "2026-10-10T04:05:00.000Z", seatsAvailable: 5, farePerPersonCents: 19_900 },
    { flightId: "TW177-2026-10-09", flightNumber: "TW177", departsAt: "2026-10-09T23:15:00.000Z", arrivesAt: "2026-10-10T00:50:00.000Z", seatsAvailable: 4, farePerPersonCents: 18_900 },
  ],
  venueSlots: [
    { venueId: "beach-club", startsAt: "2026-10-10T01:30:00.000Z", seatsAvailable: 6 },
    { venueId: "tidewater", startsAt: "2026-10-10T03:30:00.000Z", seatsAvailable: 10 },
  ],
};

const item = (plan: Plan, id: string) => plan.items.find((i) => i.id === id);

function devMissesOutbound(plan: Plan): Divergence {
  const [divergence] = detectDivergence(plan, [observed("e1", "outbound", "flight_departed", { flightNumber: "TW143", departedAt: NOW, boardedMemberIds: ["priya", "sam"] })], NOW);
  if (divergence === undefined) throw new Error("fixture no longer produces a divergence");
  return divergence;
}

describe("repairPlan: missed flight", () => {
  const plan = samplePlan();
  const proposals = repairPlan(plan, devMissesOutbound(plan), context);
  const byId = (suffix: string) => proposals.find((p) => p.option.id.endsWith(suffix));

  it("offers rebook-and-reschedule, rebook-and-skip, and go-without", () => {
    expect(proposals.map((p) => p.option.id)).toEqual([
      "div-outbound-participant_missing:rebook-reschedule",
      "div-outbound-participant_missing:rebook-skip",
      "div-outbound-participant_missing:without",
    ]);
  });

  it("cascades through the graph: moving the beach club pushes dinner, which depends on it", () => {
    const reschedule = byId("rebook-reschedule");
    expect(reschedule?.option.summary).toBe("Rebook Dev on TW177, landing 5:50pm. Move Beach club cabana to 6:30pm. Move Dinner at Tidewater to 8:30pm.");
    const next = reschedule?.plan;
    if (next === undefined) return;
    expect(next.version).toBe(2);
    expect(item(next, "beach")?.startsAt).toBe("2026-10-10T01:30:00.000Z");
    expect(item(next, "dinner")?.startsAt).toBe("2026-10-10T03:30:00.000Z");
    expect(item(next, "outbound-rebook")).toMatchObject({ participants: ["dev"], inventoryId: "TW177-2026-10-09" });
    expect(item(next, "dinner")?.dependsOn).toEqual(["hotel", "beach"]);
    // The hotel waits for Dev's new flight too, but holds the room, so its times and guests stay put.
    expect(item(next, "hotel")).toEqual({ ...item(plan, "hotel"), dependsOn: ["outbound", "outbound-rebook"] });
    // The return flight only depends on the hotel and nothing about it changes.
    expect(item(next, "return")).toEqual(item(plan, "return"));
  });

  it("marks the rebooking irreversible and the reservation moves reversible, with stable idempotency keys", () => {
    const actions = byId("rebook-reschedule")?.option.actions ?? [];
    expect(actions.map((a) => [a.kind, reversibilityOf(a)])).toEqual([
      ["book_flight", "IRREVERSIBLE"],
      ["modify_reservation", "REVERSIBLE"],
      ["modify_reservation", "REVERSIBLE"],
    ]);
    const again = repairPlan(plan, devMissesOutbound(plan), context)[0]?.option.actions.map((a) => a.idempotencyKey);
    expect(again).toEqual(actions.map((a) => a.idempotencyKey));
  });

  it("keeps the schedule when asked to, and only the late person misses what they cannot reach", () => {
    const skip = byId("rebook-skip");
    expect(skip?.option.summary).toBe("Rebook Dev on TW177, landing 5:50pm. Dev skips Beach club cabana.");
    expect(item(skip?.plan ?? plan, "beach")?.participants).toEqual(["priya", "sam"]);
    expect(item(skip?.plan ?? plan, "dinner")?.participants).toEqual(["priya", "dev", "sam"]);
    expect(skip?.option.costDeltaCents).toBe(18_900 - 4_000);
  });

  it("going without someone removes them from everything downstream, not just the next item", () => {
    const without = byId("without");
    expect(without?.option.summary).toBe("Go ahead without Dev. Dev skips Beach club cabana. Dev skips Dinner at Tidewater.");
    expect(without?.option.actions.every((a) => reversibilityOf(a) === "REVERSIBLE")).toBe(true);
  });
});

describe("repairPlan: delayed flight", () => {
  const plan = samplePlan();
  const [delay] = detectDivergence(plan, [observed("d1", "outbound", "flight_delayed", { flightNumber: "TW143", newDepartsAt: "2026-10-09T22:40:00.000Z" })], NOW);

  it("reschedules the squeezed chain, or cancels what nobody can reach when the schedule is kept", () => {
    if (delay === undefined) throw new Error("expected a delay divergence");
    const [reschedule, skip] = repairPlan(plan, delay, context);
    expect(reschedule?.option.summary).toBe("Flight TW143 now lands 5:15pm. Move Beach club cabana to 6:30pm. Move Dinner at Tidewater to 8:30pm.");
    expect(skip?.option.summary).toBe("Flight TW143 now lands 5:15pm. Keep the schedule. Cancel Beach club cabana.");
    expect(skip?.option.actions.map((a) => a.kind)).toEqual(["cancel_booking"]);
    expect(item(skip?.plan ?? plan, "beach")).toBeUndefined();
    expect(item(skip?.plan ?? plan, "dinner")?.dependsOn).toEqual(["hotel"]);
  });
});

describe("repairPlan: nothing to repair", () => {
  it("acknowledges overspend without touching the plan", () => {
    const plan = samplePlan();
    const charges = [observed("c1", "dinner", "charge_posted", { memberId: "priya", amountCents: 20_000, merchant: "Tidewater" })];
    const [overspend] = detectDivergence(plan, charges, NOW);
    if (overspend === undefined) throw new Error("expected overspend");
    const [only] = repairPlan(plan, overspend, context);
    expect(only?.option).toMatchObject({ actions: [], costDeltaCents: 3_500 });
    expect(only?.plan).toBe(plan);
  });
});
