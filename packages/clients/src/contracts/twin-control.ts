import { z } from "zod";
import { IsoDateTimeSchema } from "@trip/core";

/** Every twin exposes these under /_twin. They are test and demo controls, not part of any provider's API. */

export const FAULT_KINDS = [
  "empty_200",
  "write_then_timeout",
  "rate_limit",
  "duplicate_webhook",
  "stale_read",
  "partial_batch",
  "slow",
] as const;
export const FaultKindSchema = z.enum(FAULT_KINDS);
export type FaultKind = z.infer<typeof FaultKindSchema>;

export const HTTP_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const MAX_FAULT_DELAY_MS = 60_000;

const matcher = {
  /** How many matching requests the fault applies to before it disarms. */
  count: z.number().int().positive().default(1),
  method: z.enum(HTTP_METHODS).optional(),
  pathPrefix: z.string().startsWith("/").optional(),
};

export const FaultSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty_200"), ...matcher }),
  z.object({ kind: z.literal("write_then_timeout"), ...matcher }),
  z.object({ kind: z.literal("rate_limit"), retryAfterSeconds: z.number().int().positive().default(1), ...matcher }),
  z.object({ kind: z.literal("duplicate_webhook"), ...matcher }),
  z.object({ kind: z.literal("stale_read"), ...matcher }),
  z.object({ kind: z.literal("partial_batch"), failIndices: z.array(z.number().int().nonnegative()).min(1), ...matcher }),
  z.object({ kind: z.literal("slow"), delayMs: z.number().int().positive().max(MAX_FAULT_DELAY_MS), ...matcher }),
]);
export type FaultSpec = z.infer<typeof FaultSpecSchema>;
export type FaultSpecInput = z.input<typeof FaultSpecSchema>;

export const ArmedFaultsSchema = z.object({ faults: z.array(FaultSpecSchema) });

export const ResetRequestSchema = z.object({
  /** Full twin state to load. Omit for the twin's default seed. */
  state: z.unknown().optional(),
  clock: IsoDateTimeSchema.optional(),
});
export type ResetRequest = z.infer<typeof ResetRequestSchema>;

export const ClockControlSchema = z.union([
  z.object({ set: IsoDateTimeSchema }),
  z.object({ advanceMinutes: z.number().positive() }),
]);
export const ClockViewSchema = z.object({ now: IsoDateTimeSchema });
export type ClockView = z.infer<typeof ClockViewSchema>;

export const TwinLogEntrySchema = z.object({
  seq: z.number().int().positive(),
  at: IsoDateTimeSchema,
  twinTime: IsoDateTimeSchema,
  method: z.string(),
  path: z.string(),
  requestBody: z.unknown(),
  /** Null when the response was withheld by write_then_timeout. */
  status: z.number().int().nullable(),
  responseBody: z.unknown(),
  latencyMs: z.number().nonnegative(),
  fault: FaultKindSchema.nullable(),
  idempotencyKey: z.string().nullable(),
});
export type TwinLogEntry = z.infer<typeof TwinLogEntrySchema>;
export const TwinLogSchema = z.object({ entries: z.array(TwinLogEntrySchema) });

export const TwinControlErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
