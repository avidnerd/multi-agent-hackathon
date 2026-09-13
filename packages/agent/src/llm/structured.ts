import type { z } from "zod";
import { err, ok, type LlmCallName, type Result, type SpanHandle } from "@trip/core";
import { withRetry, type LlmClient, type LlmMessage } from "@trip/clients";

export const DEFAULT_PARSE_ATTEMPTS = 3;

export interface StructuredCall<T> {
  readonly call: LlmCallName;
  readonly system: string;
  readonly user: string;
  readonly schema: z.ZodType<T>;
  readonly maxTokens: number;
  readonly maxAttempts?: number;
}

export interface StructuredDeps {
  readonly llm: LlmClient;
  readonly span: SpanHandle;
  readonly sleep: (ms: number) => Promise<void>;
}

type JsonExtraction = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly issue: string };

/** Models sometimes wrap JSON in a code fence or a sentence. Take the outermost object. */
export function parseJsonObject(text: string): JsonExtraction {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, issue: "the reply contains no JSON object" };
  try {
    return { ok: true, value: JSON.parse(fenced.slice(start, end + 1)) };
  } catch (cause) {
    return { ok: false, issue: `the reply is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

const renderPrompt = (messages: readonly LlmMessage[]): string => messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");

/**
 * One schema-bound model call. Invalid output is sent back to the model with the validation errors
 * and retried; transport failures such as rate limits are retried separately. Every attempt is
 * recorded on the span with its prompt, response, tokens, cost and latency.
 */
export async function callStructured<T>(deps: StructuredDeps, spec: StructuredCall<T>): Promise<Result<T>> {
  const attempts = spec.maxAttempts ?? DEFAULT_PARSE_ATTEMPTS;
  const messages: LlmMessage[] = [
    { role: "system", content: spec.system },
    { role: "user", content: spec.user },
  ];
  let issues: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const completion = await withRetry(() => deps.llm.complete({ messages, maxTokens: spec.maxTokens, temperature: 0 }), {
      sleep: deps.sleep,
      onRetry: (error) => deps.span.recordRetry(`${spec.call} transport: ${error.kind}`),
    });
    if (!completion.ok) return completion;
    const reply = completion.value;
    deps.span.recordLlmCall({
      call: spec.call,
      model: reply.model,
      prompt: renderPrompt(messages),
      response: reply.text,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      costUsd: reply.costUsd,
      latencyMs: reply.latencyMs,
    });

    const json = parseJsonObject(reply.text);
    if (json.ok) {
      const parsed = spec.schema.safeParse(json.value);
      if (parsed.success) return ok(parsed.data);
      issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    } else {
      issues = [json.issue];
    }

    if (attempt < attempts) {
      deps.span.recordRetry(`${spec.call} output rejected: ${issues.join("; ")}`);
      messages.push(
        { role: "assistant", content: reply.text },
        { role: "user", content: `That reply failed validation:\n- ${issues.join("\n- ")}\nReply with only the corrected JSON object.` },
      );
    }
  }
  return err({ kind: "llm_parse_exhausted", call: spec.call, attempts, lastIssues: issues });
}
