import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MarketplaceClient, type MarketplacePlugin, type MarketplaceVersion } from "./marketplace.js";
import { PluginManager } from "./plugin-manager.js";

export const SECAgentHttpHost = "127.0.0.1";
export const SECAgentHttpPort = 42189;
export const SECAgentHttpBaseUrl = `http://${SECAgentHttpHost}:${SECAgentHttpPort}`;

const MAX_REQUEST_BYTES = 64 * 1024;

/** Local-only bridge used by companion applications to bootstrap SecAgent plugins. */
export class SecAgentHttpServer {
  private server?: Server;
  private installPromise?: Promise<PluginInstallResponse>;

  constructor(private readonly plugins: PluginManager, private readonly marketplace: MarketplaceClient) {}

  get isRunning(): boolean { return this.server?.listening === true; }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    const server = http.createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
      const onListening = (): void => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(SECAgentHttpPort, SECAgentHttpHost);
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }

    try {
      const url = new URL(request.url || "/", SECAgentHttpBaseUrl);
      if (request.method === "GET" && url.pathname === "/health") {
        this.write(response, 200, { apiVersion: 1, name: "secagent", status: "ok", installEndpoint: "/plugins/install" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/plugins") {
        this.write(response, 200, { apiVersion: 1, plugins: this.plugins.list() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/plugins/install") {
        const body = await this.readJson(request);
        const result = await this.install(body);
        this.write(response, 200, { ok: true, ...result });
        return;
      }
      this.write(response, 404, { ok: false, error: { message: "Not found" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.write(response, 400, { ok: false, error: { message } });
    }
  }

  private async install(body: Record<string, unknown>): Promise<PluginInstallResponse> {
    if (this.installPromise) return this.installPromise;
    const pluginId = body.pluginId === undefined ? "classisland-connector" : body.pluginId;
    if (typeof pluginId !== "string" || !/^[a-z][a-z0-9.-]*$/.test(pluginId)) throw new Error("pluginId 无效");
    this.installPromise = this.installFromMarketplace(pluginId);
    try { return await this.installPromise; }
    finally { this.installPromise = undefined; }
  }

  private async installFromMarketplace(pluginId: string): Promise<PluginInstallResponse> {
    const plugin = (await this.marketplace.list()).find((candidate) => candidate.id === pluginId);
    if (!plugin) throw new Error(`插件市场中不存在：${pluginId}`);
    const version = chooseLatestVersion(plugin);
    await this.marketplace.install(this.plugins, version);
    return { plugin: this.plugins.list().find((item) => item.id === pluginId) || null, version: version.version };
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_REQUEST_BYTES) throw new Error("请求体过大");
      chunks.push(bytes);
    }
    if (!chunks.length) return {};
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是 JSON 对象");
    return value as Record<string, unknown>;
  }

  private write(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status);
    response.end(JSON.stringify(value));
  }
}
export interface PluginInstallResponse {
  plugin: ReturnType<PluginManager["list"]>[number] | null;
  version: string;
}

function chooseLatestVersion(plugin: MarketplacePlugin): MarketplaceVersion {
  const version = plugin.latest;
  if (!version) throw new Error(plugin.releaseError ? `插件暂不可用：${plugin.releaseError}` : "插件没有可安装版本");
  return version;
}
