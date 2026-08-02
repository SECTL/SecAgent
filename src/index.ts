#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { initializeWorkspace, loadConfig, normalizeAndValidate, useConfiguredModel } from "./config.js";
import { DEFAULT_WORKSPACE, expandPath } from "./paths.js";
import { loadEnabledSkills } from "./skills.js";
import { AuditStore } from "./audit.js";
import { SecAgentRuntime, type RunResult, type TraceEvent } from "./runtime.js";
import type { ConversationMessage } from "./model-provider.js";
import { SecScoreMcpAdapter } from "./mcp-adapter.js";
import { PluginManager } from "./plugin-manager.js";
import { SessionStore, type AssistantActivity, type SessionData, type ToolCallRecord } from "./session-store.js";
import type { ReasoningEffort } from "./types.js";

type CliOptions = {
  workspace: string;
  sessionId?: string;
  modelId?: string;
  reasoningEffort: ReasoningEffort;
  verbose: boolean;
  positionals: string[];
};

type RuntimeHandle = {
  runtime: SecAgentRuntime;
  audit: AuditStore;
  plugins: PluginManager;
};

function usage(): string {
  return `SecAgent CLI

Usage:
  secagent init [--workspace <dir>]
  secagent run <message> [--workspace <dir>] [--session <id>] [--model <id>] [--reasoning <none|low|medium|high>]
  secagent chat [--workspace <dir>] [--session <id>] [--model <id>] [--reasoning <none|low|medium|high>]
  secagent sessions list [--workspace <dir>]
  secagent sessions show <id> [--workspace <dir>]
  secagent undo <operation-id> [--workspace <dir>]
  secagent skills list [--workspace <dir>]
  secagent mcp list [--workspace <dir>]
  secagent config validate [--workspace <dir>]
  secagent doctor [--workspace <dir>]
  secagent audit list [--workspace <dir>]

Every run is saved as a session. Use the printed session id with --session to continue it.
Thinking and tool calls are printed by default; --verbose also prints raw model request/response traces.`;
}

function parseOptions(args: string[], start = 1): CliOptions {
  let workspace = DEFAULT_WORKSPACE;
  let sessionId: string | undefined;
  let modelId: string | undefined;
  let reasoningEffort: ReasoningEffort = "high";
  let verbose = false;
  const positionals: string[] = [];

  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--verbose" || arg === "--trace") { verbose = true; continue; }
    if (["--workspace", "--session", "--model", "--reasoning"].includes(arg)) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--workspace") workspace = expandPath(value);
      else if (arg === "--session") sessionId = value;
      else if (arg === "--model") modelId = value;
      else if (!["none", "low", "medium", "high"].includes(value)) throw new Error("--reasoning must be none, low, medium, or high");
      if (arg === "--reasoning") reasoningEffort = value as ReasoningEffort;
      continue;
    }
    positionals.push(arg);
  }
  return { workspace, sessionId, modelId, reasoningEffort, verbose, positionals };
}

