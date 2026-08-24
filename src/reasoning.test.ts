import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicThinkingConfig,
  googleThinkingConfig,
  reasoningEffortsForTarget,
  reasoningFieldsForChat,
  reasoningFieldsForResponses
} from "./reasoning.js";

test("DeepSeek uses official Chat thinking fields", () => {
  const target = { provider: "openai-compatible", model: "deepseek-v4-flash" };
  assert.deepEqual(reasoningEffortsForTarget(target), ["none", "high", "max"]);
  assert.deepEqual(reasoningFieldsForChat(target, "none"), { thinking: { type: "disabled" } });
  assert.deepEqual(reasoningFieldsForChat(target, "high"), { thinking: { type: "enabled" }, reasoning_effort: "high" });
});

test("Doubao maps none to minimal and preserves official levels", () => {
  const target = { provider: "openai-compatible", model: "doubao-seed-2-0-mini-260428" };
  assert.deepEqual(reasoningEffortsForTarget(target), ["none", "low", "medium", "high"]);
  assert.deepEqual(reasoningFieldsForChat(target, "none"), { reasoning_effort: "minimal" });
  assert.deepEqual(reasoningFieldsForChat(target, "medium"), { reasoning_effort: "medium" });
});

test("Qwen uses thinking_budget instead of reasoning_effort", () => {
  const target = { provider: "openai-compatible", model: "qwen3.7-flash" };
  assert.deepEqual(reasoningFieldsForChat(target, "none"), { enable_thinking: false });
  assert.deepEqual(reasoningFieldsForChat(target, "medium"), { enable_thinking: true, thinking_budget: 4096 });
});

test("GLM 4.7 exposes only the protocol it supports", () => {
  const target = { provider: "openai-compatible", model: "glm-4.7-flash" };
  assert.deepEqual(reasoningEffortsForTarget(target), ["high"]);
  assert.deepEqual(reasoningFieldsForChat(target, "high"), { thinking: { type: "enabled" } });
});

test("Step exposes only documented effort levels", () => {
  assert.deepEqual(reasoningEffortsForTarget({ provider: "openai-compatible", model: "step-3.5-flash" }), ["low", "high"]);
  assert.deepEqual(reasoningEffortsForTarget({ provider: "openai-compatible", model: "step-3.7-flash" }), ["low", "medium", "high"]);
});

test("Responses and native providers use their own field shapes", () => {
  assert.deepEqual(reasoningFieldsForResponses({ provider: "openai-responses", model: "gpt-5.2" }, "medium"), { reasoning: { effort: "medium", summary: "auto" } });
  assert.deepEqual(reasoningEffortsForTarget({ provider: "openai-responses", model: "gpt-5.6-luna" }), ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(reasoningFieldsForResponses({ provider: "openai-responses", model: "gpt-5.6-luna" }, "none"), { reasoning: { effort: "minimal", summary: "auto" } });
  assert.deepEqual(googleThinkingConfig({ provider: "google", model: "gemini-3.7-flash" }, "none"), { thinkingLevel: "low" });
  assert.deepEqual(anthropicThinkingConfig({ provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 16384 }, "none"), { thinking: { type: "disabled" } });
});
