# Skill-Profile Picker on Agent Launch

**Status:** Draft
**Date:** 2026-05-19
**Author:** webubusiness@gmail.com (NagyVikt)
**Follows:** PR #35 (Specialize authmux launches by skill profile), PR #36 (hermes-agent third target)

## Problem

PR #35 + PR #36 wire authmux to silently activate a per-account Soul skill profile
before launching `codex`, `claude-account1`, `claude-account2`, etc. The profile
is either fixed by `AUTHMUX_DEFAULT_SKILL_PROFILE`, by the account's saved
`.authmux-skill-profile` file, or hard-coded `base`.

That is too rigid. Every terminal session has a different *task shape* —
frontend redesign, deploy, code review, orchestration. The user wants to pick
the skill profile **at launch time**, the same way they pick an account, instead
of editing files or remembering a CLI flag.

## Goal

When the user types `codex`, `claude-account1`, or `claude-account2` in a fresh
terminal, the existing shell hook prompts them with an interactive arrow-key
list of Soul skill profiles (frontend, design, medusa, review, orchestration,
deploy, base, all, …). They press Enter; the selected profile is activated
against the right target directory and saved as the new default for that
account; then the underlying agent launches normally.

Non-interactive shells (CI, pipes, `--quiet`) skip the prompt and silently
fall back to the saved/default profile — current behavior is preserved.

## Non-goals

- **No new profile content.** Authmux still consumes `~/Documents/soul/skills/profiles/*.json`. Adding profiles is a soul-repo concern.
- **No MCP bundling.** Same scope boundary PR #35 took: MCP server selection stays in soul-side installers (`install-codex-mcps.py`, `install-claude-mcps.py`). Out of scope here.
- **No global "session manager" UI.** This is one prompt at launch, not a TUI.
- **No new hermes wrapper.** `hermes` does not have a shell-launch hook today; it remains opt-in via `authmux skills activate --agent hermes`.

## Success criteria

1. Running `claude-account2` in an interactive terminal shows a select prompt seeded with the account's currently-saved profile, lets the user change it with arrow keys, and launches `claude` against `~/.claude-accounts/account2` with the chosen skills directory rebuilt.
2. Running `codex` in an interactive terminal does the same against `~/.codex/skills`.
3. Pressing Ctrl-C at the prompt aborts cleanly without launching the agent (so user can re-type).
4. The chosen profile persists in `<account-dir>/.authmux-skill-profile` so a second invocation defaults to the previous choice.
5. Setting `AUTHMUX_SKILL_PICK=off` (or piping non-TTY input) restores the silent PR #35 behavior.
6. Setting `AUTHMUX_SKILL_PROFILE=<name>` for one command bypasses the prompt and uses the override.
7. Existing tests still pass; new tests cover the non-TTY fallback and the env-bypass path.

## Architecture

### One new command: `authmux skills pick`

A thin command that wraps the existing `listAvailableSkillProfiles()` + `activateSkillProfile()` building blocks with an interactive `prompts` select. Lives in `src/commands/skills-pick.ts` (separate file rather than overloading `skills.ts` so its presence in the hook is grep-able and unit-testable).

Flags:

| Flag | Meaning |
|------|---------|
| `--agent <codex\|claude\|hermes>` | Agent target (same as `skills activate`). |
| `--target <dir>` | Explicit skills directory (skips `resolveDefaultSkillTarget`). |
| `--account <name>` | Save the chosen profile to this account; defaults to current authmux account. |
| `--save` / `--no-save` | Persist the choice (default: `--save`). For `--agent claude` with `--account`, writes `~/.claude-accounts/<account>/.authmux-skill-profile`. For `--agent codex` (no `--account` flag), resolves to `accounts.getCurrentAccountName()` and writes via `accounts.setSkillProfileForAccount(name, profile)` — same path the existing `skills use` command takes. If no current account is set, `--save` becomes a no-op with a warning. |
| `--default <name>` | Profile to pre-select / fall back to. Default cascade: `AUTHMUX_SKILL_PROFILE` → account saved → `AUTHMUX_DEFAULT_SKILL_PROFILE` → `base`. |
| `--no-activate` | Save-only; skip running the activator. |
| `--quiet` | Suppress the activation summary line; errors still print. |
| `--json` | Standard JSON envelope (Theme X4). |

