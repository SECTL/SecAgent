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