function formatValue(value: unknown, limit = 12_000): string {
  let result: string;
  try {
    result = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch { result = String(value); }
  return result.length > limit ? `${result.slice(0, limit)}\n... [truncated]` : result;
}

/** Human-readable trace output for CLI debugging. This is intentionally on by default. */
class CliTracePrinter {
  private openStream: "thinking" | "summary" | "answer" | undefined;
  constructor(private readonly verbose: boolean) {}

  print(event: TraceEvent): void {
    const data = event.data as Record<string, unknown>;
    if (event.stage === "model.output.delta") {
      const kind = data.kind === "thinking" || data.kind === "summary" ? data.kind : "answer";
      const text = typeof data.text === "string" ? data.text : "";
      if (!text) return;
      if (this.openStream !== kind) {
        this.finishStream();
        process.stdout.write(`[${kind}] `);
        this.openStream = kind;
      }
      process.stdout.write(text);
      return;
    }

    this.finishStream();
    if (event.stage === "mcp.tools/call" || event.stage === "secagent.tools/call") {
      process.stdout.write(`[tool call] ${String(data.name || "unknown")}\n${formatValue(data.arguments ?? {})}\n`);
    } else if (event.stage === "mcp.tools/result" || event.stage === "secagent.tools/result") {
      process.stdout.write(`[tool result] ${String(data.name || "unknown")}\n${formatValue(data.result)}\n`);
    } else if (event.stage === "mcp.tools/list") {
      const tools = Array.isArray(event.data) ? event.data : [];
      process.stdout.write(`[tools] discovered ${tools.length} tool(s)\n`);
    } else if (event.stage === "mcp.tools/error") {
      process.stdout.write(`[tool discovery error] ${formatValue(event.data)}\n`);
    } else if (event.stage === "model.agent.request") {
      process.stdout.write(`[agent] ${String(data.provider || "?")} / ${String(data.model || "?")}\n`);
    } else if (event.stage === "assistant.response") {
      process.stdout.write("[agent] completed\n");
    } else if (event.stage === "runtime.error") {
      process.stdout.write(`[error] ${formatValue(data.message || event.data)}\n`);
    } else if (this.verbose) {
      process.stdout.write(`[trace] ${event.stage}\n${formatValue(event.data)}\n`);
    }
  }

  finishStream(): void {
    if (this.openStream) process.stdout.write("\n");
    this.openStream = undefined;
  }
}

function historyInput(session: SessionData, current: string): string {
  const history = session.messages.slice(-20).map((message) => `${message.role}: ${message.content}`).join("\n");
  return history ? `Conversation history:\n${history}\n\nNew user message:\n${current}` : current;
}

function conversationInput(session: SessionData, current: string): ConversationMessage[] {
  const history = session.messages.slice(-20).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.attachments?.length ? { attachments: message.attachments } : {})
  }));
  if (history[0]?.role === "assistant") history.shift();
  return [...history, { role: "user", content: current }];
}

async function openRuntime(workspace: string, modelId: string | undefined, trace: (event: TraceEvent) => void): Promise<RuntimeHandle> {
  const { config } = loadConfig(workspace);
  useConfiguredModel(config, modelId);
  const audit = new AuditStore(workspace);
  const plugins = new PluginManager(workspace);
  await plugins.initialize();
  const skills = [...loadEnabledSkills(config), ...plugins.getSkills()];
  return { runtime: new SecAgentRuntime(config, audit, skills, trace, plugins), audit, plugins };
}

async function closeRuntime(handle: RuntimeHandle | undefined): Promise<void> {
  if (!handle) return;
  await handle.plugins.shutdown().catch(() => undefined);
  handle.audit.close();
}

function captureActivity(event: TraceEvent, toolCalls: ToolCallRecord[], activities: AssistantActivity[]): void {
  if (event.stage === "model.output.delta") {
    const data = event.data as { text?: unknown; kind?: unknown; turn?: unknown };
    const kind = data.kind === "thinking" || data.kind === "summary" ? data.kind : undefined;
    if (kind && typeof data.text === "string") {
      const last = activities.at(-1);
      if (last?.kind === kind) last.content += data.text;
      else activities.push({ kind, content: data.text, ...(typeof data.turn === "number" ? { turn: data.turn } : {}) });
    }
  }
  if (event.stage === "mcp.tools/call" || event.stage === "secagent.tools/call") {
    const data = event.data as { name?: unknown; arguments?: unknown };
    if (typeof data.name === "string") {
      toolCalls.push({ name: data.name, arguments: data.arguments ?? {} });
      activities.push({ kind: "tool", name: data.name, arguments: data.arguments ?? {} });
    }
  }
  if (event.stage === "mcp.tools/result" || event.stage === "secagent.tools/result") {
    const data = event.data as { name?: unknown; result?: unknown };
    if (typeof data.name === "string") {
      const call = [...toolCalls].reverse().find((item) => item.name === data.name && !("result" in item));
      if (call) call.result = data.result;
      const activity = [...activities].reverse().find((item): item is Extract<AssistantActivity, { kind: "tool" }> => item.kind === "tool" && item.name === data.name && !("result" in item));
      if (activity) activity.result = data.result;
    }
  }
}

