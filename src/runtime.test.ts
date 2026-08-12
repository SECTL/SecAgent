import assert from "node:assert/strict";
import test from "node:test";
import { resolveSkill, selectAutoLoadedSkills } from "./runtime.js";
import { loadEnabledSkills } from "./skills.js";
import type { SecAgentConfig } from "./types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("auto-loads every matching skill only once and skips skills already read", () => {
  const skills: LoadedSkill[] = [
    { ...skill("plugin/score"), autoLoadPattern: { source: "score", flags: "i" } },
    { ...skill("plugin/class"), autoLoadPattern: { source: "score|class", flags: "i" } },
    { ...skill("plugin/other"), autoLoadPattern: { source: "score", flags: "i" } }
  ];
  assert.deepEqual(selectAutoLoadedSkills(skills, "please score this", ["plugin/score"], ["other"] ).map((item) => item.name), ["plugin/class"]);
  assert.deepEqual(selectAutoLoadedSkills(skills, "please score this", [], ["class"]).map((item) => item.name), ["plugin/score", "plugin/other"]);
});

test("built-in math visualization skill auto-loads for math and diagram requests", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "secagent-math-skill-"));
  const config = { workspace } as SecAgentConfig;
  const math = loadEnabledSkills(config).find((item) => item.name === "math-visualization");
  assert.ok(math?.autoLoadPattern);
  assert.equal(selectAutoLoadedSkills([math!], "请推导圆柱体体积公式并画一个三维示意图").length, 1);
  assert.equal(selectAutoLoadedSkills([math!], "帮我写一封普通邮件").length, 0);
});
