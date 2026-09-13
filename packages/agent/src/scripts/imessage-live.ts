import { randomUUID } from "node:crypto";
import { createLogger, createTraceRecorder, describeError, ok, PhoneE164Schema } from "@trip/core";
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
import { createMemoryApprovalStore, createMemoryExecutedStore } from "../dispatcher";
import { createElicitationAgent } from "../elicitation/agent";
import { describeConstraint } from "../elicitation/extraction";
import type { ElicitationSession, TripIntake } from "../elicitation/session";

/**
 * One real phone in the room. LIVE_PHONE gets real iMessages from this Mac and replies for real;
 * the rest of the group is simulated on the Twilio twin. Real model, real clock.
 *
 *   LIVE_PHONE=+1415... LIVE_NAME=Priya pnpm imessage:live
 */

const out = (line = ""): void => void process.stdout.write(`${line}\n`);
const EXIT_FAILURE = 1;
const POLL_INTERVAL_MS = 5_000;
const WAIT_FOR_REPLY_MS = 10 * 60_000;

const phone = PhoneE164Schema.safeParse(process.env.LIVE_PHONE);
const llmConfig = parseLlmConfig(process.env);
if (!phone.success || !llmConfig.ok) {
  out(!phone.success ? "Set LIVE_PHONE to the E.164 number to text, e.g. LIVE_PHONE=+14155550123" : `Model config is missing: ${llmConfig.ok ? "" : describeError(llmConfig.error)}`);
  process.exit(EXIT_FAILURE);
}
const liveName = process.env.LIVE_NAME ?? "Priya";

const SIMULATED = { maya: "+14155550100", dev: "+14155550102", sam: "+14155550103" } as const;
const intake: TripIntake = {
  tripId: `trip-live-${Date.now()}`,
  destination: "San Diego",
  originAirport: "SFO",
  destinationAirport: "SAN",
  utcOffsetMinutes: -420,
  dateWindow: { earliestStart: "2026-10-08", latestEnd: "2026-10-13", tripDays: 3 },
  organizerId: "maya",
  members: [
    { id: "maya", name: "Maya", phone: SIMULATED.maya, email: null },
    { id: "live", name: liveName, phone: phone.data, email: null },
    { id: "dev", name: "Dev", phone: SIMULATED.dev, email: null },
    { id: "sam", name: "Sam", phone: SIMULATED.sam, email: null },
  ],
  defaults: { budgetCeilingCents: 60_000, earliestStart: "09:00" },
};

const [inventory, twilio, calendar] = await Promise.all([startTwin(inventoryTwin), startTwin(twilioTwin), startTwin(googleCalendarTwin)]);
const sms = createTwinControlClient("messaging", twilio.url);
await sms.reset({ clock: new Date().toISOString() });

const trace = createTraceRecorder({ now: () => new Date(), newId: randomUUID });
const agent = createElicitationAgent({
  messaging: createRoutedMessagingClient(
    [{ handles: [phone.data], client: createIMessageClient() }],
    createTwilioMessagingClient({ baseUrl: twilio.url, ...TWIN_TWILIO_CREDENTIALS }),
  ),
  calendar: createGoogleCalendarClient({ baseUrl: calendar.url, calendarId: "primary", accessToken: async () => ok(TWIN_GOOGLE_ACCESS_TOKEN) }),
  inventory: createInventoryClient({ baseUrl: inventory.url }),
  llm: createOpenRouterClient({ apiKey: llmConfig.value.OPENROUTER_API_KEY, model: llmConfig.value.LLM_MODEL }),
  trace,
  logger: createLogger({ sink: (line) => out(`  log ${line.event} ${JSON.stringify(line.fields)}`), now: () => new Date(), minLevel: "warn" }),
  now: () => new Date(),
  sleep: realSleep,
  approvals: createMemoryApprovalStore(),
  executed: createMemoryExecutedStore(),
});

const nameOf = (id: string | null): string => intake.members.find((m) => m.id === id)?.name ?? "unknown";
let printed = 0;
const printOutbound = (session: ElicitationSession): void => {
  for (const m of session.messages.slice(printed)) {
    const via = m.memberId === "live" ? "iMessage" : "twin";
    if (m.direction === "outbound") out(`  → ${nameOf(m.memberId)} [${via}]: ${m.body.replaceAll("\n", "\n    ")}`);
  }
  printed = session.messages.length;
};

async function shutdown(code: number): Promise<never> {
  await Promise.all([inventory.close(), twilio.close(), calendar.close()]);
  process.exit(code);
}

out(`── Starting a trip. ${liveName} (${phone.data}) is real; Maya, Dev and Sam are simulated.`);
const started = await agent.start(intake);
if (!started.ok) {
  out(`Could not start: ${describeError(started.error)}`);
  await shutdown(EXIT_FAILURE);
}
const session = started.ok ? started.value : (undefined as never);
printOutbound(session);
const liveSend = trace.spans(intake.tripId).find((s) => s.name === "send_sms" && s.status === "error");
if (liveSend?.error) out(`  ${liveName}'s text failed: ${describeError(liveSend.error)}`);

await sms.injectEvent({ kind: "inbound_sms", from: SIMULATED.sam, body: "Tuesdays are rough but I'll make it work. Budget maybe 500?" });
await sms.injectEvent({ kind: "inbound_sms", from: SIMULATED.maya, body: "Anything in that window works for me. Max $900 all in." });

out();
out(`── Waiting up to 10 minutes for ${liveName} to reply on their phone`);
const deadline = Date.now() + WAIT_FOR_REPLY_MS;
let liveAnswered = false;
while (Date.now() < deadline) {
  const report = await agent.tick(session);
  if (!report.ok) {
    out(`  poll failed: ${describeError(report.error)}`);
    await shutdown(EXIT_FAILURE);
  }
  if (!report.ok) break;
  for (const outcome of report.value.inbound) {
    if (outcome.kind !== "extracted") {
      out(`  ${outcome.kind === "unknown_sender" ? outcome.from : nameOf(outcome.memberId)}: ${outcome.kind}`);
      continue;
    }
    const member = session.trip.members.find((m) => m.id === outcome.memberId);
    const said = session.messages.filter((m) => m.memberId === outcome.memberId && m.direction === "inbound").at(-1)?.body ?? "";
    out(`  ← ${nameOf(outcome.memberId)}: ${said}`);
    for (const c of outcome.accepted.constraints) out(`    + ${c.hardness.padEnd(4)} ${describeConstraint(c)}`);
    for (const id of outcome.accepted.retractedIds) out(`    - retracted ${id}`);
    for (const d of outcome.accepted.dropped) out(`    x dropped ${d.kind}: ${d.reason}`);
    out(`    now ${member?.responseState}`);
    if (outcome.memberId === "live") liveAnswered = true;
  }
  printOutbound(session);
  if (report.value.inbound.length > 0) out(`  status: ${report.value.summary}`);
  if (liveAnswered) break;
  await realSleep(POLL_INTERVAL_MS);
}
if (!liveAnswered) out(`  No reply from ${liveName} within 10 minutes.`);

out();
out("── Trace");
for (const span of trace.spans(intake.tripId)) {
  const cost = span.llmCalls.reduce((sum, c) => sum + c.costUsd, 0);
  out(`  ${span.step.padEnd(9)} ${span.name.padEnd(20)} ${span.status.padEnd(5)} ${String(span.latencyMs).padStart(6)}ms${span.llmCalls.length > 0 ? ` $${cost.toFixed(4)}` : ""}${span.error ? `  ${describeError(span.error)}` : ""}`);
}
await shutdown(0);
