import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, createTraceRecorder } from "@trip/core";
import {
  createGoogleCalendarClient,
  createInventoryClient,
  createScriptedLlmClient,
  createTwilioMessagingClient,
  createTwinControlClient,
  type LlmRequest,
  type TwinControlClient,
} from "@trip/clients";
import { TWIN_GOOGLE_ACCESS_TOKEN, TWIN_TWILIO_CREDENTIALS } from "@trip/clients/contracts";
import { googleCalendarTwin, inventoryTwin, startTwin, twilioTwin, type RunningTwin } from "@trip/twins";
import { ok } from "@trip/core";
import { createMemoryApprovalStore, createMemoryExecutedStore } from "../dispatcher";
import { createElicitationAgent, type ElicitationAgent } from "./agent";
import type { ElicitationSession, TripIntake } from "./session";

const PHONES = { maya: "+14155550100", priya: "+14155550101", dev: "+14155550102", sam: "+14155550103" } as const;

const intake: TripIntake = {
  tripId: "trip-sd",
  destination: "San Diego",
  originAirport: "SFO",
  destinationAirport: "SAN",
  utcOffsetMinutes: -420,
  dateWindow: { earliestStart: "2026-10-08", latestEnd: "2026-10-13", tripDays: 3 },
  organizerId: "maya",
  members: [
    { id: "maya", name: "Maya", phone: PHONES.maya, email: null },
    { id: "priya", name: "Priya", phone: PHONES.priya, email: "priya@example.com" },
    { id: "dev", name: "Dev", phone: PHONES.dev, email: null },
    { id: "sam", name: "Sam", phone: PHONES.sam, email: null },
  ],
  defaults: { budgetCeilingCents: 60_000, earliestStart: "09:00" },
};

/** When set, the scripted model returns output that never parses, like a provider that is down or out of credit. */
let modelDown = false;

/** Stands in for the model with the extraction a correct model would return for each scripted reply. */
function scriptedExtraction(request: LlmRequest): string {
  if (modelDown) return "Service unavailable";
  const prompt = request.messages[1]?.content ?? "";
  const reply = (constraints: unknown[], answered: { dates: boolean; budget: boolean; schedule: boolean }) => JSON.stringify({ constraints, answered, optOut: false });
  if (prompt.includes("9th-11th")) {
    return reply(
      [
        { kind: "available_only", hardness: "hard", evidence: "the 9th-11th", replacesConstraintId: null, dates: ["2026-10-09", "2026-10-10", "2026-10-11"] },
        { kind: "budget_ceiling", hardness: "hard", evidence: "under $700", replacesConstraintId: null, amountCents: 70_000, scope: "trip_total" },
      ],
      { dates: true, budget: true, schedule: false },
    );
  }
  if (prompt.includes("Tuesdays")) {
    return reply(
      [
        { kind: "date_exclusion", hardness: "soft", evidence: "Tuesdays are rough", replacesConstraintId: null, dates: ["2026-10-13"] },
        { kind: "budget_ceiling", hardness: "soft", evidence: "maybe 500", replacesConstraintId: null, amountCents: 50_000, scope: "trip_total" },
      ],
      { dates: true, budget: true, schedule: false },
    );
  }
  if (prompt.includes("Anything works")) {
    return reply([{ kind: "budget_ceiling", hardness: "hard", evidence: "Max $900", replacesConstraintId: null, amountCents: 90_000, scope: "trip_total" }], { dates: true, budget: true, schedule: false });
  }
  return reply([], { dates: false, budget: false, schedule: false });
}

let twins: { inventory: RunningTwin<unknown>; twilio: RunningTwin<unknown>; calendar: RunningTwin<unknown> };
let sms: TwinControlClient;
let clock: Date;
let agent: ElicitationAgent;
let session: ElicitationSession;

async function advanceHours(hours: number): Promise<void> {
  clock = new Date(clock.getTime() + hours * 3_600_000);
  await sms.setClock(clock.toISOString());
}

const reply = (from: string, body: string) => sms.injectEvent({ kind: "inbound_sms", from, body });

beforeEach(async () => {
  modelDown = false;
  const [inventory, twilio, calendar] = await Promise.all([startTwin(inventoryTwin), startTwin(twilioTwin), startTwin(googleCalendarTwin)]);
  twins = { inventory, twilio, calendar };
  sms = createTwinControlClient("messaging", twilio.url);
  await createTwinControlClient("calendar", calendar.url).injectEvent({ kind: "member_calendar_shared", email: "priya@example.com", busy: [{ start: "2026-10-12T15:00:00Z", end: "2026-10-13T05:00:00Z" }] });
  clock = new Date("2026-10-01T16:00:00.000Z");

  agent = createElicitationAgent({
    messaging: createTwilioMessagingClient({ baseUrl: twilio.url, ...TWIN_TWILIO_CREDENTIALS }),
    calendar: createGoogleCalendarClient({ baseUrl: calendar.url, calendarId: "primary", accessToken: async () => ok(TWIN_GOOGLE_ACCESS_TOKEN) }),
    inventory: createInventoryClient({ baseUrl: inventory.url }),
    llm: createScriptedLlmClient(scriptedExtraction),
    trace: createTraceRecorder({ now: () => new Date(), newId: () => crypto.randomUUID() }),
    logger: createLogger({ sink: () => undefined, now: () => clock, minLevel: "error" }),
    now: () => clock,
    sleep: async () => undefined,
    approvals: createMemoryApprovalStore(),
    // Fresh per test: a shared store would replay the previous test's texts instead of sending them.
    executed: createMemoryExecutedStore(),
  });
  const started = await agent.start(intake);
  if (!started.ok) throw new Error(`start failed: ${started.error.kind}`);
  session = started.value;
});

