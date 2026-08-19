import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import YAML from "yaml";
import type { LoadedSkill, SkillAutoLoadPattern } from "./skills.js";
import type { PluginStatus, PluginToolDefinition } from "./types.js";

const API_VERSION = 1;
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;

type PluginFormat = "secagent" | "agent";

export interface PluginMcpServer {
  pluginId: string;
  name: string;
  root: string;
  dataRoot: string;
  type: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

interface PluginManifest {
  apiVersion: number;
  format: PluginFormat;
  id: string;
  name: string;
  version: string;
  main?: string;
  icon?: string;
  description?: string;
  author?: string;
  repository?: string;
  readme?: string;
  permissions?: string[];
  settingsPages?: Array<{ id: string; title: string; description?: string }>;
  agentSchema?: string;
}
interface InstalledPlugin { id: string; version: string; enabled: boolean }
interface PluginStateFile { plugins: InstalledPlugin[] }
interface ActivePlugin { manifest: PluginManifest; root: string; state: PluginStatus["state"]; message?: string; tools: Map<string, { definition: PluginToolDefinition; call: (args: Record<string, unknown>) => Promise<unknown> }>; skills: Map<string, { file: string; autoLoadPattern?: SkillAutoLoadPattern }>; mcpServers: Map<string, PluginMcpServer>; prompts: Map<string, PluginPromptProvider>; preRules: Map<string, PluginPreRuleMatcher>; rules: Map<string, { pattern: { source: string; flags: string }; handle: PluginRuleHandler }>; settingsHandlers?: Map<string, (action: string, args: Record<string, unknown>) => Promise<unknown>>; dispose?: () => void | Promise<void> }

function isAgentPluginName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && !value.includes("--") && !value.includes("..");
}

/** 插件注册的提示词：静态文本，或每次用户发消息时求值的提供器。 */
export type PluginPromptProvider = string | (() => string | Promise<string>);

/** A structured action returned by a plugin pre-rule matcher. */
export interface PluginPreRuleMatch {
  /** Tool name relative to the registering plugin. */
  tool: string;
  arguments: Record<string, unknown>;
  /** Optional deterministic renderer for the tool result. */
  render?: (result: unknown) => string | Promise<string>;
}

export type PluginPreRuleMatcher = (input: string) => PluginPreRuleMatch | null | undefined | Promise<PluginPreRuleMatch | null | undefined>;

export interface ResolvedPluginPreRule {
  pluginId: string;
  name: string;
  toolKey: string;
  arguments: Record<string, unknown>;
  render?: (result: unknown) => string | Promise<string>;
}

/** 一次求值后来自某个插件的提示词片段，按插件注册顺序收集。 */
export interface PluginPromptContribution { pluginId: string; name: string; text: string }

/** 前置规则的处理结果：直接回答，或继续请求模型并附加一次性系统消息。 */
export type PluginRuleDecision =
  | { kind: "reply"; message: string }
  | { kind: "llm"; systemMessage?: string };
export type PluginRuleHandler = (input: string, match: RegExpExecArray) => PluginRuleDecision | Promise<PluginRuleDecision>;

export interface SvgPreviewRequest {
  filePath: string;
  title: string;
}

export type SvgPreviewHandler = (request: SvgPreviewRequest) => Promise<boolean>;

