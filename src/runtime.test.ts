import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkill, selectAutoLoadedSkills } from "./runtime.js";
import { loadEnabledSkills } from "./skills.js";
import type { SecAgentConfig } from "./types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoadedSkill } from "./skills.js";
import { AuditStore } from "./audit.js";
import { PluginManager } from "./plugin-manager.js";
import { resolveVisionAgentConfig } from "./config.js";
import { SecAgentRuntime } from "./runtime.js";
import AdmZip from "adm-zip";

function skill(name: string): LoadedSkill {
  return { name, description: "test", path: `/tmp/${name}/SKILL.md`, content: "test" };
}

test("resolves a plugin Skill by its unqualified name", () => {
  const resolved = resolveSkill([skill("iccce-connector/iccce")], "iccce");
  assert.equal(resolved?.name, "iccce-connector/iccce");
});

test("prefers an exact Skill name", () => {
  const resolved = resolveSkill([skill("iccce"), skill("iccce-connector/iccce")], "iccce");
  assert.equal(resolved?.name, "iccce");
});

test("does not guess when an unqualified Skill name is ambiguous", () => {
  const resolved = resolveSkill([skill("first/iccce"), skill("second/iccce")], "iccce");
  assert.equal(resolved, undefined);
});

test("auto-loads every matching skill only once and skips skills already read", () => {
  const skills: LoadedSkill[] = [
    { ...skill("plugin/score"), autoLoadPattern: { source: "score", flags: "i" } },
    { ...skill("plugin/class"), autoLoadPattern: { source: "score|class", flags: "i" } },
    { ...skill("plugin/other"), autoLoadPattern: { source: "score", flags: "i" } }
  ];
  assert.deepEqual(selectAutoLoadedSkills(skills, "please score this", ["plugin/score"], ["other"] ).map((item) => item.name), ["plugin/class"]);
  assert.deepEqual(selectAutoLoadedSkills(skills, "please score this", [], ["class"]).map((item) => item.name), ["plugin/score", "plugin/other"]);
});

test("built-in math visualization skill auto-loads for math and diagram requests", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-math-skill-"));
  const config = { workspace } as SecAgentConfig;
  const math = loadEnabledSkills(config).find((item) => item.name === "math-visualization");
  assert.ok(math?.autoLoadPattern);
  assert.equal(selectAutoLoadedSkills([math!], "请推导圆柱体体积公式并画一个三维示意图").length, 1);
  assert.equal(selectAutoLoadedSkills([math!], "帮我写一封普通邮件").length, 0);
});

