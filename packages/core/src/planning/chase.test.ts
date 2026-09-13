import { describe, expect, it } from "vitest";
import { busyDates, calendarConstraints } from "./calendar-busy";
import { decideChase, type ChaseState } from "./chase";
import { member, PDT } from "./fixtures";

const ASKED = "2026-10-01T17:00:00.000Z";
const hoursLater = (h: number) => new Date(Date.parse(ASKED) + h * 3_600_000).toISOString();
const context = { destination: "San Diego", leadingRange: "Oct 9–11", defaultBudgetCents: 60_000 };
const dev = member("dev", "Dev", { responseState: "asked" });
const fresh: ChaseState = { askedAt: ASKED, chasesSent: 0, lastChaseAt: null, repliedAt: null };

describe("decideChase", () => {
  it("waits, then escalates nudge, direct, final", () => {
    expect(decideChase(dev, fresh, hoursLater(3), context)).toEqual({ kind: "wait", until: hoursLater(4) });
    expect(decideChase(dev, fresh, hoursLater(4), context)).toMatchObject({ kind: "chase", tier: 1, message: expect.stringContaining("no rush") });
    expect(decideChase(dev, { ...fresh, chasesSent: 1, lastChaseAt: hoursLater(4) }, hoursLater(24), context)).toMatchObject({
      tier: 2,
      message: "Dev, the group's waiting on dates for San Diego. I'm leaning toward Oct 9–11. Does that work for you?",
    });
    expect(decideChase(dev, { ...fresh, chasesSent: 2, lastChaseAt: hoursLater(24) }, hoursLater(48), context)).toMatchObject({
      tier: 3,
      message: "Last check, Dev. If I don't hear back by tomorrow I'll assume Oct 9–11 works and plan around $600 per person. You can change that anytime.",
    });
  });

  it("applies defaults a day after the final notice, not before", () => {
    const afterFinal: ChaseState = { ...fresh, chasesSent: 3, lastChaseAt: hoursLater(48) };
    expect(decideChase(dev, afterFinal, hoursLater(71), context)).toEqual({ kind: "wait", until: hoursLater(72) });
    expect(decideChase(dev, afterFinal, hoursLater(72), context)).toEqual({ kind: "apply_defaults" });
  });

  it("sends only the firmest due tier after downtime instead of a burst", () => {
    expect(decideChase(dev, fresh, hoursLater(50), context)).toMatchObject({ kind: "chase", tier: 3 });
  });

  it("never chases someone who replied or opted out", () => {
    expect(decideChase(dev, { ...fresh, repliedAt: hoursLater(1) }, hoursLater(30), context)).toEqual({ kind: "done" });
    expect(decideChase({ ...dev, optedOut: true }, fresh, hoursLater(30), context)).toEqual({ kind: "done" });
  });
});

describe("calendar busy blocks", () => {
  const window = { earliestStart: "2026-10-08", latestEnd: "2026-10-13", tripDays: 3 };

  it("counts a mostly busy waking day and ignores a short appointment", () => {
    const busy = [
      { start: "2026-10-09T17:00:00.000Z", end: "2026-10-09T18:00:00.000Z" }, // 10–11am, one hour
      { start: "2026-10-12T15:00:00.000Z", end: "2026-10-13T05:00:00.000Z" }, // 8am–10pm
    ];
    expect(busyDates(busy, window, PDT)).toEqual(["2026-10-12"]);
  });

  it("produces one soft calendar constraint per busy date", () => {
    const [constraint] = calendarConstraints(member("priya", "Priya"), "priya@example.com", [{ start: "2026-10-12T15:00:00.000Z", end: "2026-10-13T05:00:00.000Z" }], window, PDT, ASKED);
    expect(constraint).toMatchObject({ id: "cal-priya-2026-10-12", hardness: "soft", value: { dates: ["2026-10-12"] }, provenance: { source: "calendar_busy" } });
  });
});
