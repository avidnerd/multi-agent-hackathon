import { z } from "zod";
import { err, ok, type Result } from "@trip/core";
import { httpRequest, type FetchLike } from "./http";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_LLM_TIMEOUT_MS = 90_000;

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
}

export interface LlmCompletion {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** As billed by OpenRouter, not estimated. */
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly finishReason: string | null;
}

export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<Result<LlmCompletion>>;
}

const OpenRouterResponseSchema = z.object({
  model: z.string(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }), finish_reason: z.string().nullable() })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});

const OpenRouterErrorSchema = z.object({ error: z.object({ message: z.string() }) });

export interface OpenRouterConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function createOpenRouterClient(config: OpenRouterConfig, fetchImpl: FetchLike = fetch, clock: () => number = () => performance.now()): LlmClient {
  return {
    model: config.model,
    complete: async (request) => {
      const started = clock();
      const result = await httpRequest(fetchImpl, {
        service: "llm",
        method: "POST",
        url: `${config.baseUrl ?? OPENROUTER_BASE_URL}/chat/completions`,
        headers: { authorization: `Bearer ${config.apiKey}`, "x-title": "group-trip-agent" },
        body: {
          kind: "json",
          value: { model: config.model, messages: request.messages, max_tokens: request.maxTokens, temperature: request.temperature, usage: { include: true } },
        },
        schema: OpenRouterResponseSchema,
        resource: `${config.model} completion`,
        // A completion has no side effects, so resending after a timeout only costs tokens.
        retrySafeOnTimeout: true,
        timeoutMs: config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
        mapFailure: (status, body) => {
          const parsed = OpenRouterErrorSchema.safeParse(body);
          return parsed.success ? { kind: "upstream_failed", service: "llm", status, detail: parsed.data.error.message } : null;
        },
      });
      if (!result.ok) return result;
      const [choice] = result.value.choices;
      const text = choice?.message.content ?? "";
      if (text.length === 0) return err({ kind: "validation_failed", boundary: "llm_output", issues: ["the model returned no text"] });
      return ok({
        text,
        model: result.value.model,
        inputTokens: result.value.usage.prompt_tokens,
        outputTokens: result.value.usage.completion_tokens,
        costUsd: result.value.usage.cost ?? 0,
        latencyMs: Math.round(clock() - started),
        finishReason: choice?.finish_reason ?? null,
      });
    },
  };
}

export interface ScriptedLlmClient extends LlmClient {
  readonly requests: LlmRequest[];
}

/**
 * A deterministic stand-in for tests and the eval harness's plumbing checks. It is not a twin of
 * any model: extraction quality is only ever measured against the real model.
 */
export function createScriptedLlmClient(respond: (request: LlmRequest, index: number) => string): ScriptedLlmClient {
  const requests: LlmRequest[] = [];
  return {
    model: "scripted",
    requests,
    complete: async (request) => {
      requests.push(request);
      const text = respond(request, requests.length - 1);
      return ok({ text, model: "scripted", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, finishReason: "stop" });
    },
  };
}
