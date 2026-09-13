import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeFeasibleOptions, createLogger, createTraceRecorder, describeError, ok, type Result } from "@trip/core";
import { createGoogleCalendarClient, createInventoryClient, createScriptedLlmClient, createTwilioMessagingClient, type CalendarClient, type InventoryClient } from "@trip/clients";
import { TWIN_GOOGLE_ACCESS_TOKEN, TWIN_TWILIO_CREDENTIALS } from "@trip/clients/contracts";
import { googleCalendarTwin, inventoryTwin, startTwin, twilioTwin } from "@trip/twins";
import { createMemoryApprovalStore, createMemoryExecutedStore } from "../dispatcher";
import { createElicitationAgent, type AgentDeps } from "../elicitation/agent";
import type { ElicitationSession, TripIntake } from "../elicitation/session";
import { createBookingAgent, type BookingAgent, type Proposal } from "./agent";
import type { ActivityRequest } from "./selection";

const NOW = new Date("2026-10-01T16:00:00.000Z");
const intake: TripIntake = {
  tripId: "trip-sd",
  destination: "San Diego",
  originAirport: "SFO",
  destinationAirport: "SAN",
  utcOffsetMinutes: -420,
  dateWindow: { earliestStart: "2026-10-08", latestEnd: "2026-10-13", tripDays: 3 },
  organizerId: "maya",
  members: [
    { id: "maya", name: "Maya", phone: "+14155550100", email: null },
    { id: "priya", name: "Priya", phone: "+14155550101", email: "priya@example.com" },
    { id: "dev", name: "Dev", phone: "+14155550102", email: null },
    { id: "sam", name: "Sam", phone: "+14155550103", email: null },
  ],
  defaults: { budgetCeilingCents: 60_000, earliestStart: "09:00" },
};
const ACTIVITIES: ActivityRequest[] = [
  { venueId: "tidewater", activity: "dinner", dayOffset: 0, localTime: "19:00", durationMinutes: 90 },
  { venueId: "beach-club", activity: "beach", dayOffset: 1, localTime: "10:30", durationMinutes: 120 },
];

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(describeError(result.error));
  return result.value;
};

let closeTwins: () => Promise<void>;
let deps: AgentDeps;
let inventory: InventoryClient;
let calendar: CalendarClient;
let session: ElicitationSession;
let booking: BookingAgent;

beforeEach(async () => {
  const [inv, sms, cal] = await Promise.all([startTwin(inventoryTwin), startTwin(twilioTwin), startTwin(googleCalendarTwin)]);
  closeTwins = async () => void (await Promise.all([inv.close(), sms.close(), cal.close()]));
  inventory = createInventoryClient({ baseUrl: inv.url });
  calendar = createGoogleCalendarClient({ baseUrl: cal.url, calendarId: "primary", accessToken: async () => ok(TWIN_GOOGLE_ACCESS_TOKEN) });
  deps = {
    messaging: createTwilioMessagingClient({ baseUrl: sms.url, ...TWIN_TWILIO_CREDENTIALS }),
    calendar,
    inventory,
    llm: createScriptedLlmClient(() => "{}"),
    trace: createTraceRecorder({ now: () => NOW, newId: () => crypto.randomUUID() }),
    logger: createLogger({ sink: () => undefined, now: () => NOW, minLevel: "error" }),
    now: () => NOW,
    sleep: async () => undefined,
    approvals: createMemoryApprovalStore(),
    executed: createMemoryExecutedStore(),
  };
  session = unwrap(await createElicitationAgent(deps).start(intake));
  // Skip the conversation: everyone has answered and nobody has constraints.
  for (const member of session.trip.members) member.responseState = "complete";
  session.trip.candidateOptions = computeFeasibleOptions(session.trip.members, intake.dateWindow, (start) => session.pricing[start] ?? null);
  booking = createBookingAgent(deps);
});

afterEach(async () => {
  await closeTwins();
});

const propose = async (): Promise<Proposal> => unwrap(await booking.propose(session, ACTIVITIES));