export interface PluginHostApi {
  registerTool(definition: Omit<PluginToolDefinition, "key"> & { name: string }, call: (args: Record<string, unknown>) => Promise<unknown>): void;
  unregisterTool(name: string): void;
  registerSkill(relativePath: string, autoLoadPattern?: string | RegExp): string;
  unregisterSkill(name: string): void;
  registerPrompt(name: string, provider: PluginPromptProvider): void;
  unregisterPrompt(name: string): void;
  registerRule(name: string, pattern: string | RegExp, handler: PluginRuleHandler): void;
  unregisterRule(name: string): void;
  registerPreRule(name: string, matcher: PluginPreRuleMatcher): void;
  unregisterPreRule(name: string): void;
  registerSettingsHandler(pageId: string, handler: (action: string, args: Record<string, unknown>) => Promise<unknown>): void;
  unregisterSettingsHandler(pageId: string): void;
  getSectlSession(): Promise<{ accessToken: string; userId?: string; email?: string; name?: string } | null>;
  sectlOAuthLogin(): Promise<{ accessToken: string; userId?: string; email?: string; name?: string }>;
  /** Read plugin-scoped preferences. This must not be used for business data or access tokens. */
  getConfig(): Record<string, unknown>;
  /** Persist plugin-scoped preferences. The host stores this outside the workspace business databases. */
  setConfig(config: Record<string, unknown>): void;
  openSvgPreview(input: { svg: string; title?: string; fileName?: string; openPreview?: boolean }): Promise<{ path: string; relativePath: string; bytes: number; previewOpened: boolean; previewError?: string }>;
  setStatus(message: string, state?: "ready" | "error"): void;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Owns installed plugin state. Plugins choose whether/when to call registerSkill and
 * registerTool; the host never infers that from an HTTP connection state.
 */
export class PluginManager {
  private readonly installedRoot: string;
  private readonly runtimeRoot: string;
  private readonly configRoot: string;
  private readonly dataRoot: string;
  private readonly statePath: string;
  private active = new Map<string, ActivePlugin>();
  private state: PluginStateFile = { plugins: [] };
  private listeners = new Set<() => void>();

  constructor(private readonly workspace: string, private readonly authBridge: {
    getSession: () => Promise<{ accessToken: string; userId?: string; email?: string; name?: string } | null>;
    oauthLogin: () => Promise<{ accessToken: string; userId?: string; email?: string; name?: string }>;
  } = { getSession: async () => null, oauthLogin: async () => { throw new Error("SECTL OAuth login unavailable"); } },
  private readonly previewHandler?: SvgPreviewHandler) {
    this.installedRoot = path.join(workspace, "plugins", "installed");
    this.runtimeRoot = path.join(workspace, ".secagent-runtime", "plugins");
    this.configRoot = path.join(workspace, "plugins", "config");
    this.dataRoot = path.join(workspace, "plugins", "data");
    this.statePath = path.join(workspace, "plugins", "plugins.json");
  }

