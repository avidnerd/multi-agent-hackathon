import { describe, expect, it } from "vitest";
import type { DateWindow, Member } from "../domain";
import { applyDefault } from "./defaults";
import { budget, calendarBusy, excludeDates, member, said } from "./fixtures";
import { computeFeasibleOptions, type PricingLookup } from "./options";

const WINDOW: DateWindow = { earliestStart: "2026-10-08", latestEnd: "2026-10-12", tripDays: 3 };
const PRICES: Readonly<Record<string, number>> = { "2026-10-08": 50_000, "2026-10-09": 50_000, "2026-10-10": 70_000 };
const pricing: PricingLookup = (start) => {
  const perPersonCents = PRICES[start];
  return perPersonCents === undefined ? null : { perPersonCents, lodgingPerNightPerPersonCents: 10_000 };
};

function group(): Member[] {
  return [
    member("priya", "Priya", { constraints: [excludeDates("priya", "c-priya", ["2026-10-08"], "hard", said("can't do the 8th"))] }),
    member("dev", "Dev", { responseState: "asked" }),
    member("sam", "Sam", { constraints: [budget("sam", "c-sam", 60_000)] }),
    member("ana", "Ana", { constraints: [excludeDates("ana", "c-ana", ["2026-10-12"], "soft", calendarBusy("ana@example.com"))] }),
  ];
}

describe("computeFeasibleOptions", () => {
  it("evaluates every start in the window and ranks hard conflicts below silence and silence below soft conflicts", () => {
    const options = computeFeasibleOptions(group(), WINDOW, pricing);
    expect(options.map((o) => o.id)).toEqual(["opt-2026-10-09", "opt-2026-10-08", "opt-2026-10-10"]);

    const [oct9, oct8, oct10] = options;
    expect(oct9).toMatchObject({ endDate: "2026-10-11", feasibleFor: ["priya", "sam", "ana"], blockedBy: [{ memberId: "dev", reason: "no_response" }], softConflicts: [] });
    expect(oct8?.blockedBy).toEqual([
      { memberId: "priya", reason: "constraint_conflict", constraintId: "c-priya" },
      { memberId: "dev", reason: "no_response", constraintId: null },
    ]);
    expect(oct10?.blockedBy).toContainEqual({ memberId: "sam", reason: "constraint_conflict", constraintId: "c-sam" });
    expect(oct10?.softConflicts).toEqual([{ memberId: "ana", constraintId: "c-ana" }]);
  });

  it("a soft conflict ranks an option but never blocks anyone from it", () => {
    const oct10 = computeFeasibleOptions(group(), WINDOW, pricing).find((o) => o.startDate === "2026-10-10");
    expect(oct10?.feasibleFor).toContain("ana");
  });

  it("skips starts inventory cannot price and ignores members who opted out", () => {
    const members = group().map((m) => (m.id === "dev" ? { ...m, optedOut: true } : m));
    const options = computeFeasibleOptions(members, { ...WINDOW, latestEnd: "2026-10-14" }, pricing);
    expect(options).toHaveLength(3);
    expect(options.flatMap((o) => [...o.feasibleFor, ...o.blockedBy.map((b) => b.memberId)])).not.toContain("dev");
  });

  it("a publicly applied default counts as an answer", () => {
    const members = group();
    const dev = members[1];
    if (dev === undefined) throw new Error("fixture changed");
    const { constraint } = applyDefault({
      member: dev,
      kind: "date_exclusion",
      constraintId: "c-dev-default",
      silentSince: "2026-10-01T16:00:00.000Z",
      now: "2026-10-03T17:00:00.000Z",
      policy: { budgetCeilingCents: 60_000, earliestStart: "09:00" },
    });
    members[1] = { ...dev, constraints: [constraint] };
    const [best] = computeFeasibleOptions(members, WINDOW, pricing);
    expect(best).toMatchObject({ id: "opt-2026-10-09", blockedBy: [], feasibleFor: ["priya", "dev", "sam", "ana"] });
  });
});
