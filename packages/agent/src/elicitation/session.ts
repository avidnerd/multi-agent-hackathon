import type { DateWindow, DefaultPolicy, Message, OptionPricing, Trip } from "@trip/core";

export interface MemberIntake {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly email: string | null;
}

export interface TripIntake {
  readonly tripId: string;
  readonly destination: string;
  readonly originAirport: string;
  readonly destinationAirport: string;
  readonly utcOffsetMinutes: number;
  readonly dateWindow: DateWindow;
  readonly organizerId: string;
  readonly members: readonly MemberIntake[];
  readonly defaults: DefaultPolicy;
}

export interface Answered {
  dates: boolean;
  budget: boolean;
  schedule: boolean;
}

export interface MemberThread {
  askedAt: string | null;
  chasesSent: number;
  lastChaseAt: string | null;
  repliedAt: string | null;
  answered: Answered;
}

/** Everything the elicitation loop knows about a trip. Held in memory until persistence lands with the web app. */
export interface ElicitationSession {
  readonly intake: TripIntake;
  readonly trip: Trip;
  readonly threads: Record<string, MemberThread>;
  readonly messages: Message[];
  readonly seenExternalIds: Set<string>;
  /** Unblocking question key to when it was last sent. */
  readonly askedQuestions: Record<string, string>;
  readonly standingApprovalId: string;
  readonly startedAt: string;
  readonly pricing: Readonly<Record<string, OptionPricing>>;
  readonly calendarShared: Readonly<Record<string, boolean>>;
}
