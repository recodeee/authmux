# 05 — Config and Paths Improvement Protocol

This document covers `src/lib/config/paths.ts`, `src/lib/config/login-hook.ts`,
and the broader configuration story for `authmux`: environment variable
contracts (as documented in `README.md:79-81`), XDG compliance, OS-specific
artifact layout, and migration. Like its sibling document `04-ACCOUNTS-MODULE.md`,
every major proposal is laid out as **Evidence / Diagnosis / Proposal /
Migration / Rollout** with priority and size tags.

Priorities and sizes follow the same scheme:

- **P0–P3** by urgency.
- **S/M/L/XL** by implementation cost.

---

## Current paths model

### What `paths.ts` derives

**Evidence.** `src/lib/config/paths.ts:1-67`:

- `resolveCodexDir()` — `$CODEX_AUTH_CODEX_DIR` or `~/.codex` (line 9).
- `resolveAccountsDir()` — `$CODEX_AUTH_ACCOUNTS_DIR` or
  `<codexDir>/accounts` (line 18).
- `resolveAuthPath()` — `$CODEX_AUTH_JSON_PATH` or `<codexDir>/auth.json`
  (line 27).
- `resolveCurrentNamePath()` — `$CODEX_AUTH_CURRENT_PATH` or
  `<codexDir>/current` (line 36).
- `resolveRegistryPath()` — `<accountsDir>/registry.json` (line 45). No
  env override.
- `resolveSessionMapPath()` — `$CODEX_AUTH_SESSION_MAP_PATH` or
  `<accountsDir>/sessions.json` (line 49).
- `resolveSnapshotBackupDir()` — `<accountsDir>/.snapshot-backups` (line
  58). No env override.

Lines 62–67 evaluate every resolver *once at import time* and export the
result as module-level constants.

### OS differences

- **Linux**: `~/.codex` is at `$HOME/.codex`. No XDG dirs are consulted.
- **macOS**: same as Linux — `~/.codex`.
- **Windows**: `~/.codex` expands to `%USERPROFILE%/.codex`. There is
  no awareness of `%APPDATA%` or `%LOCALAPPDATA%`.

### Env-var overrides

The README documents three env vars at lines 79–81:

```
CODEX_AUTH_SKIP_POSTINSTALL
CODEX_AUTH_SKIP_TTY_RESTORE
CODEX_AUTH_SESSION_KEY
```

The path resolvers expose four *more* overrides that are not in the README:

- `CODEX_AUTH_CODEX_DIR`
- `CODEX_AUTH_ACCOUNTS_DIR`
- `CODEX_AUTH_JSON_PATH`
- `CODEX_AUTH_CURRENT_PATH`
- `CODEX_AUTH_SESSION_MAP_PATH`

There are also undocumented runtime env vars used by sibling modules:

- `CODEX_AUTH_FORCE_EXTERNAL_SYNC` — `src/lib/accounts/account-service.ts:54`.
- `CODEX_AUTH_SESSION_ACTIVE_OVERRIDE` — `account-service.ts:56`.
- `CODEX_LB_URL` — `src/lib/accounts/usage.ts:428`.
- `CODEX_LB_DASHBOARD_PASSWORD` — `usage.ts:15`.
- `CODEX_LB_DASHBOARD_TOTP_CODE` — `usage.ts:16`.
- `CODEX_LB_DASHBOARD_TOTP_COMMAND` — `usage.ts:17`.

So `authmux` has at least *twelve* environment variables that affect its
behavior, only three of which are documented at any single location.

---

## Issues

### 1. Hardcoded `~/.codex/...`

**Evidence.** `paths.ts:15`:

```ts
return path.join(os.homedir(), ".codex");
```

**Diagnosis.** `~/.codex` is the directory Codex itself writes to.
authmux's *own* artifacts (registry, session map, snapshot backups,
current pointer) live inside it by default. This conflates two distinct
ownerships:

- `~/.codex/auth.json` — Codex CLI writes this, authmux only mirrors.
- `~/.codex/accounts/`, `~/.codex/current`, `~/.codex/accounts/registry.json` —
  authmux owns these.

