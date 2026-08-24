import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WORKSPACE_ENV, resolveDefaultWorkspace } from "./paths.js";

test("uses the default SecAgent workspace when no override is set", () => {
  assert.equal(resolveDefaultWorkspace({}), path.join(os.homedir(), "SecAgentWorkspace"));
});

test("resolves SECTL_WORKSPACE as an absolute workspace path", () => {
  const configured = path.join(os.tmpdir(), "secagent-env-workspace");
  assert.equal(resolveDefaultWorkspace({ [WORKSPACE_ENV]: configured }), configured);
});

test("ignores an empty SECTL_WORKSPACE value", () => {
  assert.equal(resolveDefaultWorkspace({ [WORKSPACE_ENV]: "   " }), path.join(os.homedir(), "SecAgentWorkspace"));
});
