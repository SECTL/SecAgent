import assert from "node:assert/strict";
import test from "node:test";
import { formatOfficialBalanceExpiry, formatOfficialPoints } from "./official-balance.js";

test("official Points use two decimal places", () => {
  assert.equal(formatOfficialPoints(12), "12.00");
  assert.equal(formatOfficialPoints(1.236), "1.24");
});

test("official balance expiry labels permanent and timed groups", () => {
  assert.equal(formatOfficialBalanceExpiry(null), "永久额度");
  assert.match(formatOfficialBalanceExpiry("2026-09-01T00:00:00Z"), /失效：/);
});
