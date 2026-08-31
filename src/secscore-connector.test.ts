import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { AuditStore } from "./audit.js";
import { PluginManager } from "./plugin-manager.js";
import { SecAgentRuntime, type RunResult } from "./runtime.js";
import { loadEnabledSkills } from "./skills.js";
import type { SecAgentConfig } from "./types.js";

// 联动插件 `SECTL/SecScore-SecAgent-Connector` 的源码副本。测试通过
// PluginManager.install() 动态打包安装，不依赖网络下载，也不连接真实的
// SecScore 云端或本地后端 —— SECSCORE_SYNC_SERVER_URL 指向本测试内的假服务器。
const PLUGIN_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "test-fixtures", "secscore-connector");
const SECSCORE_BASE_URL = "http://secscore.test";
const MODEL_BASE_URL = "http://127.0.0.1:1";
const MODEL_KEY_ENV = "SECSCORE_TEST_MODEL_KEY";
const ENV_KEYS = ["SECSCORE_SYNC_SERVER_URL", "SECTL_OFFICIAL_API_URL", "SECTL_OFFICIAL_CLIENT_ID", "SECTL_OFFICIAL_PLATFORM_ID"] as const;

interface SeedStudent { name: string; group_name: string; score: number }

const DEFAULT_SEED: SeedStudent[] = [
  { name: "小明", group_name: "一组", score: 40 },
  { name: "小张", group_name: "一组", score: 38 },
  { name: "小泽", group_name: "一组", score: 35 },
  { name: "小李", group_name: "二组", score: 60 },
  { name: "小王", group_name: "二组", score: 55 },
  { name: "小刘", group_name: "二组", score: 30 },
];

interface FakeOperation {
  class_id: string;
  op_id: string;
  student_id: string;
  student_name: string;
  score_delta: number;
  reason: string;
  client_seq: number;
}

interface FakeBalance { student_id: string; score: number; reward_points: number }

/**
 * 与插件 `main.mjs` 中 deterministicStudentId 完全一致的 FNV-1a 实现，
 * 保证假服务器返回的 balances 的 student_id 与插件计算的一致。
 */
function deterministicStudentId(name: string): string {
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `${hex}-0000-5000-8000-${hex}${hex.slice(0, 4)}`;
}

/** 内存版 SecScore 后端：实现插件用到的 /v1/classes、/v1/snapshot、/v1/sync、/v1/operations。 */
class FakeSecScoreServer {
  private students: Array<{ student_id: string; name: string; group_name: string; score: number; reward_points: number }>;
  private seq = 0;
  readonly operations: FakeOperation[] = [];
  constructor(seed: SeedStudent[]) {
    this.students = seed.map((item) => ({
      student_id: deterministicStudentId(item.name),
      name: item.name,
      group_name: item.group_name,
      score: item.score,
      reward_points: item.score,
    }));
  }
  scoreOf(name: string): number {
    return this.students.find((item) => item.name === name)?.score ?? 0;
  }
  operationCount(): number { return this.operations.length; }
  handle(input: string | URL, init?: RequestInit): Response {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/v1/classes") return json({ classes: [{ id: "class-1", name: "测试班" }] });
    if (url.pathname === "/v1/snapshot") {
      return json({ snapshot: { students: this.students.map((item) => ({ id: item.student_id, name: item.name, group_name: item.group_name, score: item.score })) } });
    }
    if (url.pathname === "/v1/sync") return json({ balances: this.balances(), server_change_seq: this.seq });
    if (url.pathname === "/v1/operations" && init?.method === "POST") {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(String(init.body || "{}")) as Record<string, unknown>; } catch { /* ignore malformed body */ }
      const operation = (body.operation || {}) as { op_id?: string; entity_id?: string; payload?: { student_name?: string; reason_content?: string; score_delta?: number } };
      const delta = Number(operation.payload?.score_delta ?? 0);
      const student = this.students.find((item) => item.student_id === operation.entity_id);
      if (student) { student.score += delta; student.reward_points += delta; }
      this.seq += 1;
      this.operations.push({
        class_id: String(body.class_id ?? ""),
        op_id: operation.op_id || "",
        student_id: operation.entity_id || "",
        student_name: operation.payload?.student_name || "",
        score_delta: delta,
        reason: operation.payload?.reason_content || "",
        client_seq: Number(body.client_seq ?? 0),
      });
      return json({
        balances: this.balances(),
        server_change_seq: this.seq,
        accepted_operations: [{ op_id: operation.op_id, server_change_seq: this.seq }],
      });
    }
    return json({ error: `假服务未实现的端点：${url.pathname}` }, 404);
  }
  private balances(): FakeBalance[] {
    return this.students.map((item) => ({ student_id: item.student_id, score: item.score, reward_points: item.reward_points }));
  }
}

