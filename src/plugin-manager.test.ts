import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { PluginManager } from "./plugin-manager.js";

test("plugin-scoped config survives plugin manager restart", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-plugin-config-"));
  const archivePath = path.join(workspace, "config-test.zip");
  const archive = new AdmZip() as unknown as { addFile(name: string, data: Buffer): void; writeZip(file: string): void };
  archive.addFile("secagent-plugin.json", Buffer.from(JSON.stringify({
    apiVersion: 1,
    id: "config-test",
    name: "Config test",
    version: "1.0.0",
    main: "main.mjs",
    permissions: ["agent.settings"],
    settingsPages: [{ id: "test", title: "Test" }],
  })));
  archive.addFile("main.mjs", Buffer.from(`
export function activate(api) {
  api.registerSettingsHandler("test", async (action, args) => {
    if (action === "set") { api.setConfig(args); return api.getConfig(); }
    return api.getConfig();
  });
}
`));
  archive.writeZip(archivePath);

  try {
    const first = new PluginManager(workspace);
    await first.initialize();
    await first.install(archivePath);
    await first.callSettings("config-test", "test", "set", { accountId: "account-1", classId: "class-1" });
    await first.shutdown();

    const second = new PluginManager(workspace);
    await second.initialize();
    const config = await second.callSettings("config-test", "test", "get");
    assert.deepEqual(config, { accountId: "account-1", classId: "class-1" });
    await second.shutdown();
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("installing a newer version replaces the active plugin", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-plugin-update-"));
  const createArchive = (version: string, marker: string): string => {
    const archivePath = path.join(workspace, `${version}.zip`);
    const archive = new AdmZip() as unknown as { addFile(name: string, data: Buffer): void; writeZip(file: string): void };
    archive.addFile("secagent-plugin.json", Buffer.from(JSON.stringify({ apiVersion: 1, id: "update-test", name: "Update test", version, main: "main.mjs", permissions: ["agent.prompts"] })));
    archive.addFile("main.mjs", Buffer.from(`export function activate(api) { api.registerPrompt("marker", () => "${marker}"); }`));
    archive.writeZip(archivePath);
    return archivePath;
  };

  try {
    const manager = new PluginManager(workspace);
    await manager.initialize();
    await manager.install(createArchive("1.0.0", "old"));
    assert.equal((await manager.getPromptContributions())[0].text, "old");
    await manager.install(createArchive("1.1.0", "new"));
    assert.equal(manager.list()[0].version, "1.1.0");
    assert.equal((await manager.getPromptContributions())[0].text, "new");
    await manager.shutdown();
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("plugin SVG preview writes a workspace artifact and invokes the preview handler", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-plugin-preview-"));
  const archivePath = path.join(workspace, "preview-test.zip");
  const archive = new AdmZip() as unknown as { addFile(name: string, data: Buffer): void; writeZip(file: string): void };
  archive.addFile("secagent-plugin.json", Buffer.from(JSON.stringify({ apiVersion: 1, id: "preview-test", name: "Preview test", version: "1.0.0", main: "main.mjs", permissions: ["agent.tools", "agent.preview"] })));
  archive.addFile("main.mjs", Buffer.from(`
export function activate(api) {
  api.registerTool({ name: "preview", description: "preview", inputSchema: { type: "object" } }, (args) => api.openSvgPreview(args));
}
`));
  archive.writeZip(archivePath);
  const handled: Array<{ filePath: string; title: string }> = [];
  const manager = new PluginManager(workspace, undefined, async (request) => { handled.push(request); return true; });
  try {
    await manager.initialize();
    await manager.install(archivePath);
    const result = await manager.callTool("preview-test__preview", { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>你好</text></svg>", title: "预览测试", fileName: "测试.md" }) as { path: string; relativePath: string; bytes: number; previewOpened: boolean };
    assert.equal(result.previewOpened, true);
    assert.equal(result.relativePath.startsWith("exports/handdrawn-markdown/"), true);
    assert.equal(fs.readFileSync(result.path, "utf8").includes("你好"), true);
    assert.deepEqual(handled.map((item) => item.title), ["预览测试"]);
  } finally {
    await manager.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("plugin SVG export can skip opening a preview window", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-plugin-export-only-"));
  const archivePath = path.join(workspace, "export-only-test.zip");
  const archive = new AdmZip() as unknown as { addFile(name: string, data: Buffer): void; writeZip(file: string): void };
  archive.addFile("secagent-plugin.json", Buffer.from(JSON.stringify({ apiVersion: 1, id: "export-only-test", name: "Export only test", version: "1.0.0", main: "main.mjs", permissions: ["agent.tools", "agent.preview"] })));
  archive.addFile("main.mjs", Buffer.from(`
export function activate(api) {
  api.registerTool({ name: "export", description: "export", inputSchema: { type: "object" } }, (args) => api.openSvgPreview(args));
}
`));
  archive.writeZip(archivePath);
  let previewCalls = 0;
  const manager = new PluginManager(workspace, undefined, async () => { previewCalls += 1; return true; });
  try {
    await manager.initialize();
    await manager.install(archivePath);
    const result = await manager.callTool("export-only-test__export", { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" />", openPreview: false }) as { path: string; previewOpened: boolean };
    assert.equal(result.previewOpened, false);
    assert.equal(previewCalls, 0);
    assert.equal(fs.existsSync(result.path), true);
  } finally {
    await manager.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("SVG preview requires the agent.preview permission", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-plugin-preview-permission-"));
  const archivePath = path.join(workspace, "preview-permission-test.zip");
  const archive = new AdmZip() as unknown as { addFile(name: string, data: Buffer): void; writeZip(file: string): void };
  archive.addFile("secagent-plugin.json", Buffer.from(JSON.stringify({ apiVersion: 1, id: "preview-permission-test", name: "Preview permission test", version: "1.0.0", main: "main.mjs", permissions: ["agent.tools"] })));
  archive.addFile("main.mjs", Buffer.from(`
export function activate(api) {
  api.registerTool({ name: "preview", description: "preview", inputSchema: { type: "object" } }, (args) => api.openSvgPreview(args));
}
`));
  archive.writeZip(archivePath);
  const manager = new PluginManager(workspace);
  try {
    await manager.initialize();
    await manager.install(archivePath);
    await assert.rejects(() => manager.callTool("preview-permission-test__preview", { svg: "<svg></svg>" }), /agent\.preview/);
  } finally {
    await manager.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
