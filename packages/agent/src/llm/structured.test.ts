import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createTraceRecorder } from "@trip/core";
import { createScriptedLlmClient } from "@trip/clients";
import { callStructured, parseJsonObject } from "./structured";

const schema = z.object({ answer: z.number().int() });
const noSleep = async (): Promise<void> => undefined;

function openSpan() {
  const recorder = createTraceRecorder({ now: () => new Date(0), newId: () => "span-1" });
  return recorder.start({ traceId: "trip-1", step: "elicit", name: "extract_constraints", input: null });
}

describe("callStructured", () => {
  it("sends validation errors back to the model and accepts the corrected reply", async () => {
    const llm = createScriptedLlmClient((_request, index) => (index === 0 ? '{"answer": "seven"}' : 'Here you go:\n```json\n{"answer": 7}\n```'));
    const span = openSpan();
    const result = await callStructured({ llm, span, sleep: noSleep }, { call: "extract_constraints", system: "sys", user: "msg", schema, maxTokens: 50 });

    expect(result).toEqual({ ok: true, value: { answer: 7 } });
    expect(llm.requests[1]?.messages.at(-1)?.content).toMatch(/failed validation:\n- answer:/);
    const recorded = span.succeed(null);
    expect(recorded.llmCalls).toHaveLength(2);
    expect(recorded.retries).toHaveLength(1);
  });

  it("stops with a typed error once the attempt limit is reached", async () => {
    const llm = createScriptedLlmClient(() => "I can't help with that.");
    const result = await callStructured({ llm, span: openSpan(), sleep: noSleep }, { call: "extract_constraints", system: "sys", user: "msg", schema, maxTokens: 50 });
    expect(result).toMatchObject({ ok: false, error: { kind: "llm_parse_exhausted", call: "extract_constraints", attempts: 3, lastIssues: ["the reply contains no JSON object"] } });
    expect(llm.requests).toHaveLength(3);
  });
});

describe("parseJsonObject", () => {
  it("takes the outermost object from prose or a fence", () => {
    expect(parseJsonObject('Sure! {"a": {"b": 1}} Hope that helps')).toEqual({ ok: true, value: { a: { b: 1 } } });
    expect(parseJsonObject("```json\n{\"a\": 2}\n```")).toEqual({ ok: true, value: { a: 2 } });
    expect(parseJsonObject("{broken")).toMatchObject({ ok: false });
  });
});