test("a matching plugin pre-rule returns without sending a model request", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-runtime-pre-rule-"));
  const archivePath = path.join(workspace, "pre-rule.zip");
  const archive = new AdmZip() as unknown as { addFile(name: string, data: Buffer): void; writeZip(file: string): void };
  archive.addFile("secagent-plugin.json", Buffer.from(JSON.stringify({ apiVersion: 1, id: "runtime-pre-rule", name: "Runtime pre-rule", version: "1.0.0", main: "main.mjs", permissions: ["agent.tools", "agent.pre_rules"] })));
  archive.addFile("main.mjs", Buffer.from(`
export function activate(api) {
  api.registerTool({ name: "draw", description: "draw", hidden: true, inputSchema: { type: "object" } }, async () => ({ students: [{ name: "Alice" }] }));
  api.registerPreRule("draw_command", (input) => input === "点名" ? { tool: "draw", arguments: {}, render: (result) => "抽到：" + result.students[0].name } : undefined);
}
`));
  archive.writeZip(archivePath);
  const manager = new PluginManager(workspace);
  const audit = new AuditStore(workspace);
  const traces: string[] = [];
  const config = { workspace, agent: { provider: "openai-compatible", model: "unused", apiKeyEnv: "UNUSED", baseUrl: "http://127.0.0.1:1", endpoint: "/chat/completions", maxTokens: 100, systemPrompt: "unused" }, mcp: { servers: {} }, version: 1 } as SecAgentConfig;
  let runtime: SecAgentRuntime | undefined;
  try {
    await manager.initialize();
    await manager.install(archivePath);
    runtime = new SecAgentRuntime(config, audit, [], (event) => traces.push(event.stage), manager);
    const result = await runtime.run("点名", "high", [{ role: "user", content: "点名" }]);
    assert.equal(result.message, "抽到：Alice");
    assert.equal(traces.includes("secagent.pre-rule/match"), true);
    assert.equal(traces.includes("model.agent.request"), false);
  } finally {
    await runtime?.close();
    audit.close();
    await manager.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a failed plugin pre-rule is provided to the model instead of ending the run", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-runtime-pre-rule-error-"));
  const archivePath = path.join(workspace, "pre-rule-error.zip");
  const archive = new AdmZip() as unknown as { addFile(name: string, data: Buffer): void; writeZip(file: string): void };
  archive.addFile("secagent-plugin.json", Buffer.from(JSON.stringify({ apiVersion: 1, id: "runtime-pre-rule-error", name: "Runtime pre-rule error", version: "1.0.0", main: "main.mjs", permissions: ["agent.tools", "agent.pre_rules"] })));
  archive.addFile("main.mjs", Buffer.from(`
export function activate(api) {
  api.registerTool({ name: "draw", description: "draw", hidden: true, inputSchema: { type: "object" } }, async () => { throw new Error("名单服务不可用"); });
  api.registerPreRule("draw_command", (input) => input === "点名" ? { tool: "draw", arguments: {} } : undefined);
}
`));
  archive.writeZip(archivePath);
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.TEST_MODEL_KEY;
  const traces: Array<{ stage: string; data: unknown }> = [];
  let requestBody: { messages?: Array<{ role?: string; content?: string }> } | undefined;
  process.env.TEST_MODEL_KEY = "test-key";
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body || "{}")) as typeof requestBody;
    return new Response('data: {"choices":[{"delta":{"content":"名单服务暂不可用。"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const manager = new PluginManager(workspace);
  const audit = new AuditStore(workspace);
  let runtime: SecAgentRuntime | undefined;
  try {
    await manager.initialize();
    await manager.install(archivePath);
    const config = { workspace, agent: { provider: "openai-compatible", model: "unused", apiKeyEnv: "TEST_MODEL_KEY", baseUrl: "https://model.test", endpoint: "/chat/completions", maxTokens: 100, systemPrompt: "unused" }, mcp: { servers: {} }, version: 1 } as SecAgentConfig;
    runtime = new SecAgentRuntime(config, audit, [], (event) => traces.push({ stage: event.stage, data: event.data }), manager);
    const result = await runtime.run("点名", "high", [{ role: "user", content: "点名" }]);
    assert.equal(result.message, "名单服务暂不可用。");
    assert.equal(traces.some((event) => event.stage === "secagent.pre-rule/error"), true);
    assert.equal(traces.some((event) => event.stage === "model.agent.request"), true);
    const failureContext = requestBody?.messages?.find((message) => message.role === "system" && message.content?.includes("名单服务不可用"));
    assert.ok(failureContext);
    assert.match(failureContext.content || "", /tool_execution_failed/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousKey;
    await runtime?.close();
    audit.close();
    await manager.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

/** 1x1 transparent PNG used to exercise the vision tool path. */
const TEST_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function visionTestConfig(workspace: string, defaults: { visionModelId?: string; customModelMode?: boolean }): SecAgentConfig {
  return {
    workspace,
    agent: {
      provider: "openai-compatible",
      model: "main",
      apiKeyEnv: "TEST_MODEL_KEY",
      baseUrl: "https://main.test/v1",
      endpoint: "/chat/completions",
      maxTokens: 100,
      systemPrompt: "unused",
      models: [
        { id: "main", provider: "openai-compatible", model: "main", apiKeyEnv: "TEST_MODEL_KEY", baseUrl: "https://main.test/v1", endpoint: "/chat/completions", maxTokens: 100 },
        { id: "vision", provider: "openai-compatible", model: "vision-model", apiKeyEnv: "VISION_MODEL_KEY", baseUrl: "https://vision.test/v1", endpoint: "/chat/completions", maxTokens: 100 }
      ]
    },
    mcp: { servers: {} },
    version: 1,
    defaults
  } as SecAgentConfig;
}

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("secagent__look_at_image sends the image to the vision model and returns its text", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-vision-ok-"));
  const originalFetch = globalThis.fetch;
  const previousMain = process.env.TEST_MODEL_KEY;
  const previousVision = process.env.VISION_MODEL_KEY;
  const requestBodies: Array<{ messages?: Array<Record<string, unknown>> }> = [];
  let requestCount = 0;
  try {
    fs.writeFileSync(path.join(workspace, "test.png"), Buffer.from(TEST_PNG_BASE64, "base64"));
    process.env.TEST_MODEL_KEY = "main-key";
    process.env.VISION_MODEL_KEY = "vision-key";
    globalThis.fetch = async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body || "{}")) as { messages?: Array<Record<string, unknown>> });
      requestCount += 1;
      if (requestCount === 1) return sse('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"secagent__look_at_image","arguments":"{\\"path\\":\\"test.png\\",\\"prompt\\":\\"图中是什么颜色\\"}"}}]}}]}\n\ndata: [DONE]\n\n');
      if (requestCount === 2) return sse('data: {"choices":[{"delta":{"content":"红色的圆。"}}]}\n\ndata: [DONE]\n\n');
      return sse('data: {"choices":[{"delta":{"content":"图片内容：红色的圆。"}}]}\n\ndata: [DONE]\n\n');
    };
    const audit = new AuditStore(workspace);
    const traces: string[] = [];
    const config = visionTestConfig(workspace, { visionModelId: "vision" });
    const runtime = new SecAgentRuntime(config, audit, [], (event) => traces.push(event.stage), undefined, resolveVisionAgentConfig(config));
    try {
      const result = await runtime.run("看看这张图片", "high", [{ role: "user", content: "看看这张图片" }]);
      assert.equal(result.message, "图片内容：红色的圆。");
      assert.equal(requestCount, 3);
      // Vision sub-model request carries the prompt and the image dataUrl.
      const visionBody = requestBodies[1]?.messages || [];
      const userContent = visionBody[1]?.content as Array<{ type?: string; text?: string; image_url?: { url?: string } }>;
      assert.ok(Array.isArray(userContent));
      assert.equal(userContent[0]?.type, "text");
      assert.equal(userContent[0]?.text, "图中是什么颜色");
      assert.equal(userContent[1]?.type, "image_url");
      assert.match(userContent[1]?.image_url?.url || "", /^data:image\/png;base64,/);
      assert.equal(traces.includes("secagent.tools/call"), true);
      assert.equal(traces.includes("vision.model.request"), true);
    } finally {
      await runtime.close();
      audit.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMain === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousMain;
    if (previousVision === undefined) delete process.env.VISION_MODEL_KEY;
    else process.env.VISION_MODEL_KEY = previousVision;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("secagent__look_at_image reports a clear error when no vision model is configured", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-vision-none-"));
  const originalFetch = globalThis.fetch;
  const previousMain = process.env.TEST_MODEL_KEY;
  let requestCount = 0;
  let secondBody = "";
  try {
    fs.writeFileSync(path.join(workspace, "test.png"), Buffer.from(TEST_PNG_BASE64, "base64"));
    process.env.TEST_MODEL_KEY = "main-key";
    globalThis.fetch = async (_url, init) => {
      requestCount += 1;
      if (requestCount === 2) secondBody = String(init?.body || "");
      return requestCount === 1
        ? sse('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"secagent__look_at_image","arguments":"{\\"path\\":\\"test.png\\",\\"prompt\\":\\"图中是什么\\"}"}}]}}]}\n\ndata: [DONE]\n\n')
        : sse('data: {"choices":[{"delta":{"content":"识图功能当前不可用。"}}]}\n\ndata: [DONE]\n\n');
    };
    const audit = new AuditStore(workspace);
    const traces: string[] = [];
    // No visionModelId and customModelMode undefined → no fallback, no vision agent.
    const config = visionTestConfig(workspace, { visionModelId: undefined });
    assert.equal(resolveVisionAgentConfig(config), undefined);
    const runtime = new SecAgentRuntime(config, audit, [], (event) => traces.push(event.stage), undefined, resolveVisionAgentConfig(config));
    try {
      const result = await runtime.run("看看这张图片", "high", [{ role: "user", content: "看看这张图片" }]);
      assert.equal(result.message, "识图功能当前不可用。");
      // Only the main agent requests happened; no vision sub-request.
      assert.equal(requestCount, 2);
      assert.equal(traces.includes("vision.model.request"), false);
      assert.match(secondBody, /未配置识图模型/);
    } finally {
      await runtime.close();
      audit.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMain === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousMain;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("secagent__look_at_image validates image input before any vision request", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-vision-bad-"));
  const originalFetch = globalThis.fetch;
  const previousMain = process.env.TEST_MODEL_KEY;
  const previousVision = process.env.VISION_MODEL_KEY;
  let requestCount = 0;
  let secondBody = "";
  try {
    fs.writeFileSync(path.join(workspace, "notes.txt"), "not an image");
    process.env.TEST_MODEL_KEY = "main-key";
    process.env.VISION_MODEL_KEY = "vision-key";
    globalThis.fetch = async (_url, init) => {
      requestCount += 1;
      if (requestCount === 2) secondBody = String(init?.body || "");
      return requestCount === 1
        ? sse('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"secagent__look_at_image","arguments":"{\\"path\\":\\"notes.txt\\",\\"prompt\\":\\"图里有什么\\"}"}}]}}]}\n\ndata: [DONE]\n\n')
        : sse('data: {"choices":[{"delta":{"content":"无法识别。"}}]}\n\ndata: [DONE]\n\n');
    };
    const audit = new AuditStore(workspace);
    const traces: string[] = [];
    const config = visionTestConfig(workspace, { visionModelId: "vision" });
    const runtime = new SecAgentRuntime(config, audit, [], (event) => traces.push(event.stage), undefined, resolveVisionAgentConfig(config));
    try {
      const result = await runtime.run("看看这个文件", "high", [{ role: "user", content: "看看这个文件" }]);
      assert.equal(result.message, "无法识别。");
      // The vision sub-model was never called (2 = main turn 1 + main turn 2).
      assert.equal(requestCount, 2);
      assert.equal(traces.includes("vision.model.request"), false);
      assert.match(secondBody, /仅支持 png、jpg、jpeg、webp、gif 图片/);
    } finally {
      await runtime.close();
      audit.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMain === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousMain;
    if (previousVision === undefined) delete process.env.VISION_MODEL_KEY;
    else process.env.VISION_MODEL_KEY = previousVision;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
