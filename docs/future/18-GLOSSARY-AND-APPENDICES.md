# 18 — Glossary and Appendices

This file is the bookkeeping appendix to the protocol. It exists so that
every other document in `docs/future/` can use the same terms with the same
meaning, and so that ancillary tables (file inventory, env vars,
configuration paths) live in one place instead of being re-derived in every
PR description.

If a term in a numbered document conflicts with this glossary, the bug is in
the numbered document, not here.

## Glossary

Definitions are intentionally narrow — narrower than the surrounding
industry usage. Where a term has a broader meaning elsewhere, the narrower
one is what the protocol uses.

### Account
A named identity that maps to one auth snapshot per provider. In storage:
one entry in `RegistryData.accounts` (`src/lib/accounts/types.ts`) plus
one or more snapshot files under `~/.codex/accounts/<name>.json`. An
account is *not* a user — one human can have multiple accounts (work,
personal, sandbox).

### Active Account
The account whose Codex snapshot is currently materialized at
`~/.codex/auth.json`. Tracked in `~/.codex/current` and in
`RegistryData.activeAccountName`. Exactly one active account at any time
per Codex root.

### Adapter
See **Provider Adapter**.

### Auth Artifact
The on-disk file(s) that prove a CLI is logged in for a given provider.
For Codex: `~/.codex/auth.json`. For Claude Code: the relevant files under
the directory pointed to by `CLAUDE_CONFIG_DIR`. For Kiro: the snapshot
files under `XDG_DATA_HOME/kiro-account-switcher`.

### Auth Snapshot
A saved copy of an auth artifact, taken at the moment the user ran
`authmux save <name>` (or at the moment the external-sync flow detected
one). Stored as plain JSON in `~/.codex/accounts/<name>.json`. One snapshot
per account per provider. See **Snapshot**.

### Authmux
The project. Also the binary name (`bin: authmux` in `package.json:6-9`).
Historical alias: `agent-auth` (also installed by the same `package.json`).
Pronounced "auth-mux" (mux as in multiplexer).

### Backoff
The retry-spacing policy applied when a network call to the usage endpoint
fails. Not yet formalized; tracked under `04-USAGE-AND-QUOTA.md`.

### Calver
Calendar versioning. Not currently used — authmux ships SemVer (currently
`0.1.24` per `package.json:3`). Listed here so that any future proposal to
switch starts from the same definition.

### Capability
A boolean attribute of a Provider Adapter declaring what it can do:
`can-save`, `can-switch`, `can-list-usage`, `can-mirror-to-kiro`, etc.
Used by the auto-switch daemon to decide which accounts are switch
candidates.

### Cooldown
The minimum time the daemon must wait after switching off an account before
considering it a candidate again. Avoids ping-pong when two accounts hover
near a threshold.

### Current Pointer
The single line of text at `~/.codex/current` that records the active
account name. Read by `resolveCurrentNamePath()`
(`src/lib/config/paths.ts:36-43`).

### Daemon
The background process running `authmux daemon --watch`. Wakes every 30s
(`src/commands/daemon.ts:9`), evaluates usage, switches accounts when
thresholds breach. Per-OS service definition lives in
`src/lib/accounts/service-manager.ts`.

### Device Auth
The OAuth-style device-code flow used by `codex login` and `claude login`.
Authmux does not implement device auth itself; it captures the artifacts
produced by the upstream flows.

### Forecast
The forward-looking estimate of "when will this account hit its 5h or
weekly cap?" rendered by `authmux forecast` (`src/commands/forecast.ts`).

### Guardex
The multi-agent execution contract codified in `AGENTS.md`. Governs branch
naming (`agent/*`), worktrees, file claims, completion flow, OpenSpec
linkage. Not a runtime component of authmux; a development-time discipline
only.

### Hermes
A separate project; authmux ships a mirror in `src/lib/hermes-mirror.ts`
that propagates account changes to Hermes if present.

### Hook (login hook)
The shell function (typically named `codex`) installed by
`scripts/postinstall-login-hook.cjs` and managed by
`src/lib/config/login-hook.ts`. Wraps invocations of the real `codex`
binary so that authmux can pre-flight account selection.

### Hook (oclif init hook)
The function exported from `src/hooks/init/update-notifier.ts`. Registered
in `package.json:62-64`. Runs before every command resolution; today it
checks for npm updates and prints the hero screen on bare invocation.

