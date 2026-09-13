import { describe, expect, it } from "vitest";
import { DivergenceSchema } from "../domain";
import { detectDivergence } from "./divergence";
import { observed, samplePlan } from "./fixtures";

const NOW = "2026-10-09T17:45:00.000Z";

describe("detectDivergence", () => {
  it("flags a missed flight as critical when things depend on it", () => {
    const [divergence, ...rest] = detectDivergence(samplePlan(), [observed("e1", "outbound", "flight_departed", { flightNumber: "TW143", departedAt: NOW, boardedMemberIds: ["priya", "sam"] })], NOW);
    expect(rest).toEqual([]);
    expect(divergence).toMatchObject({ id: "div-outbound-participant_missing", kind: "participant_missing", severity: "critical", observed: { participants: ["priya", "sam"] } });
    expect(DivergenceSchema.safeParse(divergence).success).toBe(true);
  });

  it("merges the same miss reported twice into one divergence", () => {
    const events = [
      observed("e1", "outbound", "passenger_missed_flight", { flightNumber: "TW143", memberId: "dev" }),
      observed("e1", "outbound", "passenger_missed_flight", { flightNumber: "TW143", memberId: "dev" }),
      observed("e2", "outbound", "flight_departed", { flightNumber: "TW143", departedAt: NOW, boardedMemberIds: ["priya", "sam"] }),
    ];
    expect(detectDivergence(samplePlan(), events, NOW)).toHaveLength(1);
  });

  it("ignores a delay airlines would call on time, and marks one that squeezes the next item critical", () => {
    const plan = samplePlan();
    expect(detectDivergence(plan, [observed("d1", "outbound", "flight_delayed", { flightNumber: "TW143", newDepartsAt: "2026-10-09T17:50:00.000Z" })], NOW)).toEqual([]);

    const [shift] = detectDivergence(plan, [observed("d2", "outbound", "flight_delayed", { flightNumber: "TW143", newDepartsAt: "2026-10-09T20:40:00.000Z" })], NOW);
    expect(shift).toMatchObject({ kind: "time_shift", severity: "critical", observed: { startsAt: "2026-10-09T20:40:00.000Z", endsAt: "2026-10-09T22:15:00.000Z" } });
  });

  it("counts a duplicated charge once and flags real overspend", () => {
    const plan = samplePlan();
    const charge = (id: string, amountCents: number) => observed(id, "dinner", "charge_posted", { memberId: "priya", amountCents, merchant: "Tidewater" });
    expect(detectDivergence(plan, [charge("c1", 10_000), charge("c1", 10_000)], NOW)).toEqual([]);
    const [over] = detectDivergence(plan, [charge("c1", 10_000), charge("c2", 9_000)], NOW);
    expect(over).toMatchObject({ kind: "overspend", severity: "minor", observed: { costCents: 19_000 } });
  });

  it("ignores events the monitor could not attribute to a plan item", () => {
    expect(detectDivergence(samplePlan(), [observed("x", "not-in-plan", "flight_departed", { flightNumber: "TW999", departedAt: NOW, boardedMemberIds: [] })], NOW)).toEqual([]);
  });
});
