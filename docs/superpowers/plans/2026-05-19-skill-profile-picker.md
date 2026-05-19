# Skill-Profile Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive Soul skill-profile chooser that appears when the user types `codex`, `claude-account1`, or `claude-account2` in a TTY, with silent fallback for non-TTY and an `AUTHMUX_SKILL_PICK=off` escape hatch.

**Architecture:** New `authmux skills pick` command on top of the existing `activateSkillProfile` helper, plus rewiring of two shell-hook emitters (`scripts/postinstall-login-hook.cjs` codex() body and `src/commands/parallel.ts` generateAliases()).

**Tech Stack:** TypeScript, oclif, `prompts` (already a dep), node:test, bash.

**Spec:** `docs/superpowers/specs/2026-05-19-skill-profile-picker-design.md`.

**Parallel teams:** Tracks A / B / C below run as three concurrent sub-agents. Track A (Tasks 1–6) is the long pole; Track B (Tasks 7–8) starts as soon as Task 3 lands (flag surface frozen); Track C (Tasks 9–10) starts as soon as Task 1 lands. Integration (Tasks 11–12) is sequential at the end.

---

## File Structure

| File | Track | Responsibility |
|------|-------|----------------|
| `src/lib/skills/profile.ts` | A | Add helpers: `resolveDefaultProfileForAgent`, `isInteractiveTty`, `readClaudeAccountSkillProfile`, `writeClaudeAccountSkillProfile`. Existing API unchanged. |
| `src/commands/skills-pick.ts` | A | New oclif command `authmux skills:pick`. Self-contained; extends `BaseCommand` but sets `syncExternalAuthBeforeRun = false`. |
| `src/tests/skills-pick.test.ts` | A | Unit tests for helpers + command (non-TTY paths only — no interactive coverage). |
| `src/tests/skills-profile.test.ts` | A | Extend with cascade helper coverage. |
| `src/commands/parallel.ts` | B | Replace `generateAliases()` body with a `__authmux_claude_account` shell function + per-account aliases. |
| `scripts/postinstall-login-hook.cjs` | B | Replace the silent `skills activate-current` line inside `codex()` with `skills pick --agent codex --quiet --save || true`. |
| `src/tests/login-hook.test.ts` | B | Add assertion that the rendered `codex()` block contains `skills pick`, not `activate-current`. |
| `README.md` | C | Document the picker, env knobs, opt-out. |
| `docs/superpowers/specs/2026-05-19-skill-profile-picker-design.md` | C | Already merged; mark "Implemented in PR #N" at end after merge. |

---

## Track A — TypeScript core

### Task 1: Add `resolveDefaultProfileForAgent` cascade helper

**Files:**
- Modify: `src/lib/skills/profile.ts`
- Test: `src/tests/skills-profile.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/skills-profile.test.ts`:

```typescript
import { resolveDefaultProfileForAgent } from "../lib/skills/profile";

test("resolveDefaultProfileForAgent: env AUTHMUX_SKILL_PROFILE wins", () => {
  const prev = process.env.AUTHMUX_SKILL_PROFILE;
  process.env.AUTHMUX_SKILL_PROFILE = "frontend";
  try {
    assert.equal(resolveDefaultProfileForAgent({ savedProfile: "design" }), "frontend");
  } finally {
    if (prev === undefined) delete process.env.AUTHMUX_SKILL_PROFILE;
    else process.env.AUTHMUX_SKILL_PROFILE = prev;
  }
});

test("resolveDefaultProfileForAgent: saved beats AUTHMUX_DEFAULT_SKILL_PROFILE", () => {
  const prevEnv = process.env.AUTHMUX_SKILL_PROFILE;
  const prevDef = process.env.AUTHMUX_DEFAULT_SKILL_PROFILE;
  delete process.env.AUTHMUX_SKILL_PROFILE;
  process.env.AUTHMUX_DEFAULT_SKILL_PROFILE = "all";
  try {
    assert.equal(resolveDefaultProfileForAgent({ savedProfile: "design" }), "design");
  } finally {
    if (prevEnv === undefined) delete process.env.AUTHMUX_SKILL_PROFILE;
    else process.env.AUTHMUX_SKILL_PROFILE = prevEnv;
    if (prevDef === undefined) delete process.env.AUTHMUX_DEFAULT_SKILL_PROFILE;
    else process.env.AUTHMUX_DEFAULT_SKILL_PROFILE = prevDef;
  }
});

test("resolveDefaultProfileForAgent: falls through to base when nothing set", () => {
  const prevEnv = process.env.AUTHMUX_SKILL_PROFILE;
  const prevDef = process.env.AUTHMUX_DEFAULT_SKILL_PROFILE;
  delete process.env.AUTHMUX_SKILL_PROFILE;
  delete process.env.AUTHMUX_DEFAULT_SKILL_PROFILE;
  try {
    assert.equal(resolveDefaultProfileForAgent({ savedProfile: undefined }), "base");
  } finally {
    if (prevEnv !== undefined) process.env.AUTHMUX_SKILL_PROFILE = prevEnv;
    if (prevDef !== undefined) process.env.AUTHMUX_DEFAULT_SKILL_PROFILE = prevDef;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test --test-name-pattern "resolveDefaultProfileForAgent" dist/tests/skills-profile.test.js`