A user who runs `rm -rf ~/.codex` to "reset Codex" wipes all of
authmux's state. A user who runs `authmux remove-all` and then `rm -rf
~/.codex/accounts` does not actually wipe registry metadata they may
care about, because the registry lives *inside* the accounts dir.

### 2. Mixed providers writing to provider-owned dirs

**Evidence.**

- `src/lib/kiro-mirror.ts:5` writes to `~/.local/share/kiro-cli`.
- The Claude parallel feature (README line 248) writes to
  `~/.claude-accounts/<name>`.
- authmux itself writes to `~/.codex/accounts/`.

**Diagnosis.** Each provider's data is under that provider's directory,
which means authmux state is scattered across at least four roots:

- `~/.codex/...`
- `~/.local/share/kiro-cli/...`
- `~/.claude-accounts/...`
- `~/.local/share/kiro-account-switcher/...`

There is no single "authmux data" location a user can back up, version,
or move between machines.

### 3. No XDG respect

**Evidence.** `paths.ts` never reads `$XDG_CONFIG_HOME`,
`$XDG_DATA_HOME`, `$XDG_CACHE_HOME`, or `$XDG_STATE_HOME`. The only file
in the repo that respects an XDG var is
`src/commands/kiro-login.ts:10`:

```ts
const SWITCHER_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"),
  "kiro-account-switcher",
);
```

**Diagnosis.** On Linux, the XDG Base Directory Specification is the
norm for CLI tools. Ignoring it puts authmux on an island: users with
custom `XDG_*` setups (especially in containers or on NixOS) get
unexpected paths. The lone XDG-aware site for Kiro is also incomplete:
it respects `XDG_DATA_HOME` but not `XDG_CONFIG_HOME` or
`XDG_STATE_HOME`.

### 4. Ambiguous cache / state / config / data separation

**Evidence.** authmux artifacts blur four categories:

- **Config** (user intent): `autoSwitch.enabled`, threshold percentages,
  `api.usage` toggle — stored inside `registry.json`.
- **Data** (state we own and want to keep): snapshot files, registry's
  per-account metadata.
- **State** (state we own but can rebuild): the `current` pointer,
  session map, current activated pointer.
- **Cache** (rebuildable from the source of truth): `lastUsage`
  snapshots, snapshot backup vault, update-check cache.

All four live mixed in `~/.codex/accounts/`. There is no easy way to
"back up just my config", "wipe just my cache", or "rotate just my
state".

### 5. Path constants evaluated at import time

**Evidence.** `paths.ts:62-67`:

```ts
export const codexDir: string = resolveCodexDir();
export const accountsDir: string = resolveAccountsDir();
export const authPath: string = resolveAuthPath();
export const currentNamePath: string = resolveCurrentNamePath();
export const registryPath: string = resolveRegistryPath();
export const sessionMapPath: string = resolveSessionMapPath();
```

**Diagnosis.** These constants snapshot the env at module load time.
Test code that sets `CODEX_AUTH_CODEX_DIR` *after* importing
`paths.ts` (or any module that transitively imports it) silently uses
the wrong paths. The whole codebase is forced to use the *function*
forms (`resolveCodexDir()`) to avoid this trap, which means the
constants are dead surface area with high foot-gun potential.

A grep across `src/` shows that no production code uses the constants;
they exist only to satisfy a hypothetical caller. Keeping them is
strictly net-negative.

### 6. No undocumented-env-var detection

**Evidence.** Twelve env vars in use, only three documented in the
README.

**Diagnosis.** New env vars accumulate organically (every PR adds one)
and there is no list. Users cannot tell what they can configure; support
cannot tell what env users may have set that is causing issues.

### 7. Hidden snapshot backup directory

**Evidence.** `paths.ts:58-60`:

```ts
export function resolveSnapshotBackupDir(): string {
  return path.join(resolveAccountsDir(), ".snapshot-backups");
}
```

**Diagnosis.** A dot-prefixed dir inside the accounts dir is invisible
to most users and to `ls`. It can grow without bound (each `codex` run
copies every snapshot into it before
`clearSnapshotBackupVault`). If a crash or unhandled exception leaves
the vault populated, the user has no idea it exists.

### 8. Login hook implementation issues

**Evidence.** `src/lib/config/login-hook.ts`:

- Lines 30–37 detect only zsh and bash. Fish, nushell, PowerShell, and
  Windows cmd are not handled.
- Lines 39–66 emit a bash/zsh shell function and inject it into the rc
  file. There is no equivalent for non-POSIX shells.
- Line 25–28 (`normalizeRcContents`) collapses three+ consecutive
  newlines to two and ensures a trailing newline. Idempotent in
  practice, but it silently rewrites the user's whitespace style.
- Line 48 emits a long literal escape sequence to "reset terminal
  modes". The intent (clean up after Codex leaks escape codes) is
  reasonable, but the magic string is opaque.
- Line 57 sets `CODEX_AUTH_FORCE_EXTERNAL_SYNC=1` for the duration of a
  single `authmux status` call, which is the only documented mechanism
  for triggering an external sync. This is a side-channel; a real
  command (`authmux sync --force`) would be clearer.

### 9. `paths.ts` is the wrong layer for env-var contracts

**Evidence.** Env-var names (`CODEX_AUTH_CODEX_DIR`, etc.) are
hardcoded as string literals across `paths.ts`. The same pattern is
duplicated in `account-service.ts:54-56` and `usage.ts:15-17`.

**Diagnosis.** There is no central registry of env vars and no typed
reader. Adding a new env var requires touching the implementation file
*and* (in theory) the README. There is no compile-time guarantee that
the README mentions the variable, and no test that catches an
unintended deprecation.

---

## Proposal: XDG-compliant layout

The single biggest unlock: separate authmux's *own* state from the
provider directories it mirrors, and use XDG categories so each artifact
goes in the correct subtree.

### Category mapping

| Artifact | Category | Linux/XDG | macOS | Windows |
|---|---|---|---|---|
| Snapshots (`<name>.json`) | data | `$XDG_DATA_HOME/authmux/snapshots/` | `~/Library/Application Support/authmux/snapshots/` | `%APPDATA%\authmux\snapshots\` |
| Registry (`registry.json`) | data | `$XDG_DATA_HOME/authmux/registry.json` | `~/Library/Application Support/authmux/registry.json` | `%APPDATA%\authmux\registry.json` |
| Session map / pins (`sessions.json`) | state | `$XDG_STATE_HOME/authmux/sessions.json` | `~/Library/Application Support/authmux/state/sessions.json` | `%LOCALAPPDATA%\authmux\state\sessions.json` |
| Current pointer (`current`) | state | `$XDG_STATE_HOME/authmux/current` | `~/Library/Application Support/authmux/state/current` | `%LOCALAPPDATA%\authmux\state\current` |
| User config (`config.toml`) | config | `$XDG_CONFIG_HOME/authmux/config.toml` | `~/Library/Application Support/authmux/config.toml` | `%APPDATA%\authmux\config.toml` |
| Logs (daemon) | state | `$XDG_STATE_HOME/authmux/logs/` | `~/Library/Logs/authmux/` | `%LOCALAPPDATA%\authmux\logs\` |
| Cache (usage snapshots, update check) | cache | `$XDG_CACHE_HOME/authmux/` | `~/Library/Caches/authmux/` | `%LOCALAPPDATA%\authmux\cache\` |
| Snapshot backup vault | cache | `$XDG_CACHE_HOME/authmux/snapshot-backups/` | `~/Library/Caches/authmux/snapshot-backups/` | `%LOCALAPPDATA%\authmux\cache\snapshot-backups\` |
| Daemon lock file | runtime | `$XDG_RUNTIME_DIR/authmux/daemon.lock` (fallback: state dir) | `~/Library/Application Support/authmux/locks/daemon.lock` | `%LOCALAPPDATA%\authmux\locks\daemon.lock` |
| Codex live auth (mirror) | external | `~/.codex/auth.json` (unchanged — owned by Codex) | same | same |
| Claude live credentials (mirror) | external | `~/.claude/.credentials.json` (unchanged) | same | same |
| Kiro live db (mirror) | external | `~/.local/share/kiro-cli/data.sqlite3` (unchanged) | same | same |

The pattern is: authmux's data, state, cache, and config live under
`authmux/`. The *live* auth artifacts that providers themselves write
to are left alone — authmux only reads them and mirrors them into its
own snapshot store.

### Reference path resolver

```ts
// new file: src/lib/config/xdg.ts
import os from "node:os";
import path from "node:path";

