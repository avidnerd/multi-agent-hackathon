import { describe, expect, it } from "vitest";
import type { CandidateOption, Constraint } from "../domain";
import { buildPlan, type PlanSelection } from "./build-plan";
import { member, PDT, RECORDED_AT, said } from "./fixtures";

const option: CandidateOption = {
  id: "opt-2026-10-09",
  startDate: "2026-10-09",
  endDate: "2026-10-11",
  costPerPersonCents: 60_000,
  feasibleFor: ["priya", "dev", "ana"],
  blockedBy: [{ memberId: "sam", reason: "constraint_conflict", constraintId: "c" }],
  softConflicts: [],
};

const selection: PlanSelection = {
  outbound: { flightId: "TW143-2026-10-09", flightNumber: "TW143", departsAt: "2026-10-09T17:40:00.000Z", arrivesAt: "2026-10-09T19:15:00.000Z", farePerPersonCents: 20_900 },
  hotel: { hotelId: "harbor-row", name: "Harbor Row Hotel", checkInAt: "2026-10-09T22:00:00.000Z", checkOutAt: "2026-10-11T18:00:00.000Z", totalCents: 43_800 },
  venues: [
    { venueId: "beach-club", name: "Beach club cabana", activity: "beach", startsAt: "2026-10-09T23:00:00.000Z", durationMinutes: 90, pricePerPersonCents: 4_000 },
    { venueId: "cove-kayak", name: "Cove kayak tour", activity: "kayaking", startsAt: "2026-10-10T17:30:00.000Z", durationMinutes: 120, pricePerPersonCents: 6_500 },
  ],
  return: { flightId: "TW236-2026-10-11", flightNumber: "TW236", departsAt: "2026-10-11T20:45:00.000Z", arrivesAt: "2026-10-11T22:20:00.000Z", farePerPersonCents: 17_900 },
};

const avoidsKayaking: Constraint = { id: "k", memberId: "ana", kind: "activity_preference", value: { activity: "Kayaking", stance: "avoids" }, hardness: "hard", provenance: said("no kayaks"), recordedAt: RECORDED_AT };
const lateRiser: Constraint = { id: "t", memberId: "dev", kind: "time_floor", value: { earliest: "11:00", appliesTo: "any" }, hardness: "soft", provenance: said("mornings are rough"), recordedAt: RECORDED_AT };

const members = [member("priya", "Priya"), member("dev", "Dev", { constraints: [lateRiser] }), member("sam", "Sam"), member("ana", "Ana", { constraints: [avoidsKayaking] })];

describe("buildPlan", () => {
  const built = buildPlan({ tripId: "trip-1", planId: "plan-1", version: 1, option, members, selection, utcOffsetMinutes: PDT });

  it("builds the dependency graph repair will cascade along", () => {
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.plan.items.map((i) => [i.id, i.dependsOn])).toEqual([
      ["outbound", []],
      ["hotel", ["outbound"]],
      ["venue-1-beach-club", ["outbound", "hotel"]],
      ["venue-2-cove-kayak", ["outbound", "hotel"]],
      ["return", ["hotel"]],
    ]);
  });

  it("only includes people the option works for and costs items per participant", () => {
    if (!built.ok) return;
    const outbound = built.value.plan.items[0];
    expect(outbound?.participants).toEqual(["priya", "dev", "ana"]);
    expect(outbound?.costCents).toBe(3 * 20_900);
  });

  it("leaves someone out of a venue on a hard constraint and only warns on a soft one", () => {
    if (!built.ok) return;
    const kayak = built.value.plan.items.find((i) => i.id === "venue-2-cove-kayak");
    expect(kayak?.participants).toEqual(["priya", "dev"]);
    expect(kayak?.costCents).toBe(2 * 6_500);
    expect(built.value.warnings).toEqual([
      "Cove kayak tour starts before Dev's 11:00, but it's a soft preference",
      "Ana avoids kayaking, so they're left out",
    ]);
  });

  it("refuses an option nobody can go on", () => {
    const empty = buildPlan({ tripId: "trip-1", planId: "p", version: 1, option: { ...option, feasibleFor: [] }, members, selection, utcOffsetMinutes: PDT });
    expect(empty.ok).toBe(false);
  });
});
