import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createLogger, createTraceRecorder, describeError, err, formatLocalTime, localDateOf, ok, PhoneE164Schema, type Result, type TraceSpan } from "@trip/core";
import {
  createGoogleCalendarClient,
  createGoogleTokenProvider,
  createIMessageClient,
  createInventoryClient,
  createOpenRouterClient,
  createTwilioMessagingClient,
  createTwinControlClient,
  parseClientConfig,
  parseLlmConfig,
  realSleep,
  type Env,
} from "@trip/clients";
import { GOOGLE_CALENDAR_API_BASE_URL, GOOGLE_OAUTH_TOKEN_URL, TWIN_GOOGLE_ACCESS_TOKEN, TWIN_TWILIO_CREDENTIALS } from "@trip/clients/contracts";
import {
  chooseActivities,
  createBookingAgent,
  createElicitationAgent,
  createMemoryApprovalStore,
  createMemoryExecutedStore,
  describeConstraint,
  type BookingReport,
  type ElicitationSession,
  type Hold,
  type MemberIntake,
  type Proposal,
  type TripIntake,
} from "@trip/agent";
import { googleCalendarTwin, inventoryTwin, startTwin, twilioTwin } from "@trip/twins";

const POLL_INTERVAL_MS = 5_000;
const UTC_OFFSET_MINUTES = -420;
/** Used only when no real group is configured, so the board can be demonstrated on the twins. */
const SIMULATED_MEMBERS = "Maya:+14155550100,Cody:+14155550101,Dev:+14155550102,Sam:+14155550103";
const SIMULATED_REPLIES = [
  "Anything in that window works for me. Max $900 all in.",
  "free every day, under 1350, no dairy for me",
  "8th to 10th is good, I can't do the 12th. under 800 please",
  "Tuesdays are rough but I'll make it work. Budget maybe 700?",
];

const APP_OF: Readonly<Record<string, "messaging" | "calendar" | "inventory" | "model">> = {
  send_sms: "messaging",
  extract_constraints: "model",
  place_calendar_hold: "calendar",
  release_calendar_hold: "calendar",
  write_calendar_event: "calendar",
  book_flight: "inventory",
  book_hotel: "inventory",
  book_reservation: "inventory",
  build_plan: "inventory",
};

const MemberEntrySchema = z.tuple([z.string().min(1), PhoneE164Schema, z.email().optional()]);

/** TRIP_MEMBERS is "Name:+1phone:email" entries separated by commas, organizer first. Email is optional. */
export function parseMembers(raw: string): Result<MemberIntake[]> {
  const members: MemberIntake[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter((e) => e.length > 0)) {
    const parsed = MemberEntrySchema.safeParse(entry.split(":").map((p) => p.trim()));
    if (!parsed.success) return err({ kind: "validation_failed", boundary: "config", issues: [`TRIP_MEMBERS entry "${entry}" must look like Name:+14155550123:name@gmail.com`] });
    const [name, phone, email] = parsed.data;
    members.push({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, phone, email: email ?? null });
  }
  return members.length >= 2 ? ok(members) : err({ kind: "validation_failed", boundary: "config", issues: ["TRIP_MEMBERS needs at least two people"] });
}

const stringField = (span: TraceSpan, field: string): string | null => {
  const output = span.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
  const value = output[field];
  return typeof value === "string" ? value : null;
};

