import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTwilioMessagingClient, createTwinControlClient, type MessagingClient, type TwinControlClient } from "@trip/clients";
import { TWIN_TWILIO_CREDENTIALS } from "@trip/clients/contracts";
import { startTwin, type RunningTwin } from "../kit/twin-app";
import { unwrap } from "../testing";
import { twilioTwin, type TwilioState } from "./twin";

const PRIYA = "+14155550101";
const SINCE = new Date("2026-10-01T00:00:00Z");

let twin: RunningTwin<TwilioState>;
let sms: MessagingClient;
let control: TwinControlClient;

beforeEach(async () => {
  twin = await startTwin(twilioTwin);
  sms = createTwilioMessagingClient({ baseUrl: twin.url, ...TWIN_TWILIO_CREDENTIALS });
  control = createTwinControlClient("messaging", twin.url);
});

afterEach(async () => {
  await twin.close();
});

describe("twilio twin", () => {
  it("records a sent message and lists a member's reply as inbound", async () => {
    const sent = unwrap(await sms.send({ to: PRIYA, body: "Which weekend works, the 9th or the 16th?" }));
    expect(sent.externalId).toMatch(/^SM[0-9a-f]{32}$/);
    expect(unwrap(await sms.listInbound(SINCE))).toEqual([]);

    unwrap(await control.injectEvent({ kind: "inbound_sms", from: PRIYA, body: "9th works, not the 16th" }));
    const inbound = unwrap(await sms.listInbound(SINCE));
    expect(inbound).toMatchObject([{ from: PRIYA, body: "9th works, not the 16th" }]);
  });

  it("keeps a reply stamped in the same whole second the session started", async () => {
    unwrap(await control.reset({ clock: "2026-10-01T16:00:00.400Z" }));
    unwrap(await control.injectEvent({ kind: "inbound_sms", from: PRIYA, body: "under 500 works" }));
    // Twilio's date_sent reads 16:00:00, before a session that started at 16:00:00.300.
    expect(unwrap(await sms.listInbound(new Date("2026-10-01T16:00:00.300Z")))).toMatchObject([{ body: "under 500 works" }]);
  });

  it("blocks sends after STOP with Twilio's 21610 and allows them again after START", async () => {
    unwrap(await control.injectEvent({ kind: "inbound_sms", from: PRIYA, body: "stop" }));
    expect(await sms.send({ to: PRIYA, body: "Still around?" })).toMatchObject({ ok: false, error: { kind: "conflict", code: "21610" } });

    unwrap(await control.injectEvent({ kind: "inbound_sms", from: PRIYA, body: "START" }));
    expect((await sms.send({ to: PRIYA, body: "Welcome back" })).ok).toBe(true);
  });

  it("rejects bad credentials and invalid numbers with Twilio's codes", async () => {
    const wrongToken = createTwilioMessagingClient({ baseUrl: twin.url, ...TWIN_TWILIO_CREDENTIALS, authToken: "nope" });
    expect(await wrongToken.send({ to: PRIYA, body: "hi" })).toMatchObject({ ok: false, error: { kind: "upstream_failed", status: 401 } });
    expect(await sms.send({ to: "555-0101", body: "hi" })).toMatchObject({ ok: false, error: { status: 400, detail: expect.stringContaining("21211") } });
  });

  it("stale_read hides a message that has not reached the list yet", async () => {
    unwrap(await control.injectEvent({ kind: "inbound_sms", from: PRIYA, body: "Thursday is fine" }));
    unwrap(await control.armFault({ kind: "stale_read" }));
    expect(unwrap(await sms.listInbound(SINCE))).toEqual([]);
    expect(unwrap(await sms.listInbound(SINCE))).toHaveLength(1);
  });

  it("refuses faults Twilio could not produce", async () => {
    expect(await control.armFault({ kind: "partial_batch", failIndices: [0] })).toMatchObject({ ok: false, error: { status: 400 } });
  });
});
