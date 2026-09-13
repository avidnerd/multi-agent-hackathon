import { z } from "zod";
import type { Result, ServiceName } from "@trip/core";
import { ArmedFaultsSchema, ClockViewSchema, TwinLogSchema, type ClockView, type FaultSpecInput, type ResetRequest, type TwinLogEntry } from "./contracts";
import { httpRequest, type FetchLike } from "./http";
import { mapResult } from "@trip/core";

export interface TwinControlClient {
  reset(request?: ResetRequest): Promise<Result<ClockView>>;
  armFault(fault: FaultSpecInput): Promise<Result<z.infer<typeof ArmedFaultsSchema>>>;
  clearFaults(): Promise<Result<z.infer<typeof ArmedFaultsSchema>>>;
  setClock(iso: string): Promise<Result<ClockView>>;
  advanceClock(minutes: number): Promise<Result<ClockView>>;
  injectEvent(event: unknown): Promise<Result<unknown>>;
  log(afterSeq?: number): Promise<Result<TwinLogEntry[]>>;
  state(): Promise<Result<unknown>>;
}

const StateEnvelopeSchema = z.object({ state: z.unknown() });

export function createTwinControlClient(service: ServiceName, baseUrl: string, fetchImpl: FetchLike = fetch): TwinControlClient {
  const control = <T>(method: "GET" | "POST" | "DELETE", path: string, schema: z.ZodType<T>, body?: unknown) =>
    httpRequest(fetchImpl, {
      service,
      method,
      url: `${baseUrl}/_twin${path}`,
      schema,
      resource: `twin control ${path}`,
      body: body === undefined ? undefined : { kind: "json", value: body },
    });

  return {
    reset: (request = {}) => control("POST", "/reset", ClockViewSchema, request),
    armFault: (fault) => control("POST", "/fault", ArmedFaultsSchema, fault),
    clearFaults: () => control("DELETE", "/fault", ArmedFaultsSchema),
    setClock: (iso) => control("POST", "/clock", ClockViewSchema, { set: iso }),
    advanceClock: (minutes) => control("POST", "/clock", ClockViewSchema, { advanceMinutes: minutes }),
    injectEvent: (event) => control("POST", "/event", z.unknown(), event),
    log: async (afterSeq = 0) => mapResult(await control("GET", `/log?after=${afterSeq}`, TwinLogSchema), (l) => l.entries),
    state: async () => mapResult(await control("GET", "/state", StateEnvelopeSchema), (s) => s.state),
  };
}
