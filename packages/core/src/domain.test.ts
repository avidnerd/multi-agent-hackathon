import { describe, expect, it } from "vitest";
import {
  AGENT_ACTION_KINDS,
  AgentActionSchema,
  ApprovalTokenSchema,
  ConstraintSchema,
  DateWindowSchema,
  MarketSchema,
  PlanSchema,
  type PlanItem,
} from "./domain";

const T0 = "2026-10-09T10:00:00Z";
const T1 = "2026-10-09T12:00:00Z";

function item(id: string, dependsOn: string[] = []): PlanItem {
  return { id, kind: "activity", title: id, startsAt: T0, endsAt: T1, costCents: 0, participants: ["m1"], bookingRef: null, dependsOn };
}

const issuesOf = (result: { success: boolean; error?: { issues: { message: string }[] } }): string[] =>
  result.error?.issues.map((i) => i.message) ?? [];

describe("PlanSchema", () => {
  it("accepts an acyclic dependency graph", () => {
    const plan = { id: "p1", tripId: "t1", version: 1, items: [item("flight"), item("hotel", ["flight"]), item("dinner", ["hotel"])] };
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects a dependency cycle and names the path", () => {
    const plan = { id: "p1", tripId: "t1", version: 1, items: [item("a", ["c"]), item("b", ["a"]), item("c", ["b"])] };
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    expect(issuesOf(result).join()).toMatch(/dependency cycle: a > c > b > a/);
  });

  it("rejects a dependency on an item that is not in the plan", () => {
    const plan = { id: "p1", tripId: "t1", version: 1, items: [item("hotel", ["flight"])] };
    expect(issuesOf(PlanSchema.safeParse(plan)).join()).toMatch(/hotel depends on flight/);
  });
});

describe("ConstraintSchema", () => {
  const base = {
    id: "c1",
    memberId: "m1",
    kind: "time_floor",
    value: { earliest: "10:30", appliesTo: "reservation" },
    recordedAt: T0,
  } as const;

  it("accepts a hard stated constraint", () => {
    const stated = { ...base, hardness: "hard", provenance: { source: "stated", messageId: "msg1", rawText: "nothing before 10:30" } };
    expect(ConstraintSchema.safeParse(stated).success).toBe(true);
  });

  it("refuses a hard constraint inferred from a market", () => {
    const inferred = { ...base, hardness: "hard", provenance: { source: "inferred_from_market", marketId: "mk1", closingPrice: 0.31 } };
    expect(issuesOf(ConstraintSchema.safeParse(inferred))).toContain("a inferred_from_market constraint must be soft");
  });

  it("keeps a calendar busy block soft until the member confirms it", () => {
    const busy = {
      ...base,
      kind: "date_exclusion",
      value: { dates: ["2026-10-09"] },
      provenance: { source: "calendar_busy", calendarId: "priya@example.com", busyStart: T0, busyEnd: T1 },
    };
    expect(ConstraintSchema.safeParse({ ...busy, hardness: "soft" }).success).toBe(true);
    expect(issuesOf(ConstraintSchema.safeParse({ ...busy, hardness: "hard" }))).toContain("a calendar_busy constraint must be soft");
  });

  it("does not let an inferred constraint carry raw member text", () => {
    const smuggled = {
      ...base,
      hardness: "soft",
      provenance: { source: "inferred_from_market", marketId: "mk1", closingPrice: 0.31, rawText: "I said so" },
    };
    const parsed = ConstraintSchema.parse(smuggled);
    expect(parsed.provenance).not.toHaveProperty("rawText");
  });
});

describe("MarketSchema", () => {
  const market = {
    id: "mk1",
    tripId: "t1",
    question: "Do we make the 10:30 beach reservation?",
    kind: "travel_timing",
    outcomes: ["yes", "no"],
    openingPrices: { yes: 0.6, no: 0.4 },
    currentPrices: { yes: 0.35, no: 0.65 },
    status: "open",
    resolutionSource: { kind: "plan_item", planItemId: "beach" },
    resolvedOutcome: null,
    generatedFrom: { kind: "plan_item", planItemId: "beach" },
    openedAt: T0,
    closesAt: T1,
  } as const;

  it("accepts a well-formed open market", () => {
    expect(MarketSchema.safeParse(market).success).toBe(true);
  });

  it("rejects prices that do not cover the outcomes", () => {
    const bad = { ...market, currentPrices: { yes: 0.35, maybe: 0.65 } };
    expect(issuesOf(MarketSchema.safeParse(bad)).join()).toMatch(/missing: no; extra: maybe/);
  });

  it("rejects prices that do not sum to one", () => {
    expect(MarketSchema.safeParse({ ...market, openingPrices: { yes: 0.6, no: 0.6 } }).success).toBe(false);
  });

  it("rejects a resolved market with no outcome", () => {
    expect(MarketSchema.safeParse({ ...market, status: "resolved" }).success).toBe(false);
  });
});

describe("DateWindowSchema", () => {
  it("rejects a window shorter than the trip", () => {
    expect(DateWindowSchema.safeParse({ earliestStart: "2026-10-09", latestEnd: "2026-10-10", tripDays: 3 }).success).toBe(false);
    expect(DateWindowSchema.safeParse({ earliestStart: "2026-10-09", latestEnd: "2026-10-11", tripDays: 3 }).success).toBe(true);
  });
});

describe("action policy", () => {
  it("lists exactly the action kinds the schema accepts", () => {
    const schemaKinds = AgentActionSchema.options.map((o) => o.shape.kind.value);
    expect([...schemaKinds].sort()).toEqual([...AGENT_ACTION_KINDS].sort());
  });

  it("refuses a standing approval that names a reversible action", () => {
    const token = {
      id: "ap1",
      tripId: "t1",
      grantedBy: "m1",
      grantedAt: T0,
      expiresAt: T1,
      scope: { kind: "standing", actionKinds: ["send_sms", "book_reservation"], memberIds: null },
      usedAt: null,
    };
    expect(issuesOf(ApprovalTokenSchema.safeParse(token)).join()).toMatch(/reversible actions need no approval: book_reservation/);
  });
});