type TraceEntry = { stage: string; data: unknown };

/** 把插件 fixture 打包成 PluginManager.install() 可识别的 zip。 */
function buildPluginArchive(workspace: string): string {
  const archivePath = path.join(workspace, "secscore-connector.zip");
  const archive = new AdmZip() as unknown as { addFile(name: string, data: Buffer): void; writeZip(file: string): void };
  archive.addFile("secagent-plugin.json", fs.readFileSync(path.join(PLUGIN_FIXTURES, "secagent-plugin.json")));
  archive.addFile("main.mjs", fs.readFileSync(path.join(PLUGIN_FIXTURES, "main.mjs")));
  archive.addFile("icon.svg", fs.readFileSync(path.join(PLUGIN_FIXTURES, "icon.svg")));
  archive.addFile("skills/secscore/SKILL.md", fs.readFileSync(path.join(PLUGIN_FIXTURES, "skills", "secscore", "SKILL.md")));
  archive.writeZip(archivePath);
  return archivePath;
}

/** 组装 openai-compatible 流式响应。 */
function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
function modelTurn(...events: unknown[]): string {
  return `${events.map((event) => sse(event)).join("")}data: [DONE]\n\n`;
}
function answer(text: string): string {
  return modelTurn({ choices: [{ delta: { content: text } }] });
}
function callTools(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): string {
  return modelTurn({
    choices: [{
      delta: {
        tool_calls: calls.map((call, index) => ({ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } })),
      },
    }],
  });
}
const hiddenTool = (id: string, name: string, args: Record<string, unknown>) => ({ id, name: "secagent__call_hidden_tool", args: { name, arguments: args } });
const addScore = (id: string, studentName: string, score: number, reason: string) => ({ id, name: "secscore-connector__add_score", args: { student_name: studentName, score, reason } });

function completed(result: RunResult): Extract<RunResult, { kind: "completed" }> {
  assert.equal(result.kind, "completed");
  return result;
}

interface RunOutcome {
  result: RunResult;
  traces: TraceEntry[];
  server: FakeSecScoreServer;
  audit: ReturnType<AuditStore["list"]>;
}

/**
 * 安装 secscore-connector 插件并在两层 mock 下运行一次完整会话：
 *  - 模型端点（/chat/completions）返回脚本化的 SSE 工具调用与回答序列；
 *  - SECSCORE_SYNC_SERVER_URL 指向内存假后端，记录加扣分操作与积分变化。
 */
