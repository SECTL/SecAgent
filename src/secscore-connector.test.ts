import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { AuditStore } from "./audit.js";
import { PluginManager } from "./plugin-manager.js";
import { SecAgentRuntime, type TraceEvent } from "./runtime.js";
import type { SecAgentConfig } from "./types.js";

/**
 * End-to-end tests for the secscore-connector plugin (SECTL/SecScore-SecAgent-Connector).
 *
 * The connector is a pure Sync-Server client: it never talks to a local SecScore
 * install or creates a local database. These tests therefore stand in for both the
 * model (scripted SSE tool-call turns) and the SecScore backend (an in-memory fake
 * Sync Server exposing /v1/classes, /v1/snapshot, /v1/sync and /v1/operations).
 *
 * The plugin package under test is pinned as fixtures under
 * src/test-fixtures/secscore-connector/ so any upstream change to the tool keys,
 * argument names, permissions or Skill auto-load pattern fails these tests.
 */

interface SeedStudent { name: string; group: string; score: number }
interface ServerStudent { student_id: string; name: string; group_name: string; score: number; reward_points: number }
interface FakeSecScoreServer { port: number; close(): Promise<void>; state(): ServerStudent[] }

type ModelToolCall = { id: string; name: string; args: Record<string, unknown> };
type ModelTurn = { toolCalls?: ModelToolCall[]; answer?: string };

const CLASSES = [{ id: "class-1", name: "三年级二班" }];
const DEFAULT_STUDENTS: SeedStudent[] = [
  { name: "小明", group: "一组", score: 12 },
  { name: "小张", group: "一组", score: 10 },
  { name: "小泽", group: "一组", score: 9 },
  { name: "王强", group: "一组", score: 55 },
  { name: "小李", group: "二组", score: 60 },
  { name: "小红", group: "二组", score: 8 },
  { name: "小刚", group: "二组", score: 7 },
  { name: "小芳", group: "二组", score: 5 },
];

/** Locates the pinned plugin fixtures from both the compiled dist/ and source src/ layout. */
function fixtureDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "test-fixtures", "secscore-connector"),
    path.resolve(here, "..", "src", "test-fixtures", "secscore-connector"),
    path.join(process.cwd(), "src", "test-fixtures", "secscore-connector"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "secagent-plugin.json"))) return candidate;
  }
  throw new Error("找不到 secscore-connector 测试夹具目录");
}

/** Mirrors the connector's FNV-1a student ID derivation so fake balances line up. */
function deterministicStudentId(name: string): string {
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `${hex}-0000-5000-8000-${hex}${hex.slice(0, 4)}`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** In-memory SecScore Sync Server implementing the endpoints the connector calls. */
async function fakeSecScoreServer(classes: Array<{ id: string; name: string }>, seeds: SeedStudent[]): Promise<FakeSecScoreServer> {
  const studentsById = new Map<string, ServerStudent>();
  const students: ServerStudent[] = [];
  for (const seed of seeds) {
    const studentId = deterministicStudentId(seed.name);
    const student: ServerStudent = { student_id: studentId, name: seed.name, group_name: seed.group, score: seed.score, reward_points: seed.score };
    // Same-name seeds keep their own snapshot entry (the plugin rejects ambiguous names
    // itself), while the operation lookup map is keyed by the deterministic student ID.
    students.push(student);
    studentsById.set(studentId, student);
  }
  let changeSeq = 0;
  const balances = (): Array<{ student_id: string; score: number; reward_points: number }> =>
    students.map(({ student_id, score, reward_points }) => ({ student_id, score, reward_points }));
  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/v1/classes") return send(200, { classes });
    if (req.method === "GET" && url.pathname === "/v1/snapshot") {
      return send(200, { snapshot: { students: students.map(({ name, group_name, score }) => ({ name, group_name, score })) } });
    }
    if (req.method === "POST" && url.pathname === "/v1/sync") {
      return send(200, { server_change_seq: changeSeq, balances: balances() });
    }
    if (req.method === "POST" && url.pathname === "/v1/operations") {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw) as { operation?: { entity_id?: string; payload?: { score_delta?: number } } };
        const operation = body.operation || {};
        const student = operation.entity_id ? studentsById.get(operation.entity_id) : undefined;
        if (!student) return send(404, { error: "找不到学生" });
        const delta = Number(operation.payload?.score_delta ?? 0);
        student.score += delta;
        student.reward_points += delta;
        changeSeq += 1;
        send(200, { server_change_seq: changeSeq, accepted_operations: [{ server_change_seq: changeSeq }], balances: balances() });
      }).catch((error) => send(400, { error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    send(404, { error: `未知端点 ${req.method} ${url.pathname}` });
  });
  port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  return {
    port,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
    state: () => [...students],
  };
}