  async initialize(): Promise<void> {
    fs.mkdirSync(this.installedRoot, { recursive: true });
    fs.mkdirSync(this.runtimeRoot, { recursive: true });
    this.state = this.readState();
    for (const plugin of this.state.plugins.filter((item) => item.enabled)) await this.activate(plugin.id);
  }

  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) listener(); }

  list(): PluginStatus[] {
    return this.state.plugins.map((installed) => {
      const active = this.active.get(installed.id);
      const manifest = active?.manifest || this.readManifest(path.join(this.installedRoot, installed.id, installed.version));
      return {
        id: installed.id,
        format: manifest?.format,
        name: manifest?.name || installed.id,
        version: installed.version,
        icon: manifest ? this.readIcon(path.join(this.installedRoot, installed.id, installed.version), manifest) : undefined,
        enabled: installed.enabled,
        state: active?.state || "inactive",
        message: active?.message,
        description: manifest?.description,
        author: manifest?.author,
        repository: manifest?.repository,
        permissions: manifest?.permissions || [],
        readme: manifest ? this.readReadme(path.join(this.installedRoot, installed.id, installed.version), manifest) : undefined,
        settingsPages: manifest?.settingsPages || []
      };
    });
  }

  /** Installs a portable zip after rejecting traversal, oversized files and malformed manifests. */
  async install(zipFile: string): Promise<PluginStatus> {
    const stat = fs.statSync(zipFile);
    if (stat.size > MAX_PACKAGE_BYTES) throw new Error("插件包超过 25 MiB 限制");
    const zip = new AdmZip(zipFile);
    for (const entry of zip.getEntries()) {
      if (entry.entryName.includes("..") || path.isAbsolute(entry.entryName) || entry.entryName.startsWith("/")) throw new Error(`插件包包含不安全路径：${entry.entryName}`);
    }
    const ownManifestEntry = this.findArchiveManifest(zip, "secagent-plugin.json");
    const agentManifestEntry = this.findArchiveManifest(zip, "plugin.json");
    if (ownManifestEntry && agentManifestEntry) throw new Error("插件包不能同时包含两种根清单");
    const manifestEntry = ownManifestEntry || agentManifestEntry;
    if (!manifestEntry) throw new Error("插件包缺少 secagent-plugin.json 或 plugin.json");
    const manifest = this.validateManifest(JSON.parse(manifestEntry.getData().toString("utf8")), ownManifestEntry ? "secagent" : "agent");
    const previous = this.state.plugins.find((item) => item.id === manifest.id);
    const pluginRoot = path.join(this.installedRoot, manifest.id);
    const target = path.join(this.installedRoot, manifest.id, manifest.version);
    const staging = path.join(this.workspace, "plugins", `.staging-${manifest.id}-${crypto.randomUUID()}`);
    try {
      fs.mkdirSync(staging, { recursive: true });
      zip.extractAllTo(staging, true);
      const extractedRoot = this.findPackageRoot(staging, manifest.format === "secagent" ? "secagent-plugin.json" : "plugin.json");
      if (previous) await this.deactivate(manifest.id);
      if (fs.existsSync(pluginRoot)) fs.rmSync(pluginRoot, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(extractedRoot, target);
      this.state.plugins = this.state.plugins.filter((item) => item.id !== manifest.id);
      this.state.plugins.push({ id: manifest.id, version: manifest.version, enabled: previous?.enabled ?? true });
      this.saveState();
      if (previous?.enabled ?? true) await this.activate(manifest.id); else this.changed();
      return this.list().find((item) => item.id === manifest.id)!;
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const installed = this.state.plugins.find((item) => item.id === id);
    if (!installed) throw new Error(`未安装插件：${id}`);
    installed.enabled = enabled;
    this.saveState();
    if (enabled) await this.activate(id); else await this.deactivate(id);
    this.changed();
  }

  async uninstall(id: string): Promise<void> {
    const installed = this.state.plugins.find((item) => item.id === id);
    if (!installed) throw new Error(`未安装插件：${id}`);
    await this.deactivate(id);
    this.state.plugins = this.state.plugins.filter((item) => item.id !== id);
    this.saveState();
    fs.rmSync(path.join(this.installedRoot, id), { recursive: true, force: true });
    this.changed();
  }

  async reload(id: string): Promise<void> { await this.deactivate(id); await this.activate(id); }
  async shutdown(): Promise<void> { for (const id of [...this.active.keys()]) await this.deactivate(id); }
  getSkills(): LoadedSkill[] {
    const skills: LoadedSkill[] = [];
    for (const plugin of this.active.values()) for (const [name, skill] of plugin.skills) {
      const file = skill.file;
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      // Plugin skills are always namespaced so an installed package cannot shadow a workspace Skill.
      const uniqueName = `${plugin.manifest.id}/${name}`;
      const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      const description = frontmatter?.[1].match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || "插件提供的操作说明。";
      skills.push({ name: uniqueName, description, path: file, relativePath: path.relative(this.workspace, file).replace(/\\/g, "/"), content, autoLoadPattern: skill.autoLoadPattern });
    }
    return skills;
  }
  getTools(): PluginToolDefinition[] { return [...this.active.values()].flatMap((plugin) => [...plugin.tools.values()].map((item) => item.definition)); }
  getMcpServers(): PluginMcpServer[] { return [...this.active.values()].flatMap((plugin) => [...plugin.mcpServers.values()]); }
  async matchPreRule(input: string): Promise<ResolvedPluginPreRule | undefined> {
    for (const plugin of this.active.values()) {
      for (const [name, matcher] of plugin.preRules) {
        let match: PluginPreRuleMatch | null | undefined;
        try {
          match = await matcher(input);
        } catch (error) {
          console.error(`[secagent] 插件 ${plugin.manifest.id} 的前置规则 ${name} 匹配失败：${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (!match) continue;
        if (!match || typeof match !== "object" || typeof match.tool !== "string" || !/^[a-z][a-z0-9_]*$/.test(match.tool) || !match.arguments || typeof match.arguments !== "object" || Array.isArray(match.arguments) || (match.render !== undefined && typeof match.render !== "function")) {
          console.error(`[secagent] 插件 ${plugin.manifest.id} 的前置规则 ${name} 返回了无效动作`);
          continue;
        }
        const toolKey = `${plugin.manifest.id}__${match.tool}`;
        if (!plugin.tools.has(toolKey)) {
          console.error(`[secagent] 插件 ${plugin.manifest.id} 的前置规则 ${name} 引用了未注册工具 ${match.tool}`);
          continue;
        }
        return { pluginId: plugin.manifest.id, name, toolKey, arguments: match.arguments, render: match.render };
      }
    }
    return undefined;
  }
  /** 收集所有激活插件注册的提示词；单个提供器失败时记录错误并跳过，不中断其他插件。 */
  async getPromptContributions(): Promise<PluginPromptContribution[]> {
    const contributions: PluginPromptContribution[] = [];
    for (const plugin of this.active.values()) {
      for (const [name, provider] of plugin.prompts) {
        try {
          const text = typeof provider === "function" ? await provider() : provider;
          if (typeof text !== "string") throw new Error("提示词提供器必须返回字符串");
          if (!text.trim()) continue;
          contributions.push({ pluginId: plugin.manifest.id, name, text });
        } catch (error) {
          console.error(`[secagent] 插件 ${plugin.manifest.id} 的提示词 ${name} 获取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return contributions;
  }
  /** 按插件和注册顺序执行第一个命中的前置规则。 */
  async matchRule(input: string): Promise<{ pluginId: string; ruleName: string; decision: PluginRuleDecision } | undefined> {
    for (const plugin of this.active.values()) {
      for (const [name, rule] of plugin.rules) {
        const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
        const match = regex.exec(input);
        if (!match) continue;
        const decision = await rule.handle(input, match);
        if (!decision || (decision.kind !== "reply" && decision.kind !== "llm")) throw new Error(`插件规则 ${plugin.manifest.id}/${name} 返回了无效结果`);
        if (decision.kind === "reply" && typeof decision.message !== "string") throw new Error(`插件规则 ${plugin.manifest.id}/${name} 的回答必须是字符串`);
        if (decision.kind === "llm" && decision.systemMessage !== undefined && typeof decision.systemMessage !== "string") throw new Error(`插件规则 ${plugin.manifest.id}/${name} 的 systemMessage 必须是字符串`);
        return { pluginId: plugin.manifest.id, ruleName: name, decision };
      }
    }
    return undefined;
  }
  async callTool(key: string, args: Record<string, unknown>): Promise<unknown> {
    for (const plugin of this.active.values()) {
      const tool = plugin.tools.get(key);
      if (tool) return tool.call(args);
    }
    throw new Error(`未注册插件工具：${key}`);
  }

  async callSettings(id: string, pageId: string, action: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const plugin = this.active.get(id);
    const handler = plugin?.settingsHandlers?.get(pageId);
    if (!handler) throw new Error(`插件设置页不可用：${id}/${pageId}`);
    return handler(action, args);
  }

  private async activate(id: string): Promise<void> {
    const installed = this.state.plugins.find((item) => item.id === id && item.enabled);
    if (!installed || this.active.has(id)) return;
    const root = path.join(this.installedRoot, installed.id, installed.version);
    const manifest = this.readManifest(root);
    if (!manifest) { this.active.set(id, { manifest: { format: "secagent", apiVersion: API_VERSION, id, name: id, version: installed.version }, root, state: "error", message: "找不到或无法读取插件清单", tools: new Map(), skills: new Map(), mcpServers: new Map(), prompts: new Map(), preRules: new Map(), rules: new Map() }); this.changed(); return; }
    const plugin: ActivePlugin = { manifest, root, state: "starting", tools: new Map(), skills: new Map(), mcpServers: new Map(), prompts: new Map(), preRules: new Map(), rules: new Map(), settingsHandlers: new Map() };
    this.active.set(id, plugin); this.changed();
    try {
      if (manifest.format === "agent") {
        this.activateAgentPlugin(plugin);
        plugin.state = "ready";
        this.changed();
        return;
      }
      if (!manifest.main) throw new Error("插件清单缺少 main 入口");
      const entry = this.safeRelative(root, manifest.main!);
      if (!fs.existsSync(entry)) throw new Error(`找不到主入口：${manifest.main}`);
      const mod = await import(`${pathToFileURL(entry).href}?v=${Date.now()}`) as { activate?: (api: PluginHostApi) => void | (() => void) | Promise<void | (() => void)> };
      if (typeof mod.activate !== "function") throw new Error("插件主入口必须导出 activate(api)");
      const api = this.createApi(plugin);
      plugin.dispose = await mod.activate(api) || undefined;
      if (plugin.state === "starting") plugin.state = "ready";
    } catch (error) { plugin.state = "error"; plugin.message = error instanceof Error ? error.message : String(error); }
    this.changed();
  }
  private async deactivate(id: string): Promise<void> {
    const plugin = this.active.get(id);
    if (!plugin) return;
    await plugin.dispose?.();
    this.active.delete(id);
    fs.rmSync(path.join(this.runtimeRoot, plugin.manifest.id, plugin.manifest.version), { recursive: true, force: true });
  }
  private createApi(plugin: ActivePlugin): PluginHostApi {
    const requirePermission = (permission: string) => { if (!plugin.manifest.permissions?.includes(permission)) throw new Error(`插件未声明权限：${permission}`); };
    return {
      registerTool: (definition, call) => {
        requirePermission("agent.tools");
        if (!/^[a-z][a-z0-9_]*$/.test(definition.name)) throw new Error("插件工具名称只能使用小写字母、数字和下划线");
        const key = `${plugin.manifest.id}__${definition.name}`;
        plugin.tools.set(key, { definition: { key, description: definition.description, inputSchema: definition.inputSchema, hidden: definition.hidden ?? true }, call }); this.changed();
      },
      unregisterTool: (name) => { plugin.tools.delete(`${plugin.manifest.id}__${name}`); this.changed(); },
      registerSkill: (relativePath, autoLoadPattern) => {
        requirePermission("agent.skills");
        const requested = this.safeRelative(plugin.root, relativePath);
        if (!fs.existsSync(requested)) throw new Error(`找不到 Skill 路径：${relativePath}`);
        const sourceRoot = fs.statSync(requested).isDirectory() ? requested : path.dirname(requested);
        const skillFile = path.join(sourceRoot, "SKILL.md");
        if (!fs.existsSync(skillFile)) throw new Error("Skill 目录必须包含 SKILL.md");
        this.assertSafeSkillTree(sourceRoot);
        const name = path.basename(sourceRoot);
        const destination = path.join(this.runtimeRoot, plugin.manifest.id, plugin.manifest.version, "skills", name);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(sourceRoot, destination, { recursive: true, dereference: false, errorOnExist: false });
        let pattern: SkillAutoLoadPattern | undefined;
        if (autoLoadPattern !== undefined) {
          const regex = autoLoadPattern instanceof RegExp ? autoLoadPattern : new RegExp(autoLoadPattern);
          pattern = { source: regex.source, flags: regex.flags };
        }
        const file = path.join(destination, "SKILL.md");
        plugin.skills.set(name, { file, autoLoadPattern: pattern }); this.changed(); return file;
      },
      unregisterSkill: (name) => {
        const file = plugin.skills.get(name)?.file;
        plugin.skills.delete(name);
        if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
        this.changed();
      },
      registerPrompt: (name, provider) => {
        requirePermission("agent.prompts");
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("插件提示词名称只能使用小写字母、数字和下划线");
        if (typeof provider !== "string" && typeof provider !== "function") throw new Error("插件提示词必须是字符串或返回字符串的函数");
        plugin.prompts.set(name, provider); this.changed();
      },
      unregisterPrompt: (name) => { plugin.prompts.delete(name); this.changed(); },
      registerRule: (name, pattern, handler) => {
        requirePermission("agent.rules");
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("插件规则名称只能使用小写字母、数字和下划线");
        if (typeof handler !== "function") throw new Error("插件规则处理器必须是函数");
        const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
        plugin.rules.set(name, { pattern: { source: regex.source, flags: regex.flags }, handle: handler }); this.changed();
      },
      unregisterRule: (name) => { plugin.rules.delete(name); this.changed(); },
      registerPreRule: (name, matcher) => {
        requirePermission("agent.pre_rules");
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("插件前置规则名称只能使用小写字母、数字和下划线");
        if (typeof matcher !== "function") throw new Error("插件前置规则必须是函数");
        plugin.preRules.set(name, matcher); this.changed();
      },
      unregisterPreRule: (name) => { plugin.preRules.delete(name); this.changed(); },
      registerSettingsHandler: (pageId, handler) => {
        requirePermission("agent.settings");
        if (!/^[a-z][a-z0-9_-]*$/.test(pageId)) throw new Error("插件设置页 ID 无效");
        plugin.settingsHandlers ??= new Map();
        plugin.settingsHandlers.set(pageId, handler);
        this.changed();
      },
      unregisterSettingsHandler: (pageId) => { plugin.settingsHandlers?.delete(pageId); this.changed(); },
      getSectlSession: () => this.authBridge.getSession(),
      sectlOAuthLogin: () => this.authBridge.oauthLogin(),
      getConfig: () => this.readPluginConfig(plugin),
      setConfig: (config) => this.writePluginConfig(plugin, config),
      openSvgPreview: async (input) => {
        requirePermission("agent.preview");
        return this.saveSvgPreview(plugin, input);
      },
      setStatus: (message, state = "ready") => { plugin.message = message; plugin.state = state; this.changed(); },
      fetch: async (url, init) => { requirePermission("network.http"); const parsed = new URL(url); if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("插件 HTTP 仅允许 http/https"); return fetch(url, init); }
    };
  }
  private async saveSvgPreview(plugin: ActivePlugin, input: { svg: string; title?: string; fileName?: string; openPreview?: boolean }): Promise<{ path: string; relativePath: string; bytes: number; previewOpened: boolean; previewError?: string }> {
    if (!input || typeof input.svg !== "string" || !/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(input.svg)) throw new Error("预览内容必须是 SVG 文档");
    const bytes = Buffer.byteLength(input.svg, "utf8");
    if (bytes > 20 * 1024 * 1024) throw new Error("SVG 预览文件不能超过 20 MiB");
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 120) : plugin.manifest.name;
    const requestedName = typeof input.fileName === "string" && input.fileName.trim() ? input.fileName.trim() : "markdown-handdrawn";
    if (path.basename(requestedName) !== requestedName || requestedName.includes("\\") || requestedName.includes("/")) throw new Error("SVG 文件名不能包含路径");
    const stem = requestedName.replace(/\.svg$/i, "").replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "markdown-handdrawn";
    const outputRoot = path.join(this.workspace, "exports", "handdrawn-markdown");
    fs.mkdirSync(outputRoot, { recursive: true });
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}-${stem}.svg`;
    const filePath = path.join(outputRoot, fileName);
    const relativePath = path.relative(this.workspace, filePath).replace(/\\/g, "/");
    const temporaryPath = `${filePath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(temporaryPath, input.svg, "utf8");
    fs.renameSync(temporaryPath, filePath);
    if (input.openPreview === false) return { path: filePath, relativePath, bytes, previewOpened: false };
    if (!this.previewHandler) return { path: filePath, relativePath, bytes, previewOpened: false, previewError: "当前运行环境没有 Electron 预览窗口" };
    try {
      const previewOpened = await this.previewHandler({ filePath, title });
      return { path: filePath, relativePath, bytes, previewOpened };
    } catch (error) {
      return { path: filePath, relativePath, bytes, previewOpened: false, previewError: error instanceof Error ? error.message : String(error) };
    }
  }
  private safeRelative(root: string, value: string): string { const candidate = path.resolve(root, value); if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error("插件路径越界"); return candidate; }
  private assertSafeSkillTree(root: string): void {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Skill 目录不允许符号链接：${entry.name}`);
      if (stat.isDirectory()) this.assertSafeSkillTree(file);
    }
  }
  private readManifest(root: string): PluginManifest | undefined {
    for (const [file, format] of [["secagent-plugin.json", "secagent"], ["plugin.json", "agent"]] as const) {
      try { return this.validateManifest(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")), format); } catch { /* Try the other supported format. */ }
    }
    return undefined;
  }
  private readReadme(root: string, manifest: PluginManifest): string | undefined {
    const requested = manifest.readme || "README.md";
    try {
      const file = this.safeRelative(root, requested);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    } catch {
      return undefined;
    }
  }
  private readIcon(root: string, manifest: PluginManifest): string | undefined {
    if (!manifest.icon) return undefined;
    try {
      const file = this.safeRelative(root, manifest.icon);
      const extension = path.extname(file).toLowerCase();
      const mime = extension === ".svg" ? "image/svg+xml" : extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : undefined;
      if (!mime || !fs.existsSync(file)) return undefined;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 512 * 1024) return undefined;
      return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {
      return undefined;
    }
  }
  private findPackageRoot(staging: string, manifestFile: string): string {
    if (fs.existsSync(path.join(staging, manifestFile))) return staging;
    const children = fs.readdirSync(staging, { withFileTypes: true });
    const candidates = children.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(staging, entry.name, manifestFile)));
    if (candidates.length === 1 && children.every((entry) => entry.name === candidates[0].name || entry.name === ".DS_Store")) return path.join(staging, candidates[0].name);
    throw new Error(`插件包根目录缺少 ${manifestFile}`);
  }
  private findArchiveManifest(zip: AdmZip, fileName: string) {
    const entries = zip.getEntries().filter((entry) => entry.entryName === fileName || entry.entryName.endsWith(`/${fileName}`));
    return entries.length === 1 ? entries[0] : undefined;
  }
  private activateAgentPlugin(plugin: ActivePlugin): void {
    const skillsRoot = path.join(plugin.root, "skills");
    if (fs.existsSync(skillsRoot)) {
      if (!fs.statSync(skillsRoot).isDirectory()) console.error(`[secagent] Agent Plugin ${plugin.manifest.id} 的 skills 不是目录`);
      else {
        for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const sourceRoot = path.join(skillsRoot, entry.name);
          const skillFile = path.join(sourceRoot, "SKILL.md");
          try {
            const stat = fs.lstatSync(skillFile);
            if (!stat.isFile() || !this.isValidAgentSkill(skillFile)) continue;
            this.assertSafeSkillTree(sourceRoot);
            const destination = path.join(this.runtimeRoot, plugin.manifest.id, plugin.manifest.version, "skills", entry.name);
            fs.rmSync(destination, { recursive: true, force: true });
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.cpSync(sourceRoot, destination, { recursive: true, dereference: false });
            plugin.skills.set(entry.name, { file: path.join(destination, "SKILL.md") });
          } catch (error) {
            console.error(`[secagent] 跳过无效 Agent Skill ${plugin.manifest.id}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    this.loadAgentMcp(plugin);
  }
  private isValidAgentSkill(file: string): boolean {
    const content = fs.readFileSync(file, "utf8");
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
    if (!match) return false;
    const metadata = YAML.parse(match[1]) as { name?: unknown; description?: unknown } | null;
    return typeof metadata?.name === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) && typeof metadata.description === "string" && metadata.description.trim().length > 0;
  }
  private loadAgentMcp(plugin: ActivePlugin): void {
    const file = path.join(plugin.root, "mcp.json");
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!raw || raw.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" || !raw.mcpServers || typeof raw.mcpServers !== "object" || Array.isArray(raw.mcpServers) || Object.keys(raw).some((key) => key !== "$schema" && key !== "mcpServers")) throw new Error("mcp.json 顶层格式无效");
      for (const [name, value] of Object.entries(raw.mcpServers as Record<string, unknown>)) {
        try {
          const server = this.validateAgentMcpServer(plugin, name, value);
          if (server) plugin.mcpServers.set(name, server);
        } catch (error) { console.error(`[secagent] 跳过无效 Agent MCP ${plugin.manifest.id}/${name}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } catch (error) { console.error(`[secagent] 禁用 Agent Plugin ${plugin.manifest.id} 的 MCP：${error instanceof Error ? error.message : String(error)}`); }
  }
  private validateAgentMcpServer(plugin: ActivePlugin, name: string, input: unknown): PluginMcpServer {
    if (!input || typeof input !== "object" || Array.isArray(input) || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("服务名称或配置无效");
    const data = input as Record<string, unknown>;
    const type = data.type;
    if (type !== "stdio" && type !== "streamable-http" && type !== "sse") throw new Error("不支持的 MCP transport");
    const allowed = type === "stdio" ? new Set(["type", "command", "args", "env", "cwd"]) : new Set(["type", "url", "headers"]);
    if (Object.keys(data).some((key) => !allowed.has(key))) throw new Error("MCP server 包含未知字段");
    const result: PluginMcpServer = { pluginId: plugin.manifest.id, name, root: plugin.root, dataRoot: path.join(this.dataRoot, plugin.manifest.id), type };
    if (type === "stdio") {
      if (typeof data.command !== "string" || !data.command || /[\s\0]/.test(data.command) || data.command.startsWith("../") || data.command.startsWith("..\\")) throw new Error("stdio command 必须是单个可执行 token 或 ./ 相对路径");
      if (data.args !== undefined && (!Array.isArray(data.args) || data.args.some((item) => typeof item !== "string"))) throw new Error("stdio args 必须是字符串数组");
      if (data.env !== undefined && (!data.env || typeof data.env !== "object" || Array.isArray(data.env) || Object.values(data.env as object).some((item) => typeof item !== "string"))) throw new Error("stdio env 无效");
      if (data.cwd !== undefined && typeof data.cwd !== "string") throw new Error("stdio cwd 无效");
      result.command = data.command; result.args = data.args as string[] | undefined; result.env = data.env as Record<string, string> | undefined; result.cwd = data.cwd as string | undefined;
    } else {
      if (typeof data.url !== "string") throw new Error("HTTP MCP 缺少 url");
      const url = new URL(data.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP url 必须使用 http/https");
      if (url.protocol === "http:" && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new Error("非本地 MCP url 必须使用 HTTPS");
      if (data.headers !== undefined && (!data.headers || typeof data.headers !== "object" || Array.isArray(data.headers) || Object.values(data.headers as object).some((item) => typeof item !== "string"))) throw new Error("HTTP headers 无效");
      result.url = data.url; result.headers = data.headers as Record<string, string> | undefined;
    }
    return result;
  }
  private validateManifest(input: unknown, format: PluginFormat): PluginManifest {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("插件清单必须是 JSON 对象");
    const raw = input as Record<string, unknown>;
    if (format === "agent") {
      const name = raw.name;
      if (raw.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" || typeof name !== "string" || !isAgentPluginName(name)) throw new Error("无效 Agent Plugins 清单：需要受支持的 $schema 和合法 name");
      for (const field of ["version", "description", "homepage", "repository", "license"] as const) if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error(`Agent Plugins ${field} 必须是字符串`);
      if (raw.keywords !== undefined && (!Array.isArray(raw.keywords) || raw.keywords.some((item) => typeof item !== "string"))) throw new Error("Agent Plugins keywords 必须是字符串数组");
      if (raw.author !== undefined && (!raw.author || typeof raw.author !== "object" || Array.isArray(raw.author) || Object.keys(raw.author as object).some((key) => !["name", "email", "url"].includes(key)) || Object.values(raw.author as object).some((item) => typeof item !== "string"))) throw new Error("Agent Plugins author 无效");
      const author = raw.author as { name?: string } | undefined;
      return { format, apiVersion: API_VERSION, id: name, name, version: typeof raw.version === "string" && raw.version ? raw.version : "0.0.0", description: raw.description as string | undefined, author: author?.name, repository: typeof raw.repository === "string" ? raw.repository : undefined, readme: "README.md", agentSchema: raw.$schema };
    }
    const data = input as Partial<PluginManifest>;
    if (data.apiVersion !== API_VERSION || !data.id || !/^[a-z][a-z0-9-]*$/.test(data.id) || !data.name || !data.version) throw new Error("无效插件清单：需要 apiVersion=1、合法 id、name 和 version");
    if (data.main && (!data.main.endsWith(".mjs") || data.main.includes(".."))) throw new Error("main 必须是包内 .mjs 文件");
    if (data.icon !== undefined && (typeof data.icon !== "string" || !data.icon || path.isAbsolute(data.icon) || data.icon.includes(".."))) throw new Error("icon 必须是包内的图标文件");
    return { format, apiVersion: API_VERSION, id: data.id, name: data.name, version: data.version, main: data.main, icon: data.icon, description: data.description, author: data.author, repository: data.repository, readme: data.readme, permissions: data.permissions || [], settingsPages: data.settingsPages || [] };
  }
  private readState(): PluginStateFile { try { const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PluginStateFile; return { plugins: Array.isArray(raw.plugins) ? raw.plugins : [] }; } catch { return { plugins: [] }; } }
  private saveState(): void { fs.mkdirSync(path.dirname(this.statePath), { recursive: true }); fs.writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8"); }
  private pluginConfigPath(plugin: ActivePlugin): string { return path.join(this.configRoot, `${plugin.manifest.id}.json`); }
  private readPluginConfig(plugin: ActivePlugin): Record<string, unknown> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pluginConfigPath(plugin), "utf8")) as unknown;
      return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    } catch {
      return {};
    }
  }
  private writePluginConfig(plugin: ActivePlugin, config: Record<string, unknown>): void {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("插件配置必须是对象");
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error("插件配置超过 64 KiB 限制");
    fs.mkdirSync(this.configRoot, { recursive: true });
    const target = this.pluginConfigPath(plugin);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, serialized, "utf8");
    fs.renameSync(temporary, target);
  }
}
