import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkill } from "./runtime.js";
import type { LoadedSkill } from "./skills.js";

function skill(name: string): LoadedSkill {
  return { name, description: "test", path: `/tmp/${name}/SKILL.md`, content: "test" };
}

test("resolves a plugin Skill by its unqualified name", () => {
  const resolved = resolveSkill([skill("iccce-connector/iccce")], "iccce");
  assert.equal(resolved?.name, "iccce-connector/iccce");
});

test("prefers an exact Skill name", () => {
  const resolved = resolveSkill([skill("iccce"), skill("iccce-connector/iccce")], "iccce");
  assert.equal(resolved?.name, "iccce");
});

test("does not guess when an unqualified Skill name is ambiguous", () => {
  const resolved = resolveSkill([skill("first/iccce"), skill("second/iccce")], "iccce");
  assert.equal(resolved, undefined);
});
