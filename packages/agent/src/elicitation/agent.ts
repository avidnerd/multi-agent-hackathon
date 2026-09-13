import { createHash } from "node:crypto";
import {
  AgentActionSchema,
  announceDefaults,
  applyDefault,
  ApprovalTokenSchema,
  calendarConstraints,
  computeFeasibleOptions,
  decideChase,
  err,
  formatDateRange,
  identifyUnblockingQuestion,
  isViable,
  ok,
  shouldApplyDefault,
  summarizeConvergence,
  TripSchema,
  type AgentStep,
  type JsonValue,
  type Logger,
  type Result,
  type TraceRecorder,
  type UnblockingQuestion,
} from "@trip/core";
import type { CalendarClient, InventoryClient, LlmClient, MessagingClient } from "@trip/clients";
import { createDispatcher, type ApprovalStore, type ExecutedActionStore } from "../dispatcher";
import { handleInbound, type InboundOutcome } from "./inbound";
import { pricingFromInventory } from "./pricing";
import { initialQuestions } from "./questions";
import type { ElicitationSession, MemberThread, TripIntake } from "./session";

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
/** Do not repeat the same unblocking question to the same person inside this window. */
export const QUESTION_COOLDOWN_MS = 12 * MS_PER_HOUR;
const STANDING_APPROVAL_GRACE_DAYS = 1;
const MS_PER_DAY = 86_400_000;

export interface AgentDeps {
  readonly messaging: MessagingClient;
  readonly calendar: CalendarClient;
  readonly inventory: InventoryClient;
  readonly llm: LlmClient;
  readonly trace: TraceRecorder;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly approvals: ApprovalStore;
  readonly executed: ExecutedActionStore;
}

export interface TickReport {
  readonly inbound: readonly InboundOutcome[];
  readonly chases: ReadonlyArray<{ memberId: string; tier: number }>;
  readonly defaultsAnnounced: readonly string[];
  readonly question: UnblockingQuestion | null;
  readonly questionSent: boolean;
  readonly summary: string;
}

const hashKey = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 24);