export async function createTripSession(env: Env) {
  const llmConfig = parseLlmConfig(env);
  const clientConfig = parseClientConfig({ ...env, MESSAGING_MODE: "twin" });
  const members = parseMembers(env.TRIP_MEMBERS?.trim() || SIMULATED_MEMBERS);
  if (!llmConfig.ok) return llmConfig;
  if (!clientConfig.ok) return clientConfig;
  if (!members.ok) return members;

  const groupName = env.IMESSAGE_GROUP?.trim() || null;
  const googleCalendar = clientConfig.value.calendar.CALENDAR_MODE === "google" ? clientConfig.value.calendar : null;
  const [inventoryServer, twilioServer, calendarServer] = await Promise.all([startTwin(inventoryTwin), startTwin(twilioTwin), startTwin(googleCalendarTwin)]);
  const smsControl = createTwinControlClient("messaging", twilioServer.url);
  await smsControl.reset({ clock: new Date().toISOString() });

  const modes = {
    messaging: groupName === null ? { label: "Messages twin", real: false } : { label: `iMessage group "${groupName}"`, real: true },
    calendar: googleCalendar === null ? { label: "Google Calendar twin", real: false } : { label: "Google Calendar", real: true },
    inventory: { label: "Travel inventory twin", real: false },
    model: { label: "Claude Sonnet 5 via OpenRouter", real: true },
  };

  const trace = createTraceRecorder({ now: () => new Date(), newId: randomUUID });
  const deps = {
    messaging: groupName === null ? createTwilioMessagingClient({ baseUrl: twilioServer.url, ...TWIN_TWILIO_CREDENTIALS }) : createIMessageClient({ groupChatName: groupName, selfHandle: env.IMESSAGE_SELF_HANDLE?.trim() || undefined }),
    calendar:
      googleCalendar === null
        ? createGoogleCalendarClient({ baseUrl: calendarServer.url, calendarId: "primary", accessToken: async () => ok(TWIN_GOOGLE_ACCESS_TOKEN) })
        : createGoogleCalendarClient({
            baseUrl: GOOGLE_CALENDAR_API_BASE_URL,
            calendarId: googleCalendar.GOOGLE_CALENDAR_ID,
            accessToken: createGoogleTokenProvider({ tokenUrl: GOOGLE_OAUTH_TOKEN_URL, clientId: googleCalendar.GOOGLE_CLIENT_ID, clientSecret: googleCalendar.GOOGLE_CLIENT_SECRET, refreshToken: googleCalendar.GOOGLE_REFRESH_TOKEN }),
          }),
    inventory: createInventoryClient({ baseUrl: inventoryServer.url }),
    llm: createOpenRouterClient({ apiKey: llmConfig.value.OPENROUTER_API_KEY, model: llmConfig.value.LLM_MODEL }),
    trace,
    logger: createLogger({ sink: (line) => void process.stdout.write(`log ${line.event} ${JSON.stringify(line.fields)}\n`), now: () => new Date(), minLevel: "warn" }),
    now: () => new Date(),
    sleep: realSleep,
    approvals: createMemoryApprovalStore(),
    executed: createMemoryExecutedStore(),
  };
  const elicitation = createElicitationAgent(deps);
  const booking = createBookingAgent(deps);
  const intake: TripIntake = {
    tripId: `trip-${Date.now()}`,
    destination: "San Diego",
    originAirport: "SFO",
    destinationAirport: "SAN",
    utcOffsetMinutes: UTC_OFFSET_MINUTES,
    dateWindow: { earliestStart: "2026-10-08", latestEnd: "2026-10-13", tripDays: 3 },
    organizerId: members.value[0]?.id ?? "",
    members: members.value,
    defaults: { budgetCeilingCents: 60_000, earliestStart: "09:00" },
  };

  let session: ElicitationSession | null = null;
  let summary = "Concorde hasn't texted anyone yet.";
  let holds: Hold[] = [];
  let proposal: Proposal | null = null;
  let activityReasons: string[] = [];
  let refusal: string | null = null;
  let report: BookingReport | null = null;
  let lastError: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /** Actions and polling run one at a time so a tick never interleaves with a booking. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };

  const tick = async (): Promise<void> => {
    if (session === null || session.trip.status === "booked") return;
    const result = await elicitation.tick(session);
    if (result.ok) summary = result.value.summary;
    lastError = result.ok ? null : describeError(result.error);
  };

  const require = <T>(value: T | null, missing: string): Result<T> => (value === null ? err({ kind: "internal", detail: missing }) : ok(value));

  const actions: Readonly<Record<string, () => Promise<Result<null>>>> = {
    start: () =>
      serial(async () => {
        if (session !== null) return err({ kind: "internal", detail: "Planning has already started" });
        const started = await elicitation.start(intake);
        if (!started.ok) return started;
        session = started.value;
        setInterval(() => void serial(tick), POLL_INTERVAL_MS);
        return ok(null);
      }),
    simulate: () =>
      serial(async () => {
        if (groupName !== null) return err({ kind: "internal", detail: "Replies come from real phones in the iMessage group" });
        await smsControl.setClock(new Date().toISOString());
        for (const [index, member] of (session?.trip.members ?? []).entries()) {
          if (member.responseState === "asked") await smsControl.injectEvent({ kind: "inbound_sms", from: member.phone, body: SIMULATED_REPLIES[index % SIMULATED_REPLIES.length] });
        }
        await tick();
        return ok(null);
      }),
    propose: () =>
      serial(async () => {
        const current = require(session, "Start planning first");
        if (!current.ok) return current;
        holds = await booking.placeHolds(current.value);
        const picks = chooseActivities(current.value.trip.members);
        const drafted = await booking.propose(current.value, picks.map((p) => p.request));
        activityReasons = picks.map((p) => p.reason);
        if (!drafted.ok) return drafted;
        proposal = drafted.value;
        refusal = null;
        return ok(null);
      }),
    "book-unapproved": () =>
      serial(async () => {
        if (session === null || proposal === null) return err({ kind: "internal", detail: "Draft the plan first" });
        const attempt = await booking.book(session, proposal, {}, holds);
        refusal = attempt.failure === null ? null : describeError(attempt.failure.error);
        return ok(null);
      }),
    approve: () =>
      serial(async () => {
        if (session === null || proposal === null) return err({ kind: "internal", detail: "Draft the plan first" });
        report = await booking.book(session, proposal, booking.approve(session, proposal, intake.organizerId), holds);
        if (report.failure !== null) lastError = describeError(report.failure.error);
        return ok(null);
      }),
  };

  const nameOf = (id: string | null): string => intake.members.find((m) => m.id === id)?.name ?? "someone";

  function snapshot() {
    const trip = session?.trip ?? null;
    const plan = trip?.selectedPlan ?? null;
    const phase = session === null ? "idle" : trip?.status === "booked" ? "booked" : proposal === null ? "eliciting" : refusal === null ? "proposed" : "refused";
    return {
      phase,
      summary,
      lastError,
      refusal,
      organizer: nameOf(intake.organizerId),
      destination: intake.destination,
      window: "Oct 8–13, 3 days",
      modes,
      canSimulate: groupName === null && session !== null,
      canPropose: trip?.candidateOptions.some((o) => o.blockedBy.every((b) => b.reason !== "constraint_conflict")) ?? false,
      proposal: proposal === null ? null : { summary: proposal.summary, warnings: proposal.warnings, reasons: activityReasons },
      members: (trip?.members ?? intake.members.map((m) => ({ ...m, responseState: "unreached", optedOut: false, constraints: [] }))).map((m) => ({
        name: m.name,
        state: m.optedOut ? "opted out" : m.responseState,
        constraints: m.constraints.map((c) => `${c.hardness} ${describeConstraint(c)}`),
      })),
      messages: (session?.messages ?? []).map((m) => ({ from: m.direction === "outbound" ? "Concorde" : nameOf(m.memberId), to: m.direction === "outbound" ? nameOf(m.memberId) : null, body: m.body, at: m.at })),
      plan:
        plan === null
          ? null
          : plan.items.map((i) => ({
              id: i.id,
              kind: i.kind,
              title: i.title,
              day: localDateOf(i.startsAt, UTC_OFFSET_MINUTES),
              time: formatLocalTime(i.startsAt, UTC_OFFSET_MINUTES),
              people: i.participants.map(nameOf),
              costCents: i.costCents,
              bookingRef: i.bookingRef,
              dependsOn: i.dependsOn,
            })),
      calls: trace
        .spans(intake.tripId)
        .filter((s) => APP_OF[s.name] !== undefined)
        .map((s) => {
          const app = APP_OF[s.name] ?? "inventory";
          return {
            at: s.startedAt,
            app: modes[app].label,
            real: modes[app].real,
            action: s.name.replaceAll("_", " "),
            ok: s.status === "ok",
            latencyMs: Math.round(s.latencyMs),
            costUsd: s.llmCalls.reduce((sum, c) => sum + c.costUsd, 0),
            detail: s.error !== null ? describeError(s.error) : (stringField(s, "bookingRef") ?? (typeof s.input === "object" && s.input !== null && !Array.isArray(s.input) && typeof s.input.reason === "string" ? s.input.reason : "")),
          };
        })
        .reverse(),
    };
  }

  return ok({ actions, snapshot });
}
