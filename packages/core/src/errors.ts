import { z } from "zod";
import { AGENT_ACTION_KINDS, IdSchema } from "./domain";

export const SERVICES = ["messaging", "calendar", "inventory", "llm", "db"] as const;
export type ServiceName = (typeof SERVICES)[number];

export const VALIDATION_BOUNDARIES = ["llm_output", "api_response", "user_input", "webhook", "config"] as const;
export type ValidationBoundary = (typeof VALIDATION_BOUNDARIES)[number];

export const LLM_CALLS = ["extract_constraints", "generate_markets", "set_opening_prices", "propose_repair"] as const;
export type LlmCallName = (typeof LLM_CALLS)[number];

/** The never-do set. Each maps to an eval metric that must report zero violations. */
export const INVARIANTS = [
  "irreversible_requires_approval",
  "inferred_never_promoted",
  "ambiguous_market_escalates",
  "opted_out_never_contacted",
  "no_duplicate_side_effects",
] as const;
export type InvariantName = (typeof INVARIANTS)[number];

const service = z.enum(SERVICES);

export const AppErrorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("validation_failed"),
    boundary: z.enum(VALIDATION_BOUNDARIES),
    issues: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal("llm_parse_exhausted"),
    call: z.enum(LLM_CALLS),
    attempts: z.number().int().positive(),
    lastIssues: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("approval_rejected"),
    actionId: IdSchema,
    actionKind: z.enum(AGENT_ACTION_KINDS),
    tokenId: IdSchema.nullable(),
    reason: z.enum(["missing", "unknown_token", "expired", "already_used", "scope_mismatch", "not_organizer"]),
  }),
  z.object({ kind: z.literal("rate_limited"), service, retryAfterMs: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("upstream_failed"),
    service,
    status: z.number().int().nullable(),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal("timeout"),
    service,
    afterMs: z.number().int().nonnegative(),
    // A write that timed out may have applied. Retrying is only safe when the request
    // carried an idempotency key the far side dedupes on.
    retrySafe: z.boolean(),
  }),
  z.object({
    kind: z.literal("conflict"),
    service,
    resource: z.string(),
    /** The provider's machine-readable code where it has one, e.g. insufficient_seats or 21610. */
    code: z.string().nullable(),
    detail: z.string(),
  }),
  z.object({ kind: z.literal("not_found"), service, resource: z.string() }),
  z.object({ kind: z.literal("member_opted_out"), memberId: IdSchema }),
  z.object({ kind: z.literal("invariant_violated"), invariant: z.enum(INVARIANTS), detail: z.string() }),
  z.object({ kind: z.literal("internal"), detail: z.string() }),
]);
export type AppError = z.infer<typeof AppErrorSchema>;
export type AppErrorKind = AppError["kind"];

export type Result<T, E = AppError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function mapResult<T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> {
  return result.ok ? ok(transform(result.value)) : result;
}

/** For the few places that must throw (the dispatcher gate, closed spans). Carries the typed error. */
export class AppFailure extends Error {
  override readonly name = "AppFailure";
  constructor(readonly error: AppError) {
    super(describeError(error));
  }
}

export function assertNever(value: never): never {
  throw new AppFailure({ kind: "internal", detail: `unhandled variant: ${JSON.stringify(value)}` });
}

const RETRYABLE_BOUNDARIES: readonly ValidationBoundary[] = ["llm_output", "api_response"];
const SERVER_ERROR_MIN_STATUS = 500;

export function isRetryable(error: AppError): boolean {
  switch (error.kind) {
    case "validation_failed":
      // Malformed model or upstream output can be transient. Bad user input or a bad webhook will not fix itself.
      return RETRYABLE_BOUNDARIES.includes(error.boundary);
    case "rate_limited":
      return true;
    case "upstream_failed":
      return error.status === null || error.status >= SERVER_ERROR_MIN_STATUS;
    case "timeout":
      return error.retrySafe;
    case "llm_parse_exhausted":
    case "approval_rejected":
    case "conflict":
    case "not_found":
    case "member_opted_out":
    case "invariant_violated":
    case "internal":
      return false;
    default:
      return assertNever(error);
  }
}

export function describeError(error: AppError): string {
  switch (error.kind) {
    case "validation_failed":
      return `Invalid ${error.boundary.replace("_", " ")}: ${error.issues.join("; ")}`;
    case "llm_parse_exhausted":
      return `${error.call} returned unusable output ${error.attempts} times: ${error.lastIssues.join("; ")}`;
    case "approval_rejected":
      return error.reason === "missing"
        ? `${error.actionKind} is irreversible and has no approval`
        : `${error.actionKind} approval ${error.tokenId ?? ""} rejected: ${error.reason.replace("_", " ")}`;
    case "rate_limited":
      return `${error.service} is rate limiting, retry after ${error.retryAfterMs}ms`;
    case "upstream_failed":
      return `${error.service} failed${error.status === null ? "" : ` with ${error.status}`}: ${error.detail}`;
    case "timeout":
      return `${error.service} did not respond within ${error.afterMs}ms${error.retrySafe ? "" : " and the write may have applied"}`;
    case "conflict":
      return `${error.service} rejected ${error.resource}${error.code === null ? "" : ` (${error.code})`}: ${error.detail}`;
    case "not_found":
      return `${error.service} has no ${error.resource}`;
    case "member_opted_out":
      return `Member ${error.memberId} opted out and cannot be contacted`;
    case "invariant_violated":
      return `Invariant ${error.invariant} violated: ${error.detail}`;
    case "internal":
      return error.detail;
    default:
      return assertNever(error);
  }
}
