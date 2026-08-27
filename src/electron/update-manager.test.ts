import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsUpdateManager } from "./update-manager.js";

function preferences() {
  return { channel: "preview" as const, autoCheck: true, autoDownload: false, autoInstallOnQuit: false };
}

test("reports why an unpackaged Windows build cannot check for updates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-update-manager-"));
  const logs: Array<{ stage: string; data: unknown }> = [];
  try {
    const manager = new WindowsUpdateManager({
      currentVersion: "0.1.0-alpha.2",
      preferences: preferences(),
      platform: "win32",
      isPackaged: false,
      storageDirectory: root,
      publish: () => undefined,
      quit: () => undefined,
      launchInstaller: () => undefined,
      log: (stage, data) => logs.push({ stage, data })
    });
    const state = await manager.check();
    assert.equal(state.status, "unsupported");
    assert.match(state.error || "", /开发版本/);
    assert.equal(logs.some((entry) => entry.stage === "updates.check.unsupported"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