### Hysteresis
The gap between "switch away from X" and "switch back to X" thresholds.
Without it, the daemon flaps between two near-cap accounts every tick.

### Identity
The provider-side identifier that uniquely names an account. For Codex
ChatGPT-mode: `accountId` plus `userId` from the parsed snapshot
(`src/lib/accounts/auth-parser.ts`). Used to detect when two snapshots
represent the same account under different local names.

### Kiro
The Kiro CLI. Third-party AI tool whose credentials live under
`XDG_DATA_HOME/kiro-account-switcher`. Authmux can mirror Codex switches
to Kiro when matching snapshots exist (`src/lib/kiro-mirror.ts`).

### LaunchAgent
The macOS user-scoped background-service mechanism. Used by
`service-manager.ts` to register `authmux daemon --watch` on macOS hosts.

### Pin
A binding from a terminal session (identified by shell PPID or
`CODEX_AUTH_SESSION_KEY`) to a specific account name. Stored in
`~/.codex/accounts/sessions.json`. Keeps one terminal on account A while
another switches to account B.

### Pin Scope
Currently always "session" (per-shell-PPID). Future scopes proposed in
`12-CLI-UX.md`: "directory", "git-remote", "tmux-pane".

### Plan Display
The user-facing label for a Codex plan (Free, Plus, Pro, Team, Enterprise).
Rendered by `src/lib/accounts/plan-display.ts`.

### Profile (Claude parallel)
The directory pointed to by `CLAUDE_CONFIG_DIR` that holds a single
Claude Code login. `authmux parallel` uses one profile dir per account
(`src/commands/parallel.ts`).

### Provider
A vendor whose CLI authmux multiplexes. Today: Codex (OpenAI), Claude Code
(Anthropic), Kiro (third-party), Hermes (third-party mirror).

### Provider Adapter
The proposed interface (`01-ARCHITECTURE.md`) that each provider
implements: `save()`, `use()`, `list()`, `getUsage()`, `mirror()`. Not
fully realized in source today — see `03-PROVIDERS.md` (planned).

### Quota
A per-account usage limit imposed by the upstream provider. Codex
currently exposes a 5-hour rolling window and a weekly window. Surfaced via
`UsageSnapshot` (`src/lib/accounts/types.ts`).

### Refresh Token
The long-lived credential embedded in a Codex auth snapshot, used to mint
short-lived access tokens. Plaintext on disk today. See
`06-SECRETS-AND-STORAGE.md` (planned) for encryption proposal.

### Registry
The single JSON file at `~/.codex/accounts/registry.json` that records all
known accounts, their metadata (email, planType, lastUsage), the active
account name, and auto-switch settings. Schema in
`src/lib/accounts/types.ts`; load/save in
`src/lib/accounts/registry.ts`.

### Rollout Log
The JSONL files under `~/.codex/sessions/**/rollout-*.jsonl` written by
Codex itself. Authmux reads the last few for local usage fallback
(`src/lib/accounts/usage.ts:571-660`).

### Scheduled Task
The Windows equivalent of a systemd user service or LaunchAgent. Used by
`service-manager.ts` on Windows hosts.

### Service Manager
The module that abstracts per-OS background-service registration:
`src/lib/accounts/service-manager.ts`. Provides
`enableManagedService`, `disableManagedService`, `getManagedServiceState`.

### Session
A single instance of a shell where the user is running authmux-managed
commands. Identified by `CODEX_AUTH_SESSION_KEY` if set, else by
`process.ppid` (`src/lib/accounts/account-service.ts:1384-1396`).

### Session Key
The environment variable `CODEX_AUTH_SESSION_KEY`. Overrides the default
PPID-based session identification when set. Useful for tmux / screen
setups where PPID is unstable.

### Shim
The shell function installed by the login hook that intercepts `codex`
invocations. Synonymous with **Hook (login hook)** in casual usage; "shim"
emphasizes the wrapping behavior, "hook" emphasizes the installation
side.

### Snapshot
See **Auth Snapshot**. Within this codebase, "snapshot" alone always
refers to a saved auth artifact, never to a registry snapshot or DB
snapshot.

### Stale-While-Revalidate
A caching pattern where a stale cached value is served immediately and a
background refresh updates the cache. Proposed for the update-check hook
in `15-PERFORMANCE-AND-SCALABILITY.md` (P-15.6).

### Switch
The act of changing the active account: copying a saved snapshot into
`~/.codex/auth.json`, updating the current pointer, and optionally
mirroring to Kiro. Implemented by `useAccount()` in `account-service.ts`.

