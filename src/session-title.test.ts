import assert from "node:assert/strict";
import test from "node:test";
import { generateSessionTitle, normalizeSessionTitle, OFFICIAL_TITLE_MODEL } from "./session-title.js";

function config() {
  return {
    version: 1,
    workspace: ".",
    agent: {
      provider: "openai-compatible",
      model: "current-model",
      apiKeyEnv: "CURRENT_MODEL_KEY",
      baseUrl: "https://current.example/v1",
      endpoint: "/chat/completions",
      maxTokens: 256,
      systemPrompt: "unused runtime prompt"
    },
    mcp: { servers: {} }
  } as any;
}

function response(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("normalizes title-only model output", () => {
  assert.equal(normalizeSessionTitle("标题：\"整理本周课程安排\"\n补充说明"), "整理本周课程安排");
  assert.equal(normalizeSessionTitle("模型响应为空"), "");
});

test("uses the official virtual-fast model when available", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SECTL_OFFICIAL_TOKEN;
  const originalUrl = process.env.SECTL_OFFICIAL_API_URL;
  let body: Record<string, unknown> | undefined;
  process.env.SECTL_OFFICIAL_TOKEN = "official-token";
  process.env.SECTL_OFFICIAL_API_URL = "https://official.example";
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return response('data: {"type":"response.output_text.delta","delta":"课程安排"}\n\ndata: [DONE]\n\n');
  };
  try {
    assert.equal(await generateSessionTitle(config(), "请帮我整理课程安排"), "课程安排");
    assert.equal(body?.model, OFFICIAL_TITLE_MODEL);
    assert.deepEqual(body?.tools, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.SECTL_OFFICIAL_TOKEN; else process.env.SECTL_OFFICIAL_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.SECTL_OFFICIAL_API_URL; else process.env.SECTL_OFFICIAL_API_URL = originalUrl;
  }
});

test("uses the selected model when the official service is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SECTL_OFFICIAL_TOKEN;
  const originalUrl = process.env.SECTL_OFFICIAL_API_URL;
  let body: Record<string, unknown> | undefined;
  delete process.env.SECTL_OFFICIAL_TOKEN;
  delete process.env.SECTL_OFFICIAL_API_URL;
  process.env.CURRENT_MODEL_KEY = "current-key";
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return response('data: {"choices":[{"delta":{"content":"当前模型标题"}}]}\n\ndata: [DONE]\n\n');
  };
  try {
    assert.equal(await generateSessionTitle(config(), "请总结当前任务"), "当前模型标题");
    assert.equal(body?.model, "current-model");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CURRENT_MODEL_KEY;
    if (originalToken === undefined) delete process.env.SECTL_OFFICIAL_TOKEN; else process.env.SECTL_OFFICIAL_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.SECTL_OFFICIAL_API_URL; else process.env.SECTL_OFFICIAL_API_URL = originalUrl;
  }
});
