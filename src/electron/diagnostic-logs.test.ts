import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportDiagnosticLogs } from "./diagnostic-logs.js";

test("exports logs with diagnostic context and redacts message content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-diagnostics-"));
  const archivePath = path.join(root, "diagnostics.zip");
  try {
    const logDirectory = path.join(root, "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.writeFileSync(path.join(logDirectory, "electron-main.jsonl"), `${JSON.stringify({ stage: "ipc.sessions.send", data: { text: "private conversation", token: "secret-value", status: 200 } })}\n`, "utf8");
    exportDiagnosticLogs(root, archivePath, { appVersion: "0.1.0-alpha.2", platform: "win32", arch: "x64", isPackaged: true });
    const archive = new AdmZip(archivePath);
    const log = archive.getEntry("logs/electron-main.jsonl")?.getData().toString("utf8") || "";
    const context = archive.getEntry("diagnostic.json")?.getData().toString("utf8") || "";
    assert.doesNotMatch(log, /private conversation|secret-value/);
    assert.match(log, /ipc\.sessions\.send/);
    assert.match(context, /0\.1\.0-alpha\.2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