Behavior:

1. Resolve the default profile via the cascade.
2. Resolve the target directory: explicit `--target` wins; else `resolveDefaultSkillTarget(agent)`; else for claude with `--account`, `~/.claude-accounts/<account>/skills`.
3. Decide interaction mode:
    - `AUTHMUX_SKILL_PICK=off` → skip prompt, use default.
    - `--json` → skip prompt (corrupts stdout), use default.
    - `!process.stdin.isTTY || !process.stdout.isTTY` → skip prompt, use default.
    - `AUTHMUX_SKILL_PROFILE` set → skip prompt, use that value.
    - Otherwise → show prompt.
4. If prompting, show a `prompts.select` with profile names from `listAvailableSkillProfiles()`, `initial` = index of default. On Ctrl-C, exit code 130, no activation, no save.
5. Activate via `activateSkillProfile({ profile, agent, target })`.
6. If `--save` and `--account`/current account is known, write `<account-dir>/.authmux-skill-profile`.
7. Print one summary line: `Skill profile: <name> → <target> (<n> skills)`.

### Hook rewrites

#### Codex wrapper (`scripts/postinstall-login-hook.cjs`)

Inside the generated `codex()` shell function, replace the silent

```
command authmux skills activate-current --agent codex >/dev/null 2>&1 || true
```

with an interactive call that keeps stdin/stdout attached:

```
command authmux skills pick --agent codex --quiet --save || true
```

Trailing `|| true` preserves the launch-anyway contract. We do **not** swallow stderr — pick errors should be visible (missing activator, soul not installed). `--quiet` suppresses the success line so the prompt feels lightweight.

#### Claude parallel aliases (`src/commands/parallel.ts` → `generateAliases()`)

Today's alias is one line that activates silently, then launches claude. Move the activation off the alias and into a small shell function `__authmux_claude_account()` emitted once at the top of the managed block, then make each alias call that function with the account name. The function:

```
__authmux_claude_account() {
  local name="$1"
  local dir="$HOME/.claude-accounts/$name"
  command authmux skills pick \
    --agent claude \
    --account "$name" \
    --target "$dir/skills" \
    --quiet \
    --save || true
  CLAUDE_CONFIG_DIR="$dir" command claude
}
alias claude-account1='__authmux_claude_account account1'
alias claude-account2='__authmux_claude_account account2'
```

