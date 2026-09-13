import { z } from "zod";
import { findDependencyCycle, findMissingDependencies } from "./plan-graph";

export const GROUP_SIZE = { min: 4, max: 6 } as const;
export const TRIP_DAYS = { min: 2, max: 3 } as const;
export const MARKET_OUTCOME_COUNT = { min: 2, max: 6 } as const;
/** Market maker arithmetic is floating point, so prices sum to 1 only within a tolerance. */
export const PRICE_SUM_TOLERANCE = 1e-6;
/** Twilio rejects bodies over 1600 characters; iMessage has no practical limit. */
export const MAX_MESSAGE_BODY_CHARS = 1600;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const IdSchema = z.string().min(1).max(128);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const IsoDateSchema = z.iso.date();
export const LocalTimeSchema = z.iso.time({ precision: -1 });
export const CentsSchema = z.number().int().nonnegative();
export const SignedCentsSchema = z.number().int();
export const ProbabilitySchema = z.number().min(0).max(1);
export const PhoneE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164, for example +14155550123");

const instant = (iso: string): number => Date.parse(iso);
const dayNumber = (isoDate: string): number => Date.parse(`${isoDate}T00:00:00Z`) / MS_PER_DAY;

type RefinementContext = z.RefinementCtx;

function addIssue(ctx: RefinementContext, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

// ---------------------------------------------------------------------------
// Date window
// ---------------------------------------------------------------------------

export const DateWindowSchema = z
  .object({
    earliestStart: IsoDateSchema,
    latestEnd: IsoDateSchema,
    tripDays: z.number().int().min(TRIP_DAYS.min).max(TRIP_DAYS.max),
  })
  .superRefine((w, ctx) => {
    const spanDays = dayNumber(w.latestEnd) - dayNumber(w.earliestStart) + 1;
    if (spanDays < w.tripDays) {
      addIssue(ctx, ["latestEnd"], `window spans ${spanDays} days but the trip needs ${w.tripDays}`);
    }
  });
export type DateWindow = z.infer<typeof DateWindowSchema>;

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

export const PLAN_ITEM_KINDS = ["flight", "hotel", "reservation", "activity", "transfer"] as const;
export const PlanItemKindSchema = z.enum(PLAN_ITEM_KINDS);
export type PlanItemKind = z.infer<typeof PlanItemKindSchema>;

export const HardnessSchema = z.enum(["hard", "soft"]);
export type Hardness = z.infer<typeof HardnessSchema>;

export const CONSTRAINT_SOURCES = ["stated", "inferred_from_market", "default_applied", "calendar_busy"] as const;
export type ConstraintSource = (typeof CONSTRAINT_SOURCES)[number];

/**
 * Provenance is a discriminated union rather than a bare `source` enum so that evidence
 * cannot be mixed up: only a stated constraint carries the member's raw text, and an
 * inferred one must point at the market it came from.
 */
export const ProvenanceSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("stated"),
    messageId: IdSchema,
    rawText: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
  }),
  z.object({
    source: z.literal("inferred_from_market"),
    marketId: IdSchema,
    closingPrice: ProbabilitySchema,
  }),
  z.object({
    source: z.literal("default_applied"),
    silentSince: IsoDateTimeSchema,
    announcedAt: IsoDateTimeSchema,
  }),
  /** A busy block on a member's shared calendar. Free/busy hides titles, so it is a hint to confirm by text, not a known conflict. */
  z.object({
    source: z.literal("calendar_busy"),
    calendarId: z.string().min(1),
    busyStart: IsoDateTimeSchema,
    busyEnd: IsoDateTimeSchema,
  }),
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

const constraintBase = {
  id: IdSchema,
  memberId: IdSchema,
  hardness: HardnessSchema,
  provenance: ProvenanceSchema,
  recordedAt: IsoDateTimeSchema,
};

