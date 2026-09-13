import type { z } from "zod";
import { err, ok, type AppError, type Result, type ServiceName } from "@trip/core";
import type { HttpMethod } from "./contracts/twin-control";

export const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MS_PER_SECOND = 1_000;
const MAX_DETAIL_CHARS = 300;
const STATUS = { noContent: 204, notFound: 404, conflict: 409, gone: 410, unprocessable: 422, tooManyRequests: 429 } as const;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type RequestBody =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "form"; readonly value: Readonly<Record<string, string>> };

export interface HttpRequest<T> {
  readonly service: ServiceName;
  readonly method: HttpMethod;
  readonly url: string;
  /** Human name of what is being fetched or written, used in error messages. */
  readonly resource: string;
  readonly schema: z.ZodType<T>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: RequestBody;
  /** True when the far side dedupes this write, so resending after a timeout cannot apply it twice. */
  readonly retrySafeOnTimeout?: boolean;
  readonly timeoutMs?: number;
  /** Translate a provider's documented error body. Return null to fall back to the status-based mapping. */
  readonly mapFailure?: (status: number, body: unknown) => AppError | null;
}

type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // Not JSON is a legitimate outcome here; callers turn it into a typed validation error.
    return { ok: false };
  }
}

function retryAfterMs(header: string | null): number {
  if (header === null) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * MS_PER_SECOND);
  const date = Date.parse(header);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - Date.now());
}

function summarize(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.slice(0, MAX_DETAIL_CHARS);
}

function statusFailure(service: ServiceName, resource: string, status: number, body: unknown): AppError {
  switch (status) {
    case STATUS.notFound:
    case STATUS.gone:
      return { kind: "not_found", service, resource };
    case STATUS.conflict:
    case STATUS.unprocessable:
      return { kind: "conflict", service, resource, code: null, detail: summarize(body) };
    default:
      return { kind: "upstream_failed", service, status, detail: summarize(body) };
  }
}

const isAbort = (cause: unknown): boolean =>
  cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");

function buildInit(request: HttpRequest<unknown>, timeoutMs: number): RequestInit {
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  let body: string | undefined;
  if (request.body?.kind === "json") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(request.body.value);
  } else if (request.body?.kind === "form") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(request.body.value).toString();
  }
  return { method: request.method, headers, body, signal: AbortSignal.timeout(timeoutMs) };
}

/** One attempt. Every outcome, including transport failures and malformed bodies, comes back as a typed Result. */
export async function httpRequest<T>(fetchImpl: FetchLike, request: HttpRequest<T>): Promise<Result<T>> {
  const { service, resource } = request;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let status: number;
  let headers: Headers;
  let text: string;
  try {
    const response = await fetchImpl(request.url, buildInit(request, timeoutMs));
    status = response.status;
    headers = response.headers;
    text = await response.text();
  } catch (cause) {
    if (isAbort(cause)) {
      const retrySafe = request.method === "GET" || request.retrySafeOnTimeout === true;
      return err({ kind: "timeout", service, afterMs: timeoutMs, retrySafe });
    }
    return err({ kind: "upstream_failed", service, status: null, detail: cause instanceof Error ? cause.message : String(cause) });
  }

  const json = parseJson(text);
  if (status === STATUS.tooManyRequests) {
    return err({ kind: "rate_limited", service, retryAfterMs: retryAfterMs(headers.get("retry-after")) });
  }
  if (status < 200 || status >= 300) {
    const body = json.ok ? json.value : text;
    return err(request.mapFailure?.(status, body) ?? statusFailure(service, resource, status, body));
  }

  let candidate: unknown = null;
  if (status !== STATUS.noContent) {
    if (text.length === 0) {
      return err({ kind: "validation_failed", boundary: "api_response", issues: [`${service} returned ${status} with an empty body for ${resource}`] });
    }
    if (!json.ok) {
      return err({ kind: "validation_failed", boundary: "api_response", issues: [`${service} returned non-JSON for ${resource}`] });
    }
    candidate = json.value;
  }

  const parsed = request.schema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return err({ kind: "validation_failed", boundary: "api_response", issues });
  }
  return ok(parsed.data);
}
