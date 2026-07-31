#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { initializeWorkspace, loadConfig, normalizeAndValidate } from "./config.js";
import { DEFAULT_WORKSPACE, expandPath } from "./paths.js";
import { loadEnabledSkills } from "./skills.js";
import { AuditStore } from "./audit.js";
import { SecAgentRuntime, type RunResult } from "./runtime.js";
import { SecScoreMcpAdapter } from "./mcp-adapter.js";

function usage(): string {
  return `SecAgent CLI\n\n用法：\n  secagent init [--workspace <目录>]\n  secagent run <自然语言指令> [--workspace <目录>] [--verbose]\n  secagent confirm <确认令牌> [--workspace <目录>] [--verbose]\n  secagent undo <操作 ID> [--workspace <目录>] [--verbose]\n  secagent chat [--workspace <目录>] [--verbose]\n  secagent skills list [--workspace <目录>]\n  secagent mcp list [--workspace <目录>]\n  secagent config validate [--workspace <目录>]\n  secagent doctor [--workspace <目录>]\n  secagent audit list [--workspace <目录>]`;
}

function workspaceFrom(args: string[]): string {
  const index = args.indexOf("--workspace");
  if (index < 0) return DEFAULT_WORKSPACE;
  if (!args[index + 1]) throw new Error("--workspace 需要目录参数");
  return expandPath(args[index + 1]);
}

function printResult(result: RunResult): void {
  console.log(result.message);
}

function openRuntime(workspaceInput: string, verbose = false): { runtime: SecAgentRuntime; audit: AuditStore } {
  const { workspace, config } = loadConfig(workspaceInput);
  const audit = new AuditStore(workspace, config.policy.audit.redactSensitiveFields);
  const skills = loadEnabledSkills(config);
  const trace = verbose ? (event: { stage: string; data: unknown }) => console.log(`[trace] ${event.stage}\n${JSON.stringify(event.data, null, 2)}`) : undefined;
  return { runtime: new SecAgentRuntime(config, audit, skills, trace), audit };
}

async function chat(workspace: string, verbose: boolean): Promise<void> {
  const { runtime, audit } = openRuntime(workspace, verbose);
  const rl = readline.createInterface({ input, output });
  console.log("SecAgent 对话模式。输入 exit 退出；输入 确认 <令牌> 或 撤销 <操作ID>。\n");
  try {
    while (true) {
      const line = (await rl.question("你：")).trim();
      if (["exit", "quit", "退出"].includes(line.toLowerCase())) break;
      try {
        const confirm = line.match(/^确认\s+(.+)$/);
        const undo = line.match(/^撤销\s+(.+)$/);
        printResult(await (confirm ? runtime.confirm(confirm[1]) : undo ? runtime.undo(undo[1]) : runtime.run(line)));
      } catch (error) { console.error(`错误：${error instanceof Error ? error.message : String(error)}`); }
    }
  } finally { rl.close(); audit.close(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || ["-h", "--help", "help"].includes(command)) return void console.log(usage());
  const workspace = workspaceFrom(args);
  const verbose = args.includes("--verbose");
  if (command === "init") {
    initializeWorkspace(workspace);
    console.log(`已初始化 SecAgent 工作区：${workspace}`);
    return;
  }
  if (command === "config" && args[1] === "validate") {
    const { workspace: loaded, config } = loadConfig(workspace);
    normalizeAndValidate(config, loaded);
    console.log(`配置有效：${loaded}/secagent.yaml`);
    return;
  }
  if (command === "skills" && args[1] === "list") {
    const { config } = loadConfig(workspace);
    for (const skill of loadEnabledSkills(config)) console.log(`${skill.name}\t已启用\t${skill.path}`);
    return;
  }
  if (command === "mcp" && args[1] === "list") {
    const { config } = loadConfig(workspace);
    for (const [name, server] of Object.entries(config.mcp.servers)) console.log(`${name}\t${server.enabled ? "已启用" : "已禁用"}\t${server.transport}\t${server.url ?? server.command ?? "未配置"}`);
    return;
  }
  if (command === "doctor") {
    const { workspace: loaded, config } = loadConfig(workspace);
    const skills = loadEnabledSkills(config);
    const enabledMcp = Object.entries(config.mcp.servers).filter(([, server]) => server.enabled);
    console.log(`✓ 配置有效：${loaded}/secagent.yaml`);
    console.log(`✓ 已发现 ${skills.length} 个 Skill`);
    console.log(`✓ 已声明 ${enabledMcp.length} 个启用 MCP：${enabledMcp.map(([name]) => name).join("、") || "无"}`);
    console.log(`✓ 审计存储：${loaded}/audit/secagent.sqlite`);
    const modelKey = process.env[config.agent.apiKeyEnv];
    if (!modelKey) throw new Error(`未配置模型密钥环境变量 ${config.agent.apiKeyEnv}；请填写 ${loaded}/.env`);
    console.log(`✓ 模型配置：${config.agent.provider} / ${config.agent.model} / ${config.agent.baseUrl}`);
    const secscore = config.mcp.servers.secscore;
    if (!secscore?.enabled) throw new Error("SecScore MCP 未启用");
    await new SecScoreMcpAdapter(secscore).listTools();
    console.log(`✓ SecScore MCP 可连通：${secscore.url}`);
    return;
  }
  if (command === "chat") return chat(workspace, verbose);
  const { runtime, audit } = openRuntime(workspace, verbose);
  try {
    if (command === "run") {
      const text = args.filter((item, index) => index > 0 && item !== "--workspace" && item !== "--verbose" && args[index - 1] !== "--workspace").join(" ");
      if (!text) throw new Error("run 需要自然语言指令");
      printResult(await runtime.run(text));
    } else if (command === "confirm") {
      if (!args[1]) throw new Error("confirm 需要确认令牌");
      printResult(await runtime.confirm(args[1]));
    } else if (command === "undo") {
      if (!args[1]) throw new Error("undo 需要操作 ID");
      printResult(await runtime.undo(args[1]));
    } else if (command === "audit" && args[1] === "list") {
      for (const record of audit.list()) console.log(`${record.createdAt}\t${record.status}\t${record.tool}\t${record.id}${record.undoOf ? `\t撤销 ${record.undoOf}` : ""}`);
    } else throw new Error(`未知命令：${command}\n\n${usage()}`);
  } finally { audit.close(); }
}

main().catch((error) => { console.error(`SecAgent：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
