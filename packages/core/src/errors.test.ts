import { describe, expect, it } from "vitest";
import { AppFailure, isRetryable, type AppError } from "./errors";

describe("isRetryable", () => {
  const cases: ReadonlyArray<[string, AppError, boolean]> = [
    ["rate limit", { kind: "rate_limited", service: "messaging", retryAfterMs: 1000 }, true],
    ["5xx", { kind: "upstream_failed", service: "inventory", status: 503, detail: "unavailable" }, true],
    ["4xx", { kind: "upstream_failed", service: "inventory", status: 400, detail: "bad request" }, false],
    ["connection reset", { kind: "upstream_failed", service: "calendar", status: null, detail: "ECONNRESET" }, true],
    ["timed-out write with idempotency key", { kind: "timeout", service: "inventory", afterMs: 5000, retrySafe: true }, true],
    ["timed-out write without idempotency key", { kind: "timeout", service: "inventory", afterMs: 5000, retrySafe: false }, false],
    ["malformed model output", { kind: "validation_failed", boundary: "llm_output", issues: ["missing kind"] }, true],
    ["empty 200 body", { kind: "validation_failed", boundary: "api_response", issues: ["empty body"] }, true],
    ["malformed webhook", { kind: "validation_failed", boundary: "webhook", issues: ["bad signature"] }, false],
    ["bad config", { kind: "validation_failed", boundary: "config", issues: ["TWILIO_FROM_NUMBER missing"] }, false],
    [
      "sold out",
      { kind: "conflict", service: "inventory", resource: "flight TW143", code: "insufficient_seats", detail: "2 seats left" },
      false,
    ],
    [
      "missing approval",
      { kind: "approval_rejected", actionId: "a1", actionKind: "book_flight", tokenId: null, reason: "missing" },
      false,
    ],
  ];

  it.each(cases)("%s", (_label, error, expected) => {
    expect(isRetryable(error)).toBe(expected);
  });
});

describe("AppFailure", () => {
  it("carries the typed error and a readable message", () => {
    const failure = new AppFailure({ kind: "approval_rejected", actionId: "a1", actionKind: "book_flight", tokenId: null, reason: "missing" });
    expect(failure.error.kind).toBe("approval_rejected");
    expect(failure.message).toBe("book_flight is irreversible and has no approval");
  });
});
