import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolResult, toolResultParts, toolResultText } from "./tool-content.js";

test("normalizes an MCP image content block without losing the image", () => {
  const parts = toolResultParts([
    { type: "text", text: "截图" },
    { type: "image", data: "AQI=", mimeType: "image/png" }
  ]);
  assert.equal(parts.text, "截图");
  assert.equal(parts.images[0]?.mimeType, "image/png");
  assert.equal(toolResultText(parts), "截图");
});

test("summarizes image results without persisting base64 data", () => {
  const summary = summarizeToolResult({ type: "image", data: "AQI=", mimeType: "image/png", name: "screen.png" }) as { images: Array<{ name?: string; bytes?: number; data?: string }> };
  assert.equal(summary.images[0]?.name, "screen.png");
  assert.equal(summary.images[0]?.bytes, 2);
  assert.equal(summary.images[0]?.data, undefined);
});
