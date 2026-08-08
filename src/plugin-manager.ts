import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import type { LoadedSkill } from "./skills.js";
import type { PluginStatus, PluginToolDefinition } from "./types.js";

const API_VERSION = 1;
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;

interface PluginManifest {
  apiVersion: number;
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
}
interface InstalledPlugin { id: string; version: string; enabled: boolean }
interface PluginStateFile { plugins: InstalledPlugin[] }
interface ActivePlugin { manifest: PluginManifest; root: string; state: PluginStatus["state"]; message?: string; tools: Map<string, { definition: PluginToolDefinition; call: (args: Record<string, unknown>) => Promise<unknown> }>; skills: Map<string, string>; prompts: Map<string, PluginPromptProvider>; dispose?: () => void | Promise<void> }

/** 插件注册的提示词：静态文本，或每次用户发消息时求值的提供器。 */
export type PluginPromptProvider = string | (() => string | Promise<string>);

/** 一次求值后来自某个插件的提示词片段，按插件注册顺序收集。 */
export interface PluginPromptContribution { pluginId: string; name: string; text: string }

export interface PluginHostApi {
  registerTool(definition: Omit<PluginToolDefinition, "key"> & { name: string }, call: (args: Record<string, unknown>) => Promise<unknown>): void;
  unregisterTool(name: string): void;
  registerSkill(relativePath: string): string;
  unregisterSkill(name: string): void;
  registerPrompt(name: string, provider: PluginPromptProvider): void;
  unregisterPrompt(name: string): void;
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
  private readonly statePath: string;
  private active = new Map<string, ActivePlugin>();
  private state: PluginStateFile = { plugins: [] };
  private listeners = new Set<() => void>();

  constructor(private readonly workspace: string) {
    this.installedRoot = path.join(workspace, "plugins", "installed");
    this.runtimeRoot = path.join(workspace, ".secagent-runtime", "plugins");
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
    const manifestEntry = zip.getEntry("secagent-plugin.json");
    if (!manifestEntry) throw new Error("插件包缺少 secagent-plugin.json");
    const manifest = this.validateManifest(JSON.parse(manifestEntry.getData().toString("utf8")));
    const target = path.join(this.installedRoot, manifest.id, manifest.version);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    zip.extractAllTo(target, true);
    this.state.plugins = this.state.plugins.filter((item) => item.id !== manifest.id);
    this.state.plugins.push({ id: manifest.id, version: manifest.version, enabled: true });
    this.saveState();
    await this.activate(manifest.id);
    return this.list().find((item) => item.id === manifest.id)!;
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
    for (const plugin of this.active.values()) for (const [name, file] of plugin.skills) {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      // Plugin skills are always namespaced so an installed package cannot shadow a workspace Skill.
      const uniqueName = `${plugin.manifest.id}/${name}`;
      const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      const description = frontmatter?.[1].match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || "插件提供的操作说明。";
      skills.push({ name: uniqueName, description, path: file, relativePath: path.relative(this.workspace, file).replace(/\\/g, "/"), content });
    }
    return skills;
  }
  getTools(): PluginToolDefinition[] { return [...this.active.values()].flatMap((plugin) => [...plugin.tools.values()].map((item) => item.definition)); }
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
  async callTool(key: string, args: Record<string, unknown>): Promise<unknown> {
    for (const plugin of this.active.values()) {
      const tool = plugin.tools.get(key);
      if (tool) return tool.call(args);
    }
    throw new Error(`未注册插件工具：${key}`);
  }

  private async activate(id: string): Promise<void> {
    const installed = this.state.plugins.find((item) => item.id === id && item.enabled);
    if (!installed || this.active.has(id)) return;
    const root = path.join(this.installedRoot, installed.id, installed.version);
    const manifest = this.readManifest(root);
    if (!manifest) { this.active.set(id, { manifest: { apiVersion: API_VERSION, id, name: id, version: installed.version }, root, state: "error", message: "找不到或无法读取插件清单", tools: new Map(), skills: new Map(), prompts: new Map() }); this.changed(); return; }
    const plugin: ActivePlugin = { manifest, root, state: "starting", tools: new Map(), skills: new Map(), prompts: new Map() };
    this.active.set(id, plugin); this.changed();
    try {
      if (!manifest.main) throw new Error("插件清单缺少 main 入口");
      const entry = this.safeRelative(root, manifest.main);
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
      registerSkill: (relativePath) => {
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
        plugin.skills.set(name, path.join(destination, "SKILL.md")); this.changed(); return path.join(destination, "SKILL.md");
      },
      unregisterSkill: (name) => {
        const file = plugin.skills.get(name);
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
      setStatus: (message, state = "ready") => { plugin.message = message; plugin.state = state; this.changed(); },
      fetch: async (url, init) => { requirePermission("network.http"); const parsed = new URL(url); if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("插件 HTTP 仅允许 http/https"); return fetch(url, init); }
    };
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
  private readManifest(root: string): PluginManifest | undefined { try { return this.validateManifest(JSON.parse(fs.readFileSync(path.join(root, "secagent-plugin.json"), "utf8"))); } catch { return undefined; } }
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
  private validateManifest(input: unknown): PluginManifest {
    const data = input as Partial<PluginManifest>;
    if (data.apiVersion !== API_VERSION || !data.id || !/^[a-z][a-z0-9-]*$/.test(data.id) || !data.name || !data.version) throw new Error("无效插件清单：需要 apiVersion=1、合法 id、name 和 version");
    if (data.main && (!data.main.endsWith(".mjs") || data.main.includes(".."))) throw new Error("main 必须是包内 .mjs 文件");
    if (data.icon !== undefined && (typeof data.icon !== "string" || !data.icon || path.isAbsolute(data.icon) || data.icon.includes(".."))) throw new Error("icon 必须是包内的图标文件");
    return { apiVersion: API_VERSION, id: data.id, name: data.name, version: data.version, main: data.main, icon: data.icon, description: data.description, author: data.author, repository: data.repository, readme: data.readme, permissions: data.permissions || [], settingsPages: data.settingsPages || [] };
  }
  private readState(): PluginStateFile { try { const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PluginStateFile; return { plugins: Array.isArray(raw.plugins) ? raw.plugins : [] }; } catch { return { plugins: [] }; } }
  private saveState(): void { fs.mkdirSync(path.dirname(this.statePath), { recursive: true }); fs.writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8"); }
}
