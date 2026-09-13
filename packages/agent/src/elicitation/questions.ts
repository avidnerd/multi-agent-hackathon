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

export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;
export const mention = (name: string): string => `@${firstName(name)}`;

/** The opening text. Three questions, each aimed at a variable the planner actually solves for. */
export function initialQuestions(input: InitialQuestionsInput): string {
  const { member, window } = input;
  const range = formatDateRange(window.earliestStart, window.latestEnd);
  // In a group chat each person's questions are their own message, addressed by first name so they know which one to answer.
  const opener = input.isOrganizer
    ? `${mention(member.name)} I'm on the ${input.destination} planning. Same three questions I'm asking everyone:`
    : `${mention(member.name)} I'm helping ${firstName(input.organizerName)} plan ${input.destination}. Three quick questions:`;
  const busy = input.busyDates.length > 0 ? ` Your calendar looks busy on ${joinNames(input.busyDates.map(formatDate))}. Is that a hard no?` : "";
  return [
    opener,
    `1. Which ${window.tripDays} days between ${range} work for you?${busy}`,
    `2. What's the most you'd want to spend, all in?`,
    `3. What do you want to do while we're there, and is there anything you'd skip, like early starts or certain food?`,
    `Reply in your own words.`,
  ].join("\n");
}
