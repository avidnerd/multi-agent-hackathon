import type { CandidateOption, Constraint, Member } from "../domain";
import { formatDate, formatDateRange, joinNames } from "./format";
import { isLockable, isViable } from "./options";

/** Beyond the top few options the group will not pick anyway, so their blockers are not worth a text. */
export const TOP_OPTIONS_CONSIDERED = 5;
const QUOTE_MAX_CHARS = 80;

export interface UnblockingQuestion {
  readonly memberId: string;
  readonly kind: "availability" | "confirm_soft_conflict";
  readonly constraintId: string | null;
  /** The option the question is phrased around. */
  readonly optionId: string;
  /** Every considered option this answer would move. */
  readonly optionIds: readonly string[];
  /** True when this one answer is all that stands between the best option and lockable. */
  readonly locksBestOption: boolean;
  readonly score: number;
  readonly message: string;
}

interface Outstanding {
  readonly memberId: string;
  readonly kind: UnblockingQuestion["kind"];
  readonly constraintId: string | null;
}

interface Tally {
  readonly item: Outstanding;
  score: number;
  readonly optionIds: string[];
}

const KIND_PRIORITY: Readonly<Record<UnblockingQuestion["kind"], number>> = { availability: 0, confirm_soft_conflict: 1 };

function outstandingOn(option: CandidateOption): Outstanding[] {
  return [
    ...option.blockedBy.filter((b) => b.reason === "no_response").map((b): Outstanding => ({ memberId: b.memberId, kind: "availability", constraintId: null })),
    ...option.softConflicts.map((s): Outstanding => ({ memberId: s.memberId, kind: "confirm_soft_conflict", constraintId: s.constraintId })),
  ];
}

const keyOf = (o: Outstanding): string => `${o.memberId}|${o.kind}|${o.constraintId ?? ""}`;

function messageFor(item: Outstanding, member: Member, option: CandidateOption, locksBest: boolean): string {
  const range = formatDateRange(option.startDate, option.endDate);
  if (item.kind === "availability") {
    return locksBest
      ? `Hey ${member.name}, can you do ${range}? You're the last answer I need to lock it in.`
      : `Hey ${member.name}, can you do ${range}? That's the date I'm leaning toward.`;
  }
  const constraint: Constraint | undefined = member.constraints.find((c) => c.id === item.constraintId);
  if (constraint?.provenance.source === "calendar_busy" && constraint.kind === "date_exclusion") {
    const busyDays = constraint.value.dates.map(formatDate);
    return `Hey ${member.name}, your calendar shows something on ${joinNames(busyDays)}. Is that a hard no for ${range}, or could it move?`;
  }
  if (constraint?.provenance.source === "stated") {
    // Trailing punctuation inside the quote collides with the sentence's own ("work.".).
    const quote = constraint.provenance.rawText.slice(0, QUOTE_MAX_CHARS).replace(/[\s.!?,;:]+$/, "");
    return `Hey ${member.name}, you mentioned "${quote}". Is that a dealbreaker for ${range}?`;
  }
  return `Hey ${member.name}, would ${range} work for you?`;
}

/**
 * Picks the single question to the single person that most reduces uncertainty.
 *
 * Each viable option in the top few carries a list of outstanding items: people not heard from and
 * soft conflicts. An answer to one item is worth weight(rank) / outstanding-count on every option
 * that lists it, where weight(rank) = 1 / (rank + 1). So a question scores highest when it is the
 * only thing blocking the best option, and a person blocking several good options outranks one
 * blocking a single poor option. Ties go to availability over soft conflicts, since silence blocks
 * and a soft conflict only ranks.
 */
export function identifyUnblockingQuestion(options: readonly CandidateOption[], members: readonly Member[]): UnblockingQuestion | null {
  const considered = options.filter(isViable).slice(0, TOP_OPTIONS_CONSIDERED);
  const best = considered[0];
  if (best === undefined || isLockable(best)) return null;

  const tallies = new Map<string, Tally>();
  considered.forEach((option, rank) => {
    const outstanding = outstandingOn(option);
    for (const item of outstanding) {
      const tally = tallies.get(keyOf(item)) ?? { item, score: 0, optionIds: [] };
      tally.score += 1 / (rank + 1) / outstanding.length;
      tally.optionIds.push(option.id);
      tallies.set(keyOf(tally.item), tally);
    }
  });

  const nameOf = (id: string): string => members.find((m) => m.id === id)?.name ?? id;
  const [winner] = [...tallies.values()].sort(
    (a, b) => b.score - a.score || KIND_PRIORITY[a.item.kind] - KIND_PRIORITY[b.item.kind] || nameOf(a.item.memberId).localeCompare(nameOf(b.item.memberId)),
  );
  const member = members.find((m) => m.id === winner?.item.memberId);
  if (winner === undefined || member === undefined) return null;

  const option = considered.find((o) => o.id === winner.optionIds[0]) ?? best;
  const locksBestOption = option.id === best.id && outstandingOn(best).length === 1;
  return {
    memberId: member.id,
    kind: winner.item.kind,
    constraintId: winner.item.constraintId,
    optionId: option.id,
    optionIds: winner.optionIds,
    locksBestOption,
    score: winner.score,
    message: messageFor(winner.item, member, option, locksBestOption),
  };
}

/** The group-level status line, e.g. "2 of 4 replied. I can lock Oct 9–11 if Dev confirms." */
export function summarizeConvergence(options: readonly CandidateOption[], members: readonly Member[], question: UnblockingQuestion | null): string {
  const active = members.filter((m) => !m.optedOut);
  const replied = active.filter((m) => m.responseState === "partial" || m.responseState === "complete").length;
  const heard = `${replied} of ${active.length} replied.`;
  const best = options.find(isViable);
  if (best === undefined) return `${heard} No dates in the window work for everyone who has answered.`;
  const range = formatDateRange(best.startDate, best.endDate);
  if (isLockable(best)) return `${heard} ${range} works for everyone. Ready to lock it.`;
  const asked = members.find((m) => m.id === question?.memberId);
  if (question?.locksBestOption && asked !== undefined) return `${heard} I can lock ${range} if ${asked.name} confirms.`;
  const waiting = joinNames(best.blockedBy.map((b) => members.find((m) => m.id === b.memberId)?.name ?? b.memberId));
  return waiting === "" ? `${heard} ${range} is the front runner.` : `${heard} ${range} is the front runner. Waiting on ${waiting}.`;
}
