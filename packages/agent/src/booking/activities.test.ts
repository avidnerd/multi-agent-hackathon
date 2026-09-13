import { describe, expect, it } from "vitest";
import type { Constraint, Member } from "@trip/core";
import { chooseActivities } from "./activities";

const RECORDED_AT = "2026-10-01T16:00:00.000Z";
const said = (rawText: string) => ({ source: "stated" as const, messageId: `msg-${rawText.length}`, rawText });

const person = (id: string, name: string, constraints: Constraint[] = []): Member => ({
  id,
  name,
  phone: "+14155550100",
  email: null,
  optedOut: false,
  responseState: "complete",
  constraints,
  ledgerEntries: [],
});

const prefers = (memberId: string, activity: string, stance: "wants" | "avoids", hardness: "hard" | "soft" = "soft"): Constraint => ({
  id: `${memberId}-${activity}-${stance}`,
  memberId,
  kind: "activity_preference",
  value: { activity, stance },
  hardness,
  provenance: said(`${stance} ${activity}`),
  recordedAt: RECORDED_AT,
});

const notBefore = (memberId: string, earliest: string): Constraint => ({
  id: `${memberId}-floor`,
  memberId,
  kind: "time_floor",
  value: { earliest, appliesTo: "any" },
  hardness: "soft",
  provenance: said(`nothing before ${earliest}`),
  recordedAt: RECORDED_AT,
});

const summary = (members: Member[]) => chooseActivities(members).map((p) => `${p.request.venueId}@${p.request.dayOffset}:${p.request.localTime}`);

describe("chooseActivities", () => {
  it("fills the plan with dinner on arrival and both daytime venues when nobody has said anything", () => {
    expect(summary([person("a", "Ana"), person("b", "Ben")])).toEqual(["tidewater@0:19:00", "cove-kayak@1:09:00", "beach-club@1:15:00"]);
  });

  it("gives the morning to what people asked for and says who asked", () => {
    const picks = chooseActivities([person("a", "Ana", [prefers("a", "lying on the beach", "wants")]), person("b", "Ben", [prefers("b", "beach", "wants")])]);
    expect(picks.map((p) => `${p.request.venueId}@${p.request.localTime}`)).toEqual(["tidewater@19:00", "beach-club@10:30", "cove-kayak@14:00"]);
    expect(picks[1]?.reason).toBe("Ana and Ben want beach");
  });

  it("drops an activity the group is net against, and names who skips one that stays", () => {
    const members = [
      person("a", "Ana", [prefers("a", "kayaking", "avoids", "hard")]),
      person("b", "Ben", [prefers("b", "kayak tour", "avoids")]),
      person("c", "Cy", [prefers("c", "seafood", "wants"), prefers("c", "kayaking", "wants")]),
    ];
    const picks = chooseActivities(members);
    expect(picks.map((p) => p.request.venueId)).toEqual(["tidewater", "beach-club"]);
    expect(picks[0]?.reason).toBe("Cy wants dinner");

    const outvoted = chooseActivities([person("a", "Ana", [prefers("a", "kayaking", "avoids", "hard")]), person("b", "Ben", [prefers("b", "kayaking", "wants")])]);
    expect(outvoted.find((p) => p.request.venueId === "cove-kayak")?.reason).toBe("Ben wants kayaking; Ana will skip it");
  });

  it("starts nothing before the latest time anyone said they'd be up", () => {
    expect(summary([person("a", "Ana", [notBefore("a", "10:30")]), person("b", "Ben")])).toEqual(["tidewater@0:19:00", "cove-kayak@1:10:30", "beach-club@1:15:00"]);
  });
});
