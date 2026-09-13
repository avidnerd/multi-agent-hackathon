import { describe, expect, it } from "vitest";
import { parseClientConfig } from "./config";

describe("parseClientConfig", () => {
  it("defaults every people-layer app to its twin", () => {
    const config = parseClientConfig({});
    expect(config).toMatchObject({
      ok: true,
      value: { messaging: { MESSAGING_MODE: "twin" }, calendar: { CALENDAR_MODE: "twin" }, inventory: { TWIN_INVENTORY_URL: "http://127.0.0.1:4100" } },
    });
  });

  it("names every missing credential when a real mode is chosen", () => {
    const config = parseClientConfig({ MESSAGING_MODE: "twilio", TWILIO_ACCOUNT_SID: "", CALENDAR_MODE: "google" });
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.error.kind).toBe("validation_failed");
    const text = JSON.stringify(config.error);
    for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "GOOGLE_CLIENT_ID", "GOOGLE_REFRESH_TOKEN"]) {
      expect(text).toContain(key);
    }
  });
});
