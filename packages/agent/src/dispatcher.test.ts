import { beforeEach, describe, expect, it } from "vitest";
import { createTraceRecorder, err, ok, type AgentAction, type ApprovalToken, type Member, type Result, type JsonValue } from "@trip/core";
import { createDispatcher, createMemoryApprovalStore, createMemoryExecutedStore, type ApprovalStore, type Dispatcher, type ExecutedActionStore } from "./dispatcher";

const NOW = new Date("2026-10-01T17:00:00.000Z");
const LATER = "2026-10-20T00:00:00.000Z";

const person = (id: string, optedOut = false): Member => ({ id, name: id, phone: "+14155550100", email: null, optedOut, responseState: "asked", constraints: [], ledgerEntries: [] });
const members = [person("maya"), person("dev"), person("ana", true)];

const sms = (memberId: string, key = `sms-${memberId}`): AgentAction => ({ id: key, idempotencyKey: key, requestedAt: NOW.toISOString(), reason: "test", kind: "send_sms", params: { memberId, body: "hi" } });
const booking = (key = "book-1", id = "book-1"): AgentAction => ({ id, idempotencyKey: key, requestedAt: NOW.toISOString(), reason: "test", kind: "book_flight", params: { flightId: "TW143-2026-10-09", memberIds: ["dev"] } });
const move = (): AgentAction => ({ id: "move-1", idempotencyKey: "move-key-1", requestedAt: NOW.toISOString(), reason: "test", kind: "modify_reservation", params: { bookingRef: "RS1", newAt: LATER, guestIds: null } });

const token = (overrides: Partial<ApprovalToken>): ApprovalToken => ({
  id: "tok",
  tripId: "trip-1",
  grantedBy: "maya",
  grantedAt: NOW.toISOString(),
  expiresAt: LATER,
  scope: { kind: "standing", actionKinds: ["send_sms"], memberIds: ["maya", "dev", "ana"] },
  usedAt: null,
  ...overrides,
});

let approvals: ApprovalStore;
let executed: ExecutedActionStore;
let calls: string[];
let nextResult: Result<JsonValue>;
let dispatcher: Dispatcher;
const trace = createTraceRecorder({ now: () => NOW, newId: () => crypto.randomUUID() });
const run = (action: AgentAction, approvalTokenId: string | null) => dispatcher.execute(action, { traceId: "trip-1", step: "book", approvalTokenId });

beforeEach(() => {
  approvals = createMemoryApprovalStore();
  executed = createMemoryExecutedStore();
  calls = [];
  nextResult = ok({ done: true });
  const handler = async (action: AgentAction) => {
    calls.push(action.idempotencyKey);
    return nextResult;
  };
  dispatcher = createDispatcher({
    handlers: { send_sms: handler, book_flight: handler, modify_reservation: handler },
    approvals,
    executed,
    members: () => members,
    organizerId: "maya",
    trace,
    now: () => NOW,
  });
});

describe("the confirmation gate", () => {
  it("refuses an irreversible booking with no approval and never calls the provider", async () => {
    expect(await run(booking(), null)).toEqual({
      ok: false,
      error: { kind: "approval_rejected", actionId: "book-1", actionKind: "book_flight", tokenId: null, reason: "missing" },
    });
    expect(calls).toEqual([]);
    expect(trace.spans("trip-1").at(-1)).toMatchObject({ name: "book_flight", status: "error", error: { reason: "missing" } });
  });

  it("runs a reversible action without any token", async () => {
    expect((await run(move(), null)).ok).toBe(true);
  });

  it("a standing messaging approval covers texts but not bookings", async () => {
    approvals.put(token({}));
    expect((await run(sms("dev"), "tok")).ok).toBe(true);
    expect(await run(booking(), "tok")).toMatchObject({ ok: false, error: { reason: "scope_mismatch" } });
  });

  it("rejects unknown, expired, non-organizer and reused single-use tokens", async () => {
    expect(await run(booking(), "nope")).toMatchObject({ ok: false, error: { reason: "unknown_token" } });
    approvals.put(token({ id: "old", expiresAt: "2026-10-01T16:00:00.000Z", grantedAt: "2026-10-01T15:00:00.000Z" }));
    expect(await run(sms("dev"), "old")).toMatchObject({ ok: false, error: { reason: "expired" } });
    approvals.put(token({ id: "dev-grant", grantedBy: "dev" }));
    expect(await run(sms("dev"), "dev-grant")).toMatchObject({ ok: false, error: { reason: "not_organizer" } });

    approvals.put(token({ id: "once", scope: { kind: "action", actionId: "book-1" } }));
    expect((await run(booking("key-a"), "once")).ok).toBe(true);
    expect(await run(booking("key-b"), "once")).toMatchObject({ ok: false, error: { reason: "already_used" } });
    expect(calls).toEqual(["key-a"]);
  });

  it("never contacts an opted-out member, approval or not", async () => {
    approvals.put(token({}));
    expect(await run(sms("ana"), "tok")).toEqual({ ok: false, error: { kind: "member_opted_out", memberId: "ana" } });
    expect(calls).toEqual([]);
  });
});

describe("idempotency", () => {
  beforeEach(() => approvals.put(token({})));

  it("replays a completed action instead of sending it again", async () => {
    await run(sms("dev"), "tok");
    expect(await run(sms("dev"), "tok")).toEqual({ ok: true, value: { done: true } });
    expect(calls).toEqual(["sms-dev"]);
  });

  it("will not resend a text whose outcome is unknown after a timeout", async () => {
    nextResult = err({ kind: "timeout", service: "messaging", afterMs: 8000, retrySafe: false });
    await run(sms("dev"), "tok");
    nextResult = ok({ done: true });
    expect(await run(sms("dev"), "tok")).toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
    expect(calls).toEqual(["sms-dev"]);
  });

  it("allows a retry after a failure that certainly did not send", async () => {
    nextResult = err({ kind: "upstream_failed", service: "messaging", status: 503, detail: "down" });
    await run(sms("dev"), "tok");
    nextResult = ok({ done: true });
    expect((await run(sms("dev"), "tok")).ok).toBe(true);
    expect(calls).toEqual(["sms-dev", "sms-dev"]);
  });
});
