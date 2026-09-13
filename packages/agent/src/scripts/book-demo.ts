import { randomUUID } from "node:crypto";
import { createLogger, createTraceRecorder, describeError, formatDollars, ok, PhoneE164Schema, type AppError } from "@trip/core";
import {
  createGoogleCalendarClient,
  createIMessageClient,
  createInventoryClient,
  createOpenRouterClient,
  createRoutedMessagingClient,
  createTwilioMessagingClient,
  createTwinControlClient,
  parseLlmConfig,
  realSleep,
} from "@trip/clients";
import { TWIN_GOOGLE_ACCESS_TOKEN, TWIN_TWILIO_CREDENTIALS } from "@trip/clients/contracts";
import { googleCalendarTwin, inventoryTwin, startTwin, twilioTwin } from "@trip/twins";
import { createBookingAgent } from "../booking/agent";
import type { ActivityRequest } from "../booking/selection";
import { createMemoryApprovalStore, createMemoryExecutedStore } from "../dispatcher";
import { createElicitationAgent } from "../elicitation/agent";
import { describeConstraint } from "../elicitation/extraction";
import type { ElicitationSession, TripIntake } from "../elicitation/session";

/**
 * Stage 4: plan, gate, book. The group answers (real model), the agent holds the front runners, proposes a
 * plan, is refused when it tries to book without approval, then books for real against the inventory twin.
 *
 *   pnpm book:demo                                      everyone simulated
 *   LIVE_PHONE=+14155550123 LIVE_NAME=Cody pnpm book:demo   one real phone over iMessage
 */

const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const section = (title: string): void => out(`\n── ${title}`);
const EXIT_FAILURE = 1;
const POLL_INTERVAL_MS = 5_000;
const WAIT_FOR_REPLY_MS = 10 * 60_000;

const llmConfig = parseLlmConfig(process.env);
const live = process.env.LIVE_PHONE === undefined ? null : PhoneE164Schema.safeParse(process.env.LIVE_PHONE);
if (!llmConfig.ok || (live !== null && !live.success)) {
  out(!llmConfig.ok ? `Model config is missing: ${describeError(llmConfig.error)}` : "LIVE_PHONE must be E.164, e.g. +14155550123");
  process.exit(EXIT_FAILURE);
}
const livePhone = live?.success === true ? live.data : null;

const PHONES = { maya: "+14155550100", cody: livePhone ?? "+14155550101", dev: "+14155550102", sam: "+14155550103" } as const;
const intake: TripIntake = {
  tripId: `trip-book-${Date.now()}`,
  destination: "San Diego",
  originAirport: "SFO",
  destinationAirport: "SAN",
  utcOffsetMinutes: -420,
  dateWindow: { earliestStart: "2026-10-08", latestEnd: "2026-10-13", tripDays: 3 },
  organizerId: "maya",
  members: [
    { id: "maya", name: "Maya", phone: PHONES.maya, email: null },
    { id: "cody", name: process.env.LIVE_NAME ?? "Cody", phone: PHONES.cody, email: null },
    { id: "dev", name: "Dev", phone: PHONES.dev, email: null },
    { id: "sam", name: "Sam", phone: PHONES.sam, email: "sam@example.com" },
  ],
  defaults: { budgetCeilingCents: 60_000, earliestStart: "09:00" },
};
const ACTIVITIES: ActivityRequest[] = [
  { venueId: "tidewater", activity: "dinner", dayOffset: 0, localTime: "19:00", durationMinutes: 90 },
  { venueId: "beach-club", activity: "beach", dayOffset: 1, localTime: "10:30", durationMinutes: 120 },
];
const REPLIES: ReadonlyArray<readonly [string, string]> = [
  [PHONES.maya, "Anything in that window works for me. Max $900 all in."],
  [PHONES.sam, "Tuesdays are rough but I'll make it work. Budget maybe 700?"],
  [PHONES.dev, "8th to 10th is good, I can't do the 12th. under 800 please"],
  ...(livePhone === null ? [[PHONES.cody, "free every day, under 1350, no dairy for me"] as const] : []),
];

const [inventoryServer, twilioServer, calendarServer] = await Promise.all([startTwin(inventoryTwin), startTwin(twilioTwin), startTwin(googleCalendarTwin)]);
const smsControl = createTwinControlClient("messaging", twilioServer.url);
await smsControl.reset({ clock: new Date().toISOString() });
const twilio = createTwilioMessagingClient({ baseUrl: twilioServer.url, ...TWIN_TWILIO_CREDENTIALS });
const inventory = createInventoryClient({ baseUrl: inventoryServer.url });
const trace = createTraceRecorder({ now: () => new Date(), newId: randomUUID });
const deps = {
  messaging: livePhone === null ? twilio : createRoutedMessagingClient([{ handles: [livePhone], client: createIMessageClient() }], twilio),
  calendar: createGoogleCalendarClient({ baseUrl: calendarServer.url, calendarId: "primary", accessToken: async () => ok(TWIN_GOOGLE_ACCESS_TOKEN) }),
  inventory,
  llm: createOpenRouterClient({ apiKey: llmConfig.ok ? llmConfig.value.OPENROUTER_API_KEY : "", model: llmConfig.ok ? llmConfig.value.LLM_MODEL : "" }),
  trace,
  logger: createLogger({ sink: (line) => out(`  log ${line.event} ${JSON.stringify(line.fields)}`), now: () => new Date(), minLevel: "warn" }),
  now: () => new Date(),
  sleep: realSleep,
  approvals: createMemoryApprovalStore(),
  executed: createMemoryExecutedStore(),
};
const elicitation = createElicitationAgent(deps);
const booking = createBookingAgent(deps);