### Systemd User Service
The Linux user-scoped background-service mechanism. Used by
`service-manager.ts` for the daemon on Linux hosts.

### Telemetry
Opt-in usage reporting. Not implemented today. Proposed in
`09-OBSERVABILITY.md` (planned).

### Tier
Synonym for the upstream-published plan tier (Free, Plus, Pro, Team,
Enterprise). Stored in `UsageSnapshot.planType`.

### Usage
The per-account quota consumption number, normalized to a percentage
0-100. Two windows: primary (5h) and secondary (weekly). Stored on
`AccountRegistryEntry.lastUsage` (`src/lib/accounts/types.ts`).

### Usage Window (5h / weekly / monthly)
The rolling time window over which usage is summed. Codex exposes 5h
(window minutes 300) and weekly (window minutes 10080). Monthly is
hypothetical; not currently exposed by any provider authmux supports.

### Watcher
The `--watch` mode of `authmux daemon`. Wakes every 30 seconds; contrasts
with `--once` which runs a single evaluation and exits
(`src/commands/daemon.ts`).

### XDG
The XDG Base Directory Specification. Defines `$XDG_DATA_HOME`,
`$XDG_CACHE_HOME`, `$XDG_CONFIG_HOME`. Used today only at
`src/lib/kiro-mirror.ts:8`, `src/commands/kiro-login.ts:10`, and
`src/commands/kiro.ts:9`. Proposed for broader adoption in
`11-CONFIGURATION.md` (planned).

## Appendix A: Full file inventory

The table below was generated from `wc -l` against `src/` at the time of
writing. Lines are non-test source lines unless noted. Update this table in
the same PR that adds or removes a source file.

### Production source (under `src/`, excluding `src/tests/`)

| Path                                                | LOC  | Role                                                                |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| `src/index.ts`                                       |    6 | oclif entry point                                                   |
| `src/types/prompts.d.ts`                             |    1 | Ambient type stub                                                   |
| `src/hooks/init/update-notifier.ts`                  |   64 | Init hook: update check + hero screen                               |
| `src/lib/base-command.ts`                            |   26 | Shared oclif base class                                             |
| `src/lib/account-health.ts`                          |  227 | Per-account success/failure ledger                                  |
| `src/lib/account-savings.ts`                         |   63 | Cumulative "switches done" counter                                  |
| `src/lib/hermes-mirror.ts`                           |   52 | Mirror to Hermes when present                                       |
| `src/lib/kiro-mirror.ts`                             |  108 | Mirror to Kiro CLI when matching snapshot exists                    |
| `src/lib/update-check.ts`                            |  285 | npm registry version-check helpers                                  |
| `src/lib/usage-refresh.ts`                           |   83 | Cross-cutting usage-refresh helpers                                 |
| `src/lib/config/login-hook.ts`                       |  138 | Shell-hook install/remove/status logic                              |
| `src/lib/config/paths.ts`                            |   67 | Path resolvers honoring env-var overrides                           |
| `src/lib/accounts/account-service.ts`                | 1663 | Core orchestrator; load/save/use/sync/auto-switch                   |
| `src/lib/accounts/auth-parser.ts`                    |  104 | Parse Codex auth.json into ParsedAuthSnapshot                       |
| `src/lib/accounts/errors.ts`                         |   76 | Domain error classes                                                |
| `src/lib/accounts/index.ts`                          |   19 | Public re-export barrel                                              |
| `src/lib/accounts/plan-display.ts`                   |   49 | Render plan-type label                                              |
| `src/lib/accounts/registry.ts`                       |  181 | Load/save/sanitize the registry JSON                                |
| `src/lib/accounts/service-manager.ts`                |  219 | Per-OS daemon-service install/remove                                |
| `src/lib/accounts/types.ts`                          |   84 | Shared types: AccountMapping, RegistryData, UsageSnapshot           |
| `src/lib/accounts/usage.ts`                          |  660 | API / proxy / local-rollout usage fetchers                          |
| `src/commands/auto-switch.ts`                        |   32 | Toggle auto-switch on/off                                           |
| `src/commands/check.ts`                              |   31 | Health probe                                                        |
| `src/commands/clean.ts`                              |   52 | Purge orphaned files                                                |
| `src/commands/config.ts`                             |  100 | Read/write registry config keys                                     |
| `src/commands/current.ts`                            |   12 | Print active account name                                           |
| `src/commands/daemon.ts`                             |   41 | Run autoswitch loop (`--watch` / `--once`)                          |
| `src/commands/export.ts`                             |   34 | Dump an account snapshot to stdout                                  |
| `src/commands/forecast.ts`                           |   25 | Forecast next quota exhaustion                                      |
| `src/commands/hero.ts`                               |   44 | Bare-invocation tutorial screen                                     |
| `src/commands/hook-install.ts`                       |   34 | Install shell hook                                                  |
| `src/commands/hook-remove.ts`                        |   32 | Remove shell hook                                                   |
| `src/commands/hook-status.ts`                        |   28 | Print shell-hook status                                             |
| `src/commands/import.ts`                             |  130 | Import an existing auth.json under a name                           |
| `src/commands/kiro-login.ts`                         |   77 | Save current Kiro session as a named account                        |
| `src/commands/kiro.ts`                               |  108 | Switch Kiro session                                                 |
| `src/commands/list.ts`                               |  113 | List managed accounts                                               |
| `src/commands/login.ts`                              |  125 | Run codex login flow under authmux supervision                      |
| `src/commands/parallel.ts`                           |  144 | Run a command under a chosen Claude profile                         |
| `src/commands/remove.ts`                             |  123 | Remove a saved account                                              |
| `src/commands/restore-session.ts`                    |   14 | Restore session pin                                                 |
| `src/commands/save.ts`                               |   46 | Save the current auth.json under a name                             |
| `src/commands/savings.ts`                            |   22 | Print cumulative switch count                                       |
| `src/commands/status.ts`                             |   15 | Print one-line status                                               |
| `src/commands/switch.ts`                             |  126 | Interactive switcher                                                |
| `src/commands/update.ts`                             |   95 | Self-update via npm                                                 |
| `src/commands/use.ts`                                |   92 | Activate a named account                                            |