async function runWithSecScore(prompt: string, script: string[], seed: SeedStudent[] = DEFAULT_SEED): Promise<RunOutcome> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-secscore-"));
  const originalFetch = globalThis.fetch;
  const previousEnv = new Map<string, string | undefined>();
  const server = new FakeSecScoreServer(seed);
  const traces: TraceEntry[] = [];
  let modelRequests = 0;
  let runtime: SecAgentRuntime | undefined;
  let audit: AuditStore | undefined;
  let manager: PluginManager | undefined;
  try {
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    process.env.SECSCORE_SYNC_SERVER_URL = SECSCORE_BASE_URL;
    for (const key of ["SECTL_OFFICIAL_API_URL", "SECTL_OFFICIAL_CLIENT_ID", "SECTL_OFFICIAL_PLATFORM_ID"]) delete process.env[key];
    process.env[MODEL_KEY_ENV] = "test-key";

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(SECSCORE_BASE_URL)) return server.handle(url, init);
      if (url.includes("/chat/completions")) {
        const body = script[modelRequests];
        modelRequests += 1;
        if (body === undefined) throw new Error(`模型请求超出脚本长度（第 ${modelRequests} 次）：${url}`);
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      throw new Error(`测试中出现未预期的网络请求：${url}`);
    };

    manager = new PluginManager(workspace, {
      getSession: async () => ({ accessToken: "test-token", userId: "u1", email: "teacher@test", name: "测试教师" }),
      oauthLogin: async () => { throw new Error("测试中不使用 OAuth 登录"); },
    });
    audit = new AuditStore(workspace);
    await manager.initialize();
    await manager.install(buildPluginArchive(workspace));
    assert.equal(manager.list()[0]?.state, "ready", "插件激活后应处于 ready 状态（假后端 /v1/classes 必须在激活期可用）");

    const config = {
      version: 1,
      workspace,
      agent: { provider: "openai-compatible", model: "test-model", apiKeyEnv: MODEL_KEY_ENV, baseUrl: MODEL_BASE_URL, endpoint: "/chat/completions", maxTokens: 1024, systemPrompt: "测试" },
      mcp: { servers: {} },
    } as SecAgentConfig;
    const skills = [...loadEnabledSkills(config), ...manager.getSkills()];
    runtime = new SecAgentRuntime(config, audit, skills, (event) => traces.push({ stage: event.stage, data: event.data }), manager);
    // 必须带会话上下文，运行时才会对当前用户消息执行 Skill 自动加载。
    const result = await runtime.run(prompt, "high", [{ role: "user", content: prompt }]);
    return { result, traces, server, audit: audit.list() };
  } finally {
    await runtime?.close();
    audit?.close();
    await manager?.shutdown();
    globalThis.fetch = originalFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env[MODEL_KEY_ENV];
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function toolCalls(traces: TraceEntry[]): Array<{ name: string; arguments: Record<string, unknown> }> {
  return traces.filter((entry) => entry.stage === "mcp.tools/call").map((entry) => entry.data as { name: string; arguments: Record<string, unknown> });
}

test("查询单个同学积分：小明有几分", async () => {
  const { result, traces, server, audit } = await runWithSecScore("小明有几分", [
    callTools([hiddenTool("call-1", "secscore-connector__find_students", { query: "小明" })]),
    answer("小明当前有 40 分。"),
  ]);
  const outcome = completed(result);
  assert.ok(outcome.message.includes("40"), `回答应包含小明当前积分：${outcome.message}`);
  const calls = toolCalls(traces);
  assert.equal(calls.some((call) => call.name === "secscore-connector__find_students"), true, "应通过隐藏工具查询同学");
  assert.equal(server.operationCount(), 0, "查询不应产生任何加扣分操作");
  assert.equal(outcome.autoLoadedSkills?.includes("secscore-connector/secscore"), false, "「小明有几分」不命中积分关键词，不自动加载 Skill");
  assert.equal(audit.some((record) => record.tool === "secscore-connector__find_students"), true, "隐藏工具调用应写入审计记录");
});

test("给小明小张和小泽加两份并附理由", async () => {
  const reason = "昨天主动帮忙值日了";
  const { result, traces, server, audit } = await runWithSecScore("给小明小张和小泽加两份，昨天主动帮忙值日了", [
    callTools([
      addScore("call-1", "小明", 2, reason),
      addScore("call-2", "小张", 2, reason),
      addScore("call-3", "小泽", 2, reason),
    ]),
    answer("已为小明、小张、小泽各加 2 分，云端已同步。"),
  ]);
  const outcome = completed(result);
  assert.ok(outcome.autoLoadedSkills?.includes("secscore-connector/secscore"), "「加分」应触发 Skill 自动加载");
  assert.equal(server.operationCount(), 3, "假后端应收 3 条加分操作");
  assert.deepEqual(server.operations.map((op) => ({ name: op.student_name, delta: op.score_delta, reason: op.reason })), [
    { name: "小明", delta: 2, reason },
    { name: "小张", delta: 2, reason },
    { name: "小泽", delta: 2, reason },
  ]);
  assert.equal(server.scoreOf("小明"), 42);
  assert.equal(server.scoreOf("小张"), 40);
  assert.equal(server.scoreOf("小泽"), 37);
  const addScoreAudits = audit.filter((record) => record.tool === "secscore-connector__add_score");
  assert.equal(addScoreAudits.length, 3, "三次 add_score 都应写入审计记录");
});

test("给一组所有人加一分", async () => {
  const { result, traces, server } = await runWithSecScore("给一组所有人加一分", [
    callTools([hiddenTool("call-1", "secscore-connector__list_group_members", { group_name: "一组" })]),
    callTools([
      addScore("call-2", "小明", 1, "一组全员加分"),
      addScore("call-3", "小张", 1, "一组全员加分"),
      addScore("call-4", "小泽", 1, "一组全员加分"),
    ]),
    answer("已为一组的小明、小张、小泽各加 1 分。"),
  ]);
  const outcome = completed(result);
  assert.ok(outcome.autoLoadedSkills?.includes("secscore-connector/secscore"));
  const calls = toolCalls(traces);
  assert.equal(calls.some((call) => call.name === "secscore-connector__list_group_members" && call.arguments.group_name === "一组"), true, "应先按分组列出组员");
  assert.equal(server.operationCount(), 3, "加分量应等于一组组员数");
  assert.ok(server.operations.every((op) => op.score_delta === 1));
  assert.deepEqual([server.scoreOf("小明"), server.scoreOf("小张"), server.scoreOf("小泽")], [41, 39, 36]);
  assert.equal(server.scoreOf("小李"), 60, "二组同学不应受影响");
});

test("总积分超过50的有哪些人", async () => {
  const { result, traces, server, audit } = await runWithSecScore("总积分超过50的有哪些人", [
    callTools([hiddenTool("call-1", "secscore-connector__list_students", {})]),
    answer("总积分超过 50 的有：小李（60分）、小王（55分）。"),
  ]);
  const outcome = completed(result);
  assert.ok(outcome.message.includes("小李") && outcome.message.includes("小王"), `回答应列出超过 50 分的同学：${outcome.message}`);
  assert.ok(outcome.autoLoadedSkills?.includes("secscore-connector/secscore"), "「积分」应触发 Skill 自动加载");
  const calls = toolCalls(traces);
  assert.equal(calls.some((call) => call.name === "secscore-connector__list_students"), true, "应通过隐藏工具列出全班同学");
  assert.equal(calls.some((call) => call.name === "secscore-connector__add_score"), false, "纯查询不应调用写工具");
  assert.equal(server.operationCount(), 0);
  assert.equal(audit.some((record) => record.tool === "secscore-connector__add_score"), false);
});

test("同名同学触发「找到多个同名或相似同学」报错并回传模型", async () => {
  const seed: SeedStudent[] = [
    { name: "小明", group_name: "一组", score: 40 },
    { name: "小明", group_name: "二组", score: 45 },
    { name: "小张", group_name: "一组", score: 38 },
  ];
  const { result, traces, server, audit } = await runWithSecScore("给小明加一分，今天值日认真", [
    callTools([addScore("call-1", "小明", 1, "今天值日认真")]),
    answer("班里有两位同名同学，需要先确认给哪一位加分。"),
  ], seed);
  const outcome = completed(result);
  assert.equal(server.operationCount(), 0, "同名同学不应产生任何积分操作");
  assert.equal(server.scoreOf("小明"), 40);
  assert.equal(audit.some((record) => record.tool === "secscore-connector__add_score"), false);
  const bodies = traces.filter((entry) => entry.stage === "model.request").map((entry) => (entry.data as { body: { messages?: Array<{ content?: string | null }> } }).body);
  assert.equal(
    bodies.some((body) => body.messages?.some((message) => typeof message.content === "string" && message.content.includes("找到多个同名或相似同学"))),
    true,
    "插件抛出的错误应以工具结果形式回传给模型"
  );
});

test("add_score 对模型可见，其余查询工具必须隐藏", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-secscore-visibility-"));
  const originalFetch = globalThis.fetch;
  const server = new FakeSecScoreServer(DEFAULT_SEED);
  const previousEnv = new Map<string, string | undefined>();
  let manager: PluginManager | undefined;
  try {
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    process.env.SECSCORE_SYNC_SERVER_URL = SECSCORE_BASE_URL;
    for (const key of ["SECTL_OFFICIAL_API_URL", "SECTL_OFFICIAL_CLIENT_ID", "SECTL_OFFICIAL_PLATFORM_ID"]) delete process.env[key];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(SECSCORE_BASE_URL)) return server.handle(url, init);
      throw new Error(`测试中出现未预期的网络请求：${url}`);
    };
    manager = new PluginManager(workspace, {
      getSession: async () => ({ accessToken: "test-token", userId: "u1" }),
      oauthLogin: async () => { throw new Error("测试中不使用 OAuth 登录"); },
    });
    await manager.initialize();
    await manager.install(buildPluginArchive(workspace));
    const tools = manager.getTools();
    assert.deepEqual(tools.filter((tool) => !tool.hidden).map((tool) => tool.key), ["secscore-connector__add_score"], "只有 add_score 应对模型可见");
    assert.deepEqual(tools.filter((tool) => tool.hidden).map((tool) => tool.key).sort(), [
      "secscore-connector__find_students",
      "secscore-connector__list_group_members",
      "secscore-connector__list_groups",
      "secscore-connector__list_students",
    ], "查询工具必须隐藏，只能经 secagent__call_hidden_tool 调用");
  } finally {
    await manager?.shutdown();
    globalThis.fetch = originalFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