export const ConstraintSchema = z
  .discriminatedUnion("kind", [
    z.object({
      ...constraintBase,
      kind: z.literal("date_exclusion"),
      value: z.object({ dates: z.array(IsoDateSchema) }),
    }),
    z.object({
      ...constraintBase,
      kind: z.literal("budget_ceiling"),
      value: z.object({
        amountCents: CentsSchema,
        scope: z.enum(["trip_total", "per_night_lodging"]),
      }),
    }),
    z.object({
      ...constraintBase,
      kind: z.literal("time_floor"),
      value: z.object({
        earliest: LocalTimeSchema,
        appliesTo: z.union([PlanItemKindSchema, z.literal("any")]),
      }),
    }),
    z.object({
      ...constraintBase,
      kind: z.literal("dietary"),
      value: z.object({ restriction: z.string().min(1).max(80) }),
    }),
    z.object({
      ...constraintBase,
      kind: z.literal("activity_preference"),
      value: z.object({
        activity: z.string().min(1).max(80),
        stance: z.enum(["wants", "avoids"]),
      }),
    }),
    z.object({
      ...constraintBase,
      kind: z.literal("hard_requirement"),
      value: z.object({ description: z.string().min(1).max(280) }),
    }),
  ])
  .superRefine((c, ctx) => {
    // Only a person can make something non-negotiable. Markets and defaults produce soft
    // constraints, which is what keeps an inference from ever outranking a stated need.
    if (c.provenance.source !== "stated" && c.hardness === "hard") {
      addIssue(ctx, ["hardness"], `a ${c.provenance.source} constraint must be soft`);
    }
    if (c.kind === "hard_requirement" && c.hardness !== "hard") {
      addIssue(ctx, ["hardness"], "a hard_requirement must be hard");
    }
    // An empty exclusion list means "any date works", which only a default can assert on someone's behalf.
    if (c.kind === "date_exclusion" && c.value.dates.length === 0 && c.provenance.source !== "default_applied") {
      addIssue(ctx, ["value", "dates"], "only a default can exclude no dates");
    }
  });
export type Constraint = z.infer<typeof ConstraintSchema>;
export type ConstraintKind = Constraint["kind"];

// ---------------------------------------------------------------------------
// Ledger and messages
// ---------------------------------------------------------------------------

