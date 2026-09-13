import {
  AgentActionSchema,
  ApprovalTokenSchema,
  buildPlan,
  err,
  formatDate,
  formatDateRange,
  formatDollars,
  formatLocalTime,
  IRREVERSIBLE,
  isViable,
  joinNames,
  localDateOf,
  ok,
  reversibilityOf,
  type AgentActionKind,
  type AppError,
  type JsonValue,
  type Member,
  type Plan,
  type Result,
} from "@trip/core";
import { createDispatcher } from "../dispatcher";
import type { AgentDeps } from "../elicitation/agent";
import type { ElicitationSession } from "../elicitation/session";
import { planActions, type PlannedAction } from "./actions";
import { createPlanHandlers, stringField } from "./handlers";
import { selectInventory, type ActivityRequest } from "./selection";

/** How long an organizer's yes stays good. Seats and prices move, so a stale approval should not book. */
export const APPROVAL_TTL_MS = 30 * 60_000;
/** Front-running options held on the organizer's calendar while the group decides. */
export const HOLD_FINALISTS = 3;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export type BookingDeps = Omit<AgentDeps, "llm">;

export interface Proposal {
  readonly plan: Plan;
  readonly warnings: readonly string[];
  readonly actions: readonly PlannedAction[];
  /** What the organizer reads before approving. */
  readonly summary: string;
}

export interface Hold {
  readonly optionId: string;
  readonly eventId: string;
}

export interface BookingReport {
  readonly completed: ReadonlyArray<{ readonly planItemId: string; readonly kind: AgentActionKind; readonly bookingRef: string | null }>;
  /** The first action that did not go through. Everything before it stands; nothing is cancelled automatically. */
  readonly failure: { readonly actionId: string; readonly kind: AgentActionKind; readonly error: AppError } | null;
  readonly plan: Plan;
  readonly confirmationsSent: number;
}

/** A member's share: each item's cost split evenly among the people on it. */
export const shareOf = (plan: Plan, memberId: string): number =>
  Math.round(plan.items.filter((i) => i.participants.includes(memberId)).reduce((sum, i) => sum + i.costCents / i.participants.length, 0));

function confirmationText(session: ElicitationSession, plan: Plan, member: Member): string {
  const offset = session.intake.utcOffsetMinutes;
  const mine = plan.items.filter((i) => i.participants.includes(member.id));
  const flights = mine.filter((i) => i.kind === "flight");
  const leg = (item: (typeof mine)[number], direction: string) => `${item.title} ${direction} ${formatDate(localDateOf(item.startsAt, offset))} at ${formatLocalTime(item.startsAt, offset)}`;
  const out = flights[0];
  const back = flights.length > 1 ? flights.at(-1) : undefined;
  const parts = [out === undefined ? null : leg(out, "out"), mine.find((i) => i.kind === "hotel")?.title ?? null, back === undefined ? null : leg(back, "home")].filter((p) => p !== null);
  const calendar = member.email === null ? "" : " It's on your calendar.";
  return `Booked for ${session.trip.destination}. ${parts.join(", ")}. Your share is ${formatDollars(shareOf(plan, member.id))}.${calendar}`;
}

function describeProposal(session: ElicitationSession, plan: Plan, travellers: number): string {
  const offset = session.intake.utcOffsetMinutes;
  const flights = plan.items.filter((i) => i.kind === "flight");
  const out = flights[0];
  const back = flights.at(-1);
  if (out === undefined || back === undefined) return `${session.trip.destination} plan v${plan.version}. Nothing is booked until you approve.`;
  const venues = plan.items.filter((i) => i.kind === "reservation").map((i) => i.title);
  const hotel = plan.items.find((i) => i.kind === "hotel")?.title;
  const total = plan.items.reduce((sum, i) => sum + i.costCents, 0);
  const stops = [`out on ${out.title} at ${formatLocalTime(out.startsAt, offset)}`, hotel, venues.length > 0 ? joinNames(venues) : undefined, `home on ${back.title} at ${formatLocalTime(back.startsAt, offset)}`];
  const range = formatDateRange(localDateOf(out.startsAt, offset), localDateOf(back.startsAt, offset));
  return `${session.trip.destination}, ${range}, ${travellers} people: ${stops.filter((s) => s !== undefined).join(", ")}. About ${formatDollars(total / travellers)} a person. Nothing is booked until you approve.`;
}

