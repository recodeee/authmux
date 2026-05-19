import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type SkillAgent = "codex" | "claude" | "hermes";
export type SkillProfileSource = "env" | "account" | "default";

const SKILL_AGENTS: readonly SkillAgent[] = ["codex", "claude", "hermes"];

export function isSkillAgent(value: string): value is SkillAgent {
  return (SKILL_AGENTS as readonly string[]).includes(value);
}

export function resolveDefaultSkillTarget(agent: SkillAgent): string | undefined {
  if (agent === "hermes") {
    const root = process.env.AUTHMUX_HERMES_HOME || process.env.HERMES_AGENT_HOME || "~/Documents/hermes-agent";
    return path.join(resolvePath(root), "skills");
  }
  return undefined;
}

export interface ResolvedSkillProfile {
  profile: string;
  source: SkillProfileSource;
  accountName?: string;
}

export interface SkillProfileActivation {
  activated: boolean;
  profile: string;
  agent: SkillAgent;
  target?: string;
  skillCount?: number;
  reason?: string;
  stdout: string;
  stderr: string;
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

function resolvePath(rawPath: string): string {
  return path.resolve(expandHome(rawPath));
}

export function normalizeSkillProfileName(rawProfile: string): string {
  const profile = rawProfile.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile)) {
    throw new Error(`Invalid skill profile name: ${rawProfile}`);
  }
  return profile;
}

export function defaultSkillProfileName(): string {
  return normalizeSkillProfileName(process.env.AUTHMUX_DEFAULT_SKILL_PROFILE || "base");
}

export function resolveSoulHome(): string {
  return resolvePath(process.env.AUTHMUX_SOUL_HOME || process.env.SOUL_HOME || "~/Documents/soul");
}

export function resolveSoulSkillActivator(): string {
  const explicit = process.env.AUTHMUX_SOUL_SKILL_ACTIVATOR;
  if (explicit && explicit.trim().length > 0) {
    return resolvePath(explicit.trim());
  }
  return path.join(resolveSoulHome(), "skills", "scripts", "activate-profile.sh");
}

export function resolveSoulProfilesRoot(): string {
  return path.join(resolveSoulHome(), "skills", "profiles");
}

export function listAvailableSkillProfiles(): string[] {
  const profilesRoot = resolveSoulProfilesRoot();
  if (!fs.existsSync(profilesRoot)) return [];
  return fs.readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/i, ""))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function activateSkillProfile(input: {
  profile: string;
  agent?: SkillAgent;
  target?: string;
}): SkillProfileActivation {
  const profile = normalizeSkillProfileName(input.profile);
  const agent = input.agent ?? "codex";
  const target = input.target ?? resolveDefaultSkillTarget(agent);
  const activator = resolveSoulSkillActivator();
  if (!fs.existsSync(activator)) {
    return {
      activated: false,
      profile,
      agent,
      target,
      reason: `missing activator: ${activator}`,
      stdout: "",
      stderr: "",
    };
  }

  const args = ["--profile", profile, "--agent", agent];
  if (target) {
    args.push("--target", target);
  }

  const result = spawnSync(activator, args, {
    encoding: "utf8",
    env: process.env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (result.status !== 0) {
    throw new Error(
      `Skill profile activation failed for "${profile}" (${result.status ?? "unknown"}): ${stderr || stdout}`,
    );
  }

  const targetMatch = stdout.match(/\btarget=(\S+)/);
  const countMatch = stdout.match(/\bskills=(\d+)/);
  return {
    activated: true,
    profile,
    agent,
    target: target ?? targetMatch?.[1],
    skillCount: countMatch ? Number.parseInt(countMatch[1], 10) : undefined,
    stdout,
    stderr,
  };
}
