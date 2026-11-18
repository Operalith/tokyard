import { beforeAll, test, expect, vi } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}) }));
import { createSSEStream } from "open-sse/utils/stream.js";
import { initTranslators } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { maskSensitiveHeaders } from "open-sse/utils/requestLogger.js";
beforeAll(() => initTranslators());
async function run(text, options) {
  const chunks = new Response(text).body.pipeThrough(createSSEStream(options));
  return new Response(chunks).text();
}
test("raw usage trailer wins over synthetic finish-chunk estimates", async () => {
  const onUsage = vi.fn();
  const text = [
    { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 } },
  ].map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  await run(text, { mode: "passthrough", provider: "openai", body: { messages: [] }, onUsage });
  expect(onUsage).toHaveBeenCalledOnce();
  expect(onUsage.mock.calls[0][0]).toMatchObject({ prompt_tokens: 50, completion_tokens: 12 });
  expect(onUsage.mock.calls[0][0].estimated).toBeUndefined();
});
test("incomplete Claude streams cannot settle placeholder output usage", async () => {
  const onUsage = vi.fn();
  await run('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":20,"output_tokens":1}}}\n\n', { targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI, onUsage });
  expect(onUsage).not.toHaveBeenCalled();
});
test("Claude cache input and final output remain available before translation", async () => {
  const onUsage = vi.fn();
  const frames = [
    { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
  ].map(c => `data: ${JSON.stringify(c)}\n\n`).join("");
  await run(frames, { targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI, onUsage });
  expect(onUsage).toHaveBeenCalledOnce();
  expect(onUsage.mock.calls[0][0]).toMatchObject({ prompt_tokens: 10, completion_tokens: 8, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 });
});
test("diagnostics redact short secrets, cookies and provider credentials", () => {
  expect(maskSensitiveHeaders({ Authorization: "Bearer raw-key", "x-api-key": "short", Cookie: "auth_token=secret", "x-goog-api-key": "private", Accept: "application/json" })).toEqual({ Authorization: "[REDACTED]", "x-api-key": "[REDACTED]", Cookie: "[REDACTED]", "x-goog-api-key": "[REDACTED]", Accept: "application/json" });
});
