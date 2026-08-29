import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { configPath, initializeWorkspace, isOnboardingComplete, loadConfig, markOnboardingComplete, oobeProgressPath, readOobeProgress, readSettings, saveOobeProgress, saveSettings, type OobeProgress } from "./config.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "secagent-oobe-"));
}

test("persists OOBE progress and clears it when onboarding completes", () => {
  const workspace = temporaryWorkspace();
  try {
    const progress: OobeProgress = { step: "config", source: "official" };
    saveOobeProgress(workspace, progress);
    assert.deepEqual(readOobeProgress(workspace), progress);

    markOnboardingComplete(workspace);
    assert.equal(isOnboardingComplete(workspace), true);
    assert.equal(readOobeProgress(workspace), undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("does not persist a custom provider API key in OOBE progress", () => {
  const workspace = temporaryWorkspace();
  try {
    const progress = {
      step: "config",
      source: "custom",
      provider: {
        id: "custom-provider",
        name: "Custom",
        provider: "openai-compatible",
        apiKeyEnv: "CUSTOM_API_KEY",
        apiKey: "do-not-write-this",
        baseUrl: "https://example.test/v1",
        endpoint: "/chat/completions",
        models: [{ id: "model", name: "Model", enabled: true }]
      }
    } as unknown as OobeProgress;
    saveOobeProgress(workspace, progress);

    const raw = JSON.parse(fs.readFileSync(oobeProgressPath(workspace), "utf8")) as { provider?: { apiKey?: string } };
    assert.equal(raw.provider?.apiKey, undefined);
    assert.equal("apiKey" in (readOobeProgress(workspace)?.provider || {}), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("hardcodes the system prompt and drops workspace overrides", () => {
  const workspace = temporaryWorkspace();
  try {
    initializeWorkspace(workspace);

    // New workspaces are created without a systemPrompt entry.
    const file = configPath(workspace);
    const readAgent = (): { systemPrompt?: string } | undefined => (YAML.parse(fs.readFileSync(file, "utf8")) as { agent?: { systemPrompt?: string } }).agent;
    assert.equal(readAgent()?.systemPrompt, undefined);

    // A workspace-side agent.systemPrompt is ignored at load time...
    const raw = YAML.parse(fs.readFileSync(file, "utf8")) as { agent: { systemPrompt?: string } };
    raw.agent.systemPrompt = "workspace override";
    fs.writeFileSync(file, YAML.stringify(raw), "utf8");
    assert.equal(loadConfig(workspace).config.agent.systemPrompt, SYSTEM_PROMPT);

    // ...and the stale key disappears from secagent.yaml when settings are saved.
    saveSettings(workspace, readSettings(workspace));
    assert.equal(readAgent()?.systemPrompt, undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("persists the autostart preference with the settings", () => {
  const workspace = temporaryWorkspace();
  try {
    initializeWorkspace(workspace);
    const settings = readSettings(workspace);
    const saved = saveSettings(workspace, { ...settings, autostart: true });

    assert.equal(saved.autostart, true);
    assert.equal(readSettings(workspace).autostart, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("hides the main window after autostart by default and honors opting out", () => {
  const workspace = temporaryWorkspace();
  try {
    initializeWorkspace(workspace);

    // Fresh installs (including installer-based ones) start with the option on.
    assert.equal(readSettings(workspace).autostartHidden, true);

    const settings = readSettings(workspace);
    assert.equal(saveSettings(workspace, { ...settings, autostart: true }).autostartHidden, true);
    assert.equal(saveSettings(workspace, { ...settings, autostartHidden: false }).autostartHidden, false);
    assert.equal(readSettings(workspace).autostartHidden, false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("defaults and persists Windows update preferences", () => {
  const workspace = temporaryWorkspace();
  try {
    initializeWorkspace(workspace);
    const settings = readSettings(workspace);
    assert.deepEqual(settings.updates, { channel: "stable", autoCheck: true, autoDownload: true, autoInstallOnQuit: true });
    const saved = saveSettings(workspace, { ...settings, updates: { channel: "preview", autoCheck: false, autoDownload: true, autoInstallOnQuit: false } });
    assert.deepEqual(saved.updates, { channel: "preview", autoCheck: false, autoDownload: true, autoInstallOnQuit: false });
    assert.deepEqual(readSettings(workspace).updates, saved.updates);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