export const LedgerEntrySchema = z.object({
  id: IdSchema,
  tripId: IdSchema,
  paidBy: IdSchema,
  amountCents: CentsSchema.positive(),
  description: z.string().min(1).max(200),
  planItemId: IdSchema.nullable(),
  splitAmong: z.array(IdSchema).min(1),
  postedAt: IsoDateTimeSchema,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** A message body is untrusted member text. It is data for prompts, never instruction. */
export const MessageSchema = z.object({
  id: IdSchema,
  tripId: IdSchema,
  memberId: IdSchema.nullable(),
  channel: z.enum(["sms", "imessage"]),
  direction: z.enum(["inbound", "outbound"]),
  body: z.string().max(MAX_MESSAGE_BODY_CHARS),
  externalId: z.string().nullable(),
  at: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const ResponseStateSchema = z.enum(["unreached", "asked", "partial", "complete", "ghosted"]);
export type ResponseState = z.infer<typeof ResponseStateSchema>;

export const MemberSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(60),
    phone: PhoneE164Schema,
    email: z.email().nullable(),
    optedOut: z.boolean(),
    responseState: ResponseStateSchema,
    constraints: z.array(ConstraintSchema),
    ledgerEntries: z.array(LedgerEntrySchema),
  })
  .superRefine((m, ctx) => {
    m.constraints.forEach((c, i) => {
      if (c.memberId !== m.id) {
        addIssue(ctx, ["constraints", i, "memberId"], `constraint ${c.id} belongs to ${c.memberId}, not ${m.id}`);
      }
    });
  });
export type Member = z.infer<typeof MemberSchema>;

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export const PlanItemSchema = z
  .object({
    id: IdSchema,
    kind: PlanItemKindSchema,
    title: z.string().min(1).max(120),
    startsAt: IsoDateTimeSchema,
    endsAt: IsoDateTimeSchema,
    costCents: CentsSchema,
    participants: z.array(IdSchema).min(1),
    bookingRef: z.string().nullable(),
    /** The inventory record this item is drawn from: a flightId, hotelId or venueId. */
    inventoryId: z.string().nullable(),
    dependsOn: z.array(IdSchema),
  })
  .superRefine((item, ctx) => {
    if (instant(item.endsAt) < instant(item.startsAt)) {
      addIssue(ctx, ["endsAt"], "endsAt is before startsAt");
    }
  });
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const PlanSchema = z
  .object({
    id: IdSchema,
    tripId: IdSchema,
    version: z.number().int().positive(),
    items: z.array(PlanItemSchema),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.items.forEach((item, i) => {
      if (seen.has(item.id)) addIssue(ctx, ["items", i, "id"], `duplicate plan item id ${item.id}`);
      seen.add(item.id);
    });
    for (const { itemId, missingId } of findMissingDependencies(plan.items)) {
      addIssue(ctx, ["items"], `${itemId} depends on ${missingId}, which is not in the plan`);
    }
    const cycle = findDependencyCycle(plan.items);
    if (cycle !== null) addIssue(ctx, ["items"], `dependency cycle: ${cycle.join(" > ")}`);
  });
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// Convergence output
// ---------------------------------------------------------------------------

export const BlockerSchema = z.object({
  memberId: IdSchema,
  reason: z.enum(["no_response", "constraint_conflict"]),
  constraintId: IdSchema.nullable(),
});
export type Blocker = z.infer<typeof BlockerSchema>;

export const CandidateOptionSchema = z.object({
  id: IdSchema,
  startDate: IsoDateSchema,
  endDate: IsoDateSchema,
  costPerPersonCents: CentsSchema,
  feasibleFor: z.array(IdSchema),
  blockedBy: z.array(BlockerSchema),
  /** Soft constraints this option breaks. They rank options but never block them. */
  softConflicts: z.array(z.object({ memberId: IdSchema, constraintId: IdSchema })),
});
export type CandidateOption = z.infer<typeof CandidateOptionSchema>;

// ---------------------------------------------------------------------------
// Trip
// ---------------------------------------------------------------------------

export const TripStatusSchema = z.enum([
  "eliciting",
  "converging",
  "awaiting_confirmation",
  "booked",
  "live",
  "completed",
  "cancelled",
]);
export type TripStatus = z.infer<typeof TripStatusSchema>;

export const LiveStateSchema = z.object({
  startedAt: IsoDateTimeSchema.nullable(),
  lastPolledAt: IsoDateTimeSchema.nullable(),
  openDivergenceIds: z.array(IdSchema),
});
export type LiveState = z.infer<typeof LiveStateSchema>;

export const TripSchema = z
  .object({
    id: IdSchema,
    destination: z.string().min(1).max(120),
    dateWindow: DateWindowSchema,
    organizerId: IdSchema,
    members: z.array(MemberSchema).min(GROUP_SIZE.min).max(GROUP_SIZE.max),
    status: TripStatusSchema,
    candidateOptions: z.array(CandidateOptionSchema),
    selectedPlan: PlanSchema.nullable(),
    liveState: LiveStateSchema,
  })
  .superRefine((trip, ctx) => {
    const memberIds = new Set(trip.members.map((m) => m.id));
    if (memberIds.size !== trip.members.length) addIssue(ctx, ["members"], "duplicate member ids");
    if (!memberIds.has(trip.organizerId)) addIssue(ctx, ["organizerId"], "organizer is not a member");

    if (trip.selectedPlan !== null) {
      if (trip.selectedPlan.tripId !== trip.id) addIssue(ctx, ["selectedPlan", "tripId"], "plan belongs to another trip");
      trip.selectedPlan.items.forEach((item, i) => {
        for (const p of item.participants) {
          if (!memberIds.has(p)) addIssue(ctx, ["selectedPlan", "items", i, "participants"], `${p} is not a member`);
        }
      });
    }
    const statusNeedsPlan: readonly TripStatus[] = ["booked", "live", "completed"];
    if (statusNeedsPlan.includes(trip.status) && trip.selectedPlan === null) {
      addIssue(ctx, ["selectedPlan"], `a ${trip.status} trip must have a selected plan`);
    }
  });
export type Trip = z.infer<typeof TripSchema>;

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export const MARKET_KINDS = [
  "travel_timing",
  "spend_threshold",
  "activity_preference",
  "behavioral",
  "allocation",
] as const;
export const MarketKindSchema = z.enum(MARKET_KINDS);
export type MarketKind = z.infer<typeof MarketKindSchema>;

export const PricesSchema = z.record(z.string(), ProbabilitySchema);
export type Prices = z.infer<typeof PricesSchema>;

export const ResolutionSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan_item"), planItemId: IdSchema }),
  z.object({ kind: z.literal("ledger"), memberId: IdSchema.nullable(), thresholdCents: CentsSchema }),
  z.object({ kind: z.literal("manual") }),
]);
export type ResolutionSource = z.infer<typeof ResolutionSourceSchema>;

