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
