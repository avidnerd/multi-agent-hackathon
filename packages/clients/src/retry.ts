import { isRetryable, type AppError, type Result } from "@trip/core";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5_000 };

export interface RetryOptions {
  readonly policy?: RetryPolicy;
  /** Injected so tests and the eval runner do not wait on real time. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly onRetry?: (error: AppError, attempt: number, delayMs: number) => void;
}

export function retryDelayMs(error: AppError, attempt: number, policy: RetryPolicy): number {
  if (error.kind === "rate_limited") return Math.min(error.retryAfterMs, policy.maxDelayMs);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

export async function withRetry<T>(operation: (attempt: number) => Promise<Result<T>>, options: RetryOptions): Promise<Result<T>> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  let attempt = 1;
  let result = await operation(attempt);
  while (!result.ok && isRetryable(result.error) && attempt < policy.maxAttempts) {
    const delay = retryDelayMs(result.error, attempt, policy);
    options.onRetry?.(result.error, attempt, delay);
    await options.sleep(delay);
    attempt += 1;
    result = await operation(attempt);
  }
  return result;
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
