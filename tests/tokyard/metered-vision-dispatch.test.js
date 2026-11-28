import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());
import { dispatchMeteredVision } from "../../src/sse/handlers/meteredVision.js";

const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
function setup(stream = false) {
  const body = { model: "openai/gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "private text" }, { type: "image_url", image_url: { url } }] }], stream, max_tokens: 12 };
  const meter = { vision: { url, model: "gpt-4o", inputBound: 4096 }, outputCap: 12, onDispatch: vi.fn(), onUsage: vi.fn() };
  const credentials = { authType: "apikey", apiKey: "secret", providerSpecificData: {} };
  return { body, meter, credentials };
}

describe("metered vision dispatch", () => {
  it("sends one normalized image directly, bounded, and records usage", async () => {
    const args = setup();
    const transport = vi.fn(async () => new Response(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 2 } }), { headers: { "content-type": "application/json" } }));
    const response = await dispatchMeteredVision({ ...args, transport });
    expect(response.status).toBe(200);
    expect(transport).toHaveBeenCalledOnce();
    const [endpoint, options] = transport.mock.calls[0];
    expect(endpoint).toBe("https://api.openai.com/v1/chat/completions");
    expect(options.redirect).toBe("manual");
    const sent = JSON.parse(options.body);
    expect(sent.model).toBe("gpt-4o");
    expect(sent.max_tokens).toBe(12);
    expect(sent.messages[0].content[1].image_url).toEqual({ url, detail: "low" });
    expect(args.meter.onDispatch).toHaveBeenCalledOnce();
    expect(args.meter.onUsage).toHaveBeenCalledWith({ prompt_tokens: 100, completion_tokens: 2 });
  });

  it("collects stream usage without diagnostic sinks", async () => {
    const args = setup(true);
    const text = 'data: {"choices":[],"usage":{"prompt_tokens":90,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
    const transport = vi.fn(async () => new Response(new ReadableStream({ start(controller) { const bytes = new TextEncoder().encode(text); controller.enqueue(bytes.slice(0, 37)); controller.enqueue(bytes.slice(37)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }));
    const response = await dispatchMeteredVision({ ...args, transport });
    expect(await response.text()).toBe(text);
    expect(args.meter.onUsage).toHaveBeenCalledWith({ prompt_tokens: 90, completion_tokens: 3 });
    expect(JSON.parse(transport.mock.calls[0][1].body).stream_options).toEqual({ include_usage: true });
  });

  it("rejects altered images, extra images, out-of-bound text and proxy configuration before dispatch", async () => {
    for (const change of [
      a => { a.body.messages[0].content[1].image_url.url += "x"; },
      a => { a.body.messages[0].content.push(a.body.messages[0].content[1]); },
      a => { a.meter.vision.inputBound = 1; },
      a => { a.credentials.providerSpecificData.connectionProxyEnabled = true; },
      a => { a.body.tools = []; },
    ]) {
      const args = setup(); change(args);
      const transport = vi.fn();
      expect((await dispatchMeteredVision({ ...args, transport })).status).toBe(403);
      expect(transport).not.toHaveBeenCalled();
      expect(args.meter.onDispatch).not.toHaveBeenCalled();
    }
  });

  it("allows usage-only without an output limit and rejects mismatches", async () => {
    const args = setup();
    args.meter.outputCap = null;
    delete args.body.max_tokens;
    const transport = vi.fn(async () => new Response('{}'));
    expect((await dispatchMeteredVision({ ...args, transport })).status).toBe(200);
    expect(JSON.parse(transport.mock.calls[0][1].body)).not.toHaveProperty("max_tokens");
    args.body.max_tokens = 12;
    expect((await dispatchMeteredVision({ ...args, transport })).status).toBe(403);
    args.meter.outputCap = 13;
    expect((await dispatchMeteredVision({ ...args, transport })).status).toBe(403);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("does not retry or expose provider errors", async () => {
    const args = setup();
    const transport = vi.fn(async () => new Response("private text " + url, { status: 401 }));
    const response = await dispatchMeteredVision({ ...args, transport });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("private text");
    expect(transport).toHaveBeenCalledOnce();
    expect(args.meter.onDispatch).toHaveBeenCalledOnce();
  });
});