describe("the confirmation gate", () => {
  it("refuses to book a plan the organizer has not approved, and nothing reaches the inventory", async () => {
    const proposal = await propose();
    const report = await booking.book(session, proposal, {}, []);

    expect(report.failure).toMatchObject({ kind: "book_flight", error: { kind: "approval_rejected", reason: "missing" } });
    expect(report.completed).toEqual([]);
    expect(unwrap(await inventory.listFlightBookings())).toEqual([]);
    expect(unwrap(await inventory.listHotelBookings())).toEqual([]);
    expect(session.trip.status).toBe("awaiting_confirmation");
  });

  it("does not accept an approval from anyone but the organizer", async () => {
    const proposal = await propose();
    const report = await booking.book(session, proposal, booking.approve(session, proposal, "dev"), []);
    expect(report.failure).toMatchObject({ error: { kind: "approval_rejected", reason: "not_organizer" } });
    expect(unwrap(await inventory.listFlightBookings())).toEqual([]);
  });

  it("an approval for one version of the plan cannot book the next version", async () => {
    const first = await propose();
    const approvedFirst = booking.approve(session, first, "maya");
    const second = await propose();
    expect(second.plan.version).toBe(2);

    // Hand version 2's actions the tokens granted for version 1, one for one.
    const reused = Object.fromEntries(
      second.actions.flatMap(({ action }, index) => {
        const token = approvedFirst[first.actions[index]?.action.id ?? ""];
        return token === undefined ? [] : [[action.id, token]];
      }),
    );
    const report = await booking.book(session, second, reused, []);
    expect(report.failure).toMatchObject({ error: { kind: "approval_rejected", reason: "scope_mismatch" } });
    expect(unwrap(await inventory.listFlightBookings())).toEqual([]);
  });
});

describe("booking an approved plan", () => {
  it("books in dependency order, swaps holds for calendar events and texts everyone their share", async () => {
    const holds = await booking.placeHolds(session);
    expect(holds).toHaveLength(3);
    const proposal = await propose();
    expect(proposal.summary).toMatch(/^San Diego, Oct 8–10, 4 people: out on Flight TW\d+ at .+ About \$\d+ a person\. Nothing is booked until you approve\.$/);

    const report = await booking.book(session, proposal, booking.approve(session, proposal, "maya"), holds);

    expect(report.failure).toBeNull();
    expect(report.completed.map((c) => `${c.kind}:${c.planItemId}`).slice(0, 5)).toEqual([
      "book_flight:outbound",
      "book_hotel:hotel",
      "book_reservation:venue-1-tidewater",
      "book_reservation:venue-2-beach-club",
      "book_flight:return",
    ]);
    expect(report.completed.slice(5, -1).every((c) => c.kind === "write_calendar_event")).toBe(true);
    expect(report.completed.at(-1)?.kind).toBe("record_expenses");
    expect(report.plan.items.every((i) => i.bookingRef !== null)).toBe(true);
    expect(session.trip.status).toBe("booked");

    const outbound = report.plan.items.find((i) => i.id === "outbound");
    expect(unwrap(await inventory.getFlight(outbound?.inventoryId ?? ""))).toMatchObject({ seatsAvailable: 8 });

    const events = unwrap(await calendar.listTripEvents({ tripId: session.trip.id, from: "2026-10-07T00:00:00Z", to: "2026-10-15T00:00:00Z" })).filter((e) => e.status !== "cancelled");
    expect(events).toHaveLength(report.plan.items.length);
    expect(events.every((e) => e.blocksTime)).toBe(true);

    expect(report.confirmationsSent).toBe(4);
    const toPriya = session.messages.filter((m) => m.memberId === "priya" && m.direction === "outbound").at(-1)?.body;
    expect(toPriya).toMatch(/^Booked for San Diego\. Flight TW\d+ out Oct 8 at .+, Ocean Beach Guesthouse, Flight TW\d+ home Oct 10 at .+\. Your share is \$\d+\. It's on your calendar\.$/);
  });

  it("a retry after losing every local record books nothing twice", async () => {
    const proposal = await propose();
    const first = await booking.book(session, proposal, booking.approve(session, proposal, "maya"), []);
    expect(first.failure).toBeNull();
    const chargesAfterFirst = unwrap(await inventory.listCharges());

    // The agent restarts with empty executed-action and approval stores, and the organizer approves again.
    const restarted = createBookingAgent({ ...deps, executed: createMemoryExecutedStore(), approvals: createMemoryApprovalStore() });
    const second = await restarted.book(session, proposal, restarted.approve(session, proposal, "maya"), []);

    expect(second.failure).toBeNull();
    expect(second.plan.items.map((i) => i.bookingRef)).toEqual(first.plan.items.map((i) => i.bookingRef));
    expect(unwrap(await inventory.listFlightBookings())).toHaveLength(2);
    expect(unwrap(await inventory.listHotelBookings())).toHaveLength(1);
    expect(unwrap(await inventory.listReservations())).toHaveLength(2);
    expect(unwrap(await inventory.listCharges())).toEqual(chargesAfterFirst);
  });
});
