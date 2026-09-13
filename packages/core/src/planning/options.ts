import type { Blocker, CandidateOption, Constraint, DateWindow, Member, ResponseState } from "../domain";
import { addDays, datesInclusive } from "./dates";

export interface OptionPricing {
  readonly perPersonCents: number;
  readonly lodgingPerNightPerPersonCents: number;
}

/** Price of a trip starting on a date, from inventory. Null when inventory cannot support that start. */
export type PricingLookup = (startDate: string) => OptionPricing | null;

const RESPONDED_STATES: readonly ResponseState[] = ["partial", "complete"];

/** Silence is not "free". Availability is known once the member has answered or a public default stands in for them. */
export function availabilityKnown(member: Member): boolean {
  return (
    RESPONDED_STATES.includes(member.responseState) ||
    member.constraints.some((c) => c.kind === "date_exclusion" && c.provenance.source === "default_applied")
  );
}

function violates(constraint: Constraint, dates: ReadonlySet<string>, pricing: OptionPricing): boolean {
  switch (constraint.kind) {
    case "date_exclusion":
      return constraint.value.dates.some((d) => dates.has(d));
    case "budget_ceiling":
      return constraint.value.scope === "trip_total"
        ? pricing.perPersonCents > constraint.value.amountCents
        : pricing.lodgingPerNightPerPersonCents > constraint.value.amountCents;
    case "time_floor":
    case "dietary":
    case "activity_preference":
    case "hard_requirement":
      // These shape which activities go in the plan and when, not which dates work.
      return false;
  }
}

function evaluate(members: readonly Member[], startDate: string, endDate: string, pricing: OptionPricing): CandidateOption {
  const dates = new Set(datesInclusive(startDate, endDate));
  const feasibleFor: string[] = [];
  const blockedBy: Blocker[] = [];
  const softConflicts: CandidateOption["softConflicts"] = [];

  for (const member of members) {
    if (member.optedOut) continue;
    let hardConflict = false;
    for (const constraint of member.constraints) {
      if (!violates(constraint, dates, pricing)) continue;
      if (constraint.hardness === "hard") {
        blockedBy.push({ memberId: member.id, reason: "constraint_conflict", constraintId: constraint.id });
        hardConflict = true;
      } else {
        softConflicts.push({ memberId: member.id, constraintId: constraint.id });
      }
    }
    if (hardConflict) continue;
    if (availabilityKnown(member)) feasibleFor.push(member.id);
    else blockedBy.push({ memberId: member.id, reason: "no_response", constraintId: null });
  }

  return { id: `opt-${startDate}`, startDate, endDate, costPerPersonCents: pricing.perPersonCents, feasibleFor, blockedBy, softConflicts };
}

const countReason = (option: CandidateOption, reason: Blocker["reason"]): number => option.blockedBy.filter((b) => b.reason === reason).length;

export const isViable = (option: CandidateOption): boolean => countReason(option, "constraint_conflict") === 0;

/** A lockable option is viable, has heard from everyone, and breaks nothing anyone asked for. */
export const isLockable = (option: CandidateOption): boolean => option.blockedBy.length === 0 && option.softConflicts.length === 0;

/** Hard conflicts rank worst, then people not heard from, then soft conflicts, then price, then earliest date. */
export function compareOptions(a: CandidateOption, b: CandidateOption): number {
  return (
    countReason(a, "constraint_conflict") - countReason(b, "constraint_conflict") ||
    countReason(a, "no_response") - countReason(b, "no_response") ||
    a.softConflicts.length - b.softConflicts.length ||
    a.costPerPersonCents - b.costPerPersonCents ||
    a.startDate.localeCompare(b.startDate)
  );
}

/** Every trip start in the window that inventory can price, evaluated against every member, best first. */
export function computeFeasibleOptions(members: readonly Member[], dateWindow: DateWindow, pricing: PricingLookup): CandidateOption[] {
  const lastStart = addDays(dateWindow.latestEnd, -(dateWindow.tripDays - 1));
  return datesInclusive(dateWindow.earliestStart, lastStart)
    .flatMap((startDate) => {
      const price = pricing(startDate);
      return price === null ? [] : [evaluate(members, startDate, addDays(startDate, dateWindow.tripDays - 1), price)];
    })
    .sort(compareOptions);
}
