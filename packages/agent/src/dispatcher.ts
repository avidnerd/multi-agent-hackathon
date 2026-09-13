import { ACTION_REVERSIBILITY, err, IRREVERSIBLE, ok, type AgentAction, type AgentActionKind, type AgentStep, type AppError, type ApprovalToken, type JsonValue, type Member, type Result, type TraceRecorder } from "@trip/core";

export interface ExecutedAction {
  readonly idempotencyKey: string;
  readonly actionId: string;
  readonly kind: AgentActionKind;
  /** pending means the write started and its outcome is unknown. It is never silently repeated. */
  readonly status: "pending" | "succeeded";
  readonly result: JsonValue | null;
  readonly approvalTokenId: string | null;
  readonly at: string;
}

export interface ExecutedActionStore {
  get(idempotencyKey: string): ExecutedAction | undefined;
  put(record: ExecutedAction): void;
  delete(idempotencyKey: string): void;
  all(): readonly ExecutedAction[];
}

export interface ApprovalStore {
  get(tokenId: string): ApprovalToken | undefined;
  put(token: ApprovalToken): void;
}

export type ActionHandler = (action: AgentAction) => Promise<Result<JsonValue>>;

export interface DispatcherDeps {
  readonly handlers: Partial<Record<AgentActionKind, ActionHandler>>;
  readonly approvals: ApprovalStore;
  readonly executed: ExecutedActionStore;
  readonly members: () => readonly Member[];
  readonly organizerId: string;
  readonly trace: TraceRecorder;
  readonly now: () => Date;
}

export interface DispatchOptions {
  readonly traceId: string;
  readonly step: AgentStep;
  readonly approvalTokenId: string | null;
  readonly parentId?: string;
}

export interface Dispatcher {
  execute(action: AgentAction, options: DispatchOptions): Promise<Result<JsonValue>>;
}

/** Members an action reaches out to. Opt-out blocks these regardless of approval. */
export function contactedMemberIds(action: AgentAction): string[] {
  switch (action.kind) {
    case "send_sms":
      return [action.params.memberId];
    case "write_calendar_event":
      return action.params.attendeeIds;
    case "record_expenses":
      return [...new Set(action.params.expenses.flatMap((e) => e.memberIds))];
    default:
      return [];
  }
}

function affectedMemberIds(action: AgentAction): string[] {
  return action.kind === "book_flight" ? action.params.memberIds : contactedMemberIds(action);
}

/**
 * THE GATE. An IRREVERSIBLE action runs only with a valid approval token: granted by the organizer,
 * unexpired, and scoped to this action (single use) or to its kind and the members it touches
 * (standing). This is the only path to an external write; there is no prompt-level override.
 */
export function checkApproval(action: AgentAction, tokenId: string | null, deps: Pick<DispatcherDeps, "approvals" | "organizerId" | "now">): Result<ApprovalToken | null> {
  if (ACTION_REVERSIBILITY[action.kind] !== IRREVERSIBLE) return ok(null);
  const reject = (reason: Extract<AppError, { kind: "approval_rejected" }>["reason"]): Result<never> =>
    err({ kind: "approval_rejected", actionId: action.id, actionKind: action.kind, tokenId, reason });

  if (tokenId === null) return reject("missing");
  const token = deps.approvals.get(tokenId);
  if (token === undefined) return reject("unknown_token");
  if (token.grantedBy !== deps.organizerId) return reject("not_organizer");
  if (Date.parse(token.expiresAt) <= deps.now().getTime()) return reject("expired");
  if (token.scope.kind === "action") {
    if (token.scope.actionId !== action.id) return reject("scope_mismatch");
    if (token.usedAt !== null) return reject("already_used");
    return ok(token);
  }
  if (!token.scope.actionKinds.includes(action.kind)) return reject("scope_mismatch");
  const allowed = token.scope.memberIds;
  if (allowed !== null) {
    const touched = affectedMemberIds(action);
    if (touched.length === 0 || !touched.every((id) => allowed.includes(id))) return reject("scope_mismatch");
  }
  return ok(token);
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  return {
    async execute(action, options) {
      const span = deps.trace.start({
        traceId: options.traceId,
        parentId: options.parentId,
        step: options.step,
        name: action.kind,
        input: { id: action.id, kind: action.kind, reason: action.reason, approvalTokenId: options.approvalTokenId },
        idempotencyKey: action.idempotencyKey,
      });
      const fail = (error: AppError): Result<never> => {
        span.fail(error);
        return err(error);
      };

      const prior = deps.executed.get(action.idempotencyKey);
      if (prior?.status === "succeeded") {
        span.succeed({ replayed: true, result: prior.result });
        return ok(prior.result);
      }
      if (prior?.status === "pending") {
        return fail({ kind: "conflict", service: "db", resource: action.id, code: "outcome_unknown", detail: "An earlier attempt may have gone through, so it is not being repeated" });
      }

      const optedOut = contactedMemberIds(action).find((id) => deps.members().find((m) => m.id === id)?.optedOut === true);
      if (optedOut !== undefined) return fail({ kind: "member_opted_out", memberId: optedOut });

      const approval = checkApproval(action, options.approvalTokenId, deps);
      if (!approval.ok) return fail(approval.error);

      const handler = deps.handlers[action.kind];
      if (handler === undefined) return fail({ kind: "internal", detail: `no handler for ${action.kind}` });

      const at = deps.now().toISOString();
      const record = { idempotencyKey: action.idempotencyKey, actionId: action.id, kind: action.kind, approvalTokenId: approval.value?.id ?? null, at };
      deps.executed.put({ ...record, status: "pending", result: null });

      const result = await handler(action);
      if (result.ok) {
        deps.executed.put({ ...record, status: "succeeded", result: result.value });
        if (approval.value?.scope.kind === "action") deps.approvals.put({ ...approval.value, usedAt: at });
        span.succeed(result.value);
        return result;
      }
      // A timeout on a write the provider does not dedupe may have landed. Keep it pending so it is never resent blind.
      const outcomeUnknown = result.error.kind === "timeout" && !result.error.retrySafe;
      if (!outcomeUnknown) deps.executed.delete(action.idempotencyKey);
      return fail(result.error);
    },
  };
}

export function createMemoryExecutedStore(): ExecutedActionStore {
  const records = new Map<string, ExecutedAction>();
  return {
    get: (key) => records.get(key),
    put: (record) => void records.set(record.idempotencyKey, record),
    delete: (key) => void records.delete(key),
    all: () => [...records.values()],
  };
}

export function createMemoryApprovalStore(): ApprovalStore {
  const tokens = new Map<string, ApprovalToken>();
  return { get: (id) => tokens.get(id), put: (token) => void tokens.set(token.id, token) };
}
