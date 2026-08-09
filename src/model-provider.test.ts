import assert from "node:assert/strict";
import test from "node:test";
import { ModelToolAgent } from "./model-provider.js";

function config() {
  return {
    agent: {
      provider: "openai-compatible",
      model: "test-model",
      apiKeyEnv: "TEST_MODEL_KEY",
      baseUrl: "https://model.test",
      endpoint: "/chat/completions",
      maxTokens: 256,
      systemPrompt: "test",
    },
  } as any;
}

function response(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("tool failure is not reported as completed", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MODEL_KEY = "test-key";
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) return response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bad_tool","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n');
    return response("data: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n");
  };
  try {
    const agent = new ModelToolAgent(config(), [], undefined);
    const result = await agent.run("do it", [{ key: "bad_tool", description: "bad", inputSchema: { type: "object" } }], async () => {
      throw new Error("工具不存在");
    });
    assert.equal(result, "工具执行失败：工具不存在");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MODEL_KEY;
  }
});

test("an empty model response is reported explicitly", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MODEL_KEY = "test-key";
  globalThis.fetch = async () => response("data: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n");
  try {
    const agent = new ModelToolAgent(config(), [], undefined);
    const result = await agent.run("say something", [{ key: "unused_tool", description: "unused", inputSchema: { type: "object" } }], async () => ({}));
    assert.equal(result, "模型响应为空。");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MODEL_KEY;
  }
});