Crucially, no `>/dev/null` redirection on the `pick` call — the prompt needs the terminal. The function preserves the existing exit-code semantics (the alias still exits with claude's exit code).

#### Env knobs

Documented in README and accepted by `pick`:

| Variable | Effect |
|----------|--------|
| `AUTHMUX_SKILL_PICK=off` | Always silent fallback (restores PR #35 behavior). |
| `AUTHMUX_SKILL_PROFILE=<name>` | One-shot override, no prompt. |
| `AUTHMUX_DEFAULT_SKILL_PROFILE=<name>` | Fallback when no account-saved profile (already existed). |

### Files touched

```
src/commands/skills-pick.ts        (new)
src/lib/skills/profile.ts          (small additions: profile-cascade helper, isInteractive())
src/tests/skills-pick.test.ts      (new)
src/tests/skills-profile.test.ts   (extend: cascade helper)
src/commands/parallel.ts           (generateAliases — emit function + aliases)
scripts/postinstall-login-hook.cjs (codex() body — swap activate-current → pick)
README.md                          (one section + env table additions)
```

### Data flow

```
user types `claude-account2`
        │
        ▼
__authmux_claude_account account2
        │
        ▼
authmux skills pick --agent claude --account account2 --target ~/.claude-accounts/account2/skills
        │
        ├─ TTY? AUTHMUX_SKILL_PICK=off? AUTHMUX_SKILL_PROFILE set? --json?
        │       │
        │       └─ silent path → use saved/default profile
        │
        ▼
prompts.select { profiles, initial = saved-or-default }
        │
        ▼
activateSkillProfile(profile, agent=claude, target)
        │
        ▼
write <account-dir>/.authmux-skill-profile (--save default)
        │
        ▼
CLAUDE_CONFIG_DIR=… command claude
```

### Error handling

| Situation | Behavior |
|-----------|----------|
| Activator script missing | `pick` warns, returns activated=false, agent still launches (preserve PR #35 contract). |
| Activator script fails | `pick` prints stderr; `|| true` in alias means agent still launches. |
| User Ctrl-C at prompt | `pick` exits 130, no save, no activate; `|| true` in alias means agent still launches with *previously* activated skills (no rebuild — safe). |
| No profiles found (soul missing) | `pick` prints "no skill profiles available — set AUTHMUX_SOUL_HOME", returns activated=false, agent still launches. |
| Profile name invalid | `normalizeSkillProfileName` throws; pick prints error; agent still launches. |

## Testing

Unit tests (`src/tests/skills-pick.test.ts`):

1. **Non-TTY fallback:** with `process.stdin.isTTY = false`, `pick --agent codex` activates the default profile without prompting; verify `activateSkillProfile` call signature.
2. **Env bypass:** with `AUTHMUX_SKILL_PROFILE=frontend`, pick uses `frontend` regardless of saved profile.
3. **Save default:** non-TTY run with `--save --account testacc` writes `<dir>/.authmux-skill-profile`.
4. **No-save:** `--no-save` skips the write.
5. **Cascade order:** new `resolveDefaultProfileFor(agent, accountName)` helper returns env > account-saved > AUTHMUX_DEFAULT_SKILL_PROFILE > "base".
6. **Activator missing:** stub a missing activator path, assert `activated=false` with a warn line, exit code 0.

Integration smoke (manual, documented in spec; no harness yet):

- Start a fresh terminal, type `claude-account2`, pick `design`, confirm `~/.claude-accounts/account2/skills` contains the design profile's symlinks.
- Type `claude-account2` again, confirm `design` is pre-selected.

## Parallel implementation tracks

The change naturally splits into three tracks that share no files. They should be implemented by parallel sub-agents:

| Track | Owns | Touches |
|-------|------|---------|
| **A — TS core** | New command + helper + types | `src/commands/skills-pick.ts`, `src/lib/skills/profile.ts`, `src/index.ts` (oclif registration if needed) |
| **B — Shell hooks** | Wire pick into codex + claude wrappers | `scripts/postinstall-login-hook.cjs`, `src/commands/parallel.ts` (only `generateAliases()` / `installAliases()` blocks) |
| **C — Tests + docs** | Coverage + user-facing docs | `src/tests/skills-pick.test.ts`, `src/tests/skills-profile.test.ts`, `README.md`, this spec |

Tracks A and B both depend on the spec being final; B depends on A's flag surface being agreed (the spec freezes it). Track C depends on A for tests but can write the README skeleton in parallel.

Sequencing for the parallel run:

1. Spec merges first (this doc).
2. Tracks A + C-docs start in parallel.
3. Track B starts once A's flag names are committed (~1 commit in).
4. Track C-tests start once A's helper signatures land.
5. All three rebase onto a single integration branch, then one PR.

## Open questions (resolved by author for V1)

- **Q: Auto-timeout the prompt?** No. If the user wants no prompt, they set `AUTHMUX_SKILL_PICK=off`. Auto-timeout adds non-determinism for one shaved keystroke.
- **Q: Show a per-profile description in the prompt?** Not in V1. Profile JSON has no description field. If users want this, add it to soul-side JSON first, then wire it through.
- **Q: Cache the profile list?** No. `listAvailableSkillProfiles()` is a single `readdirSync` on ~10 entries — sub-millisecond.
- **Q: Should `authmux use <account>` also prompt?** Not in V1. `use` is non-interactive by default and is often scripted. The prompt belongs in the launch wrapper, not the account switcher.

## Migration / backwards compat

- Users on PR #35 get the new behavior automatically the next time they reinstall (`npm install` triggers `postinstall-login-hook.cjs`) **and** the next time they run `authmux parallel --install`. Until they do, the old aliases keep silent-activating; nothing breaks.
- The new `pick` command is additive. `skills activate-current` is unchanged; the only callsite that switched is the shell hook block.
- `AUTHMUX_SKILL_PICK=off` is the escape hatch for users who liked the silent flow.
