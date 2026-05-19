import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  activateSkillProfile,
  isSkillAgent,
  listAvailableSkillProfiles,
  normalizeSkillProfileName,
  resolveDefaultSkillTarget,
} from "../lib/skills/profile";

test("normalizeSkillProfileName accepts simple profile names", () => {
  assert.equal(normalizeSkillProfileName("frontend"), "frontend");
  assert.equal(normalizeSkillProfileName("medusa-v2"), "medusa-v2");
});

test("normalizeSkillProfileName rejects path-like names", () => {
  assert.throws(() => normalizeSkillProfileName("../all"), /Invalid skill profile/);
});

test("listAvailableSkillProfiles reads Soul profile JSON files", () => {
  const profiles = listAvailableSkillProfiles();
  assert.ok(profiles.includes("base"));
  assert.ok(profiles.includes("all"));
});

test("activateSkillProfile delegates to the Soul activator", async (t) => {
  const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-skills-profile-"));
  t.after(async () => {
    await fsp.rm(targetRoot, { recursive: true, force: true });
  });

  const result = activateSkillProfile({
    profile: "base",
    agent: "codex",
    target: path.join(targetRoot, "skills"),
  });

  assert.equal(result.activated, true);
  assert.equal(result.profile, "base");
  assert.equal(result.skillCount, 10);
});

test("isSkillAgent narrows to known agents", () => {
  assert.equal(isSkillAgent("codex"), true);
  assert.equal(isSkillAgent("claude"), true);
  assert.equal(isSkillAgent("hermes"), true);
  assert.equal(isSkillAgent("kiro"), false);
  assert.equal(isSkillAgent(""), false);
});

test("resolveDefaultSkillTarget points hermes at hermes-agent/skills", () => {
  const previous = process.env.AUTHMUX_HERMES_HOME;
  process.env.AUTHMUX_HERMES_HOME = "/tmp/authmux-hermes-fixture";
  try {
    assert.equal(
      resolveDefaultSkillTarget("hermes"),
      path.join("/tmp/authmux-hermes-fixture", "skills"),
    );
  } finally {
    if (previous === undefined) delete process.env.AUTHMUX_HERMES_HOME;
    else process.env.AUTHMUX_HERMES_HOME = previous;
  }
});

test("resolveDefaultSkillTarget returns undefined for codex and claude", () => {
  assert.equal(resolveDefaultSkillTarget("codex"), undefined);
  assert.equal(resolveDefaultSkillTarget("claude"), undefined);
});

test("activateSkillProfile fills hermes target from env when not given", async (t) => {
  const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-skills-hermes-"));
  t.after(async () => {
    await fsp.rm(targetRoot, { recursive: true, force: true });
  });
  const previous = process.env.AUTHMUX_HERMES_HOME;
  process.env.AUTHMUX_HERMES_HOME = targetRoot;
  try {
    const result = activateSkillProfile({ profile: "base", agent: "hermes" });
    assert.equal(result.activated, true);
    assert.equal(result.agent, "hermes");
    assert.equal(result.target, path.join(targetRoot, "skills"));
    assert.equal(result.skillCount, 10);
  } finally {
    if (previous === undefined) delete process.env.AUTHMUX_HERMES_HOME;
    else process.env.AUTHMUX_HERMES_HOME = previous;
  }
});