export type XdgKind = "config" | "data" | "state" | "cache" | "runtime";

function platform(): "linux" | "darwin" | "win32" | "other" {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "other";
}

function macRoot(kind: XdgKind): string {
  const home = os.homedir();
  switch (kind) {
    case "cache":   return path.join(home, "Library", "Caches");
    case "config":
    case "data":
    case "state":
    case "runtime": return path.join(home, "Library", "Application Support");
  }
}

function winRoot(kind: XdgKind): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const roam  = process.env.APPDATA      ?? path.join(os.homedir(), "AppData", "Roaming");
  switch (kind) {
    case "config": return roam;
    case "data":   return roam;
    case "state":  return local;
    case "cache":  return local;
    case "runtime": return local;
  }
}

function linuxRoot(kind: XdgKind): string {
  const home = os.homedir();
  switch (kind) {
    case "config":  return process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    case "data":    return process.env.XDG_DATA_HOME   ?? path.join(home, ".local", "share");
    case "state":   return process.env.XDG_STATE_HOME  ?? path.join(home, ".local", "state");
    case "cache":   return process.env.XDG_CACHE_HOME  ?? path.join(home, ".cache");
    case "runtime": return process.env.XDG_RUNTIME_DIR ?? linuxRoot("state");
  }
}

export function xdgPath(kind: XdgKind, ...parts: string[]): string {
  const root = (() => {
    switch (platform()) {
      case "linux":   return linuxRoot(kind);
      case "darwin":  return macRoot(kind);
      case "win32":   return winRoot(kind);
      default:        return path.join(os.homedir(), ".authmux");
    }
  })();
  return path.join(root, "authmux", ...parts);
}
```

Then rewrite `paths.ts` to use it:

```ts
export function resolveSnapshotsDir(): string {
  return process.env.AUTHMUX_DATA_DIR
    ? path.join(process.env.AUTHMUX_DATA_DIR, "snapshots")
    : xdgPath("data", "snapshots");
}

