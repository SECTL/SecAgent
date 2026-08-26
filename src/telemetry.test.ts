import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { TelemetryClient, normalizeMessage, redactTraceEvent } from "./telemetry.js";

test("normalizes telemetry messages and redacts trace content", () => {
  const message = normalizeMessage("failed C:\\Users\\Alice\\secret.txt Bearer abc.def https://example.test/token");
  assert.equal(message.includes("Alice"), false);
  assert.equal(message.includes("abc.def"), false);
  assert.equal(message.includes("example.test"), false);

  const redacted = redactTraceEvent({
    sequence: 1,
    at: "2026-08-26T00:00:00.000Z",
    stage: "tool.call",
    data: { name: "search", arguments: { query: "private query" }, result: "private result", content: "private content", status: "failed" }
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("private query"), false);
  assert.equal(serialized.includes("private result"), false);
  assert.equal(serialized.includes("private content"), false);
  assert.equal(redacted.data.argumentsBytes, Buffer.byteLength(JSON.stringify({ query: "private query" })));
  assert.equal(redacted.data.resultLength, "private result".length);
});

test("disabled telemetry makes no request", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-telemetry-off-"));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return new Response("{}", { status: 200 }); };
  try {
    const client = new TelemetryClient({ baseUrl: "https://telemetry.example", storageDirectory: directory, appVersion: "test", enabled: false });
    client.recordFailure({ type: "model.timeout", error: new Error("should not upload") });
    await assert.rejects(() => client.uploadDiagnostic({ meta: { id: "session", title: "test", createdAt: "now", updatedAt: "now" }, messages: [] }, []));
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failure events are sanitized while explicit diagnostics retain only selected session content", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-telemetry-on-"));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body?: unknown }> = [];
  globalThis.fetch = async (...args) => {
    requests.push({ url: String(args[0]), body: args[1]?.body });
    return new Response("{}", { status: 200 });
  };
  try {
    const client = new TelemetryClient({ baseUrl: "https://telemetry.example", storageDirectory: directory, appVersion: "test", enabled: true });
    client.recordFailure({ type: "tool.call.failed", error: new Error("failed C:\\Users\\Alice\\secret.txt"), context: { prompt: "private prompt", apiKey: "private key", tool: "search" } });
    await (client as unknown as { flush: () => Promise<void> }).flush();
    const eventBody = String(requests[0].body);
    assert.equal(eventBody.includes("private prompt"), false);
    assert.equal(eventBody.includes("private key"), false);
    assert.equal(eventBody.includes("Alice"), false);
    assert.equal(eventBody.includes("search"), true);

    await client.uploadDiagnostic({
      meta: { id: "session", title: "test", createdAt: "now", updatedAt: "now" },
      messages: [{ id: "message", role: "user", content: "user-selected diagnostic content", createdAt: "now" }]
    }, [{ sequence: 1, at: "now", stage: "tool.call", data: { arguments: { secret: "do not include" }, result: "private result" } }]);
    const diagnostic = JSON.parse(gunzipSync(requests[1].body as Buffer).toString("utf8")) as { session: { messages: Array<{ content: string }> }; runtime: unknown };
    assert.equal(diagnostic.session.messages[0].content, "user-selected diagnostic content");
    assert.equal(JSON.stringify(diagnostic.runtime).includes("do not include"), false);
    assert.equal(JSON.stringify(diagnostic.runtime).includes("private result"), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("retries the sanitized event queue after an offline restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-telemetry-retry-"));
  const originalFetch = globalThis.fetch;
  let online = false;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (!online) throw new Error("offline");
    return new Response("{}", { status: 200 });
  };
  try {
    const first = new TelemetryClient({ baseUrl: "https://telemetry.example", storageDirectory: directory, appVersion: "test", enabled: true });
    first.recordFailure({ type: "model.timeout", error: new Error("offline") });
    await (first as unknown as { flush: () => Promise<void> }).flush();
    first.stop();
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "telemetry-events.json"), "utf8")).length, 1);

    online = true;
    const second = new TelemetryClient({ baseUrl: "https://telemetry.example", storageDirectory: directory, appVersion: "test", enabled: true });
    await (second as unknown as { flush: () => Promise<void> }).flush();
    assert.equal(requests, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "telemetry-events.json"), "utf8")).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