const nameOf = (id: string | null): string => intake.members.find((m) => m.id === id || m.phone === id)?.name ?? "unknown";
let printed = 0;
const printOutbound = (session: ElicitationSession): void => {
  for (const m of session.messages.slice(printed)) if (m.direction === "outbound") out(`  → ${nameOf(m.memberId)}: ${m.body.replaceAll("\n", "\n    ")}`);
  printed = session.messages.length;
};
async function stop(code: number, error?: AppError): Promise<never> {
  if (error !== undefined) out(`  ${describeError(error)}`);
  await Promise.all([inventoryServer.close(), twilioServer.close(), calendarServer.close()]);
  process.exit(code);
}
const flightBookings = async (): Promise<number> => {
  const listed = await inventory.listFlightBookings();
  return listed.ok ? listed.value.length : Number.NaN;
};

section("The agent texts the group");
const started = await elicitation.start(intake);
if (!started.ok) await stop(EXIT_FAILURE, started.error);
const session = started.ok ? started.value : (undefined as never);
printOutbound(session);

section(livePhone === null ? "Replies come in" : `Replies come in. Waiting up to 10 minutes for ${nameOf("cody")} on their phone`);
await smsControl.setClock(new Date().toISOString());
for (const [from, body] of REPLIES) await smsControl.injectEvent({ kind: "inbound_sms", from, body });
let heard = 0;
for (const deadline = Date.now() + WAIT_FOR_REPLY_MS; Date.now() < deadline; await realSleep(POLL_INTERVAL_MS)) {
  const report = await elicitation.tick(session);
  if (!report.ok) await stop(EXIT_FAILURE, report.error);
  if (!report.ok) break;
  for (const outcome of report.value.inbound) {
    if (outcome.kind !== "extracted") {
      out(`  ${outcome.kind === "unknown_sender" ? outcome.from : nameOf(outcome.memberId)}: ${outcome.kind}`);
      continue;
    }
    heard += 1;
    const said = session.messages.filter((m) => m.memberId === outcome.memberId && m.direction === "inbound").at(-1)?.body ?? "";
    out(`  ← ${nameOf(outcome.memberId)}: ${said}`);
    for (const c of outcome.accepted.constraints) out(`      ${c.hardness.padEnd(4)} ${describeConstraint(c)}`);
  }
  printOutbound(session);
  if (report.value.inbound.length > 0) out(`  status: ${report.value.summary}`);
  if (heard >= intake.members.length) break;
}

section("Holds on the front runners. Reversible, so no approval needed");
const holds = await booking.placeHolds(session);
for (const hold of holds) out(`  held ${hold.optionId} on Maya's calendar as event ${hold.eventId}`);

section("The plan");
const proposed = await booking.propose(session, ACTIVITIES);
if (!proposed.ok) await stop(EXIT_FAILURE, proposed.error);
const proposal = proposed.ok ? proposed.value : (undefined as never);
for (const item of proposal.plan.items) out(`  ${item.id.padEnd(22)} ${item.title.padEnd(26)} ${formatDollars(item.costCents).padStart(6)}  after ${item.dependsOn.join(", ") || "nothing"}`);
for (const warning of proposal.warnings) out(`  warning: ${warning}`);
out(`  → Maya: ${proposal.summary}`);

section("The agent tries to book before Maya approves");
const refused = await booking.book(session, proposal, {}, holds);
out(`  refused at ${refused.failure?.kind ?? "nothing, which is a bug"}: ${refused.failure === null ? "" : describeError(refused.failure.error)}`);
out(`  flight bookings in the inventory: ${await flightBookings()}`);

section("Maya approves. One single-use token per irreversible action in this plan version");
const tokens = booking.approve(session, proposal, intake.organizerId);
const report = await booking.book(session, proposal, tokens, holds);
for (const c of report.completed) out(`  ${c.kind.padEnd(22)} ${c.planItemId.padEnd(22)} ${c.bookingRef ?? ""}`);
if (report.failure !== null) out(`  stopped at ${report.failure.kind}: ${describeError(report.failure.error)}`);
printOutbound(session);
const outbound = await inventory.getFlight(report.plan.items.find((i) => i.id === "outbound")?.inventoryId ?? "");
out(`  seats left on the outbound flight: ${outbound.ok ? outbound.value.seatsAvailable : describeError(outbound.error)}`);

section("The same booking, retried");
const retried = await booking.book(session, proposal, tokens, holds);
out(`  ${retried.failure === null ? "replayed from the executed-action record" : describeError(retried.failure.error)}; flight bookings still ${await flightBookings()}`);

section("Trace");
for (const span of trace.spans(intake.tripId)) {
  if (span.name === "converge" && span.status === "ok") continue;
  const cost = span.llmCalls.reduce((sum, c) => sum + c.costUsd, 0);
  out(`  ${span.step.padEnd(8)} ${span.name.padEnd(22)} ${span.status.padEnd(5)} ${String(span.latencyMs).padStart(6)}ms${cost > 0 ? ` $${cost.toFixed(4)}` : ""}${span.error ? `  ${describeError(span.error)}` : ""}`);
}
await stop(0);