async function runSessionMessage(options: CliOptions, sessionId: string | undefined, text: string): Promise<{ session: SessionData; ok: boolean; created: boolean }> {
  const sessions = new SessionStore(options.workspace);
  const before = sessionId ? sessions.get(sessionId) : sessions.create();
  const created = !sessionId;
  const id = before.meta.id;
  const toolCalls: ToolCallRecord[] = [];
  const activities: AssistantActivity[] = [];
  const printer = new CliTracePrinter(options.verbose);
  let sequence = 0;
  const trace = (event: TraceEvent): void => {
    const ordered: TraceEvent = { sequence: ++sequence, at: new Date().toISOString(), stage: event.stage, data: event.data };
    captureActivity(ordered, toolCalls, activities);
    sessions.appendRuntimeEvent(id, ordered);
    printer.print(ordered);
  };

  sessions.appendMessage(id, "user", text);
  trace({ sequence: 0, at: new Date().toISOString(), stage: "user.request", data: { text } });
  let handle: RuntimeHandle | undefined;
  try {
    handle = await openRuntime(options.workspace, options.modelId, trace);
    const result = await handle.runtime.run(historyInput(before, text), options.reasoningEffort, conversationInput(before, text));
    sessions.appendMessage(id, "assistant", result.message, toolCalls, activities);
    trace({ sequence: 0, at: new Date().toISOString(), stage: "assistant.response", data: { text: result.message } });
    printer.finishStream();
    process.stdout.write(`[final] ${result.message}\n`);
    return { session: sessions.get(id), ok: true, created };
  } catch (error) {
    const message = `Execution failed: ${error instanceof Error ? error.message : String(error)}`;
    sessions.appendMessage(id, "assistant", message, toolCalls, activities);
    trace({ sequence: 0, at: new Date().toISOString(), stage: "runtime.error", data: { message } });
    printer.finishStream();
    process.stderr.write(`${message}\n`);
    return { session: sessions.get(id), ok: false, created };
  } finally {
    await closeRuntime(handle);
  }
}

function printSessionId(session: SessionData): void {
  process.stdout.write(`[session] ${session.meta.id}  ${session.meta.title}\n`);
}

async function chat(options: CliOptions): Promise<void> {
  const sessions = new SessionStore(options.workspace);
  const selected = options.sessionId || sessions.list()[0]?.id;
  const session = selected ? sessions.get(selected) : sessions.create();
  printSessionId(session);
  process.stdout.write("Enter a message, or type :history, :use <id>, or exit.\n\n");
  const rl = readline.createInterface({ input, output });
  let currentId = session.meta.id;
  try {
    while (true) {
      const line = (await rl.question("you> ")).trim();
      if (["exit", "quit", ":exit"].includes(line.toLowerCase())) break;
      if (!line) continue;
      if (line === ":history") {
        const current = sessions.get(currentId);
        for (const message of current.messages) process.stdout.write(`${message.role}> ${message.content}\n`);
        continue;
      }
      const use = line.match(/^:use\s+(.+)$/);
      if (use) {
        const next = sessions.get(use[1].trim());
        currentId = next.meta.id;
        printSessionId(next);
        continue;
      }
      const result = await runSessionMessage(options, currentId, line);
      if (!result.ok) process.stderr.write("The message was saved; you can continue or inspect the session.\n");
    }
  } finally { rl.close(); }
}

