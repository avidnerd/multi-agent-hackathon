import { joinNames, type Member } from "@trip/core";
import type { ActivityRequest } from "./selection";

export interface VenueOption {
  readonly venueId: string;
  /** The activity name recorded on the plan and matched by buildPlan against avoids. */
  readonly activity: string;
  /** Words people use for this activity; a stated preference matches if it contains any of them. */
  readonly keywords: readonly string[];
  readonly timing: "day" | "evening";
  /** "HH:MM" local slots the venue offers. */
  readonly slots: readonly string[];
  readonly durationMinutes: number;
}

/** What the San Diego inventory twin offers. Slots mirror the twin's seed. */
export const SAN_DIEGO_VENUES: readonly VenueOption[] = [
  { venueId: "cove-kayak", activity: "kayaking", keywords: ["kayak", "paddl", "water", "ocean", "outdoor", "adventure", "hike"], timing: "day", slots: ["09:00", "10:30", "12:00", "14:00"], durationMinutes: 150 },
  { venueId: "beach-club", activity: "beach", keywords: ["beach", "sun", "swim", "relax", "chill", "cabana", "pool", "lounge"], timing: "day", slots: ["10:30", "12:00", "15:00"], durationMinutes: 120 },
  { venueId: "tidewater", activity: "dinner", keywords: ["dinner", "food", "restaurant", "seafood", "eat", "drinks"], timing: "evening", slots: ["19:00", "20:30"], durationMinutes: 90 },
];

export interface ActivityPick {
  readonly request: ActivityRequest;
  /** Why it is on the plan, in words the group would use. */
  readonly reason: string;
}

const DEFAULT_EARLIEST = "09:00";
const MORNING_LATEST = "12:00";
const AFTERNOON_EARLIEST = "13:00";
const DAY_END = "23:59";
const ARRIVAL_DAY = 0;
const FIRST_FULL_DAY = 1;

const uniq = (names: readonly string[]): string[] => [...new Set(names)];
const laterOf = (a: string, b: string): string => (a > b ? a : b);
const slotBetween = (slots: readonly string[], from: string, to: string): string | undefined => [...slots].sort().find((s) => s >= from && s <= to);

/** The latest "nothing before" anyone stated for activities, so no pick starts before someone is up. */
function earliestStart(members: readonly Member[]): string {
  return members
    .flatMap((m) => m.constraints)
    .reduce((latest, c) => (c.kind === "time_floor" && c.value.appliesTo !== "flight" ? laterOf(latest, c.value.earliest) : latest), DEFAULT_EARLIEST);
}

/**
 * Builds the activity half of the plan from what people said. Each venue scores one point per person who
 * wants it and loses one per person who avoids it; the group skips anything it is net against. People who
 * hard-avoid a venue that stays in are left off that item by buildPlan, not dropped from the trip.
 */
export function chooseActivities(members: readonly Member[], venues: readonly VenueOption[] = SAN_DIEGO_VENUES): ActivityPick[] {
  const scored = venues
    .map((venue) => {
      const fans: string[] = [];
      const critics: string[] = [];
      for (const member of members) {
        for (const c of member.constraints) {
          if (c.kind !== "activity_preference" || !venue.keywords.some((k) => c.value.activity.toLowerCase().includes(k))) continue;
          (c.value.stance === "wants" ? fans : critics).push(member.name);
        }
      }
      return { venue, fans: uniq(fans), critics: uniq(critics) };
    })
    .filter((s) => s.fans.length >= s.critics.length);

  const reasonFor = (s: (typeof scored)[number]): string => {
    const why = s.fans.length > 0 ? `${joinNames(s.fans)} ${s.fans.length === 1 ? "wants" : "want"} ${s.venue.activity}` : `nobody objected to ${s.venue.activity}`;
    return s.critics.length > 0 ? `${why}; ${joinNames(s.critics)} will skip it` : why;
  };
  const pick = (s: (typeof scored)[number], dayOffset: number, localTime: string): ActivityPick => ({
    request: { venueId: s.venue.venueId, activity: s.venue.activity, dayOffset, localTime, durationMinutes: s.venue.durationMinutes },
    reason: reasonFor(s),
  });

  const floor = earliestStart(members);
  const picks: ActivityPick[] = [];
  const dinner = scored.find((s) => s.venue.timing === "evening");
  const dinnerTime = dinner === undefined ? undefined : slotBetween(dinner.venue.slots, floor, DAY_END);
  if (dinner !== undefined && dinnerTime !== undefined) picks.push(pick(dinner, ARRIVAL_DAY, dinnerTime));

  const [first, second] = scored.filter((s) => s.venue.timing === "day").sort((a, b) => b.fans.length - b.critics.length - (a.fans.length - a.critics.length));
  const morning = first === undefined ? undefined : (slotBetween(first.venue.slots, floor, MORNING_LATEST) ?? slotBetween(first.venue.slots, floor, DAY_END));
  if (first !== undefined && morning !== undefined) picks.push(pick(first, FIRST_FULL_DAY, morning));
  const afternoon = second === undefined ? undefined : slotBetween(second.venue.slots, laterOf(AFTERNOON_EARLIEST, floor), DAY_END);
  if (second !== undefined && afternoon !== undefined) picks.push(pick(second, FIRST_FULL_DAY, afternoon));
  return picks;
}