export const GeneratedFromSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan_item"), planItemId: IdSchema }),
  z.object({ kind: z.literal("disruption"), divergenceId: IdSchema }),
]);
export type GeneratedFrom = z.infer<typeof GeneratedFromSchema>;

function checkPrices(ctx: RefinementContext, field: string, prices: Prices, outcomes: readonly string[]): void {
  const keys = Object.keys(prices);
  const missing = outcomes.filter((o) => !(o in prices));
  const extra = keys.filter((k) => !outcomes.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    addIssue(ctx, [field], `prices must cover exactly the outcomes (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
    return;
  }
  const sum = Object.values(prices).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > PRICE_SUM_TOLERANCE) addIssue(ctx, [field], `prices sum to ${sum}, not 1`);
}

export const MarketStatusSchema = z.enum(["open", "closed", "resolved", "escalated", "voided"]);
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

export const MarketSchema = z
  .object({
    id: IdSchema,
    tripId: IdSchema,
    question: z.string().min(1).max(200),
    kind: MarketKindSchema,
    outcomes: z.array(z.string().min(1).max(60)).min(MARKET_OUTCOME_COUNT.min).max(MARKET_OUTCOME_COUNT.max),
    openingPrices: PricesSchema,
    currentPrices: PricesSchema,
    status: MarketStatusSchema,
    resolutionSource: ResolutionSourceSchema,
    resolvedOutcome: z.string().nullable(),
    generatedFrom: GeneratedFromSchema,
    openedAt: IsoDateTimeSchema,
    closesAt: IsoDateTimeSchema,
  })
  .superRefine((m, ctx) => {
    if (new Set(m.outcomes).size !== m.outcomes.length) addIssue(ctx, ["outcomes"], "duplicate outcomes");
    checkPrices(ctx, "openingPrices", m.openingPrices, m.outcomes);
    checkPrices(ctx, "currentPrices", m.currentPrices, m.outcomes);
    if (m.status === "resolved" && m.resolvedOutcome === null) {
      addIssue(ctx, ["resolvedOutcome"], "a resolved market must name its outcome");
    }
    if (m.status !== "resolved" && m.resolvedOutcome !== null) {
      addIssue(ctx, ["resolvedOutcome"], `a ${m.status} market cannot have a resolved outcome`);
    }
    if (m.resolvedOutcome !== null && !m.outcomes.includes(m.resolvedOutcome)) {
      addIssue(ctx, ["resolvedOutcome"], `${m.resolvedOutcome} is not one of the outcomes`);
    }
    if (instant(m.closesAt) <= instant(m.openedAt)) addIssue(ctx, ["closesAt"], "closesAt must be after openedAt");
  });
export type Market = z.infer<typeof MarketSchema>;

export const PositionSchema = z.object({
  marketId: IdSchema,
  memberId: IdSchema,
  outcome: z.string().min(1),
  shares: z.number().positive(),
  avgPrice: ProbabilitySchema,
});
export type Position = z.infer<typeof PositionSchema>;

// ---------------------------------------------------------------------------
// Observed events
// ---------------------------------------------------------------------------

const eventBase = {
  id: IdSchema,
  tripId: IdSchema,
  at: IsoDateTimeSchema,
  source: z.enum(["twin", "real"]),
  subject: z.object({ planItemId: IdSchema.nullable(), memberId: IdSchema.nullable() }),
};

export const ObservedEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...eventBase,
    kind: z.literal("passenger_checked_in"),
    payload: z.object({ flightNumber: z.string(), memberId: IdSchema }),
  }),
  z.object({
    ...eventBase,
    kind: z.literal("passenger_missed_flight"),
    payload: z.object({ flightNumber: z.string(), memberId: IdSchema }),
  }),
  z.object({
    ...eventBase,
    kind: z.literal("flight_delayed"),
    payload: z.object({ flightNumber: z.string(), newDepartsAt: IsoDateTimeSchema }),
  }),
  z.object({
    ...eventBase,
    kind: z.literal("flight_departed"),
    payload: z.object({ flightNumber: z.string(), departedAt: IsoDateTimeSchema, boardedMemberIds: z.array(IdSchema) }),
  }),
  z.object({
    ...eventBase,
    kind: z.literal("flight_arrived"),
    payload: z.object({ flightNumber: z.string(), arrivedAt: IsoDateTimeSchema }),
  }),
  z.object({
    ...eventBase,
    kind: z.literal("hotel_checked_in"),
    payload: z.object({ bookingRef: z.string(), memberIds: z.array(IdSchema) }),
  }),
  z.object({
    ...eventBase,
    kind: z.literal("reservation_seated"),
    payload: z.object({ bookingRef: z.string(), seatedMemberIds: z.array(IdSchema).min(1) }),
  }),
  z.object({
    ...eventBase,
    kind: z.literal("charge_posted"),
    payload: z.object({ memberId: IdSchema, amountCents: CentsSchema.positive(), merchant: z.string() }),
  }),
]);
export type ObservedEvent = z.infer<typeof ObservedEventSchema>;
export type ObservedEventKind = ObservedEvent["kind"];

// ---------------------------------------------------------------------------
// Agent actions and the reversibility policy
// ---------------------------------------------------------------------------

const actionBase = {
  id: IdSchema,
  /** Every external write carries one. Twins and real clients dedupe on it. */
  idempotencyKey: z.string().min(8).max(128),
  requestedAt: IsoDateTimeSchema,
  reason: z.string().min(1).max(280),
};

export const AGENT_ACTION_KINDS = [
  "place_calendar_hold",
  "release_calendar_hold",
  "write_calendar_event",
  "send_sms",
  "book_flight",
  "book_hotel",
  "book_reservation",
  "modify_reservation",
  "cancel_booking",
  "open_market",
  "resolve_market",
] as const;
export type AgentActionKind = (typeof AGENT_ACTION_KINDS)[number];

export const AgentActionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...actionBase,
    kind: z.literal("place_calendar_hold"),
    params: z.object({ title: z.string(), startsAt: IsoDateTimeSchema, endsAt: IsoDateTimeSchema }),
  }),
  z.object({ ...actionBase, kind: z.literal("release_calendar_hold"), params: z.object({ holdId: z.string() }) }),
  z.object({
    ...actionBase,
    kind: z.literal("write_calendar_event"),
    params: z.object({ planItemId: IdSchema, attendeeIds: z.array(IdSchema).min(1) }),
  }),
  z.object({
    ...actionBase,
    kind: z.literal("send_sms"),
    params: z.object({ memberId: IdSchema, body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS) }),
  }),
  z.object({
    ...actionBase,
    kind: z.literal("book_flight"),
    params: z.object({ flightId: z.string(), memberIds: z.array(IdSchema).min(1) }),
  }),
  z.object({
    ...actionBase,
    kind: z.literal("book_hotel"),
    params: z.object({ hotelId: z.string(), checkIn: IsoDateSchema, checkOut: IsoDateSchema, rooms: z.number().int().positive() }),
  }),
  z.object({
    ...actionBase,
    kind: z.literal("book_reservation"),
    params: z.object({ venueId: z.string(), at: IsoDateTimeSchema, partySize: z.number().int().positive() }),
  }),
  z.object({
    ...actionBase,
    kind: z.literal("modify_reservation"),
    params: z.object({ bookingRef: z.string(), newAt: IsoDateTimeSchema.nullable(), guestIds: z.array(IdSchema).min(1).nullable() }),
  }),
  z.object({ ...actionBase, kind: z.literal("cancel_booking"), params: z.object({ bookingRef: z.string() }) }),
  z.object({ ...actionBase, kind: z.literal("open_market"), params: z.object({ marketId: IdSchema }) }),
  z.object({
    ...actionBase,
    kind: z.literal("resolve_market"),
    params: z.object({ marketId: IdSchema, outcome: z.string().min(1) }),
  }),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const REVERSIBLE = "REVERSIBLE";
export const IRREVERSIBLE = "IRREVERSIBLE";
export type Reversibility = typeof REVERSIBLE | typeof IRREVERSIBLE;

/**
 * The rule: an action is irreversible if undoing it would be noticed by someone outside the
 * agent or would cost money. A text cannot be unsent and a calendar invite has already
 * emailed its attendees, so messaging is irreversible and runs under a standing approval
 * the organizer grants up front. Holds live only on the organizer's calendar, and twin
 * restaurant reservations cancel free, so those are reversible.
 */
export const ACTION_REVERSIBILITY: { readonly [K in AgentActionKind]: Reversibility } = {
  place_calendar_hold: REVERSIBLE,
  release_calendar_hold: REVERSIBLE,
  write_calendar_event: IRREVERSIBLE,
  send_sms: IRREVERSIBLE,
  book_flight: IRREVERSIBLE,
  book_hotel: IRREVERSIBLE,
  book_reservation: REVERSIBLE,
  modify_reservation: REVERSIBLE,
  cancel_booking: IRREVERSIBLE,
  open_market: REVERSIBLE,
  resolve_market: IRREVERSIBLE,
};

export const reversibilityOf = (action: AgentAction): Reversibility => ACTION_REVERSIBILITY[action.kind];

export const IRREVERSIBLE_ACTION_KINDS = AGENT_ACTION_KINDS.filter((k) => ACTION_REVERSIBILITY[k] === IRREVERSIBLE);

export const ApprovalScopeSchema = z.discriminatedUnion("kind", [
  /** Single use: approves exactly one action by id. */
  z.object({ kind: z.literal("action"), actionId: IdSchema }),
  /** Reusable until expiry for the listed kinds, optionally limited to some members. */
  z.object({
    kind: z.literal("standing"),
    actionKinds: z.array(z.enum(AGENT_ACTION_KINDS)).min(1),
    memberIds: z.array(IdSchema).nullable(),
  }),
]);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalTokenSchema = z
  .object({
    id: IdSchema,
    tripId: IdSchema,
    grantedBy: IdSchema,
    grantedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    scope: ApprovalScopeSchema,
    usedAt: IsoDateTimeSchema.nullable(),
  })
  .superRefine((t, ctx) => {
    if (instant(t.expiresAt) <= instant(t.grantedAt)) addIssue(ctx, ["expiresAt"], "token expires before it was granted");
    if (t.scope.kind === "standing") {
      const reversible = t.scope.actionKinds.filter((k) => ACTION_REVERSIBILITY[k] === REVERSIBLE);
      if (reversible.length > 0) {
        addIssue(ctx, ["scope", "actionKinds"], `reversible actions need no approval: ${reversible.join(", ")}`);
      }
      if (t.usedAt !== null) addIssue(ctx, ["usedAt"], "standing tokens are not consumed");
    }
  });
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;

// ---------------------------------------------------------------------------
// Divergence and repair
// ---------------------------------------------------------------------------

export const PlanItemSnapshotSchema = z.object({
  startsAt: IsoDateTimeSchema.nullable(),
  endsAt: IsoDateTimeSchema.nullable(),
  participants: z.array(IdSchema),
  costCents: CentsSchema.nullable(),
});
export type PlanItemSnapshot = z.infer<typeof PlanItemSnapshotSchema>;

export const RepairOptionSchema = z.object({
  id: IdSchema,
  summary: z.string().min(1).max(280),
  affectedPlanItemIds: z.array(IdSchema).min(1),
  costDeltaCents: SignedCentsSchema,
  actions: z.array(AgentActionSchema),
});
export type RepairOption = z.infer<typeof RepairOptionSchema>;

export const DivergenceSchema = z
  .object({
    id: IdSchema,
    tripId: IdSchema,
    planItemId: IdSchema,
    kind: z.enum(["participant_missing", "time_shift", "cancelled", "overspend"]),
    severity: z.enum(["minor", "major", "critical"]),
    expected: PlanItemSnapshotSchema,
    observed: PlanItemSnapshotSchema,
    detectedAt: IsoDateTimeSchema,
    repairOptions: z.array(RepairOptionSchema),
    selectedRepairId: IdSchema.nullable(),
  })
  .superRefine((d, ctx) => {
    if (d.selectedRepairId !== null && !d.repairOptions.some((o) => o.id === d.selectedRepairId)) {
      addIssue(ctx, ["selectedRepairId"], `${d.selectedRepairId} is not one of the repair options`);
    }
  });
export type Divergence = z.infer<typeof DivergenceSchema>;
