import { createServer } from "node:http";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { AppFailure } from "@trip/core";
import { ClockControlSchema, FaultSpecSchema, ResetRequestSchema, type FaultKind, type FaultSpec } from "@trip/clients/contracts";
import { FaultQueue } from "./faults";
import { RequestLog } from "./request-log";

const MS_PER_MINUTE = 60_000;
/** Faults the kit applies around any handler. The rest need domain knowledge and are taken by handlers. */
const GENERIC_FAULTS = ["rate_limit", "slow", "empty_200", "write_then_timeout"] as const;
const STATUS = { ok: 200, created: 201, badRequest: 400, notFound: 404, conflict: 409, tooManyRequests: 429, internal: 500 } as const;

export interface TwinRuntime<S> {
  readonly name: string;
  now(): Date;
  /** Live state. Mutate only inside write(). */
  current(): S;
  /** State for a read. Returns the pre-write snapshot when a stale_read fault fires. */
  read(request: Request): S;
  write<T>(mutate: (state: S) => T): T;
  takeFault<K extends FaultKind>(kind: K, request: Request): Extract<FaultSpec, { kind: K }> | null;
  sendError(res: Response, status: number, code: string, message: string): void;
}

export interface TwinDefinition<S> {
  readonly name: string;
  readonly supportedFaults: readonly FaultKind[];
  readonly stateSchema: z.ZodType<S>;
  readonly seed: () => S;
  readonly defaultClock: Date;
  /** The provider's error body shape, so clients exercise their real error parsing. */
  readonly errorBody: (status: number, code: string, message: string) => unknown;
  readonly routes: (router: Router, twin: TwinRuntime<S>) => void;
  readonly injectEvent?: (twin: TwinRuntime<S>, event: unknown) => { status: number; body: unknown };
  readonly onClockAdvance?: (state: S, fromMs: number, toMs: number) => void;
}

export interface Twin<S> {
  readonly app: express.Express;
  readonly runtime: TwinRuntime<S>;
  releaseHangingResponses(): void;
}

function decodeBody(body: unknown): unknown {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  if (typeof text !== "string") return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON bodies are logged verbatim.
    return text;
  }
}

const issuesText = (error: z.ZodError): string => error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");

function controlError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function statusOf(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") return error.status;
  return STATUS.internal;
}

const AfterQuerySchema = z.coerce.number().int().nonnegative().catch(0);