/** Serializes one scripted model turn into an OpenAI-compatible SSE response body. */
function sseBody(turn: ModelTurn): string {
  if (turn.toolCalls?.length) {
    const calls = turn.toolCalls.map((call, index) =>
      `{"index":${index},"id":${JSON.stringify(call.id)},"type":"function","function":{"name":${JSON.stringify(call.name)},"arguments":${JSON.stringify(JSON.stringify(call.args))}}}`
    );
    return `data: {"choices":[{"delta":{"tool_calls":[${calls.join(",")}]}}]}\n\ndata: [DONE]\n\n`;
  }
  return `data: {"choices":[{"delta":{"content":${JSON.stringify(turn.answer ?? "")}}}]}\n\ndata: [DONE]\n\n`;
}

class SecScoreHarness {
  readonly workspace: string;
  readonly manager: PluginManager;
  readonly audit: AuditStore;
  readonly runtime: SecAgentRuntime;
  readonly traces: TraceEvent[];
  readonly server: FakeSecScoreServer;
  readonly modelBodies: string[];
  readonly result: Awaited<ReturnType<SecAgentRuntime["run"]>>;
  private readonly restoreEnv: () => void;
  private readonly restoreFetch: () => void;
  private closed = false;

  private constructor(
    workspace: string,
    manager: PluginManager,
    audit: AuditStore,
    runtime: SecAgentRuntime,
    traces: TraceEvent[],
    server: FakeSecScoreServer,
    modelBodies: string[],
    result: SecScoreHarness["result"],
    restoreEnv: () => void,
    restoreFetch: () => void
  ) {
    this.workspace = workspace;
    this.manager = manager;
    this.audit = audit;
    this.runtime = runtime;
    this.traces = traces;
    this.server = server;
    this.modelBodies = modelBodies;
    this.result = result;
    this.restoreEnv = restoreEnv;
    this.restoreFetch = restoreFetch;
  }

