import { formatDate, formatDateRange, joinNames, type DateWindow, type Member } from "@trip/core";

export interface InitialQuestionsInput {
  readonly member: Member;
  readonly organizerName: string;
  readonly isOrganizer: boolean;
  readonly destination: string;
  readonly window: DateWindow;
  /** Window dates the member's shared calendar shows as busy. */
  readonly busyDates: readonly string[];
}

/** The opening text. Three questions, each aimed at a variable the planner actually solves for. */
export function initialQuestions(input: InitialQuestionsInput): string {
  const { member, window } = input;
  const range = formatDateRange(window.earliestStart, window.latestEnd);
  const opener = input.isOrganizer
    ? `Hi ${member.name}, I'm on the ${input.destination} planning. Same three questions I'm asking everyone:`
    : `Hi ${member.name}, I'm helping ${input.organizerName} plan ${input.destination}. Three quick questions:`;
  const busy = input.busyDates.length > 0 ? ` Your calendar looks busy on ${joinNames(input.busyDates.map(formatDate))}. Is that a hard no?` : "";
  return [
    opener,
    `1. Which ${window.tripDays} days between ${range} work for you?${busy}`,
    `2. What's the most you'd want to spend, all in?`,
    `3. Anything you'd skip or can't do, like early starts or certain food?`,
    `Reply in your own words.`,
  ].join("\n");
}