export function resolveRegistryPath(): string {
  return process.env.AUTHMUX_REGISTRY_PATH
    ?? path.join(xdgPath("data"), "registry.json");
}

// etc.
```

### Migration

This is a breaking change to on-disk layout. Three deliverables:

1. **Detection.** On startup, if the legacy `~/.codex/accounts/` exists
   and the new XDG locations do not, run a one-time migration:
   - Copy snapshots → `$XDG_DATA_HOME/authmux/snapshots/`.
   - Copy `registry.json` → `$XDG_DATA_HOME/authmux/registry.json`.
   - Copy `sessions.json` → `$XDG_STATE_HOME/authmux/sessions.json`.
   - Copy `current` → `$XDG_STATE_HOME/authmux/current`.
   - Write a `MIGRATION-INFO.md` file in the legacy dir explaining what
     happened.
   - Leave the legacy dir intact (do not delete) for one release.
2. **Compatibility fallback.** If neither the new nor the legacy
   location exists, prefer new (clean install). If legacy exists *and*
   new exists, prefer new and warn that legacy is stale.
3. **Documentation.** Add a section to the README under "Paths and
   environment" listing the new layout and the migration behavior.

### Rollout

- XDG resolver + new paths: **P1 / M**.
- One-time migrator: **P1 / M**.
- README + migration warning: **P1 / S**.

---

## Config schema

### Today: registry-embedded config

**Evidence.** `src/lib/accounts/types.ts:31-47`:

```ts
export interface AutoSwitchConfig {
  enabled: boolean;
  threshold5hPercent: number;
  thresholdWeeklyPercent: number;
}

export interface ApiConfig {
  usage: boolean;
}