function printResult(result: RunResult): void { process.stdout.write(`${result.message}\n`); }

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || ["-h", "--help", "help"].includes(command)) return void console.log(usage());
  const options = parseOptions(args);
  const { workspace, positionals } = options;

  if (command === "init") {
    initializeWorkspace(workspace);
    console.log(`Initialized SecAgent workspace: ${workspace}`);
    return;
  }
  if (command === "config" && positionals[0] === "validate") {
    const { workspace: loaded, config } = loadConfig(workspace);
    normalizeAndValidate(config, loaded);
    console.log(`Config is valid: ${loaded}/secagent.yaml`);
    return;
  }
  if ((command === "sessions" || command === "session") && positionals[0] === "list") {
    for (const item of new SessionStore(workspace).list()) console.log(`${item.id}\t${item.updatedAt}\t${item.title}`);
    return;
  }
  if ((command === "sessions" || command === "session") && positionals[0] === "show") {
    if (!positionals[1]) throw new Error("sessions show requires a session id");
    const item = new SessionStore(workspace).get(positionals[1]);
    printSessionId(item);
    for (const message of item.messages) {
      console.log(`\n[${message.role}] ${message.createdAt}`);
      console.log(message.content);
      for (const activity of message.activities || []) {
        if (activity.kind === "tool") console.log(`[tool] ${activity.name}\n${formatValue(activity.arguments)}\nresult: ${formatValue(activity.result)}`);
        else console.log(`[${activity.kind}]\n${activity.content}`);
      }
    }
    return;
  }
  if (command === "skills" && positionals[0] === "list") {
    const { config } = loadConfig(workspace);
    for (const skill of loadEnabledSkills(config)) console.log(`${skill.name}\t${skill.path}`);
    return;
  }
  if (command === "mcp" && positionals[0] === "list") {
    const { config } = loadConfig(workspace);
    for (const [name, server] of Object.entries(config.mcp.servers)) console.log(`${name}\t${server.enabled ? "enabled" : "disabled"}\t${server.transport}\t${server.url ?? server.command ?? ""}`);
    return;
  }
  if (command === "doctor") {
    const { workspace: loaded, config } = loadConfig(workspace);
    const skills = loadEnabledSkills(config);
    const enabledMcp = Object.entries(config.mcp.servers).filter(([, server]) => server.enabled);
    console.log(`Config valid: ${loaded}/secagent.yaml`);
    console.log(`Skills: ${skills.length}`);
    console.log(`Enabled MCP servers: ${enabledMcp.map(([name]) => name).join(", ") || "none"}`);
    console.log(`Audit database: ${loaded}/audit/secagent.sqlite`);
    const modelKey = process.env[config.agent.apiKeyEnv];
    if (!modelKey) throw new Error(`Missing model key environment variable ${config.agent.apiKeyEnv}; set it in ${loaded}/.env`);
    console.log(`Model: ${config.agent.provider} / ${config.agent.model} / ${config.agent.baseUrl}`);
    const secscore = config.mcp.servers.secscore;
    if (!secscore?.enabled) throw new Error("SecScore MCP is not enabled");
    await new SecScoreMcpAdapter(secscore).listTools();
    console.log(`SecScore MCP reachable: ${secscore.url}`);
    return;
  }
  if (command === "chat") return chat(options);
  if (command === "run") {
    const text = positionals.join(" ").trim();
    if (!text) throw new Error("run requires a message");
    const result = await runSessionMessage(options, options.sessionId, text);
    if (result.created || options.sessionId) printSessionId(result.session);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "undo") {
    if (!positionals[0]) throw new Error("undo requires an operation id");
    const printer = new CliTracePrinter(options.verbose);
    const handle = await openRuntime(workspace, options.modelId, (event) => printer.print(event));
    try { printResult(await handle.runtime.undo(positionals[0])); } finally { printer.finishStream(); await closeRuntime(handle); }
    return;
  }
  if (command === "audit" && positionals[0] === "list") {
    const audit = new AuditStore(workspace);
    try { for (const record of audit.list()) console.log(`${record.createdAt}\t${record.status}\t${record.tool}\t${record.id}${record.undoOf ? `\tundo ${record.undoOf}` : ""}`); }
    finally { audit.close(); }
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => { console.error(`SecAgent: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