### Tests (under `src/tests/`)

| Path                                                | LOC  | Role                                                                |
| --------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| `src/tests/account-list-usage-refresh.test.ts`       |  389 | Listing + usage-refresh integration                                 |
| `src/tests/account-plan-display.test.ts`             |   24 | Plan label rendering                                                |
| `src/tests/auth-parser.test.ts`                      |   73 | auth.json parsing                                                   |
| `src/tests/login-hook.test.ts`                       |  124 | Shell-hook install logic                                            |
| `src/tests/registry.test.ts`                         |   36 | Registry load/save                                                  |
| `src/tests/save-account-safety.test.ts`              | 1772 | Snapshot-write race conditions                                      |
| `src/tests/update-check.test.ts`                     |  258 | npm version comparison                                              |
| `src/tests/usage.test.ts`                            |   37 | Usage math                                                          |

### Totals

- Production source: ~5,257 LOC across 47 TypeScript files
- Tests: ~2,713 LOC across 8 test files
- Combined: ~7,970 LOC

Note: prior protocol files cite a slightly different combined figure
(`00-OVERVIEW.md` mentions ~8,583). Differences are accounted for by
intermediate changes between snapshots; update both numbers together when
either drifts.

## Appendix B: Command quick-reference table

The table covers every command currently in `src/commands/`, the flags it
accepts, the proposed exit-code map (today most commands just exit 0 or
1; the proposal in `10-ERROR-MODEL.md` standardizes them), and a one-line
description.

### Proposed exit-code map

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | Success.                                                             |
| 1    | Generic failure (current default).                                   |
| 2    | Misuse: invalid flag combination, missing required argument.         |
| 3    | Not found: account, snapshot, or registry entry missing.             |
| 4    | Conflict: name already exists, identity mismatch, locked.            |
| 5    | Auth artifact missing or unparseable.                                |
| 6    | Network failure on usage endpoint (warning-class).                   |
| 7    | OS service install/remove failed.                                    |
| 8    | Prompt cancelled by user (Ctrl-C / ESC at a `prompts` selector).     |
| 9    | Permission denied (filesystem ACL on `~/.codex/`).                   |
| 10   | Daemon already running / not running when contradicted.              |

### Command table