Expected: build fails because `resolveDefaultProfileForAgent` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `src/lib/skills/profile.ts` after `defaultSkillProfileName`:

```typescript
export function resolveDefaultProfileForAgent(input: {
  savedProfile: string | undefined;
}): string {
  const envOverride = (process.env.AUTHMUX_SKILL_PROFILE || process.env.SOUL_SKILL_PROFILE || "").trim();
  if (envOverride.length > 0) return normalizeSkillProfileName(envOverride);
  if (input.savedProfile && input.savedProfile.trim().length > 0) {
    return normalizeSkillProfileName(input.savedProfile);
  }
  return defaultSkillProfileName();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test --test-name-pattern "resolveDefaultProfileForAgent" dist/tests/skills-profile.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/profile.ts src/tests/skills-profile.test.ts
git commit -m "feat(skills): add resolveDefaultProfileForAgent cascade helper"
```

---

### Task 2: Add `isInteractiveTty` + claude-account skill-profile file helpers

**Files:**
- Modify: `src/lib/skills/profile.ts`
- Test: `src/tests/skills-profile.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/tests/skills-profile.test.ts`:

```typescript
import {
  isInteractiveTty,
  readClaudeAccountSkillProfile,
  writeClaudeAccountSkillProfile,
  claudeAccountDir,
} from "../lib/skills/profile";

test("isInteractiveTty respects AUTHMUX_SKILL_PICK=off", () => {
  const prev = process.env.AUTHMUX_SKILL_PICK;
  process.env.AUTHMUX_SKILL_PICK = "off";
  try {
    assert.equal(isInteractiveTty({ stdin: { isTTY: true } as NodeJS.ReadStream, stdout: { isTTY: true } as NodeJS.WriteStream }), false);
  } finally {
    if (prev === undefined) delete process.env.AUTHMUX_SKILL_PICK;
    else process.env.AUTHMUX_SKILL_PICK = prev;
  }
});

test("isInteractiveTty returns false when stdin or stdout is not a TTY", () => {
  delete process.env.AUTHMUX_SKILL_PICK;
  assert.equal(isInteractiveTty({ stdin: { isTTY: false } as NodeJS.ReadStream, stdout: { isTTY: true } as NodeJS.WriteStream }), false);
  assert.equal(isInteractiveTty({ stdin: { isTTY: true } as NodeJS.ReadStream, stdout: { isTTY: false } as NodeJS.WriteStream }), false);
  assert.equal(isInteractiveTty({ stdin: { isTTY: true } as NodeJS.ReadStream, stdout: { isTTY: true } as NodeJS.WriteStream }), true);
});

test("read/writeClaudeAccountSkillProfile round-trip the per-dir file", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-claudeacct-"));
  t.after(async () => { await fsp.rm(root, { recursive: true, force: true }); });
  const acct = "spec-test";
  await fsp.mkdir(path.join(root, acct), { recursive: true });
  writeClaudeAccountSkillProfile({ accountsDir: root, account: acct, profile: "design" });
  assert.equal(readClaudeAccountSkillProfile({ accountsDir: root, account: acct }), "design");
});

test("readClaudeAccountSkillProfile returns undefined when missing", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-claudeacct-"));
  t.after(async () => { await fsp.rm(root, { recursive: true, force: true }); });
  await fsp.mkdir(path.join(root, "nope"), { recursive: true });
  assert.equal(readClaudeAccountSkillProfile({ accountsDir: root, account: "nope" }), undefined);
});

test("claudeAccountDir defaults to ~/.claude-accounts/<name>", () => {
  const expected = path.join(os.homedir(), ".claude-accounts", "x");
  assert.equal(claudeAccountDir("x"), expected);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: build fails on missing exports.

- [ ] **Step 3: Implement helpers**

Append to `src/lib/skills/profile.ts`:

```typescript
export const CLAUDE_ACCOUNT_PROFILE_FILE = ".authmux-skill-profile";