export interface RegistryData {
  version: 1;
  autoSwitch: AutoSwitchConfig;
  api: ApiConfig;
  activeAccountName?: string;
  accounts: Record<string, AccountRegistryEntry>;
}
```

**Diagnosis.** User-intent settings (`autoSwitch.enabled`, thresholds,
`api.usage`) live mingled with state (`activeAccountName`) and data
(`accounts`). Two consequences:

- Editing the registry by hand to change a config knob is dangerous
  because you can accidentally corrupt the accounts dict.
- Versioning is monolithic: a config schema change forces a registry
  schema bump, and vice versa.

### Proposed: standalone typed Config

```ts
// src/lib/config/schema.ts
export interface Config {
  schemaVersion: 1;
  autoSwitch: {
    enabled: boolean;
    threshold5hPercent: number;
    thresholdWeeklyPercent: number;
    cooldownSeconds: number;        // NEW: minimum gap between switches
  };
  usage: {
    source: "api" | "proxy" | "local" | "auto";
    proxyUrl?: string;              // captures CODEX_LB_URL
    refreshConcurrency: number;
  };
  paths: {
    dataDir?: string;
    stateDir?: string;
    cacheDir?: string;
    configDir?: string;             // self-referential override
  };
  daemon: {
    intervalSeconds: number;
    logLevel: "error" | "warn" | "info" | "debug";
  };
  shell: {
    forceExternalSync: boolean;
    skipTtyRestore: boolean;
    sessionKey?: string;
  };
  postinstall: {
    skipPrompt: boolean;
  };
}
```

### File formats

Support both JSON and TOML. TOML is friendlier for hand-editing and
matches the convention of `~/.codex/config.toml`. JSON stays as a
fallback for programmatic generation.

Search order:

1. `$AUTHMUX_CONFIG_PATH` (explicit override).
2. `$XDG_CONFIG_HOME/authmux/config.toml`.
3. `$XDG_CONFIG_HOME/authmux/config.json`.
4. `~/.config/authmux/config.toml` (Linux fallback).
5. `~/Library/Application Support/authmux/config.toml` (macOS).
6. `%APPDATA%\authmux\config.toml` (Windows).
7. Defaults baked into the binary.

### Env-var precedence order

For each config knob, precedence (highest to lowest):

1. Explicit CLI flag (e.g., `--threshold-5h 20`).
2. Process env var (e.g., `AUTHMUX_AUTOSWITCH_THRESHOLD_5H=20`).
3. Config file value.
4. Built-in default.

Provide a single `loadConfig({ env, argv })` function that does the
merge and returns a frozen `Config`. Every other module receives
`Config` by injection; no module reads `process.env` directly for
known config knobs.

### `authmux config` subcommands

- `authmux config show [--source]` — render the active config; with
  `--source`, annotate each field with its origin (default / file / env /
  flag).
- `authmux config dump > config.toml` — write the resolved config to
  stdout in TOML.
- `authmux config validate [path]` — load a config file (default: the
  resolved one) and validate it against the schema; exit non-zero on
  failure.
- `authmux config edit` — open the config file in `$EDITOR`. Create
  it from defaults if missing.
- `authmux config path` — print the resolved config file path.
- `authmux config env` — print the full list of recognized env vars
  with their current values and effective sources.

### Migration

Move the three config knobs out of `registry.json` and into
`config.toml` on first run. Keep reading the legacy registry fields for
one release and warning if they differ from the config file.

### Rollout

- Standalone config schema and loader: **P1 / M**.
- TOML + JSON parsing: **P1 / S**.
- `authmux config` subcommands: **P1 / M**.
- One-time migrator from registry-embedded config: **P2 / S**.

---

## Login hook config (`login-hook.ts`)

### Current state

**Evidence.** `src/lib/config/login-hook.ts:1-138`:

- Generates a bash/zsh-compatible shell function (line 50–63) that
  wraps `codex` and calls `authmux restore-session` before and
  `authmux status` (with `CODEX_AUTH_FORCE_EXTERNAL_SYNC=1`) after.
- Injects the block between mark comments (`# >>>
  authmux-login-auto-snapshot >>>` / `# <<< ... <<<`) into the user's
  rc file.
- Default rc file is `~/.zshrc` if `$SHELL` contains "zsh", otherwise
  `~/.bashrc` (line 30–37).