| Command            | Flags                                         | Exit codes used     | One-line description                                                  |
| ------------------ | --------------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| `auto-switch`      | (subcommand: on / off / status)              | 0, 1, 2             | Toggle the autoswitch policy in the registry.                         |
| `check`            | none                                           | 0, 1, 5, 6          | Health probe of current account.                                      |
| `clean`            | `--dry-run`                                    | 0, 1                | Remove orphaned snapshot files and registry entries.                  |
| `config`           | `<key>` `<value?>`                             | 0, 1, 2             | Read or write a registry config key.                                  |
| `current`          | none                                           | 0, 1, 3             | Print the active account name.                                        |
| `daemon`           | `--watch`, `--once`                            | 0, 1, 2, 10         | Run the autoswitch loop.                                              |
| `export`           | `<name>`                                       | 0, 1, 3             | Dump a snapshot's JSON to stdout.                                     |
| `forecast`         | none                                           | 0, 1                | Forecast next quota exhaustion.                                       |
| `hero`             | none                                           | 0                   | Print the welcome/tutorial screen.                                    |
| `hook-install`     | `--shell <bash|zsh>`                           | 0, 1, 7             | Install the shell login hook.                                         |
| `hook-remove`      | `--shell <bash|zsh>`                           | 0, 1, 7             | Remove the shell login hook.                                          |
| `hook-status`      | none                                           | 0, 1                | Print shell-hook install status.                                      |
| `import`           | `<name>` `--from <path>`                       | 0, 1, 4, 5          | Import an external auth.json under a name.                            |
| `kiro-login`       | `<name>`                                       | 0, 1, 4             | Save the current Kiro session as a named account.                     |
| `kiro`             | (subcommand: list / use / current)             | 0, 1, 3             | Manage Kiro mirror snapshots.                                         |
| `list`             | `-d, --details`                                | 0, 1                | List managed Codex accounts.                                          |
| `login`            | `<name?>`                                      | 0, 1, 4, 5          | Run codex login flow under authmux supervision.                       |
| `parallel`         | `<name>` `--cmd <command>`                     | 0, 1, 3             | Spawn a command with a chosen Claude profile.                         |
| `remove`           | `<name>` `--force`                             | 0, 1, 3, 4          | Remove a saved account.                                               |
| `restore-session`  | none                                           | 0, 1                | Re-pin the current session to the previously pinned account.          |
| `save`             | `<name>` `--force`                             | 0, 1, 4, 5          | Save the current `auth.json` under a name.                            |
| `savings`          | none                                           | 0                   | Print cumulative switch count.                                        |
| `status`           | none                                           | 0, 1                | Print one-line status.                                                |
| `switch`           | `<name?>`                                      | 0, 1, 3, 8          | Interactive switcher.                                                 |
| `update`           | none                                           | 0, 1, 6             | Self-update via npm.                                                  |
| `use`              | `<account?>` `--no-kiro`                       | 0, 1, 3, 8          | Activate a named account; mirror to Kiro if applicable.               |

## Appendix C: Configuration environment variables

The list below is the result of grepping `process.env.` across the source
tree (excluding `src/tests/`). Every entry is anchored to the file and
line where it is read.

### Authmux-defined env vars

| Name                                   | Default                                                | Read at                                                                 | Semantics                                                                                            |
| -------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CODEX_AUTH_CODEX_DIR`                 | `~/.codex`                                              | `src/lib/config/paths.ts:10`                                            | Override the root Codex directory.                                                                   |
| `CODEX_AUTH_ACCOUNTS_DIR`              | `${CODEX_AUTH_CODEX_DIR}/accounts`                      | `src/lib/config/paths.ts:19`                                            | Override the accounts subdirectory.                                                                  |
| `CODEX_AUTH_JSON_PATH`                 | `${CODEX_AUTH_CODEX_DIR}/auth.json`                     | `src/lib/config/paths.ts:28`                                            | Override the active-auth file path.                                                                  |
| `CODEX_AUTH_CURRENT_PATH`              | `${CODEX_AUTH_CODEX_DIR}/current`                       | `src/lib/config/paths.ts:37`                                            | Override the current-pointer file path.                                                              |
| `CODEX_AUTH_SESSION_MAP_PATH`          | `${CODEX_AUTH_ACCOUNTS_DIR}/sessions.json`              | `src/lib/config/paths.ts:50`                                            | Override the session-map file path.                                                                  |
| `CODEX_AUTH_FORCE_EXTERNAL_SYNC`       | unset (falsy)                                          | `src/lib/accounts/account-service.ts:1377`                              | Force `syncExternalAuthSnapshotIfNeeded` to run even when fingerprint matches.                        |
| `CODEX_AUTH_SESSION_KEY`               | unset (falls back to PPID)                              | `src/lib/accounts/account-service.ts:1385`                              | Override the per-shell session identifier; useful in tmux/screen.                                    |
| `CODEX_AUTH_SESSION_ACTIVE_OVERRIDE`   | unset                                                  | `src/lib/accounts/account-service.ts:1538`                              | Force the session-active check to true/false; used by tests and tooling.                              |
| `CODEX_AUTH_SKIP_POSTINSTALL`          | unset (falsy)                                          | `scripts/postinstall-login-hook.cjs:106`                                | Skip the postinstall login-hook prompt.                                                              |
| `CODEX_LB_URL`                         | `http://127.0.0.1:2455`                                 | `src/lib/accounts/usage.ts:428`                                         | Proxy-mode dashboard URL.                                                                            |
| `CODEX_LB_DASHBOARD_PASSWORD`          | unset                                                  | `src/lib/accounts/usage.ts:386` (via `DASHBOARD_PASSWORD_ENV`)          | Password for the proxy-mode dashboard login.                                                         |
| `CODEX_LB_DASHBOARD_TOTP_CODE`         | unset                                                  | `src/lib/accounts/usage.ts:356` (via `DASHBOARD_TOTP_CODE_ENV`)         | TOTP code for the proxy-mode dashboard.                                                              |
| `CODEX_LB_DASHBOARD_TOTP_COMMAND`      | unset                                                  | `src/lib/accounts/usage.ts:361` (via `DASHBOARD_TOTP_COMMAND_ENV`)      | Shell command that prints a TOTP code on stdout.                                                     |

