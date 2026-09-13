import type { Constraint, Member, ResponseState } from "../domain";
import { formatDollars, joinNames } from "./format";

export const DEFAULTABLE_KINDS = ["date_exclusion", "budget_ceiling", "time_floor"] as const;
export type DefaultableKind = (typeof DEFAULTABLE_KINDS)[number];

/** Two days of silence after being asked. Long enough for a busy person, short enough that one quiet friend cannot stall the trip. */
export const DEFAULT_SILENCE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

export interface DefaultPolicy {
  /** Per-person trip budget assumed for someone who never answered. Usually the lowest ceiling anyone stated. */
  readonly budgetCeilingCents: number;
  /** Earliest local start assumed for someone who never answered, "HH:MM". */
  readonly earliestStart: string;
}

const SILENT_STATES: readonly ResponseState[] = ["asked", "ghosted"];

export function shouldApplyDefault(member: Member, kind: DefaultableKind, silentSince: string, now: string, thresholdMs = DEFAULT_SILENCE_THRESHOLD_MS): boolean {
  if (member.optedOut || !SILENT_STATES.includes(member.responseState)) return false;
  if (member.constraints.some((c) => c.kind === kind)) return false;
  return Date.parse(now) - Date.parse(silentSince) >= thresholdMs;
}

export interface AppliedDefault {
  readonly constraint: Constraint;
  /** What is now assumed, as a clause: "a budget of $600 per person". Combine several with announceDefaults. */
  readonly assumption: string;
}

/**
 * The public notice for defaults, so nobody is silently decided for. The group hears about the silent
 * member by name; the silent member gets the same news addressed to them.
 */
export function announceDefaults(memberName: string, assumptions: readonly string[], audience: "group" | "member"): string {
  const assumed = joinNames(assumptions);
  return audience === "group"
    ? `I haven't heard from ${memberName}, so I'm assuming ${assumed}. ${memberName} can text me anytime to change that.`
    : `I haven't heard back from you, so I'm assuming ${assumed}. Text me anytime to change that.`;
}

export interface ApplyDefaultInput {
  readonly member: Member;
  readonly kind: DefaultableKind;
  readonly constraintId: string;
  readonly silentSince: string;
  readonly now: string;
  readonly policy: DefaultPolicy;
}

export function applyDefault(input: ApplyDefaultInput): AppliedDefault {
  const { member, now, policy } = input;
  const base = {
    id: input.constraintId,
    memberId: member.id,
    hardness: "soft" as const,
    provenance: { source: "default_applied" as const, silentSince: input.silentSince, announcedAt: now },
    recordedAt: now,
  };
  switch (input.kind) {
    case "date_exclusion":
      return { constraint: { ...base, kind: "date_exclusion", value: { dates: [] } }, assumption: "any date in the window works" };
    case "budget_ceiling":
      return {
        constraint: { ...base, kind: "budget_ceiling", value: { amountCents: policy.budgetCeilingCents, scope: "trip_total" } },
        assumption: `a budget of ${formatDollars(policy.budgetCeilingCents)} per person`,
      };
    case "time_floor":
      return {
        constraint: { ...base, kind: "time_floor", value: { earliest: policy.earliestStart, appliesTo: "any" } },
        assumption: `nothing starts before ${policy.earliestStart}`,
      };
  }
}
