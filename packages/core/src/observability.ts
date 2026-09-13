import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./domain";
import { AppErrorSchema, AppFailure, LLM_CALLS, type AppError } from "./errors";

export const JsonSchema = z.json();
export type JsonValue = z.infer<typeof JsonSchema>;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Readonly<Record<string, JsonValue>>;

export interface LogLine {
  readonly level: LogLevel;
  readonly event: string;
  readonly at: string;
  readonly fields: LogFields;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Where lines go. Core never touches stdout itself; the host process supplies the sink. */
  readonly sink: (line: LogLine) => void;
  readonly now: () => Date;
  readonly minLevel: LogLevel;
  readonly bindings?: LogFields;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LOG_LEVELS.indexOf(options.minLevel);
  const bindings = options.bindings ?? {};
  const emitAt =
    (level: LogLevel) =>
    (event: string, fields: LogFields = {}): void => {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      options.sink({ level, event, at: options.now().toISOString(), fields: { ...bindings, ...fields } });
    };
  return {
    debug: emitAt("debug"),
    info: emitAt("info"),
    warn: emitAt("warn"),
    error: emitAt("error"),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export const AGENT_STEPS = [
  "intake",
  "elicit",
  "chase",
  "converge",
  "plan",
  "confirm",
  "book",
  "market_gen",
  "read_prices",
  "monitor",
  "detect",
  "repair",
  "notify",
  "resolve",
  "regenerate",
] as const;
export const AgentStepSchema = z.enum(AGENT_STEPS);
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const LlmCallRecordSchema = z.object({
  call: z.enum(LLM_CALLS),
  model: z.string(),
  prompt: z.string(),
  response: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
});
export type LlmCallRecord = z.infer<typeof LlmCallRecordSchema>;

export const TraceSpanSchema = z.object({
  id: IdSchema,
  traceId: IdSchema,
  parentId: IdSchema.nullable(),
  step: AgentStepSchema,
  name: z.string().min(1),
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema,
  latencyMs: z.number().nonnegative(),
  status: z.enum(["ok", "error"]),
  input: JsonSchema,
  output: JsonSchema.nullable(),
  error: AppErrorSchema.nullable(),
  retries: z.array(z.object({ at: IsoDateTimeSchema, reason: z.string() })),
  llmCalls: z.array(LlmCallRecordSchema),
  idempotencyKey: z.string().nullable(),
});
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export interface StartSpanInput {
  readonly traceId: string;
  readonly parentId?: string;
  readonly step: AgentStep;
  readonly name: string;
  readonly input: JsonValue;
  readonly idempotencyKey?: string;
}

export interface SpanHandle {
  readonly id: string;
  recordRetry(reason: string): void;
  recordLlmCall(call: LlmCallRecord): void;
  succeed(output: JsonValue): TraceSpan;
  fail(error: AppError): TraceSpan;
}

export interface TraceRecorder {
  start(input: StartSpanInput): SpanHandle;
  spans(traceId?: string): readonly TraceSpan[];
}

export interface TraceRecorderDeps {
  readonly now: () => Date;
  readonly newId: () => string;
  /** Called once per finished span, e.g. to persist it. */
  readonly onSpan?: (span: TraceSpan) => void;
}

export function createTraceRecorder(deps: TraceRecorderDeps): TraceRecorder {
  const finished: TraceSpan[] = [];

  return {
    start(input) {
      const id = deps.newId();
      const startedAt = deps.now();
      const retries: TraceSpan["retries"] = [];
      const llmCalls: LlmCallRecord[] = [];
      let closed = false;

      const close = (status: TraceSpan["status"], output: JsonValue | null, error: AppError | null): TraceSpan => {
        if (closed) throw new AppFailure({ kind: "internal", detail: `span ${id} (${input.name}) closed twice` });
        closed = true;
        const endedAt = deps.now();
        const span: TraceSpan = {
          id,
          traceId: input.traceId,
          parentId: input.parentId ?? null,
          step: input.step,
          name: input.name,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          latencyMs: endedAt.getTime() - startedAt.getTime(),
          status,
          input: input.input,
          output,
          error,
          retries: [...retries],
          llmCalls: [...llmCalls],
          idempotencyKey: input.idempotencyKey ?? null,
        };
        finished.push(span);
        deps.onSpan?.(span);
        return span;
      };

      return {
        id,
        recordRetry: (reason) => {
          retries.push({ at: deps.now().toISOString(), reason });
        },
        recordLlmCall: (call) => {
          llmCalls.push(call);
        },
        succeed: (output) => close("ok", output, null),
        fail: (error) => close("error", null, error),
      };
    },
    spans: (traceId) => (traceId === undefined ? [...finished] : finished.filter((s) => s.traceId === traceId)),
  };
}