### Third-party env vars consumed by authmux

| Name                                   | Default                                                | Read at                                                                 | Semantics                                                                                            |
| -------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SHELL`                                | `/bin/bash`                                            | `src/lib/config/login-hook.ts:31`, `src/commands/parallel.ts:17`, `scripts/postinstall-login-hook.cjs:18` | Detect user's shell for hook install and parallel-spawn.                                              |
| `XDG_DATA_HOME`                        | `${HOME}/.local/share`                                  | `src/lib/kiro-mirror.ts:8`, `src/commands/kiro-login.ts:10`, `src/commands/kiro.ts:9` | Kiro snapshot root directory.                                                                        |
| `CI`                                   | unset                                                  | `scripts/postinstall-login-hook.cjs:107`                                | When set to a truthy value, skip postinstall prompts (CI-safe).                                       |
| `npm_config_global`                    | set by npm                                              | `scripts/postinstall-login-hook.cjs:105`                                | Postinstall only runs when authmux is being installed globally.                                       |
| `GUARDEX_VSCODE_EXTENSIONS_DIR`        | unset                                                  | `scripts/install-vscode-active-agents-extension.js:76`                  | Override VSCode extensions directory for the optional Guardex extension installer.                    |
| `VSCODE_EXTENSIONS_DIR`                | unset                                                  | `scripts/install-vscode-active-agents-extension.js:77`                  | Override VSCode extensions directory (alternative variable).                                          |

### Proposed but not yet implemented

These appear in proposal blocks elsewhere in the protocol. Listed here for
discoverability; do not assume they work today.

| Name                                   | Status        | Source                                                |
| -------------------------------------- | ------------- | ----------------------------------------------------- |
| `AUTHMUX_USAGE_REFRESH_CONCURRENCY`    | Proposed P1   | `15-PERFORMANCE-AND-SCALABILITY.md` P-15.4            |
| `AUTHMUX_DISABLE_UPDATE_CHECK`         | Proposed P0   | `15-PERFORMANCE-AND-SCALABILITY.md` P-15.6            |
| `AUTHMUX_CACHE_DIR`                    | Proposed P1   | `15-PERFORMANCE-AND-SCALABILITY.md` P-15.2            |
| `AUTHMUX_TRACE`                        | Proposed P1   | `15-PERFORMANCE-AND-SCALABILITY.md` P-15.6            |
| `CLAUDE_CONFIG_DIR`                    | Used by Claude itself; surface in adapter docs | `03-PROVIDERS.md` (planned) |

## Appendix D: File layout reference

Two columns: today (as shipped) and the proposed XDG-compliant layout from
`05-AUTO-SWITCH-DAEMON.md` / `11-CONFIGURATION.md` (planned). The
migration path itself lives in those documents; this appendix is the
side-by-side reference.

### Current layout

| Item                       | Path                                                          |
| -------------------------- | ------------------------------------------------------------- |
| Codex root                 | `~/.codex/`                                                    |
| Active auth                | `~/.codex/auth.json`                                           |
| Current pointer            | `~/.codex/current`                                             |
| Accounts directory         | `~/.codex/accounts/`                                           |
| Registry                   | `~/.codex/accounts/registry.json`                              |
| Snapshot file              | `~/.codex/accounts/<name>.json`                                |
| Session map                | `~/.codex/accounts/sessions.json`                              |
| Snapshot backup vault      | `~/.codex/accounts/.snapshot-backups/`                         |
| Rollout logs (read-only)   | `~/.codex/sessions/**/rollout-*.jsonl`                         |
| Kiro snapshots             | `${XDG_DATA_HOME:-~/.local/share}/kiro-account-switcher/`      |
| Claude profile (parallel)  | `${CLAUDE_CONFIG_DIR}` (per-account dir)                       |
| Shell hook (bash/zsh)      | Appended to `~/.bashrc` / `~/.zshrc` (see login-hook.ts)       |
| Daemon service (Linux)     | `~/.config/systemd/user/authmux-daemon.service`                |
| Daemon service (macOS)     | `~/Library/LaunchAgents/com.recodee.authmux.plist`             |
| Daemon service (Windows)   | Scheduled Task under user scope                                |

### Proposed XDG-compliant layout

| Item                       | Path                                                          |
| -------------------------- | ------------------------------------------------------------- |
| Codex root (legacy)        | `~/.codex/` (read-only; for `auth.json` interop with codex)    |
| Active auth (still here)   | `~/.codex/auth.json` (mandated by upstream)                    |
| Authmux config             | `${XDG_CONFIG_HOME:-~/.config}/authmux/config.json`             |
| Accounts directory         | `${XDG_DATA_HOME:-~/.local/share}/authmux/accounts/`            |
| Registry                   | `${XDG_DATA_HOME:-~/.local/share}/authmux/registry.json`        |
| Snapshot file              | `${XDG_DATA_HOME:-~/.local/share}/authmux/accounts/<name>.json` |
| Session map                | `${XDG_STATE_HOME:-~/.local/state}/authmux/sessions.json`        |
| Snapshot backup vault      | `${XDG_STATE_HOME:-~/.local/state}/authmux/snapshot-backups/`    |
| Cache (registry, update)   | `${XDG_CACHE_HOME:-~/.cache}/authmux/`                          |
| Logs                       | `${XDG_STATE_HOME:-~/.local/state}/authmux/logs/`                |
| Daemon service paths       | Unchanged (per-OS conventions take precedence)                  |

The compatibility plan: read from both locations during a deprecation
window, write to the new location, log a one-time migration notice. Drop
the old path after one major version.

## Appendix E: External resources

These are background reading sources. Names only; do not fabricate URLs
in this list. When linked from the docs site, ensure the URL is current
at the time of publication.

- oclif: official documentation site
- XDG Base Directory Specification (freedesktop.org)
- systemd.service unit reference (freedesktop.org)
- launchd / launchctl reference (Apple developer documentation)
- LaunchAgent plist format (Apple developer documentation)
- Windows Task Scheduler reference (Microsoft Learn)
- npm registry HTTP API (npm Docs)
- Node.js fs/promises documentation (nodejs.org)
- Node.js child_process documentation (nodejs.org)
- OpenAI platform documentation landing page
- Anthropic API documentation landing page
- ChatGPT / Codex CLI repository (GitHub)
- Claude Code documentation landing page
- Kiro CLI repository (GitHub)
- Hermes repository (GitHub)
- TypeScript handbook (typescriptlang.org)
- Conventional Commits specification (conventionalcommits.org)
- Semantic Versioning specification (semver.org)
- Keep a Changelog (keepachangelog.com)

## Appendix F: Open questions tracker template

`AGENTS.md` mandates that unresolved questions during a change are
recorded at `openspec/plan/<plan-slug>/open-questions.md`. The template
below is what those files should look like.

```markdown
# Open questions — <plan-slug>

