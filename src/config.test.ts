import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { OFFICIAL_VISION_MODEL, configPath, initializeWorkspace, isOnboardingComplete, loadConfig, markOnboardingComplete, oobeProgressPath, readOobeProgress, readSettings, resolveVisionAgentConfig, saveOobeProgress, saveSettings, type OobeProgress } from "./config.js";
import type { SecAgentConfig } from "./types.js";
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

test("persists the vision model id with the settings", () => {
  const workspace = temporaryWorkspace();
  try {
    initializeWorkspace(workspace);
    const settings = readSettings(workspace);
    const saved = saveSettings(workspace, { ...settings, visionModelId: "custom-provider:vision" });
    assert.equal(saved.visionModelId, "custom-provider:vision");
    assert.equal(readSettings(workspace).visionModelId, "custom-provider:vision");
    // Clearing the value removes the persisted key.
    const cleared = saveSettings(workspace, { ...settings, visionModelId: undefined });
    assert.equal(cleared.visionModelId, undefined);
    assert.equal(readSettings(workspace).visionModelId, undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function multiModelConfig(overrides: Partial<SecAgentConfig> = {}): SecAgentConfig {
  return {
    version: 1,
    workspace: "/tmp/secagent-test-ws",
    agent: {
      provider: "openai-compatible",
      model: "main",
      apiKeyEnv: "MAIN_KEY",
      baseUrl: "https://main.test/v1",
      endpoint: "/chat/completions",
      maxTokens: 100,
      systemPrompt: "main",
      models: [
        { id: "main", provider: "openai-compatible", model: "main", apiKeyEnv: "MAIN_KEY", baseUrl: "https://main.test/v1", endpoint: "/chat/completions", maxTokens: 100 },
        { id: "vision", provider: "openai-compatible", model: "vision-model", apiKeyEnv: "VISION_KEY", baseUrl: "https://vision.test/v1", endpoint: "/chat/completions", maxTokens: 100 },
        { id: "sectl-official:deepseek-v4-flash", provider: "openai-responses", model: "deepseek-v4-flash", apiKeyEnv: "SECTL_OFFICIAL_TOKEN", baseUrl: "https://relay.test/v1", endpoint: "/responses", maxTokens: 100 }
      ]
    },
    mcp: { servers: {} },
    ...overrides
  } as SecAgentConfig;
}

test("resolveVisionAgentConfig honors an explicit vision model id without mutating the source config", () => {
  const config = multiModelConfig({ defaults: { modelId: "main", visionModelId: "vision" } });
  const vision = resolveVisionAgentConfig(config);
  assert.ok(vision);
  assert.equal(vision.agent.model, "vision-model");
  assert.equal(vision.agent.apiKeyEnv, "VISION_KEY");
  assert.equal(vision.agent.baseUrl, "https://vision.test/v1");
  // The caller's config keeps its own model.
  assert.equal(config.agent.model, "main");
});

test("resolveVisionAgentConfig returns undefined for a stale vision model id", () => {
  const config = multiModelConfig({ defaults: { visionModelId: "does-not-exist" } });
  assert.equal(resolveVisionAgentConfig(config), undefined);
});

test("resolveVisionAgentConfig falls back to the official virtual-vision model in official mode", () => {
  const previous = process.env.SECTL_OFFICIAL_TOKEN;
  process.env.SECTL_OFFICIAL_TOKEN = "test-token";
  try {
    const config = multiModelConfig({ defaults: { customModelMode: false } });
    const vision = resolveVisionAgentConfig(config);
    assert.ok(vision);
    assert.equal(vision.agent.model, OFFICIAL_VISION_MODEL);
    assert.equal(vision.agent.apiKeyEnv, "SECTL_OFFICIAL_TOKEN");
    assert.equal(vision.agent.endpoint, "/responses");
  } finally {
    if (previous === undefined) delete process.env.SECTL_OFFICIAL_TOKEN;
    else process.env.SECTL_OFFICIAL_TOKEN = previous;
  }
});

test("resolveVisionAgentConfig does not fall back in custom model mode", () => {
  const previous = process.env.SECTL_OFFICIAL_TOKEN;
  process.env.SECTL_OFFICIAL_TOKEN = "test-token";
  try {
    const config = multiModelConfig({ defaults: { customModelMode: true } });
    assert.equal(resolveVisionAgentConfig(config), undefined);
  } finally {
    if (previous === undefined) delete process.env.SECTL_OFFICIAL_TOKEN;
    else process.env.SECTL_OFFICIAL_TOKEN = previous;
  }
});
