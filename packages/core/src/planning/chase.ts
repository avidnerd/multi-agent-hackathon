import type { Member } from "../domain";
import { formatDollars } from "./format";

const MS_PER_HOUR = 3_600_000;

/** Hours after the first question. Each tier is firmer than the last; the third names the default that will apply. */
export const CHASE_SCHEDULE = [
  { tier: 1, afterMs: 4 * MS_PER_HOUR },
  { tier: 2, afterMs: 24 * MS_PER_HOUR },
  { tier: 3, afterMs: 48 * MS_PER_HOUR },
] as const;
export type ChaseTier = (typeof CHASE_SCHEDULE)[number]["tier"];

/** The final chase promises "by tomorrow", so defaults wait a day after it. */
export const FINAL_NOTICE_GRACE_MS = 24 * MS_PER_HOUR;

export interface ChaseState {
  readonly askedAt: string;
  readonly chasesSent: number;
  readonly lastChaseAt: string | null;
  readonly repliedAt: string | null;
}

export interface ChaseContext {
  readonly destination: string;
  /** The front-running dates, e.g. "Oct 9–11", or null before there is one. */
  readonly leadingRange: string | null;
  readonly defaultBudgetCents: number;
}

export type ChaseDecision =
  | { readonly kind: "done" }
  | { readonly kind: "wait"; readonly until: string }
  | { readonly kind: "chase"; readonly tier: ChaseTier; readonly message: string }
  | { readonly kind: "apply_defaults" };

function chaseMessage(tier: ChaseTier, name: string, context: ChaseContext): string {
  switch (tier) {
    case 1:
      return `Hey ${name}, no rush, but any thoughts on dates for ${context.destination}? Even a one-word answer helps.`;
    case 2:
      return context.leadingRange === null
        ? `${name}, the group's waiting on you for ${context.destination}. Which dates work?`
        : `${name}, the group's waiting on dates for ${context.destination}. I'm leaning toward ${context.leadingRange}. Does that work for you?`;
    case 3:
      return `Last check, ${name}. If I don't hear back by tomorrow I'll assume ${context.leadingRange ?? "any date"} works and plan around ${formatDollars(context.defaultBudgetCents)} per person. You can change that anytime.`;
  }
}

/**
 * What to do about someone who has not replied at all. Partial replies are handled by the unblocking
 * question instead, so a person who answered anything is never chased. If the agent was offline past
 * several tiers it sends only the firmest one that is due, not a burst.
 */
export function decideChase(member: Member, state: ChaseState, now: string, context: ChaseContext): ChaseDecision {
  if (member.optedOut || state.repliedAt !== null || member.responseState === "ghosted") return { kind: "done" };
  const nowMs = Date.parse(now);
  const askedMs = Date.parse(state.askedAt);

  if (state.chasesSent >= CHASE_SCHEDULE.length) {
    const defaultsAt = Date.parse(state.lastChaseAt ?? state.askedAt) + FINAL_NOTICE_GRACE_MS;
    return nowMs >= defaultsAt ? { kind: "apply_defaults" } : { kind: "wait", until: new Date(defaultsAt).toISOString() };
  }

  const due = CHASE_SCHEDULE.filter((step, index) => index >= state.chasesSent && askedMs + step.afterMs <= nowMs).at(-1);
  if (due === undefined) {
    const next = CHASE_SCHEDULE[state.chasesSent];
    return { kind: "wait", until: new Date(askedMs + (next?.afterMs ?? 0)).toISOString() };
  }
  return { kind: "chase", tier: due.tier, message: chaseMessage(due.tier, member.name, context) };
}