afterEach(async () => {
  await Promise.all([twins.inventory.close(), twins.twilio.close(), twins.calendar.close()]);
});

const outboundTo = (memberId: string) => session.messages.filter((m) => m.direction === "outbound" && m.memberId === memberId).map((m) => m.body);

describe("elicitation loop against the twins", () => {
  it("texts everyone the opening questions and folds in Priya's shared calendar", () => {
    expect(session.messages.filter((m) => m.direction === "outbound")).toHaveLength(4);
    expect(outboundTo("priya")[0]).toContain("Your calendar looks busy on Oct 12. Is that a hard no?");
    expect(outboundTo("dev")[0]).toContain("Hi Dev, I'm helping Maya plan San Diego.");
    expect(session.trip.members.every((m) => m.responseState === "asked")).toBe(true);
  });

  it("turns replies into constraints and names who it is waiting on", async () => {
    await advanceHours(1);
    await reply(PHONES.priya, "ooh the 9th-11th is perfect, keep it under $700 if we can");
    await reply(PHONES.sam, "Tuesdays are rough but whatever. maybe 500?");
    await reply(PHONES.maya, "Anything works for me. Max $900.");
    const report = await agent.tick(session);
    if (!report.ok) throw new Error(report.error.kind);

    expect(report.value.inbound.map((o) => o.kind)).toEqual(["extracted", "extracted", "extracted"]);
    const priya = session.trip.members.find((m) => m.id === "priya");
    expect(priya?.responseState).toBe("complete");
    expect(priya?.constraints.map((c) => c.id)).toEqual(["cal-priya-2026-10-12", "in-SM00000000000000000000000000000005-c1", "in-SM00000000000000000000000000000005-c2"]);
    expect(report.value.summary).toBe("3 of 4 replied. Oct 9–11 is the front runner. Waiting on Dev.");
    // Dev is silent, so the chase schedule owns him, not an unblocking text.
    expect(report.value.questionSent).toBe(false);
  });

  it("chases the silent member with escalating tone, then applies a public default and moves on", async () => {
    await advanceHours(1);
    await reply(PHONES.priya, "ooh the 9th-11th is perfect, keep it under $700 if we can");
    await reply(PHONES.sam, "Tuesdays are rough but whatever. maybe 500?");
    await reply(PHONES.maya, "Anything works for me. Max $900.");
    await agent.tick(session);

    const tiers: number[] = [];
    for (const hours of [4, 20, 24, 24]) {
      await advanceHours(hours);
      const tick = await agent.tick(session);
      if (!tick.ok) throw new Error(tick.error.kind);
      tiers.push(...tick.value.chases.map((c) => c.tier));
      if (tick.value.defaultsAnnounced.length > 0) {
        expect(tick.value.defaultsAnnounced[0]).toBe(
          "I haven't heard from Dev, so I'm assuming any date in the window works and a budget of $600 per person. Dev can text me anytime to change that.",
        );
        expect(outboundTo("dev").at(-1)).toBe("I haven't heard back from you, so I'm assuming any date in the window works and a budget of $600 per person. Text me anytime to change that.");
        expect(tick.value.summary).toBe("3 of 4 replied. I can lock Oct 9–11 if Sam confirms.");
        expect(tick.value.questionSent).toBe(true);
      }
    }
    expect(tiers).toEqual([1, 2, 3]);
    expect(session.trip.members.find((m) => m.id === "dev")?.responseState).toBe("ghosted");
    expect(outboundTo("sam").at(-1)).toBe('Hey Sam, you mentioned "maybe 500". Is that a dealbreaker for Oct 9–11?');
  });

  it("does not count a reply the model could not read, and reads it once the model is back", async () => {
    await advanceHours(1);
    await reply(PHONES.maya, "Anything works for me. Max $900.");
    modelDown = true;
    const failed = await agent.tick(session);
    if (!failed.ok) throw new Error(failed.error.kind);
    expect(failed.value.inbound.map((o) => o.kind)).toEqual(["extraction_failed"]);
    expect(session.trip.members.find((m) => m.id === "maya")?.responseState).toBe("asked");
    expect(failed.value.summary).toMatch(/^0 of 4 replied\./);

    modelDown = false;
    const retried = await agent.tick(session);
    if (!retried.ok) throw new Error(retried.error.kind);
    expect(retried.value.inbound.map((o) => o.kind)).toEqual(["extracted"]);
    expect(session.trip.members.find((m) => m.id === "maya")?.responseState).toBe("complete");
    expect(session.messages.filter((m) => m.direction === "inbound")).toHaveLength(1);
  });

  it("honours STOP immediately and never texts that member again", async () => {
    await advanceHours(1);
    await reply(PHONES.dev, "STOP");
    await agent.tick(session);
    expect(session.trip.members.find((m) => m.id === "dev")?.optedOut).toBe(true);
    const before = outboundTo("dev").length;
    await advanceHours(100);
    await agent.tick(session);
    expect(outboundTo("dev")).toHaveLength(before);
  });
});