Last updated: <YYYY-MM-DD>
Owner: <agent-branch or human handle>

## Active

- [ ] Should the registry cache file use mtime in ms or in s? (P-15.2)
      Context: Linux mtime resolution is filesystem-dependent. ext4 gives
      ns; tmpfs sometimes only gives s. Decision affects cross-FS
      portability.
      Asked by: <handle>, <YYYY-MM-DD>.
      Owner: <handle>.

- [ ] If a user has both `CODEX_AUTH_JSON_PATH` and `CODEX_AUTH_CODEX_DIR`
      set and they disagree, which wins?
      Context: today the more specific path wins by accident (it short-
      circuits before the dir resolver runs). We should encode the rule
      explicitly in docs and add a test.
      Asked by: <handle>, <YYYY-MM-DD>.
      Owner: <handle>.

## Resolved

- [x] Should the daemon retry on a single failed usage fetch or skip the
      tick? — **Resolved**: skip with a logged warning; the next tick (30s
      later) will retry. Avoids cascading retries on a flaky network.
      Resolved by: <handle>, <YYYY-MM-DD>.

## Won't fix

- [~] Should we support per-directory account pinning via a `.authmuxrc`
      file? — **Won't fix in this change**: scope creep relative to the
      change goal. Re-file as a separate proposal under
      `12-CLI-UX.md` if there is demand.
