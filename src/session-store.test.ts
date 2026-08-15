import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "./session-store.js";

test("restores only the latest session run from the runtime log", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-session-store-"));
  try {
    const store = new SessionStore(workspace);
    const session = store.create();
    store.appendRuntimeEvent(session.meta.id, { sequence: 1, at: "2026-01-01T00:00:00.000Z", stage: "user.request", data: { text: "old" } });
    store.appendRuntimeEvent(session.meta.id, { sequence: 2, at: "2026-01-01T00:00:01.000Z", stage: "assistant.response", data: { text: "old result" } });
    store.appendRuntimeEvent(session.meta.id, { sequence: 3, at: "2026-01-01T00:00:02.000Z", stage: "user.request", data: { text: "current" } });
    store.appendRuntimeEvent(session.meta.id, { sequence: 4, at: "2026-01-01T00:00:03.000Z", stage: "mcp.tools/call", data: { name: "lookup" } });
    fs.appendFileSync(path.join(workspace, "sessions", session.meta.id, "runtime.jsonl"), "not-json\n", "utf8");

    assert.deepEqual(store.getRuntimeEvents(session.meta.id).map((event) => event.sequence), [3, 4]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("persists a generated session title in the session index", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-session-title-"));
  try {
    const store = new SessionStore(workspace);
    const session = store.create();
    store.setTitle(session.meta.id, "整理课程安排");
    assert.equal(store.get(session.meta.id).meta.title, "整理课程安排");
    assert.equal(store.list()[0]?.title, "整理课程安排");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
