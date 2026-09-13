import { type AppError, type Logger, type TraceRecorder } from "@trip/core";
import type { InboundMessage, LlmClient } from "@trip/clients";
import { TWILIO_STOP_KEYWORDS } from "@trip/clients/contracts";
import { callStructured } from "../llm/structured";
import { acceptExtraction, buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT, ExtractionOutputSchema, type AcceptedExtraction } from "./extraction";
import type { ElicitationSession } from "./session";

const EXTRACTION_MAX_TOKENS = 1_500;

export interface InboundDeps {
  readonly channel: "sms" | "imessage";
  readonly llm: LlmClient;
  readonly trace: TraceRecorder;
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
}

export type InboundOutcome =
  | { readonly kind: "unknown_sender"; readonly from: string }
  | { readonly kind: "opted_out"; readonly memberId: string }
  | { readonly kind: "extracted"; readonly memberId: string; readonly accepted: AcceptedExtraction }
  | { readonly kind: "extraction_failed"; readonly memberId: string; readonly error: AppError };

export async function handleInbound(deps: InboundDeps, session: ElicitationSession, inbound: InboundMessage): Promise<InboundOutcome> {
  const { trip } = session;
  const member = trip.members.find((m) => m.phone === inbound.from);
  if (member === undefined) {
    deps.logger.warn("inbound.unknown_sender", { from: inbound.from });
    return { kind: "unknown_sender", from: inbound.from };
  }

  const messageId = `in-${inbound.externalId}`;
  session.messages.push({ id: messageId, tripId: trip.id, memberId: member.id, channel: deps.channel, direction: "inbound", body: inbound.body, externalId: inbound.externalId, at: inbound.receivedAt });
  const thread = session.threads[member.id];

  // Carrier opt-out keywords are honoured before any model sees the text.
  if ((TWILIO_STOP_KEYWORDS as readonly string[]).includes(inbound.body.trim().toUpperCase())) {
    member.optedOut = true;
    return { kind: "opted_out", memberId: member.id };
  }

  const span = deps.trace.start({ traceId: trip.id, step: "elicit", name: "extract_constraints", input: { memberId: member.id, messageId, body: inbound.body } });
  const output = await callStructured(
    { llm: deps.llm, span, sleep: deps.sleep },
    {
      call: "extract_constraints",
      system: EXTRACTION_SYSTEM_PROMPT,
      user: buildExtractionPrompt({ destination: trip.destination, window: trip.dateWindow, today: deps.now().toISOString().slice(0, 10), member, body: inbound.body }),
      schema: ExtractionOutputSchema,
      maxTokens: EXTRACTION_MAX_TOKENS,
    },
  );
  if (thread !== undefined) thread.repliedAt = inbound.receivedAt;
  if (!output.ok) {
    span.fail(output.error);
    if (member.responseState === "asked" || member.responseState === "unreached") member.responseState = "partial";
    return { kind: "extraction_failed", memberId: member.id, error: output.error };
  }

  const accepted = acceptExtraction(output.value, { member, message: { id: messageId, body: inbound.body, at: inbound.receivedAt }, window: trip.dateWindow });
  member.constraints = [...member.constraints.filter((c) => !accepted.retractedIds.includes(c.id)), ...accepted.constraints];
  if (accepted.optOut) member.optedOut = true;

  if (thread !== undefined) {
    const hasDates = member.constraints.some((c) => c.kind === "date_exclusion" && c.provenance.source === "stated");
    const hasBudget = member.constraints.some((c) => c.kind === "budget_ceiling" && c.provenance.source === "stated");
    thread.answered = {
      dates: thread.answered.dates || accepted.answered.dates || hasDates,
      budget: thread.answered.budget || accepted.answered.budget || hasBudget,
      schedule: thread.answered.schedule || accepted.answered.schedule,
    };
    member.responseState = thread.answered.dates && thread.answered.budget ? "complete" : "partial";
  }

  span.succeed({
    constraints: accepted.constraints.map((c) => c.id),
    retracted: accepted.retractedIds,
    dropped: accepted.dropped.map((d) => `${d.kind}: ${d.reason}`),
    responseState: member.responseState,
  });
  return { kind: "extracted", memberId: member.id, accepted };
}
