import { describe, expect, it } from "vitest";
import type { CandidateOption, DateWindow } from "../domain";
import { calendarBusy, excludeDates, member, said } from "./fixtures";
import { computeFeasibleOptions } from "./options";
import { identifyUnblockingQuestion, summarizeConvergence } from "./unblocking";

const WINDOW: DateWindow = { earliestStart: "2026-10-09", latestEnd: "2026-10-12", tripDays: 3 };
const flat = () => ({ perPersonCents: 50_000, lodgingPerNightPerPersonCents: 10_000 });

function option(start: string, outstanding: { noResponse?: string[]; soft?: Array<[string, string]> }): CandidateOption {
  return {
    id: `opt-${start}`,
    startDate: start,
    endDate: start,
    costPerPersonCents: 50_000,
    feasibleFor: [],
    blockedBy: (outstanding.noResponse ?? []).map((memberId) => ({ memberId, reason: "no_response" as const, constraintId: null })),
    softConflicts: (outstanding.soft ?? []).map(([memberId, constraintId]) => ({ memberId, constraintId })),
  };
}

describe("identifyUnblockingQuestion", () => {
  it("asks the one silent person who stands between the best option and a locked plan", () => {
    const members = [
      member("priya", "Priya", { constraints: [excludeDates("priya", "c1", ["2026-10-12"], "hard", said("not the 12th"))] }),
      member("dev", "Dev", { responseState: "asked" }),
      member("sam", "Sam"),
      member("ana", "Ana"),
    ];
    const options = computeFeasibleOptions(members, WINDOW, flat);
    const question = identifyUnblockingQuestion(options, members);

    expect(question).toMatchObject({ memberId: "dev", kind: "availability", optionId: "opt-2026-10-09", locksBestOption: true });
    expect(question?.message).toBe("Hey Dev, can you do Oct 9–11? You're the last answer I need to lock it in.");
    expect(summarizeConvergence(options, members, question)).toBe("3 of 4 replied. I can lock Oct 9–11 if Dev confirms.");
  });

  it("turns a calendar busy block into a confirmation question once everyone has answered", () => {
    const members = [
      member("priya", "Priya"),
      member("ana", "Ana", { constraints: [excludeDates("ana", "busy-10", ["2026-10-10"], "soft", calendarBusy("ana@example.com"))] }),
    ];
    const question = identifyUnblockingQuestion(computeFeasibleOptions(members, WINDOW, flat), members);
    expect(question).toMatchObject({ memberId: "ana", kind: "confirm_soft_conflict", constraintId: "busy-10" });
    expect(question?.message).toBe("Hey Ana, your calendar shows something on Oct 10. Is that a hard no for Oct 9–11, or could it move?");
  });

  it("prefers the person blocking more of the good options over one blocking a single option", () => {
    const members = [member("dev", "Dev", { responseState: "asked" }), member("ana", "Ana", { responseState: "asked" })];
    const options = [option("2026-10-09", { noResponse: ["dev", "ana"] }), option("2026-10-10", { noResponse: ["dev"] }), option("2026-10-11", { noResponse: ["ana"] })];
    // dev: 1/2 + 1/2 = 1.0. ana: 1/2 + 1/3 = 0.83.
    const question = identifyUnblockingQuestion(options, members);
    expect(question?.memberId).toBe("dev");
    expect(question?.optionIds).toEqual(["opt-2026-10-09", "opt-2026-10-10"]);
    expect(question?.locksBestOption).toBe(false);
  });

  it("quotes a soft stated constraint back without doubled punctuation", () => {
    const members = [member("sam", "Sam", { constraints: [excludeDates("sam", "tue", ["2026-10-10"], "soft", said("Tuesdays are rough but I'll make it work."))] })];
    const question = identifyUnblockingQuestion(computeFeasibleOptions(members, WINDOW, flat), members);
    expect(question?.message).toBe('Hey Sam, you mentioned "Tuesdays are rough but I\'ll make it work". Is that a dealbreaker for Oct 9–11?');
  });

  it("asks nothing when the best option is already lockable", () => {
    const members = [member("priya", "Priya"), member("sam", "Sam")];
    const options = computeFeasibleOptions(members, WINDOW, flat);
    expect(identifyUnblockingQuestion(options, members)).toBeNull();
    expect(summarizeConvergence(options, members, null)).toBe("2 of 2 replied. Oct 9–11 works for everyone. Ready to lock it.");
  });

  it("does not waste a question on options a hard conflict already rules out", () => {
    const members = [member("dev", "Dev", { responseState: "asked" })];
    const blocked: CandidateOption = { ...option("2026-10-09", { noResponse: ["dev"] }), blockedBy: [{ memberId: "priya", reason: "constraint_conflict", constraintId: "c1" }, { memberId: "dev", reason: "no_response", constraintId: null }] };
    expect(identifyUnblockingQuestion([blocked], members)).toBeNull();
  });
});
