import { AppFailure, type Result } from "@trip/core";

/** For tests and eval setup only: a failed Result becomes a thrown typed error. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new AppFailure(result.error);
  return result.value;
}