export function createElicitationAgent(deps: AgentDeps) {
  const nowIso = (): string => deps.now().toISOString();

  async function sendSms(session: ElicitationSession, memberId: string, body: string, purpose: string, step: AgentStep): Promise<Result<JsonValue>> {
    const { trip } = session;
    const dispatcher = createDispatcher({
      handlers: {
        send_sms: async (action) => {
          const member = action.kind === "send_sms" ? trip.members.find((m) => m.id === action.params.memberId) : undefined;
          if (action.kind !== "send_sms" || member === undefined) return err({ kind: "not_found", service: "messaging", resource: `member for ${action.id}` });
          const sent = await deps.messaging.send({ to: member.phone, body: action.params.body });
          if (!sent.ok) return sent;
          session.messages.push({ id: `out-${sent.value.externalId}`, tripId: trip.id, memberId: member.id, channel: deps.messaging.channel, direction: "outbound", body: action.params.body, externalId: sent.value.externalId, at: sent.value.sentAt });
          return ok({ externalId: sent.value.externalId });
        },
      },
      approvals: deps.approvals,
      executed: deps.executed,
      members: () => trip.members,
      organizerId: trip.organizerId,
      trace: deps.trace,
      now: deps.now,
    });
    const key = `${trip.id}:${purpose}:${memberId}`;
    const action = AgentActionSchema.parse({ id: key, idempotencyKey: key, requestedAt: nowIso(), reason: purpose, kind: "send_sms", params: { memberId, body } });
    return dispatcher.execute(action, { traceId: trip.id, step, approvalTokenId: session.standingApprovalId });
  }

  async function start(intake: TripIntake): Promise<Result<ElicitationSession>> {
    const at = nowIso();
    const span = deps.trace.start({ traceId: intake.tripId, step: "intake", name: "intake", input: { tripId: intake.tripId, members: intake.members.length, window: intake.dateWindow } });

    const [flights, hotels] = await Promise.all([deps.inventory.searchFlights({}), deps.inventory.listHotels()]);
    if (!flights.ok || !hotels.ok) {
      const error = !flights.ok ? flights.error : !hotels.ok ? hotels.error : { kind: "internal" as const, detail: "unreachable" };
      span.fail(error);
      return err(error);
    }

    const parsedTrip = TripSchema.safeParse({
      id: intake.tripId,
      destination: intake.destination,
      dateWindow: intake.dateWindow,
      organizerId: intake.organizerId,
      members: intake.members.map((m) => ({ ...m, optedOut: false, responseState: "unreached", constraints: [], ledgerEntries: [] })),
      status: "eliciting",
      candidateOptions: [],
      selectedPlan: null,
      liveState: { startedAt: null, lastPolledAt: null, openDivergenceIds: [] },
    });
    if (!parsedTrip.success) {
      const error = { kind: "validation_failed" as const, boundary: "user_input" as const, issues: parsedTrip.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
      span.fail(error);
      return err(error);
    }
    const trip = parsedTrip.data;

    // The organizer approves messaging the group once, up front, instead of every text.
    const approval = ApprovalTokenSchema.parse({
      id: `${trip.id}-standing-sms`,
      tripId: trip.id,
      grantedBy: trip.organizerId,
      grantedAt: at,
      expiresAt: new Date(Date.parse(`${intake.dateWindow.latestEnd}T00:00:00Z`) + STANDING_APPROVAL_GRACE_DAYS * MS_PER_DAY).toISOString(),
      scope: { kind: "standing", actionKinds: ["send_sms"], memberIds: trip.members.map((m) => m.id) },
      usedAt: null,
    });
    deps.approvals.put(approval);

    const calendarShared: Record<string, boolean> = {};
    const emails = trip.members.flatMap((m) => (m.email === null ? [] : [m.email]));
    if (emails.length > 0) {
      const from = new Date(Date.parse(`${intake.dateWindow.earliestStart}T00:00:00Z`) - intake.utcOffsetMinutes * MS_PER_MINUTE).toISOString();
      const to = new Date(Date.parse(`${intake.dateWindow.latestEnd}T00:00:00Z`) + MS_PER_DAY - intake.utcOffsetMinutes * MS_PER_MINUTE).toISOString();
      const availability = await deps.calendar.freeBusy({ from, to, calendarIds: emails });
      if (!availability.ok) deps.logger.warn("calendar.freebusy_failed", { kind: availability.error.kind });
      for (const member of trip.members) {
        const entry = member.email === null || !availability.ok ? undefined : availability.value[member.email];
        calendarShared[member.id] = entry !== undefined && entry.unavailableReason === null;
        if (entry !== undefined && entry.unavailableReason === null && member.email !== null) {
          member.constraints.push(...calendarConstraints(member, member.email, entry.busy, intake.dateWindow, intake.utcOffsetMinutes, at));
        }
      }
    }

    const pricing = pricingFromInventory({
      flights: flights.value,
      hotels: hotels.value,
      originAirport: intake.originAirport,
      destinationAirport: intake.destinationAirport,
      window: intake.dateWindow,
      groupSize: trip.members.length,
      utcOffsetMinutes: intake.utcOffsetMinutes,
    });
    const threads: Record<string, MemberThread> = Object.fromEntries(
      trip.members.map((m) => [m.id, { askedAt: null, chasesSent: 0, lastChaseAt: null, repliedAt: null, answered: { dates: false, budget: false, schedule: false } }]),
    );
    const session: ElicitationSession = { intake, trip, threads, messages: [], seenExternalIds: new Set(), askedQuestions: {}, standingApprovalId: approval.id, startedAt: at, pricing, calendarShared };
    span.succeed({ pricedStarts: Object.keys(pricing), calendarsShared: Object.entries(calendarShared).filter(([, shared]) => shared).map(([id]) => id) });

    const organizer = trip.members.find((m) => m.id === trip.organizerId);
    for (const member of trip.members) {
      const body = initialQuestions({
        member,
        organizerName: organizer?.name ?? "your organizer",
        isOrganizer: member.id === trip.organizerId,
        destination: trip.destination,
        window: trip.dateWindow,
        busyDates: member.constraints.flatMap((c) => (c.kind === "date_exclusion" && c.provenance.source === "calendar_busy" ? c.value.dates : [])),
      });
      const sent = await sendSms(session, member.id, body, "questions", "elicit");
      const thread = threads[member.id];
      if (sent.ok && thread !== undefined) {
        thread.askedAt = at;
        member.responseState = "asked";
      } else if (!sent.ok) {
        deps.logger.warn("elicit.send_failed", { memberId: member.id, kind: sent.error.kind });
      }
    }
    return ok(session);
  }

  async function tick(session: ElicitationSession): Promise<Result<TickReport>> {
    const { trip, intake } = session;
    const now = nowIso();

    const polled = await deps.messaging.listInbound(new Date(session.startedAt), trip.members.map((m) => m.phone));
    if (!polled.ok) return polled;
    const fresh = polled.value.filter((m) => !session.seenExternalIds.has(m.externalId)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const inbound: InboundOutcome[] = [];
    for (const message of fresh) {
      session.seenExternalIds.add(message.externalId);
      const outcome = await handleInbound({ ...deps, channel: deps.messaging.channel }, session, message);
      // Read it again next tick rather than drop what the member said because the model was unavailable.
      if (outcome.kind === "extraction_failed") session.seenExternalIds.delete(message.externalId);
      inbound.push(outcome);
    }

    const options = () => computeFeasibleOptions(trip.members, trip.dateWindow, (start) => session.pricing[start] ?? null);
    const leading = options().find(isViable);
    const leadingRange = leading === undefined ? null : formatDateRange(leading.startDate, leading.endDate);

    const chases: Array<{ memberId: string; tier: number }> = [];
    const defaultsAnnounced: string[] = [];
    for (const member of trip.members) {
      const thread = session.threads[member.id];
      if (thread === undefined || thread.askedAt === null) continue;
      const decision = decideChase(member, { askedAt: thread.askedAt, chasesSent: thread.chasesSent, lastChaseAt: thread.lastChaseAt, repliedAt: thread.repliedAt }, now, {
        destination: trip.destination,
        leadingRange,
        defaultBudgetCents: intake.defaults.budgetCeilingCents,
      });
      if (decision.kind === "chase") {
        const sent = await sendSms(session, member.id, decision.message, `chase-${decision.tier}`, "chase");
        if (sent.ok) {
          thread.chasesSent = decision.tier;
          thread.lastChaseAt = now;
          chases.push({ memberId: member.id, tier: decision.tier });
        }
      } else if (decision.kind === "apply_defaults") {
        const assumptions: string[] = [];
        for (const kind of ["date_exclusion", "budget_ceiling"] as const) {
          if (!shouldApplyDefault(member, kind, thread.askedAt, now, 0)) continue;
          const applied = applyDefault({ member, kind, constraintId: `default-${member.id}-${kind}`, silentSince: thread.askedAt, now, policy: intake.defaults });
          member.constraints.push(applied.constraint);
          assumptions.push(applied.assumption);
        }
        member.responseState = "ghosted";
        if (assumptions.length > 0) {
          defaultsAnnounced.push(announceDefaults(member.name, assumptions, "group"));
          for (const recipient of trip.members.filter((m) => !m.optedOut)) {
            const audience = recipient.id === member.id ? "member" : "group";
            await sendSms(session, recipient.id, announceDefaults(member.name, assumptions, audience), `defaults-${member.id}`, "chase");
          }
        }
      }
    }

    const span = deps.trace.start({ traceId: trip.id, step: "converge", name: "converge", input: { members: trip.members.map((m) => ({ id: m.id, state: m.responseState, constraints: m.constraints.length })) } });
    const ranked = options();
    trip.candidateOptions = ranked;
    trip.status = "converging";
    const question = identifyUnblockingQuestion(ranked, trip.members);
    const summary = summarizeConvergence(ranked, trip.members, question);

    let questionSent = false;
    const target = trip.members.find((m) => m.id === question?.memberId);
    // Silent people are handled by the chase schedule. The unblocking question goes to people already in the conversation.
    if (question !== null && target !== undefined && (target.responseState === "partial" || target.responseState === "complete")) {
      const questionKey = hashKey(`${question.memberId}|${question.kind}|${question.constraintId ?? ""}|${question.optionId}`);
      const lastAsked = session.askedQuestions[questionKey];
      if (lastAsked === undefined || Date.parse(now) - Date.parse(lastAsked) >= QUESTION_COOLDOWN_MS) {
        const sent = await sendSms(session, target.id, question.message, `unblock-${questionKey}`, "converge");
        if (sent.ok) {
          session.askedQuestions[questionKey] = now;
          questionSent = true;
        }
      }
    }
    span.succeed({ topOptions: ranked.slice(0, 3).map((o) => o.id), question: question?.message ?? null, questionSent, summary });
    return ok({ inbound, chases, defaultsAnnounced, question, questionSent, summary });
  }

  return { start, tick };
}

export type ElicitationAgent = ReturnType<typeof createElicitationAgent>;