  static async create(prompt: string, turns: ModelTurn[], students: SeedStudent[]): Promise<SecScoreHarness> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-secscore-"));
    const originalFetch = globalThis.fetch;
    const envKeys = ["SECSCORE_SYNC_SERVER_URL", "SECSCORE_SYNC_API_URL", "TEST_MODEL_KEY", "SECTL_OFFICIAL_API_URL", "SECTL_OFFICIAL_CLIENT_ID"] as const;
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<(typeof envKeys)[number], string | undefined>;
    let server: FakeSecScoreServer | undefined;
    let manager: PluginManager | undefined;
    let audit: AuditStore | undefined;
    let runtime: SecAgentRuntime | undefined;
    const restoreEnv = (): void => {
      for (const key of envKeys) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    try {
      const archivePath = path.join(workspace, "secscore-connector.zip");
      const fixtures = fixtureDir();
      const archive = new AdmZip();
      for (const file of ["main.mjs", "secagent-plugin.json", "icon.svg"]) archive.addFile(file, fs.readFileSync(path.join(fixtures, file)));
      archive.addFile("skills/secscore/SKILL.md", fs.readFileSync(path.join(fixtures, "skills", "secscore", "SKILL.md")));
      archive.writeZip(archivePath);

      server = await fakeSecScoreServer(CLASSES, students);
      const serverPort = server.port;
      process.env.SECSCORE_SYNC_SERVER_URL = `http://127.0.0.1:${serverPort}`;
      process.env.TEST_MODEL_KEY = "test-key";
      delete process.env.SECSCORE_SYNC_API_URL;
      delete process.env.SECTL_OFFICIAL_API_URL;
      delete process.env.SECTL_OFFICIAL_CLIENT_ID;

      const modelBodies: string[] = [];
      let modelRequestCount = 0;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
        if (url.includes("/chat/completions")) {
          const body = sseBody(turns[modelRequestCount]);
          if (body === undefined) throw new Error(`模型请求次数超出脚本：第 ${modelRequestCount + 1} 次`);
          modelBodies.push(String(init?.body ?? ""));
          modelRequestCount += 1;
          return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        if (url.startsWith(`http://127.0.0.1:${serverPort}`)) return originalFetch(input, init);
        throw new Error(`测试中出现了未预期的网络请求：${url}`);
      };

      manager = new PluginManager(workspace, {
        getSession: async () => ({ accessToken: "test-token", userId: "u1", email: "teacher@example.com", name: "测试老师" }),
        oauthLogin: async () => { throw new Error("测试中不应触发 OAuth 登录"); },
      });
      audit = new AuditStore(workspace);
      await manager.initialize();
      await manager.install(archivePath);
      const config = {
        workspace,
        agent: {
          provider: "openai-compatible",
          model: "unused",
          apiKeyEnv: "TEST_MODEL_KEY",
          baseUrl: "http://127.0.0.1:1",
          endpoint: "/chat/completions",
          maxTokens: 200,
          systemPrompt: "unused",
        },
        mcp: { servers: {} },
        version: 1,
      } as SecAgentConfig;
      const traces: TraceEvent[] = [];
      runtime = new SecAgentRuntime(config, audit, manager.getSkills(), (event) => traces.push(event), manager);
      const result = await runtime.run(prompt, "high", [{ role: "user", content: prompt }]);
      return new SecScoreHarness(workspace, manager, audit, runtime, traces, server, modelBodies, result, restoreEnv, () => { globalThis.fetch = originalFetch; });
    } catch (error) {
      globalThis.fetch = originalFetch;
      restoreEnv();
      await runtime?.close().catch(() => undefined);
      audit?.close();
      await manager?.shutdown().catch(() => undefined);
      await server?.close().catch(() => undefined);
      fs.rmSync(workspace, { recursive: true, force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.runtime.close().catch(() => undefined);
    this.audit.close();
    await this.manager.shutdown().catch(() => undefined);
    await this.server.close().catch(() => undefined);
    this.restoreEnv();
    this.restoreFetch();
    fs.rmSync(this.workspace, { recursive: true, force: true });
  }

  toolCalls(): Array<{ name: string; arguments: Record<string, unknown> }> {
    return this.traces.filter((event) => event.stage === "mcp.tools/call").map((event) => event.data as { name: string; arguments: Record<string, unknown> });
  }

  listedTools(): Array<{ key: string; hidden: boolean }> {
    const event = this.traces.find((trace) => trace.stage === "mcp.tools/list");
    return (event?.data as Array<{ key: string; hidden: boolean }>) || [];
  }
}

test("查询单个同学积分（小明有几分）：隐藏工具 + 正确分数", async () => {
  const harness = await SecScoreHarness.create(
    "小明有几分",
    [
      { toolCalls: [{ id: "call-find", name: "secagent__call_hidden_tool", args: { name: "secscore-connector__find_students", arguments: { query: "小明" } } }] },
      { answer: "小明当前有 12 分。" },
    ],
    DEFAULT_STUDENTS
  );
  try {
    assert.match(harness.result.message, /小明/);
    assert.match(harness.result.message, /12/);

    // Plugin tool visibility contract: add_score is visible, everything else hidden.
    const listed = harness.listedTools();
    assert.equal(listed.find((tool) => tool.key === "secscore-connector__add_score")?.hidden, false);
    for (const key of ["secscore-connector__list_students", "secscore-connector__find_students", "secscore-connector__list_groups", "secscore-connector__list_group_members"]) {
      assert.equal(listed.find((tool) => tool.key === key)?.hidden, true, `${key} 应为隐藏工具`);
    }

    const calls = harness.toolCalls();
    assert.equal(calls.length, 1);
    // 模型脚本通过 secagent__call_hidden_tool 包装调用隐藏工具，运行时按解析后的 key 执行。
    assert.match(harness.modelBodies[0], /secagent__call_hidden_tool/);
    assert.equal(calls[0].name, "secscore-connector__find_students");
    assert.deepEqual(calls[0].arguments, { query: "小明" });
    assert.equal(calls.some((call) => call.name === "secscore-connector__add_score"), false);

    assert.equal(harness.server.state().find((item) => item.name === "小明")?.score, 12);
    assert.equal(harness.audit.list().some((record) => record.tool === "secscore-connector__find_students"), true);
  } finally {
    await harness.close();
  }
});

test("批量加分（给小明小张和小泽加两份）：三次 add_score 同步到云端", async () => {
  const harness = await SecScoreHarness.create(
    "给小明小张和小泽加两份，昨天主动帮忙值日了",
    [
      {
        toolCalls: [
          { id: "call-1", name: "secscore-connector__add_score", args: { student_name: "小明", score: 2, reason: "昨天主动帮忙值日了" } },
          { id: "call-2", name: "secscore-connector__add_score", args: { student_name: "小张", score: 2, reason: "昨天主动帮忙值日了" } },
          { id: "call-3", name: "secscore-connector__add_score", args: { student_name: "小泽", score: 2, reason: "昨天主动帮忙值日了" } },
        ],
      },
      { answer: "已给小明、小张、小泽各加 2 分，原因：昨天主动帮忙值日了。" },
    ],
    DEFAULT_STUDENTS
  );
  try {
    const calls = harness.toolCalls();
    assert.deepEqual(calls.map((call) => call.name), ["secscore-connector__add_score", "secscore-connector__add_score", "secscore-connector__add_score"]);
    assert.deepEqual(calls.map((call) => call.arguments.student_name), ["小明", "小张", "小泽"]);
    for (const call of calls) {
      assert.equal(call.arguments.score, 2);
      assert.equal(call.arguments.reason, "昨天主动帮忙值日了");
    }

    const state = harness.server.state();
    assert.equal(state.find((item) => item.name === "小明")?.score, 14);
    assert.equal(state.find((item) => item.name === "小张")?.score, 12);
    assert.equal(state.find((item) => item.name === "小泽")?.score, 11);
    assert.equal(state.find((item) => item.name === "小李")?.score, 60);

    const addScoreAudits = harness.audit.list().filter((record) => record.tool === "secscore-connector__add_score");
    assert.equal(addScoreAudits.length, 3);
    const auditedNames = addScoreAudits.map((record) => (JSON.parse(record.params || "{}") as { student_name: string }).student_name).sort();
    assert.deepEqual(auditedNames, ["小明", "小张", "小泽"].sort());
    for (const record of addScoreAudits) {
      const params = JSON.parse(record.params || "{}") as { score: number; reason: string };
      assert.equal(params.score, 2);
      assert.equal(params.reason, "昨天主动帮忙值日了");
    }

    assert.match(harness.result.message, /小明/);
    assert.match(harness.result.message, /小张/);
    assert.match(harness.result.message, /小泽/);
  } finally {
    await harness.close();
  }
});

test("按分组加分（给一组所有人加一分）：先查分组再逐个加分", async () => {
  const harness = await SecScoreHarness.create(
    "给一组所有人加一分",
    [
      { toolCalls: [{ id: "call-groups", name: "secagent__call_hidden_tool", args: { name: "secscore-connector__list_group_members", arguments: { group_name: "一组" } } }] },
      {
        toolCalls: [
          { id: "call-a", name: "secscore-connector__add_score", args: { student_name: "小明", score: 1, reason: "给一组所有人加一分" } },
          { id: "call-b", name: "secscore-connector__add_score", args: { student_name: "小张", score: 1, reason: "给一组所有人加一分" } },
          { id: "call-c", name: "secscore-connector__add_score", args: { student_name: "小泽", score: 1, reason: "给一组所有人加一分" } },
          { id: "call-d", name: "secscore-connector__add_score", args: { student_name: "王强", score: 1, reason: "给一组所有人加一分" } },
        ],
      },
      { answer: "已给一组全部 4 名同学各加 1 分。" },
    ],
    DEFAULT_STUDENTS
  );
  try {
    const calls = harness.toolCalls();
    assert.equal(calls.length, 5);
    assert.equal(calls[0].name, "secscore-connector__list_group_members");
    assert.deepEqual(calls[0].arguments, { group_name: "一组" });
    const addCalls = calls.slice(1);
    assert.deepEqual(addCalls.map((call) => call.arguments.student_name), ["小明", "小张", "小泽", "王强"]);
    for (const call of addCalls) assert.equal(call.arguments.score, 1);

    const state = harness.server.state();
    assert.equal(state.find((item) => item.name === "小明")?.score, 13);
    assert.equal(state.find((item) => item.name === "小张")?.score, 11);
    assert.equal(state.find((item) => item.name === "小泽")?.score, 10);
    assert.equal(state.find((item) => item.name === "王强")?.score, 56);
    assert.equal(state.find((item) => item.name === "小李")?.score, 60);
  } finally {
    await harness.close();
  }
});

test("总积分超过50的有哪些人：自动加载 Skill 且只查询不加分", async () => {
  const harness = await SecScoreHarness.create(
    "总积分超过50的有哪些人",
    [
      { toolCalls: [{ id: "call-list", name: "secagent__call_hidden_tool", args: { name: "secscore-connector__list_students", arguments: {} } }] },
      { answer: "总积分超过 50 的同学有：王强（55 分）、小李（60 分）。" },
    ],
    DEFAULT_STUDENTS
  );
  try {
    assert.match(harness.result.message, /王强/);
    assert.match(harness.result.message, /小李/);

    const autoLoads = harness.traces.filter((event) => event.stage === "secagent.skills/auto-load").flatMap((event) => (event.data as Array<{ name: string }>).map((skill) => skill.name));
    assert.ok(autoLoads.includes("secscore-connector/secscore"), "包含“积分”的提示词应自动加载 secscore Skill");

    const firstBody = harness.modelBodies[0];
    assert.match(firstBody, /已自动加载 Skill/);
    assert.match(firstBody, /secscore-connector\/secscore/);

    const calls = harness.toolCalls();
    assert.deepEqual(calls.map((call) => call.name), ["secscore-connector__list_students"]);
    assert.deepEqual(calls[0].arguments, {});
    assert.equal(calls.some((call) => call.name === "secscore-connector__add_score"), false);
  } finally {
    await harness.close();
  }
});

test("同名同学时加分失败：返回错误原因且云端积分不变", async () => {
  const students: SeedStudent[] = [
    { name: "小明", group: "一组", score: 12 },
    { name: "小明", group: "二组", score: 20 },
  ];
  const harness = await SecScoreHarness.create(
    "给小明加一分",
    [
      { toolCalls: [{ id: "call-1", name: "secscore-connector__add_score", args: { student_name: "小明", score: 1, reason: "值日" } }] },
      { answer: "发现两位同名同学，请补充更完整姓名后再操作。" },
    ],
    students
  );
  try {
    const calls = harness.toolCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "secscore-connector__add_score");
    // 第二轮模型请求必须带回工具失败的错误结果。
    assert.match(harness.modelBodies[1], /同名/);
    // 云端没有收到任何 operations，积分保持不变。
    const state = harness.server.state();
    assert.deepEqual(state.map((item) => item.score).sort(), [12, 20]);
    assert.equal(harness.audit.list().some((record) => record.tool === "secscore-connector__add_score"), false);
  } finally {
    await harness.close();
  }
});