- `installLoginHook` (line 68–94) is idempotent: if the marks already
  exist, it replaces the content between them; otherwise it appends.
- `removeLoginHook` (line 96–116) strips the block.

### Issues

1. **Shell coverage.**
   - Fish (`config.fish`) is unsupported.
   - Nushell (`config.nu`) is unsupported.
   - PowerShell (`$PROFILE`) is unsupported.
   - Windows cmd has no rc-file equivalent.
   The hook only works on bash/zsh.

2. **Shell-function shadowing risks.** A user-defined `codex()` in a
   sourced file *after* our block silently overrides our wrapper. We
   then mysteriously stop syncing. There is no way to detect this from
   inside authmux.

3. **Side-channel env var.** `CODEX_AUTH_FORCE_EXTERNAL_SYNC=1` is set
   only by this hook (line 57). It would be cleaner for the hook to
   call `authmux sync --force` and let that command implement the same
   behavior.

4. **TTY restore escape sequence.** Line 48 is a wall of escape codes
   with no comment explaining each. If a user reports a regression
   ("my prompt looks weird after Codex"), this is the place to debug
   but there is no documentation.

5. **rc-file mutation is invasive.** Even with mark comments, editing
   the user's shell rc is a common source of bug reports (mark drift,
   syntax errors after concurrent edits by other installers, dotfile
   managers that fight with us).

6. **Idempotency edge case.** `normalizeRcContents` (line 25) collapses
   `\n{3,}` to `\n\n`. If the user *intentionally* has a triple newline
   somewhere in their rc, this rewrites it. Unlikely to matter but it
   is a silent transformation.

7. **No status reporting on install.** `installLoginHook` returns
   `"installed" | "updated" | "already-installed"` (line 8) but doesn't
   say *which lines changed* or print a diff. A `--dry-run` mode would
   help.

### Proposal: shim script instead of shell function

Replace the shell-function wrapper with a `codex` shim that authmux
installs into `~/.local/bin/codex` (or `%LOCALAPPDATA%\authmux\bin\codex.cmd`
on Windows). The shim is shell-agnostic.

**Shim contents (POSIX shell):**

```sh
#!/usr/bin/env sh
# authmux codex shim — keeps multi-account snapshots in sync.
# Generated by `authmux hook install`.
set -e

AUTHMUX_BIN="${AUTHMUX_BIN:-authmux}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex.real 2>/dev/null || echo /usr/local/bin/codex)}"

if command -v "$AUTHMUX_BIN" >/dev/null 2>&1; then
  "$AUTHMUX_BIN" restore-session >/dev/null 2>&1 || true
fi

set +e
"$CODEX_BIN" "$@"
status=$?
set -e

if command -v "$AUTHMUX_BIN" >/dev/null 2>&1; then
  "$AUTHMUX_BIN" sync --force >/dev/null 2>&1 || true
fi

exit $status
```

**Why this is better.**

- Works under any shell because we are an executable, not a function.
- Cannot be shadowed by user code; PATH precedence is explicit.
- Easy to inspect: `cat ~/.local/bin/codex`.
- TTY restore moves into `authmux sync --force` so the magic escape
  sequence is in one Node module with comments, not in a heredoc'd
  shell snippet.

**Install matrix.**

| OS | Install location | PATH requirement |
|---|---|---|
| Linux | `$XDG_BIN_HOME/codex` or `~/.local/bin/codex` | `$XDG_BIN_HOME` or `~/.local/bin` must precede the real codex on PATH |
| macOS | `~/bin/codex` | `~/bin` must precede `/usr/local/bin` on PATH |
| Windows | `%LOCALAPPDATA%\authmux\bin\codex.cmd` | `%LOCALAPPDATA%\authmux\bin` must precede the real codex on PATH |

**Discovering the real `codex`.** The shim caches the absolute path of
the real `codex` at install time (in a sibling file like
`~/.local/bin/.codex.target`). If the cached target disappears, the
shim re-resolves by scanning PATH minus its own directory.

### Migration

1. Keep `login-hook.ts`'s rc-file mutator for one release as the
   fallback.
