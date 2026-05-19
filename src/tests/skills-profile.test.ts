import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  activateSkillProfile,
  listAvailableSkillProfiles,
  normalizeSkillProfileName,
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