```

Notes on usage:

- The leading checkbox is the source of truth for "is this question still
  blocking work?".
- Move resolved items to the **Resolved** section instead of deleting
  them — future agents need the history.
- One open-questions file per plan slug; never share a file across slugs.

## Appendix G: Definitions of done

The "done" bar is different for different kinds of work. Spelling it out
avoids the failure mode where a refactor PR ships without tests, or a new
command ships without docs, simply because nobody agreed up front what
"done" meant.

### For refactors

- [ ] No public API behavior change (or, if there is one, documented and
      changeset-recorded).
- [ ] All existing tests still pass on Node 18 and Node 20.
- [ ] No new lint or type errors.
- [ ] Bench numbers captured in `bench/results/<sha>.json` if a hot-path
      file changed (`15-PERFORMANCE-AND-SCALABILITY.md`).
- [ ] PR description references the protocol section that motivated the
      refactor.
- [ ] Reviewer signs off explicitly on the diff.

### For new commands

- [ ] Command file under `src/commands/<name>.ts` extends `BaseCommand`
      (not raw `@oclif/core` Command, unless justified inline).
- [ ] `static description` is set.
- [ ] `static flags` is fully typed (no `any`).
- [ ] `static examples` is set with at least two examples.
- [ ] One unit test under `src/tests/<name>.test.ts`.
- [ ] One integration scenario added to the end-to-end harness when one
      exists (`13-TESTING-STRATEGY.md` planned).
- [ ] Entry added to Appendix B in this file.
- [ ] Entry added to the command table in `00-OVERVIEW.md` if new family.
- [ ] `oclif readme --multi` regenerated and committed.
- [ ] Exit codes consistent with Appendix B's map.

### For provider adapters

- [ ] Implements the full `ProviderAdapter` interface (`01-
      ARCHITECTURE.md` once that lands).
- [ ] Capability flags declared explicitly.
- [ ] Unit tests under `src/tests/providers/<name>.test.ts`.
- [ ] Documented under `docs/site/guides/<provider>.md`.
- [ ] Glossary entry added to this file for any provider-specific term.
- [ ] Threat-model section in `06-SECRETS-AND-STORAGE.md` updated with
      the new auth artifact's location and sensitivity.

### For security-impacting changes

- [ ] Change is documented in `SECURITY.md` if it changes the threat
      model.
- [ ] Reviewer with security-tag CODEOWNERS approval is required (not
      just any maintainer).
- [ ] Test that exercises the new path with the credential set to a
      known sentinel value.
- [ ] No new on-disk plaintext credential storage without explicit
      sign-off in the PR description.
- [ ] No new network endpoint contacted without explicit sign-off and a
      `--no-network` test that proves the call is skippable.
- [ ] Release notes include a "Security" subsection.
- [ ] If a CVE is reasonably foreseeable, file a private security
      advisory before merging.

### For documentation-only changes

- [ ] All cross-references resolve (no dangling `01-ARCHITECTURE.md`
      links to absent files).
- [ ] Markdown lints cleanly with the project's `markdownlint` config
      (when one exists).
- [ ] No fabricated URLs or invented function signatures.
- [ ] Code references include line numbers where helpful.
- [ ] No emojis (per protocol style rule, `00-OVERVIEW.md` and
      `16-DOCUMENTATION-AND-DX.md`).

## Closing note

The appendices in this document are reference material, not narrative.
They will rot faster than the prose elsewhere in the protocol because the
underlying code (line counts, env vars, command list) shifts release over
release. The rule is: **update this file in the same PR that changes the
underlying source.** A drift between Appendix A and `wc -l src` is the
same class of bug as a drift between a function's docstring and its
signature — both should be caught at review.