export function createTwin<S>(def: TwinDefinition<S>): Twin<S> {
  let state = def.seed();
  let previous: S | null = null;
  let nowMs = def.defaultClock.getTime();
  const faults = new FaultQueue();
  const log = new RequestLog();
  const hanging = new Set<Response>();

  const releaseHangingResponses = (): void => {
    for (const res of hanging) res.socket?.destroy();
    hanging.clear();
  };

  const runtime: TwinRuntime<S> = {
    name: def.name,
    now: () => new Date(nowMs),
    current: () => state,
    read: (request) => {
      if (previous === null) return state;
      return faults.take(["stale_read"], request) === null ? state : previous;
    },
    write: (mutate) => {
      previous = structuredClone(state);
      return mutate(state);
    },
    takeFault: (kind, request) => faults.take([kind], request),
    sendError: (res, status, code, message) => {
      res.status(status).json(def.errorBody(status, code, message));
    },
  };

  const control = express.Router();

  control.post("/_twin/reset", (req, res) => {
    const parsed = ResetRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return controlError(res, STATUS.badRequest, "invalid_request", issuesText(parsed.error));
    let next = def.seed();
    if (parsed.data.state !== undefined) {
      const loaded = def.stateSchema.safeParse(parsed.data.state);
      if (!loaded.success) return controlError(res, STATUS.badRequest, "invalid_state", issuesText(loaded.error));
      next = loaded.data;
    }
    releaseHangingResponses();
    state = next;
    previous = null;
    nowMs = parsed.data.clock === undefined ? def.defaultClock.getTime() : Date.parse(parsed.data.clock);
    faults.clear();
    log.clear();
    res.json({ now: new Date(nowMs).toISOString() });
  });

  control.post("/_twin/fault", (req, res) => {
    const parsed = FaultSpecSchema.safeParse(req.body);
    if (!parsed.success) return controlError(res, STATUS.badRequest, "invalid_request", issuesText(parsed.error));
    if (!def.supportedFaults.includes(parsed.data.kind)) {
      return controlError(res, STATUS.badRequest, "unsupported_fault", `The ${def.name} twin does not support ${parsed.data.kind}`);
    }
    faults.arm(parsed.data);
    res.status(STATUS.created).json({ faults: faults.list() });
  });

  control.get("/_twin/fault", (_req, res) => {
    res.json({ faults: faults.list() });
  });

  control.delete("/_twin/fault", (_req, res) => {
    faults.clear();
    res.json({ faults: [] });
  });

  control.get("/_twin/clock", (_req, res) => {
    res.json({ now: new Date(nowMs).toISOString() });
  });

  control.post("/_twin/clock", (req, res) => {
    const parsed = ClockControlSchema.safeParse(req.body);
    if (!parsed.success) return controlError(res, STATUS.badRequest, "invalid_request", issuesText(parsed.error));
    const target = "set" in parsed.data ? Date.parse(parsed.data.set) : nowMs + parsed.data.advanceMinutes * MS_PER_MINUTE;
    if (target < nowMs) {
      return controlError(res, STATUS.conflict, "clock_backwards", `The clock is at ${new Date(nowMs).toISOString()}. Reset the twin to go back in time.`);
    }
    const from = nowMs;
    nowMs = target;
    const advance = def.onClockAdvance;
    if (advance !== undefined) runtime.write((s) => advance(s, from, target));
    res.json({ now: new Date(nowMs).toISOString() });
  });

  control.post("/_twin/event", (req, res) => {
    if (def.injectEvent === undefined) return controlError(res, STATUS.notFound, "unsupported", `The ${def.name} twin has no injectable events`);
    const result = def.injectEvent(runtime, req.body);
    res.status(result.status).json(result.body);
  });

  control.get("/_twin/log", (req, res) => {
    res.json({ entries: log.list(AfterQuerySchema.parse(req.query.after)) });
  });

  control.get("/_twin/state", (_req, res) => {
    res.json({ state });
  });

  const instrument = (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = performance.now();
    const fault = faults.take(GENERIC_FAULTS, req);
    let recorded = false;
    const record = (status: number | null, body: unknown): void => {
      if (recorded) return;
      recorded = true;
      log.append({
        at: new Date().toISOString(),
        twinTime: new Date(nowMs).toISOString(),
        method: req.method,
        path: req.originalUrl,
        requestBody: req.body ?? null,
        status,
        responseBody: body,
        latencyMs: Math.round(performance.now() - startedAt),
        fault: fault?.kind ?? null,
        idempotencyKey: req.get("idempotency-key") ?? null,
      });
    };

    const send = res.send.bind(res);
    // Express types send as an overloaded generic; this wrapper accepts the same bodies and returns res.
    res.send = ((body?: unknown) => {
      if (fault?.kind === "write_then_timeout") {
        record(null, decodeBody(body));
        hanging.add(res);
        return res;
      }
      if (fault?.kind === "empty_200") {
        record(STATUS.ok, null);
        res.status(STATUS.ok);
        res.removeHeader("content-type");
        return send("");
      }
      record(res.statusCode, decodeBody(body));
      return send(body);
    }) as Response["send"];

    if (fault?.kind === "rate_limit") {
      res.set("Retry-After", String(fault.retryAfterSeconds));
      res.set("X-RateLimit-Remaining", "0");
      runtime.sendError(res, STATUS.tooManyRequests, "rate_limited", "Too many requests");
      return;
    }
    if (fault?.kind === "slow") {
      setTimeout(next, fault.delayMs);
      return;
    }
    next();
  };

  const router = express.Router();
  def.routes(router, runtime);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(control);
  app.use(instrument);
  app.use(router);
  app.use((req: Request, res: Response) => runtime.sendError(res, STATUS.notFound, "not_found", `No route for ${req.method} ${req.path}`));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = statusOf(error);
    const code = status === STATUS.badRequest ? "invalid_request" : "internal";
    runtime.sendError(res, status, code, error instanceof Error ? error.message : "Unexpected twin error");
  });

  return { app, runtime, releaseHangingResponses };
}

export interface RunningTwin<S> {
  readonly url: string;
  readonly twin: Twin<S>;
  close(): Promise<void>;
}

export async function startTwin<S>(def: TwinDefinition<S>, port = 0, host = "127.0.0.1"): Promise<RunningTwin<S>> {
  const twin = createTwin(def);
  const server = createServer(twin.app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new AppFailure({ kind: "internal", detail: `${def.name} twin did not bind a TCP port` });
  }
  return {
    url: `http://${host}:${address.port}`,
    twin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        twin.releaseHangingResponses();
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