2. Add `authmux hook install --mode=shim|shell` with `shim` as the
   default on new installs.
3. On upgrade, if the rc-file hook is present, detect it and offer to
   replace it with the shim.
4. After the deprecation period, remove the rc-file path entirely.

### Compatibility: when shim cannot be used

Some environments cannot rely on PATH precedence (locked-down corporate
laptops, devcontainers with read-only `~/.local/bin`). For those,
fall back to the shell-function hook but support more shells:

- **fish**: write `~/.config/fish/functions/codex.fish` with a
  function block. fish auto-loads the file.
- **nushell**: write a snippet to
  `~/.config/nushell/config.nu` between mark comments, and ship a
  `codex` def that wraps the real binary.
- **PowerShell**: write a function to `$PROFILE` between mark
  comments.

Each shell needs its own renderer; share the install/remove plumbing
via a `ShellHookAdapter` interface:

```ts
export interface ShellHookAdapter {
  readonly id: "bash" | "zsh" | "fish" | "nushell" | "pwsh";
  defaultRcPath(): string;
  renderBlock(): string;
  isPresent(contents: string): boolean;
  stripBlock(contents: string): string;
}
```

### Rollout

- Shim mode: **P1 / M**.
- Fish + nushell + PowerShell adapters: **P2 / M**.
- Hook install/remove command UX (`--dry-run`, diff output): **P2 / S**.
- Deprecate rc-file hook after one release: **P2 / S**.

---

## Migration plan

A versioned config file with a one-time mover when an old layout is
detected.

### Versioned config file

The new `config.toml` includes:

```toml
schema_version = 1

[autoSwitch]
enabled = false
threshold5hPercent = 10
thresholdWeeklyPercent = 5
cooldownSeconds = 120

# ... and so on
```

A `schema_version` mismatch is handled identically to the registry
schema migrations described in `04-ACCOUNTS-MODULE.md`: a list of
ordered `migrate(from, to)` functions, each pure, with golden
fixtures committed.

### Old-layout detector

On every startup, after env reading and before any IO:

```ts
async function detectAndMigrateLegacyLayout(env: Env): Promise<MigrationOutcome> {
  const legacyAccountsDir = path.join(env.home, ".codex", "accounts");
  const newDataDir = xdgPath("data", "snapshots");

  const [legacyExists, newExists] = await Promise.all([
    pathExists(legacyAccountsDir),
    pathExists(newDataDir),
  ]);

  if (!legacyExists) return { kind: "noop" };
  if (newExists)    return { kind: "already-migrated" };

  return runOneTimeMigration(legacyAccountsDir, newDataDir);
}
```

The migration:

1. Creates the new dirs.
2. Copies (does not move) snapshots, registry, session map, current
   pointer.
3. Splits the registry-embedded config out into `config.toml`.
4. Writes a sentinel `migrated-at` file in the new data dir so we
   don't try again.
5. Leaves the legacy dir intact and writes a `README.md` inside it
   explaining the new locations and how to delete the legacy dir.

### Backup before migration

Before any copy, snapshot the legacy dir to
`$XDG_CACHE_HOME/authmux/pre-migration-backup-<timestamp>/`. If the
migration fails partway through, we can restore.

### Dry-run

`authmux migrate --dry-run` prints the plan without doing anything.
`authmux migrate --execute` runs it. The startup auto-migration is
opt-out via `AUTHMUX_SKIP_AUTO_MIGRATION=1` for users who want manual
control.

### Rollout

- Detector + dry-run: **P1 / S**.
- One-time migrator with backup: **P1 / M**.
- Sentinel + opt-out env var: **P1 / S**.

---

## Testing

The path resolver and migration code are pure functions of env + disk
state, which makes them very testable once the right seams exist.

### Fakes for env and HOME

Replace direct reads of `os.homedir()` and `process.env.*` in
`paths.ts`, `xdg.ts`, and `login-hook.ts` with reads from an injected
`Env` interface:

```ts
export interface Env {
  home(): string;
  platform(): "linux" | "darwin" | "win32" | "other";
  get(name: string): string | undefined;
}
```

