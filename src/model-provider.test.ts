import assert from "node:assert/strict";
import test from "node:test";
import { ModelToolAgent, type ConversationMessage } from "./model-provider.js";

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

function responsesConfig() {
  return {
    agent: {
      provider: "openai-responses",
      model: "test-model",
      apiKeyEnv: "TEST_MODEL_KEY",
      baseUrl: "https://model.test",
      endpoint: "/responses",
      maxTokens: 256,
      systemPrompt: "test",
    },
  } as any;
}

function anthropicConfig() {
  return {
    agent: {
      provider: "anthropic",
      model: "claude-test",
      apiKeyEnv: "TEST_MODEL_KEY",
      baseUrl: "https://model.test",
      endpoint: "/v1/messages",
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

test("malformed tool arguments are returned to the model for correction", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MODEL_KEY = "test-key";
  let requestCount = 0;
  let executeCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) return response(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"demo","arguments":"{\\"broken\\":"}}]}}]}\n\ndata: [DONE]\n\n`);
    return response(`data: {"choices":[{"delta":{"content":"已根据错误重新生成。"}}]}\n\ndata: [DONE]\n\n`);
  };
  try {
    const agent = new ModelToolAgent(config(), [], undefined);
    const result = await agent.run("do it", [{ key: "demo", description: "demo", inputSchema: { type: "object" } }], async () => {
      executeCount += 1;
      return {};
    });
    assert.equal(result, "已根据错误重新生成。");
    assert.equal(requestCount, 2);
    assert.equal(executeCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MODEL_KEY;
  }
});

test("an empty model response is retried once", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MODEL_KEY = "test-key";
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return requestCount === 1
      ? response("data: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n")
      : response("data: {\"choices\":[{\"delta\":{\"content\":\"重试成功\"}}]}\n\ndata: [DONE]\n\n");
  };
  try {
    const agent = new ModelToolAgent(config(), [], undefined);
    const result = await agent.run("say something", [{ key: "unused_tool", description: "unused", inputSchema: { type: "object" } }], async () => ({}));
    assert.equal(result, "重试成功");
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MODEL_KEY;
  }
});

test("Responses completed event supplies text when no text delta was sent", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MODEL_KEY = "test-key";
  globalThis.fetch = async () => response("data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"completed fallback\"}]}]}}\n\ndata: [DONE]\n\n");
  try {
    const agent = new ModelToolAgent(responsesConfig(), [], undefined);
    const result = await agent.run("say something", [{ key: "unused_tool", description: "unused", inputSchema: { type: "object" } }], async () => ({}));
    assert.equal(result, "completed fallback");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MODEL_KEY;
  }
});

test("model API connection errors are retried up to recovery", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MODEL_KEY = "test-key";
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount < 3) throw new Error("fetch failed: socket reset");
    return response("data: {\"choices\":[{\"delta\":{\"content\":\"recovered\"}}]}\n\ndata: [DONE]\n\n");
  };
  try {
    const agent = new ModelToolAgent(config(), [], undefined);
    const result = await agent.run("say something", [{ key: "unused_tool", description: "unused", inputSchema: { type: "object" } }], async () => ({}));
    assert.equal(result, "recovered");
    assert.equal(requestCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MODEL_KEY;
  }
});

test("malformed Anthropic tool arguments are returned as a tool result", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MODEL_KEY = "test-key";
  let requestCount = 0;
  let executeCount = 0;
  let secondRequest = "";
  globalThis.fetch = async (_url, init) => {
    requestCount += 1;
    if (requestCount === 2) secondRequest = String(init?.body || "");
    return requestCount === 1
      ? response('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"demo"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"broken\\":"}}\n\n')
      : response('data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"fixed"}}\n\n');
  };
  try {
    const agent = new ModelToolAgent(anthropicConfig(), [], undefined);
    const result = await agent.run("do it", [{ key: "demo", description: "demo", inputSchema: { type: "object" } }], async () => {
      executeCount += 1;
      return {};
    });
    assert.equal(result, "fixed");
    assert.equal(requestCount, 2);
    assert.equal(executeCount, 0);
    assert.match(secondRequest, /tool_result/);
    assert.match(secondRequest, /模型返回了无法解析的工具参数/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MODEL_KEY;
  }
});

test("persisted tool calls and results are restored to the next OpenAI request", async () => {
  const originalFetch = globalThis.fetch;
  process.env.TEST_MODEL_KEY = "test-key";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return response('data: {"choices":[{"delta":{"content":"continued"}}]}\n\ndata: [DONE]\n\n');
  };
  const conversation: ConversationMessage[] = [
    { role: "user", content: "inspect it" },
    {
      role: "assistant",
      content: "The inspection is complete.",
      toolCalls: [{ id: "history-call-1", name: "demo", arguments: { path: "a.txt" }, result: { text: "file contents" } }]
    },
    { role: "user", content: "continue" }
  ];
  try {
    const agent = new ModelToolAgent(config(), [], undefined);
    await agent.run("continue", [{ key: "demo", description: "demo", inputSchema: { type: "object" } }], async () => ({}), "high", conversation);
    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages.slice(1).map((message) => message.role), ["user", "assistant", "tool", "assistant", "user"]);
    assert.deepEqual(messages[2]?.tool_calls, [{ id: "history-call-1", type: "function", function: { name: "demo", arguments: '{"path":"a.txt"}' } }]);
    assert.equal(messages[3]?.tool_call_id, "history-call-1");
    assert.equal(messages[3]?.content, '{"text":"file contents"}');
    assert.equal(messages[4]?.content, "The inspection is complete.");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MODEL_KEY;
  }
});