export function createBookingAgent(deps: BookingDeps) {
  const nowIso = (): string => deps.now().toISOString();

  const dispatcherFor = (session: ElicitationSession, plan: Plan | null, refs: ReadonlyMap<string, string>) =>
    createDispatcher({
      handlers: createPlanHandlers(deps, session, plan, refs),
      approvals: deps.approvals,
      executed: deps.executed,
      members: () => session.trip.members,
      organizerId: session.trip.organizerId,
      trace: deps.trace,
      now: deps.now,
    });

  /** Tentative, non-blocking holds on the organizer's calendar for the front runners. Reversible, so no approval. */
  async function placeHolds(session: ElicitationSession, count = HOLD_FINALISTS): Promise<Hold[]> {
    const { trip, intake } = session;
    const dispatcher = dispatcherFor(session, null, new Map());
    const localMidnightMs = (date: string) => Date.parse(`${date}T00:00:00Z`) - intake.utcOffsetMinutes * MS_PER_MINUTE;
    const holds: Hold[] = [];
    for (const option of trip.candidateOptions.filter(isViable).slice(0, count)) {
      const range = formatDateRange(option.startDate, option.endDate);
      const action = AgentActionSchema.parse({
        id: `hold-${option.id}`,
        idempotencyKey: `${trip.id}:hold:${option.id}`,
        requestedAt: nowIso(),
        reason: `Keep ${range} open while the group decides`,
        kind: "place_calendar_hold",
        params: { title: `Hold: ${trip.destination} ${range}`, startsAt: new Date(localMidnightMs(option.startDate)).toISOString(), endsAt: new Date(localMidnightMs(option.endDate) + MS_PER_DAY).toISOString() },
      });
      const result = await dispatcher.execute(action, { traceId: trip.id, step: "plan", approvalTokenId: null });
      const eventId = result.ok ? stringField(result.value, "eventId") : null;
      if (eventId !== null) holds.push({ optionId: option.id, eventId });
      else deps.logger.warn("plan.hold_failed", { optionId: option.id, kind: result.ok ? "no_event_id" : result.error.kind });
    }
    return holds;
  }

  /** Builds the plan for the best viable option and every action needed to book it. Writes nothing external. */
  async function propose(session: ElicitationSession, activities: readonly ActivityRequest[]): Promise<Result<Proposal>> {
    const { trip, intake } = session;
    const option = trip.candidateOptions.find(isViable);
    const span = deps.trace.start({ traceId: trip.id, step: "plan", name: "build_plan", input: { optionId: option?.id ?? null, activities: activities.map((a) => `${a.venueId}@${a.localTime}+${a.dayOffset}d`) } });
    const fail = (error: AppError): Result<never> => {
      span.fail(error);
      return err(error);
    };
    if (option === undefined) return fail({ kind: "internal", detail: "No dates work for everyone who has answered, so there is nothing to plan yet" });

    const [flights, hotels, venues] = await Promise.all([deps.inventory.searchFlights({}), deps.inventory.listHotels(), deps.inventory.listVenues()]);
    if (!flights.ok) return fail(flights.error);
    if (!hotels.ok) return fail(hotels.error);
    if (!venues.ok) return fail(venues.error);

    const travellers = trip.members.filter((m) => option.feasibleFor.includes(m.id)).length;
    const selection = selectInventory({ option, flights: flights.value, hotels: hotels.value, venues: venues.value, originAirport: intake.originAirport, destinationAirport: intake.destinationAirport, utcOffsetMinutes: intake.utcOffsetMinutes, groupSize: travellers, activities });
    if (!selection.ok) return fail(selection.error);
    const built = buildPlan({ tripId: trip.id, planId: `${trip.id}-plan`, version: (trip.selectedPlan?.version ?? 0) + 1, option, members: trip.members, selection: selection.value, utcOffsetMinutes: intake.utcOffsetMinutes });
    if (!built.ok) return fail(built.error);

    const { plan, warnings } = built.value;
    const actions = planActions(plan, intake.utcOffsetMinutes, nowIso());
    trip.selectedPlan = plan;
    trip.status = "awaiting_confirmation";
    span.succeed({ planId: plan.id, version: plan.version, items: plan.items.map((i) => i.id), warnings: [...warnings], irreversibleActions: actions.filter((a) => reversibilityOf(a.action) === IRREVERSIBLE).length });
    return ok({ plan, warnings, actions, summary: describeProposal(session, plan, travellers) });
  }

  /**
   * The organizer's yes, recorded as one single-use token per irreversible action in this exact plan version.
   * Called from the organizer's surface, never by the agent on its own behalf. The dispatcher rejects tokens
   * granted by anyone but the organizer.
   */
  function approve(session: ElicitationSession, proposal: Proposal, grantedBy: string): Readonly<Record<string, string>> {
    const grantedAt = deps.now();
    const span = deps.trace.start({ traceId: session.trip.id, step: "confirm", name: "approve_plan", input: { planId: proposal.plan.id, version: proposal.plan.version, grantedBy } });
    const tokens: Record<string, string> = {};
    for (const { action } of proposal.actions) {
      if (reversibilityOf(action) !== IRREVERSIBLE) continue;
      const token = ApprovalTokenSchema.parse({
        id: `apv-${action.id}`,
        tripId: session.trip.id,
        grantedBy,
        grantedAt: grantedAt.toISOString(),
        expiresAt: new Date(grantedAt.getTime() + APPROVAL_TTL_MS).toISOString(),
        scope: { kind: "action", actionId: action.id },
        usedAt: null,
      });
      deps.approvals.put(token);
      tokens[action.id] = token.id;
    }
    span.succeed({ tokens: Object.keys(tokens).length });
    return tokens;
  }

  /** Executes the proposal in order through the gate. Stops at the first failure and reports what already stands. */
  async function book(session: ElicitationSession, proposal: Proposal, approvalTokenIds: Readonly<Record<string, string>>, holds: readonly Hold[]): Promise<BookingReport> {
    const { trip } = session;
    const refs = new Map<string, string>();
    const dispatcher = dispatcherFor(session, proposal.plan, refs);
    const completed: Array<BookingReport["completed"][number]> = [];
    let failure: BookingReport["failure"] = null;

    for (const { planItemId, action } of proposal.actions) {
      const result = await dispatcher.execute(action, { traceId: trip.id, step: "book", approvalTokenId: approvalTokenIds[action.id] ?? null });
      if (!result.ok) {
        failure = { actionId: action.id, kind: action.kind, error: result.error };
        break;
      }
      const bookingRef = action.kind === "write_calendar_event" ? null : stringField(result.value, "bookingRef");
      if (bookingRef !== null) refs.set(planItemId, bookingRef);
      completed.push({ planItemId, kind: action.kind, bookingRef });
    }

    const plan: Plan = { ...proposal.plan, items: proposal.plan.items.map((i) => ({ ...i, bookingRef: refs.get(i.id) ?? i.bookingRef })) };
    trip.selectedPlan = plan;
    if (failure !== null) return { completed, failure, plan, confirmationsSent: 0 };
    trip.status = "booked";

    for (const hold of holds) {
      const release = AgentActionSchema.parse({ id: `release-${hold.optionId}`, idempotencyKey: `${trip.id}:release:${hold.optionId}`, requestedAt: nowIso(), reason: "The plan is booked, so the hold is no longer needed", kind: "release_calendar_hold", params: { holdId: hold.eventId } });
      const released = await dispatcher.execute(release, { traceId: trip.id, step: "book", approvalTokenId: null });
      if (!released.ok) deps.logger.warn("book.release_hold_failed", { holdId: hold.eventId, kind: released.error.kind });
    }

    let confirmationsSent = 0;
    for (const member of trip.members.filter((m) => !m.optedOut && plan.items.some((i) => i.participants.includes(m.id)))) {
      const key = `${trip.id}:confirm-v${plan.version}:${member.id}`;
      const action = AgentActionSchema.parse({ id: key, idempotencyKey: key, requestedAt: nowIso(), reason: "Tell each person what was booked and their share", kind: "send_sms", params: { memberId: member.id, body: confirmationText(session, plan, member) } });
      const sent = await dispatcher.execute(action, { traceId: trip.id, step: "notify", approvalTokenId: session.standingApprovalId });
      if (sent.ok) confirmationsSent += 1;
      else deps.logger.warn("book.confirmation_failed", { memberId: member.id, kind: sent.error.kind });
    }
    return { completed, failure: null, plan, confirmationsSent };
  }

  /** One message meant for one member, through the gate under the standing messaging approval. */
  async function announce(session: ElicitationSession, purpose: string, memberId: string, body: string): Promise<Result<JsonValue>> {
    const { trip } = session;
    const key = `${trip.id}:${purpose}:${memberId}`;
    const action = AgentActionSchema.parse({ id: key, idempotencyKey: key, requestedAt: nowIso(), reason: purpose.replaceAll("-", " "), kind: "send_sms", params: { memberId, body } });
    return dispatcherFor(session, null, new Map()).execute(action, { traceId: trip.id, step: "market_gen", approvalTokenId: session.standingApprovalId });
  }

  return { placeHolds, propose, approve, book, announce };
}

export type BookingAgent = ReturnType<typeof createBookingAgent>;