export function claudeAccountsRoot(): string {
  return resolvePath(process.env.AUTHMUX_CLAUDE_ACCOUNTS_DIR || "~/.claude-accounts");
}

export function claudeAccountDir(account: string): string {
  return path.join(claudeAccountsRoot(), account);
}

export function readClaudeAccountSkillProfile(input: { accountsDir?: string; account: string }): string | undefined {
  const root = input.accountsDir ?? claudeAccountsRoot();
  const file = path.join(root, input.account, CLAUDE_ACCOUNT_PROFILE_FILE);
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw.length > 0 ? raw : undefined;
}

export function writeClaudeAccountSkillProfile(input: { accountsDir?: string; account: string; profile: string }): void {
  const root = input.accountsDir ?? claudeAccountsRoot();
  const dir = path.join(root, input.account);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CLAUDE_ACCOUNT_PROFILE_FILE);
  fs.writeFileSync(file, `${normalizeSkillProfileName(input.profile)}\n`);
}

export interface InteractiveTtyInput {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}

export function isInteractiveTty(streams: InteractiveTtyInput = { stdin: process.stdin, stdout: process.stdout }): boolean {
  const opt = (process.env.AUTHMUX_SKILL_PICK || "").trim().toLowerCase();
  if (opt === "off" || opt === "0" || opt === "false" || opt === "no") return false;
  return Boolean(streams.stdin.isTTY) && Boolean(streams.stdout.isTTY);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all skills-profile tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/skills/profile.ts src/tests/skills-profile.test.ts
git commit -m "feat(skills): add claude-account profile-file helpers and TTY detection"
```

---

### Task 3: Add `authmux skills:pick` command (non-TTY paths only)

**Files:**
- Create: `src/commands/skills-pick.ts`
- Test: `src/tests/skills-pick.test.ts`

This task scaffolds the command with everything except the interactive prompt — that lands in Task 4. Track B can start once this task is committed because the flag surface is now frozen.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/skills-pick.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = path.resolve(__dirname, "..", "..", "dist", "index.js");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("skills pick falls back to default when stdin is not a TTY", async (t) => {
  const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-pick-default-"));
  t.after(async () => { await fsp.rm(targetRoot, { recursive: true, force: true }); });

  const result = runCli([
    "skills", "pick",
    "--agent", "codex",
    "--target", path.join(targetRoot, "skills"),
    "--no-save",
    "--default", "base",
    "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.profile, "base");
  assert.equal(payload.data.activation.activated, true);
});

test("skills pick honors AUTHMUX_SKILL_PROFILE override", async (t) => {
  const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-pick-env-"));
  t.after(async () => { await fsp.rm(targetRoot, { recursive: true, force: true }); });

  const result = runCli(
    ["skills", "pick", "--agent", "codex", "--target", path.join(targetRoot, "skills"), "--no-save", "--json"],
    { AUTHMUX_SKILL_PROFILE: "frontend" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.profile, "frontend");
});

test("skills pick --save writes the per-account file for claude agent", async (t) => {
  const accountsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-pick-claude-"));
  t.after(async () => { await fsp.rm(accountsRoot, { recursive: true, force: true }); });
  const account = "smoke";
  await fsp.mkdir(path.join(accountsRoot, account), { recursive: true });

  const result = runCli(
    [
      "skills", "pick",
      "--agent", "claude",
      "--account", account,
      "--target", path.join(accountsRoot, account, "skills"),
      "--save",
      "--default", "design",
      "--json",
    ],
    { AUTHMUX_CLAUDE_ACCOUNTS_DIR: accountsRoot },
  );

  assert.equal(result.status, 0, result.stderr);
  const saved = await fsp.readFile(path.join(accountsRoot, account, ".authmux-skill-profile"), "utf8");
  assert.equal(saved.trim(), "design");
});

test("skills pick AUTHMUX_SKILL_PICK=off behaves like non-TTY", async (t) => {
  const targetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-pick-off-"));
  t.after(async () => { await fsp.rm(targetRoot, { recursive: true, force: true }); });

  const result = runCli(
    ["skills", "pick", "--agent", "codex", "--target", path.join(targetRoot, "skills"), "--no-save", "--default", "base", "--json"],
    { AUTHMUX_SKILL_PICK: "off" },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.profile, "base");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: tests fail because the `pick` command does not exist (oclif "command not found").

- [ ] **Step 3: Implement the command (non-interactive paths only)**

Create `src/commands/skills-pick.ts`:

```typescript
import { Args, Flags } from "@oclif/core";
import path from "node:path";
import { BaseCommand } from "../lib/base-command";
import {
  activateSkillProfile,
  claudeAccountDir,
  isInteractiveTty,
  isSkillAgent,
  listAvailableSkillProfiles,
  normalizeSkillProfileName,
  readClaudeAccountSkillProfile,
  resolveDefaultProfileForAgent,
  resolveDefaultSkillTarget,
  SkillAgent,
  writeClaudeAccountSkillProfile,
} from "../lib/skills/profile";

export default class SkillsPickCommand extends BaseCommand {
  protected readonly syncExternalAuthBeforeRun = false;

  static description = "Pick a Soul skill profile (interactive on TTY, fallback otherwise) and activate it.";
  static aliases = ["skills:pick"];
  static id = "skills pick";

  static args = {} as const;

  static flags = {
    agent: Flags.string({
      description: "Agent skill target",
      options: ["codex", "claude", "hermes"],
      default: "codex",
    }),
    target: Flags.string({ description: "Explicit skills directory" }),
    account: Flags.string({ description: "Account name to save the profile against" }),
    save: Flags.boolean({
      description: "Persist the chosen profile (default true; pair with --no-save to opt out)",
      allowNo: true,
      default: true,
    }),
    "no-activate": Flags.boolean({ description: "Skip activating the skills directory", default: false }),
    quiet: Flags.boolean({ description: "Suppress the success summary line", default: false }),
    default: Flags.string({ description: "Profile name to pre-select / fall back to" }),
    ...BaseCommand.jsonFlag,
  } as const;

  async run(): Promise<void> {
    const { flags } = await this.parse(SkillsPickCommand);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      const agent = flags.agent as SkillAgent;
      if (!isSkillAgent(agent)) this.error(`Unknown agent: ${agent}`);

      const savedProfile = await this.resolveSavedProfile(agent, flags.account);
      const defaultProfile = flags.default ?? resolveDefaultProfileForAgent({ savedProfile });
      const profiles = listAvailableSkillProfiles();

      const interactive = isInteractiveTty() && !this.jsonMode;
      // Prompt path lands in Task 4. For now, always take the fallback.
      const picked = interactive
        ? await this.promptForProfile(profiles, defaultProfile)
        : defaultProfile;

      const normalized = normalizeSkillProfileName(picked);
      const target = flags.target ?? this.resolveTarget(agent, flags.account);

      const activation = flags["no-activate"]
        ? null
        : activateSkillProfile({ profile: normalized, agent, target });

      const saved = flags.save ? await this.persistProfile(agent, normalized, flags.account) : null;

      this.emit(
        { agent, profile: normalized, target: target ?? null, activation: activation ?? null, saved: saved ?? null, source: interactive ? "prompt" : "default" },
        (data) => {
          if (flags.quiet) {
            if (data.activation && !data.activation.activated) this.warn(`Skill profile "${data.profile}" not activated: ${data.activation.reason ?? "unknown reason"}`);
            return;
          }
          if (data.activation?.activated) {
            this.log(`Skill profile: ${data.profile} → ${data.target ?? "default"} (${data.activation.skillCount ?? "?"} skills)`);
          } else if (data.activation) {
            this.warn(`Skill profile "${data.profile}" not activated: ${data.activation.reason ?? "unknown reason"}`);
          } else {
            this.log(`Skill profile saved: ${data.profile} (no-activate)`);
          }
        },
      );
    });
  }

  // Replaced in Task 4 with a prompts.select.
  private async promptForProfile(_profiles: string[], fallback: string): Promise<string> {
    return fallback;
  }

  private async resolveSavedProfile(agent: SkillAgent, account: string | undefined): Promise<string | undefined> {
    if (agent === "claude" && account) {
      return readClaudeAccountSkillProfile({ account });
    }
    const resolved = await this.accounts.resolveCurrentSkillProfile();
    return resolved.profile;
  }

  private resolveTarget(agent: SkillAgent, account: string | undefined): string | undefined {
    if (agent === "claude" && account) {
      return path.join(claudeAccountDir(account), "skills");
    }
    return resolveDefaultSkillTarget(agent);
  }

  private async persistProfile(
    agent: SkillAgent,
    profile: string,
    account: string | undefined,
  ): Promise<{ scope: "claude-account" | "authmux-account"; account: string; profile: string } | null> {
    if (agent === "claude") {
      if (!account) {
        this.warn("--save requires --account for --agent claude; skipping save.");
        return null;
      }
      writeClaudeAccountSkillProfile({ account, profile });
      return { scope: "claude-account", account, profile };
    }
    const currentAccount = account ?? (await this.accounts.getCurrentAccountName());
    if (!currentAccount) {
      this.warn("No current authmux account; skipping save.");
      return null;
    }
    const saved = await this.accounts.setSkillProfileForAccount(currentAccount, profile);
    return { scope: "authmux-account", account: saved.accountName, profile: saved.skillProfile };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all 4 new `skills-pick` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/skills-pick.ts src/tests/skills-pick.test.ts
git commit -m "feat(skills): add 'authmux skills pick' with non-TTY fallback"
```

**🚦 Track B unblocked here.**

---

### Task 4: Wire the interactive `prompts.select` into `skills pick`

**Files:**
- Modify: `src/commands/skills-pick.ts`

No new tests — interactive `prompts` is impractical to drive from `node --test` without injecting a fake. Coverage is via the non-TTY tests in Task 3 plus the manual smoke test in Task 11.

- [ ] **Step 1: Replace the stub `promptForProfile` with a real prompt**

Edit `src/commands/skills-pick.ts`. Add at top:

```typescript
import prompts from "prompts";
import { PromptCancelledError } from "../lib/accounts";
```

Replace the stubbed `promptForProfile` method body:

```typescript
  private async promptForProfile(profiles: string[], fallback: string): Promise<string> {
    if (profiles.length === 0) return fallback;
    const initial = Math.max(profiles.indexOf(fallback), 0);
    const response = await prompts(
      {
        type: "select",
        name: "profile",
        message: "Skill profile",
        choices: profiles.map((name) => ({
          title: name === fallback ? `${name} (current)` : name,
          value: name,
        })),
        initial,
      },
      {
        onCancel: () => {
          throw new PromptCancelledError();
        },
      },
    );
    const picked = response.profile as string | undefined;
    return picked ?? fallback;
  }
```

- [ ] **Step 2: Verify the non-TTY tests still pass**

Run: `npm test`
Expected: all skills-pick tests still pass (they run under non-TTY stdin, so the prompt branch is not taken).

- [ ] **Step 3: Manual interactive sanity check**

Run from a TTY: `node dist/index.js skills pick --agent codex --target /tmp/authmux-pick-sanity/skills --no-save`
Expected: arrow-key select appears; pressing Enter activates the highlighted profile; Ctrl-C exits with code 130 and no activation.

- [ ] **Step 4: Commit**

```bash
git add src/commands/skills-pick.ts
git commit -m "feat(skills): interactive prompts.select for 'skills pick'"
```

---

### Task 5: Make pick discoverable via `authmux skills pick <profile>` shortcut

**Files:**
- Modify: `src/commands/skills.ts`

Goal: keep the existing `authmux skills …` surface coherent. `authmux skills pick` should be a recognized action in the dispatcher in `skills.ts`, delegating to the new command. (oclif already registers `skills pick` from filename, but `skills pick` typed as `skills` + first arg should not error.)

- [ ] **Step 1: Extend the action type**

Edit `src/commands/skills.ts`. Change:

```typescript
type SkillAction = "list" | "current" | "use" | "activate" | "activate-current";
```

to:

```typescript
type SkillAction = "list" | "current" | "use" | "activate" | "activate-current" | "pick";
```

- [ ] **Step 2: Forward `pick` to the new command**

In the `run()` method of `SkillsCommand`, after `if (action === "activate") { … }` and before the trailing default block, add:

```typescript
      if (action === "pick") {
        const SkillsPickCommand = (await import("./skills-pick")).default;
        await SkillsPickCommand.run(this.argv.slice(1));
        return;
      }
```

Update `normalizeAction()` switch to accept `"pick"`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: existing skills.ts tests (if any) still pass; nothing new broken.

- [ ] **Step 4: Commit**

```bash
git add src/commands/skills.ts
git commit -m "feat(skills): forward 'skills pick' from the umbrella dispatcher"
```

---

### Task 6: Track A self-check

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests pass, build clean.

- [ ] **Step 2: Verify CLI surface**

Run: `node dist/index.js skills pick --help`
Expected: help text shows `--agent`, `--target`, `--account`, `--save`/`--no-save`, `--default`, `--quiet`, `--json`, `--no-activate`.

- [ ] **Step 3: Hand off to integration phase**

Mark Track A complete.

---

## Track B — Shell hooks

Starts as soon as Task 3 is committed. The flag surface to call is:

```
authmux skills pick --agent <codex|claude> [--account <name>] [--target <dir>] --quiet --save
```

### Task 7: Update claude-parallel alias generator to a function + aliases

**Files:**
- Modify: `src/commands/parallel.ts`

- [ ] **Step 1: Replace `generateAliases()`**

In `src/commands/parallel.ts`, replace the entire `generateAliases()` method with:

```typescript
  private generateAliases(): string {
    const profiles = getProfiles();
    if (!profiles.length) return "";
    const lines = [
      "# Claude Code parallel accounts (managed by agent-auth)",
      "__authmux_claude_account() {",
      "  local name=\"$1\"",
      "  local dir=\"$HOME/.claude-accounts/$name\"",
      "  if command -v authmux >/dev/null 2>&1; then",
      "    command authmux skills pick \\",
      "      --agent claude \\",
      "      --account \"$name\" \\",
      "      --target \"$dir/skills\" \\",
      "      --quiet --save || true",
      "  fi",
      "  CLAUDE_CONFIG_DIR=\"$dir\" command claude",
      "}",
      ...profiles.map((p) => `alias claude-${p}='__authmux_claude_account ${shellQuote(p).slice(1, -1)}'`),
    ];
    return lines.join("\n");
  }
```

Note: keep `getProfiles`, `shellQuote`, `installAliases`, and `readSkillProfile` exactly as they are — only the body of `generateAliases()` changes. Account name validation lives upstream in `addProfile`.

- [ ] **Step 2: Run any existing parallel tests**

Run: `npm test`
Expected: all existing tests still pass.

- [ ] **Step 3: Manual smoke**

Run: `node dist/index.js parallel --aliases`
Expected: output contains `__authmux_claude_account()` function followed by `alias claude-account1='__authmux_claude_account account1'` (assuming `account1` exists).

- [ ] **Step 4: Commit**

```bash
git add src/commands/parallel.ts
git commit -m "feat(parallel): emit __authmux_claude_account function with interactive pick"
```

---

### Task 8: Update codex postinstall login hook

**Files:**
- Modify: `scripts/postinstall-login-hook.cjs`
- Test: `src/tests/login-hook.test.ts`

- [ ] **Step 1: Inspect the existing test**

Read `src/tests/login-hook.test.ts` and find the assertion(s) that check the rendered block. If there's an assertion about `skills activate-current`, update it; if not, add one.

- [ ] **Step 2: Add an assertion against the new line**

Append to `src/tests/login-hook.test.ts`:

```typescript
test("renderHookBlock invokes 'skills pick' instead of 'activate-current'", () => {
  const { renderHookBlock } = require("../../scripts/postinstall-login-hook.cjs");
  const block = renderHookBlock();
  assert.match(block, /authmux skills pick --agent codex --quiet --save/);
  assert.doesNotMatch(block, /skills activate-current/);
});
```

If `renderHookBlock` is not currently exported from the CJS file, also export it (add `module.exports = { renderHookBlock };` at the end of the script — guarded so the postinstall behavior remains: only export when required, not when run directly).

- [ ] **Step 3: Run the test and verify it fails**

Run: `npm test`
Expected: the new test fails because the hook still calls `skills activate-current`.

- [ ] **Step 4: Update the hook body**

Edit `scripts/postinstall-login-hook.cjs`, inside `renderHookBlock()`. Replace:

```js
    "    command authmux skills activate-current --agent codex >/dev/null 2>&1 || true",
```

with:

```js
    "    command authmux skills pick --agent codex --quiet --save || true",
```

Also ensure the CJS module exports `renderHookBlock` for the test:

```js
if (require.main !== module) {
  module.exports = { renderHookBlock };
}
```

(Place it at the end of the file, after `main()` is defined; do not export when the file is run directly so the postinstall side-effect path is preserved.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: new test passes; existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/postinstall-login-hook.cjs src/tests/login-hook.test.ts
git commit -m "feat(hook): codex wrapper uses interactive 'skills pick' on launch"
```

---

## Track C — Docs

Starts as soon as Task 1 is committed. Track C must not touch source files Track A/B own.

### Task 9: README — picker section + env knobs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find the existing skill-profile section**

Run: `grep -n "skill" README.md | head -20`
Locate the section that documents `authmux skills` (added in PR #35).

- [ ] **Step 2: Add a "Picker on launch" subsection**

Below the existing `authmux skills …` documentation, insert:

```markdown
### Picker on launch

When you start `codex`, `claude-account1`, `claude-account2`, … in an interactive
terminal, the authmux shell hook now shows an arrow-key chooser of Soul skill
profiles (`base`, `frontend`, `design`, `medusa`, `deploy`, `review`,
`orchestration`, `all`, …). The default is the profile you saved last time;
press Enter to keep it or pick a different one. The chosen profile is activated
against the agent's skills directory, saved to your account, and then the
underlying agent launches.

You can also run the picker directly:

```bash
authmux skills pick --agent codex             # interactive
authmux skills pick --agent claude --account account2
authmux skills pick --agent codex --no-save   # one-shot, do not persist
authmux skills pick --agent codex --default frontend --json  # non-interactive
```

#### Environment knobs

| Variable | Effect |
|----------|--------|
| `AUTHMUX_SKILL_PICK=off` | Skip the prompt entirely; use the saved/default profile silently. Restores PR #35 behavior. |
| `AUTHMUX_SKILL_PROFILE=<name>` | One-shot override. The picker uses this value without prompting. |
| `AUTHMUX_DEFAULT_SKILL_PROFILE=<name>` | Fallback when no account has saved a profile. |
| `AUTHMUX_CLAUDE_ACCOUNTS_DIR=<dir>` | Override `~/.claude-accounts` (used by the picker to find and persist per-account profiles). |
| `AUTHMUX_HERMES_HOME` / `HERMES_AGENT_HOME` | Already used by `--agent hermes`. |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document the launch-time skill-profile picker"
```

---

### Task 10: Mark the spec as implemented

**Files:**
- Modify: `docs/superpowers/specs/2026-05-19-skill-profile-picker-design.md`

- [ ] **Step 1: Wait for integration PR to merge**

This task runs **after** Task 12 has produced and merged the integration PR.

- [ ] **Step 2: Append an implementation footer**

Add to the bottom of the spec:

```markdown
---

**Implementation:** PR #<N> (merged <date>). See `docs/superpowers/plans/2026-05-19-skill-profile-picker.md`.
```

Replace `<N>` and `<date>` with the actual values from the merged PR.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-19-skill-profile-picker-design.md
git commit -m "docs(spec): mark skill-profile picker as implemented"
```

---

## Integration phase

### Task 11: Full verification

**Files:** none modified — verification only.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: TypeScript build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Manual interactive smoke test (codex)**

In a real terminal:

```bash
# Force the postinstall hook to be re-installed for testing.
node scripts/postinstall-login-hook.cjs
exec "$SHELL" -l
codex --help  # triggers the wrapper; expect the skill-profile prompt
```

Expected: an arrow-key select appears with profile names (`all`, `base`, `deploy`, `design`, `frontend`, `medusa`, `orchestration`, `review`). Pressing Enter on a profile activates it; `codex --help` then runs. Ctrl-C at the prompt cancels but `codex --help` still runs (via `|| true`).

- [ ] **Step 4: Manual interactive smoke test (claude-account2)**

```bash
node dist/index.js parallel --install
exec "$SHELL" -l
claude-account2
```

Expected: arrow-key select appears, then `claude` launches against `CLAUDE_CONFIG_DIR=~/.claude-accounts/account2`. Re-running `claude-account2` shows the previously-picked profile pre-selected.

- [ ] **Step 5: Verify non-TTY fallback**

```bash
echo | AUTHMUX_SKILL_PICK=off codex --help
```

Expected: no prompt; `codex --help` runs.

- [ ] **Step 6: Verify env override**

```bash
AUTHMUX_SKILL_PROFILE=design node dist/index.js skills pick --agent codex --target /tmp/spike/skills --no-save --json
```

Expected: JSON with `"profile":"design"`, no prompt even in a TTY.

---

### Task 12: Open PR

**Files:** none modified — coordination only.

- [ ] **Step 1: Push the branch and open PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(skills): launch-time skill-profile picker" --body "$(cat <<'EOF'
## Summary
- Add `authmux skills pick` with interactive arrow-key chooser via `prompts`.
- Replace silent `skills activate-current` in the `codex()` shell wrapper.
- Refactor `claude-account-*` aliases to a single `__authmux_claude_account` shell function that calls `skills pick`.

Spec: `docs/superpowers/specs/2026-05-19-skill-profile-picker-design.md`
Plan: `docs/superpowers/plans/2026-05-19-skill-profile-picker.md`

## Test plan
- [x] `npm test` (all unit tests)
- [ ] Manual: codex launch → prompt → activation
- [ ] Manual: claude-account2 launch → prompt → activation
- [ ] Manual: `AUTHMUX_SKILL_PICK=off` skips prompt
- [ ] Manual: `AUTHMUX_SKILL_PROFILE=frontend` overrides
- [ ] Manual: Ctrl-C cancels prompt but agent still launches

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Record PR number for Task 10**

Note the PR number returned by `gh pr create` — pass it to Task 10.

---

## Self-review checklist (run by author after writing this plan)

- **Spec coverage:**
  - `authmux skills pick` command → Tasks 3, 4, 5 ✅
  - Codex hook wiring → Task 8 ✅
  - Claude-account-* alias wiring → Task 7 ✅
  - Cascade default → Task 1 ✅
  - TTY detection + `AUTHMUX_SKILL_PICK` → Task 2 ✅
  - Per-claude-account profile file helpers → Task 2 ✅
  - Save path (claude vs codex) → Task 3 ✅
  - Tests (non-TTY, env bypass, save, off) → Task 3 ✅
  - README + env table → Task 9 ✅
  - Graceful failure when activator missing → covered by existing `activateSkillProfile` behavior; surfaced via `pick` summary in Task 3 ✅
- **Placeholders:** none.
- **Type consistency:** `SkillAgent`, `SkillProfileActivation`, `normalizeSkillProfileName`, `resolveDefaultSkillTarget` already exist in `profile.ts`; new exports (`resolveDefaultProfileForAgent`, `isInteractiveTty`, `claudeAccountDir`, `claudeAccountsRoot`, `readClaudeAccountSkillProfile`, `writeClaudeAccountSkillProfile`, `CLAUDE_ACCOUNT_PROFILE_FILE`) are used consistently across Tasks 1, 2, 3.

## Execution handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch one fresh subagent per task (or one per track A/B/C), review between, fast iteration. Matches the user's "parallel team" ask.
2. **Inline Execution** — drive the plan in this session via `superpowers:executing-plans`, checkpoint between tracks.

For this plan, **Subagent-Driven** is the right choice because Tracks A/B/C are independent after Task 3 lands.