The production implementation reads `os.homedir()` and
`process.env`. Tests supply a deterministic fake.

### Snapshot tests for resolved paths per platform

For each combination of:

- platform: linux / darwin / win32
- XDG presence: with `XDG_CONFIG_HOME` etc. / without
- legacy presence: legacy dir exists / not
- env overrides: each `AUTHMUX_*` set / not

… record the resolved paths in a JSON fixture and compare. This is a
small matrix (~24 cases) and catches regressions cheaply.

Example fixture:

```json
{
  "name": "linux-xdg-set-no-legacy",
  "env": {
    "HOME": "/home/u",
    "XDG_DATA_HOME": "/home/u/.local/share",
    "XDG_STATE_HOME": "/home/u/.local/state",
    "XDG_CONFIG_HOME": "/home/u/.config",
    "XDG_CACHE_HOME": "/home/u/.cache"
  },
  "platform": "linux",
  "expected": {
    "snapshotsDir": "/home/u/.local/share/authmux/snapshots",
    "registryPath": "/home/u/.local/share/authmux/registry.json",
    "sessionMapPath": "/home/u/.local/state/authmux/sessions.json",
    "currentPath": "/home/u/.local/state/authmux/current",
    "configPath": "/home/u/.config/authmux/config.toml",
    "cacheDir": "/home/u/.cache/authmux"
  }
}
```

### Login-hook rendering tests

For each shell adapter:

1. Render the block. Assert it starts and ends with the mark comments.
2. Strip the block from a synthetic rc file containing extra content
   before and after. Assert the surrounding content is preserved
   exactly (modulo the `\n{3,}` collapse, which should be documented).
3. Install on a fresh rc → install again → assert
   `"already-installed"` and unchanged file bytes.
4. Install over a corrupted block (missing end mark) → assert the
   installer either repairs cleanly or errors with a clear message.

### Migration tests

Use a temp dir as `$HOME`. Pre-populate a synthetic legacy layout from
fixtures. Run the migrator. Assert:

- New layout matches expectations.
- Legacy dir is untouched (no files deleted, only added the
  `MIGRATION-INFO.md`).
- Sentinel file is present.
- Subsequent run is a no-op.

### Config schema validation tests

Run a list of known-good and known-bad `config.toml` files through the
validator. Each case ships with its expected output (parsed config or
specific error code).

### Rollout

- Env/HOME injection refactor: **P1 / S**.
- Snapshot-tested platform matrix: **P1 / S**.
- Shell adapter unit tests: **P1 / S**.
- Migration end-to-end tests with temp HOME: **P1 / M**.
- Config validator tests: **P1 / S**.

---

## Summary of priorities

| Item | Priority | Size |
|---|---|---|
| XDG-compliant path layout | P1 | M |
| One-time migrator from `~/.codex/accounts` | P1 | M |
| Env/HOME injection refactor for testability | P1 | S |
| Snapshot-tested platform path matrix | P1 | S |
| Standalone typed Config with TOML + JSON | P1 | M |
| `authmux config` subcommands (show/dump/validate/env/path) | P1 | M |
| Codex shim instead of bash/zsh shell function | P1 | M |
| Detection + dry-run for legacy layout migration | P1 | S |
| Drop module-level path constants from `paths.ts` | P1 | S |
| Document all twelve env vars in one place | P1 | S |
| Fish / nushell / PowerShell hook adapters | P2 | M |
| Hook `--dry-run` and diff output | P2 | S |
| Move auto-switch config out of `registry.json` into `config.toml` | P2 | S |
| Replace `CODEX_AUTH_FORCE_EXTERNAL_SYNC` side-channel with `authmux sync --force` | P2 | S |
| Deprecate rc-file login hook after one release | P2 | S |
| `XDG_RUNTIME_DIR` lock file for daemon | P2 | S |
| Surface snapshot-backup vault size in `authmux status` | P3 | S |
| Document the TTY-restore escape sequence inline | P3 | S |

The P1 set is the minimum coherent shift to make authmux's
configuration story production-grade: XDG layout, typed config,
shim-based shell integration, migration, and the testing seams to make
all of the above safe. The remaining items are quality-of-life and can
land opportunistically.
