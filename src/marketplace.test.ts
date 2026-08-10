import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions } from "./marketplace.js";

test("marketplace versions compare numerically and respect prereleases", () => {
  assert.equal(compareVersions("1.0.10", "1.0.2") > 0, true);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.1") > 0, true);
  assert.equal(compareVersions("2.0.0", "1.9.99") > 0, true);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});
