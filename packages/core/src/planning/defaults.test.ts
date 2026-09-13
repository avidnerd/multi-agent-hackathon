import { describe, expect, it } from "vitest";
import { ConstraintSchema } from "../domain";
import { applyDefault, shouldApplyDefault } from "./defaults";
import { budget, member } from "./fixtures";

const ASKED_AT = "2026-10-01T16:00:00.000Z";
const POLICY = { budgetCeilingCents: 60_000, earliestStart: "09:00" };

describe("shouldApplyDefault", () => {
  const dev = member("dev", "Dev", { responseState: "asked" });

  it("waits out the silence threshold", () => {
    expect(shouldApplyDefault(dev, "date_exclusion", ASKED_AT, "2026-10-03T15:59:00.000Z")).toBe(false);
    expect(shouldApplyDefault(dev, "date_exclusion", ASKED_AT, "2026-10-03T16:00:00.000Z")).toBe(true);
  });

  it("never overrides someone who answered, already has that constraint, or opted out", () => {
    const late = "2026-10-09T00:00:00.000Z";
    expect(shouldApplyDefault({ ...dev, responseState: "partial" }, "date_exclusion", ASKED_AT, late)).toBe(false);
    expect(shouldApplyDefault({ ...dev, constraints: [budget("dev", "b", 1)] }, "budget_ceiling", ASKED_AT, late)).toBe(false);
    expect(shouldApplyDefault({ ...dev, optedOut: true }, "date_exclusion", ASKED_AT, late)).toBe(false);
  });
});

describe("applyDefault", () => {
  it("records a soft, announced default with its provenance, and the schema accepts it", () => {
    const now = "2026-10-03T17:00:00.000Z";
    const applied = applyDefault({ member: member("dev", "Dev"), kind: "budget_ceiling", constraintId: "d1", silentSince: ASKED_AT, now, policy: POLICY });
    expect(applied.constraint).toMatchObject({ hardness: "soft", provenance: { source: "default_applied", silentSince: ASKED_AT, announcedAt: now } });
    expect(ConstraintSchema.safeParse(applied.constraint).success).toBe(true);
    expect(applied.announcement).toBe("I haven't heard from Dev, so I'm assuming a budget of $600 per person. Dev can text me anytime to change it.");
  });

  it("lets only a default claim that no dates are excluded", () => {
    const applied = applyDefault({ member: member("dev", "Dev"), kind: "date_exclusion", constraintId: "d2", silentSince: ASKED_AT, now: ASKED_AT, policy: POLICY });
    expect(ConstraintSchema.safeParse(applied.constraint).success).toBe(true);
    const forged = { ...applied.constraint, provenance: { source: "stated", messageId: "m", rawText: "whatever" } };
    expect(ConstraintSchema.safeParse(forged).success).toBe(false);
  });
});
