import { describe, expect, it } from "vitest";
import { AppFailure } from "./errors";
import { TraceSpanSchema, createLogger, createTraceRecorder, type LogLine } from "./observability";

function fakeClock(startMs: number) {
  let nowMs = startMs;
  return { now: () => new Date(nowMs), advance: (ms: number) => void (nowMs += ms) };
}

function sequentialIds() {
  let n = 0;
  return () => `span-${++n}`;
}

describe("createTraceRecorder", () => {
  it("records latency, retries and a schema-valid span", () => {
    const clock = fakeClock(Date.parse("2026-10-09T10:00:00Z"));
    const persisted: unknown[] = [];
    const recorder = createTraceRecorder({ now: clock.now, newId: sequentialIds(), onSpan: (s) => persisted.push(s) });

    const span = recorder.start({ traceId: "trace-1", step: "book", name: "book_flight", input: { flight: "UA12" }, idempotencyKey: "book-ua12-t1" });
    clock.advance(120);
    span.recordRetry("rate_limited");
    clock.advance(300);
    const done = span.succeed({ bookingRef: "PNR123" });

    expect(done.latencyMs).toBe(420);
    expect(done.retries).toEqual([{ at: "2026-10-09T10:00:00.120Z", reason: "rate_limited" }]);
    expect(TraceSpanSchema.safeParse(done).success).toBe(true);
    expect(persisted).toEqual([done]);
    expect(recorder.spans("trace-1")).toEqual([done]);
    expect(recorder.spans("trace-2")).toEqual([]);
  });

  it("refuses to close a span twice", () => {
    const recorder = createTraceRecorder({ now: () => new Date(0), newId: sequentialIds() });
    const span = recorder.start({ traceId: "t", step: "detect", name: "detect", input: null });
    span.fail({ kind: "internal", detail: "boom" });
    expect(() => span.succeed(null)).toThrow(AppFailure);
  });
});

describe("createLogger", () => {
  it("drops lines below the minimum level and merges child bindings", () => {
    const lines: LogLine[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), now: () => new Date(0), minLevel: "info" });
    const child = logger.child({ tripId: "t1" });

    child.debug("chase.skipped");
    child.info("chase.sent", { memberId: "m2" });

    expect(lines).toEqual([{ level: "info", event: "chase.sent", at: "1970-01-01T00:00:00.000Z", fields: { tripId: "t1", memberId: "m2" } }]);
  });
});
