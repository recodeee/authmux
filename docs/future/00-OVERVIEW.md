# 00 — Overview: authmux Improvement Protocol

## What this protocol is

This document, together with its sibling files under `docs/future/`, is a
deliberately long-form **improvement protocol** for the `authmux` project. It is
not a sales deck, not a marketing roadmap, and not aspirational hand-waving. It
is a written contract between current maintainers, future contributors, and the
AI agents that operate this repository under `AGENTS.md` / Guardex.

Every numbered file (`00-OVERVIEW.md` through `18-...`) describes a slice of the
codebase that has accumulated enough technical debt, missing capability, or
architectural risk to deserve a focused write-up. Each slice is **source-
grounded**: claims are tied to real file paths (e.g. `src/lib/accounts/account-
service.ts:1599`), real LOC counts (`account-service.ts` is currently 1663
lines), and real shipped behavior in `releases/`.

The protocol assumes that the people reading it are doing one of three things:

1. **Building** the next feature and wanting to know which scaffolding they
   can lean on vs. which scaffolding will collapse under the weight of the
   change.
2. **Reviewing** a pull request and wanting to compare it to a longer-term
   target so that ad-hoc patches don't drift further from the desired
   architecture.
3. **Refactoring** with explicit license from the maintainers, and wanting to
   know the exact migration path that was endorsed at design time rather than
   improvising one inside a hot PR.

If you are an AI agent reading this under the Guardex / OMX contract in
`AGENTS.md`, treat the protocol the same way you treat `openspec/` artifacts:
authoritative for *intent*, but never a substitute for reading the actual
source before changing it.

## Audience

| Audience                         | What they should take from this protocol                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Maintainers                      | A single agreed list of where the code wants to go, so PR reviews have an anchor beyond personal taste.      |
| New human contributors           | A map of which files are stable and which are explicitly marked "do not extend without splitting first".     |
| AI agents (Codex / Claude Code)  | Constraints, evidence patterns, and migration recipes that survive context compaction across sessions.       |
| Downstream package authors       | A view into upcoming public-API surface area (`src/lib/accounts/index.ts`), versioning policy, and shims.    |
| Security-conscious users         | Honest disclosure of where the project stores plaintext auth, what it does not yet encrypt, and the plan.    |

## Reading order

The numbered files are designed to be read top-to-bottom for a complete picture,
but each is self-contained enough to be linked from a PR description. Below is
the canonical reading order with a one-paragraph synopsis per file.

### `00-OVERVIEW.md` (this file)
Scope, audience, conventions, current-state snapshot, non-goals. Start here
before reading anything else so the shorthand used later (`P0`, `M`, `Evidence
→ Diagnosis → Proposal → Migration → Rollout`) lands cleanly.

### `01-ARCHITECTURE.md`
Current module map, four-layer target architecture, domain model proposal
(`Account`, `Snapshot`, `Identity`, `UsageQuota`, `Pin`, `Session`,
`ProviderAdapter`), concurrency / locking design for the registry file, error
taxonomy expansion, public TypeScript API surface, plug-in story for new CLI
targets, and an ADR template suggestion.

### `02-COMMANDS.md` (planned)
Per-command audit: every entry under `src/commands/` reviewed for flag
consistency, output format, JSON-mode parity, error-code hygiene. Identifies
the inconsistent split between commands extending `BaseCommand` vs. commands
that import `@oclif/core` `Command` directly (e.g. `parallel.ts`, `kiro.ts`).

### `03-PROVIDERS.md` (planned)
Codex, Claude Code (parallel-via-env), Kiro, Hermes mirror. Proposes the
`ProviderAdapter` interface that lets each be a first-class plug-in instead of
the current mix of `accounts/` (Codex-centric) plus ad-hoc commands.

### `04-USAGE-AND-QUOTA.md` (planned)
Deep dive on `src/lib/accounts/usage.ts` (660 LOC). API mode, local rollout
parsing, proxy mode (`ProxyUsageIndex`), the 5h / weekly window math, and the
proposed `UsageQuota` value object.

### `05-AUTO-SWITCH-DAEMON.md` (planned)
The `authmux daemon --watch` loop, the per-OS managed service in
`service-manager.ts`, missing structured logging, missing health probes, and
the proposal to expose Prometheus-style metrics on a localhost UDS.

### `06-SECRETS-AND-STORAGE.md` (planned)
Today snapshots are plaintext JSON under `~/.codex/accounts/*.json`. Plan for
optional OS-keychain backing (`keytar` / Win Credential Manager / Secret
Service), encrypted-at-rest mode, and threat-model discussion.

### `07-CONCURRENCY-AND-LOCKING.md` (planned)
The single-writer registry assumption, the snapshot-backup vault dance in
`account-service.ts:859-947`, the symlink-materialization race, and the
proposed advisory-lock + atomic-rename pattern.

### `08-SHELL-HOOK-SUBSYSTEM.md` (planned)
`scripts/postinstall-login-hook.cjs`, `src/lib/config/login-hook.ts`, the
`hook-install` / `hook-status` / `hook-remove` commands, `codex()` wrapper
shadowing, TTY-restore env switch, fish/nu/pwsh future support.

### `09-OBSERVABILITY.md` (planned)
Structured logs, opt-in telemetry, debug bundle (`authmux diag`), correlation
IDs across daemon evaluations.

### `10-ERROR-MODEL.md` (planned)
Extending `src/lib/accounts/errors.ts` with stable codes (`E_AUTH_MISSING`,
`E_NAME_INVALID`, `E_REGISTRY_LOCKED`, ...), severity tiers, and JSON envelopes
for `--json` mode parity.

### `11-CONFIGURATION.md` (planned)
The current scatter of env vars (`CODEX_AUTH_JSON_PATH`,
`CODEX_AUTH_SESSION_KEY`, `CODEX_AUTH_FORCE_EXTERNAL_SYNC`, ...). Proposes a
single `authmux.config.json` file with documented precedence rules.

### `12-CLI-UX.md` (planned)
Output formatting, color, the `--json` flag everywhere, the interactive
prompts powered by `prompts`, help-screen-on-bare invocation, exit-code
discipline.

### `13-TESTING-STRATEGY.md` (planned)
Today's `src/tests/*.test.ts` files are small (`registry.test.ts` 36 lines,
`auth-parser.test.ts` 73 lines). Proposes a layered test pyramid: unit ->
integration with a fake `~/.codex` -> end-to-end harness that drives the real
`codex` binary via a mock server.

### `14-RELEASE-AND-DISTRIBUTION.md` (planned)
The `releases/v0.1.*.md` cadence, npm publishing flow, `prepublishOnly`, the
postinstall login-hook prompt, the `update-notifier` init hook, plans for
homebrew / scoop / nix.

### `15-DOCS-AND-EXAMPLES.md` (planned)
README structure, the `docs/future/` protocol (this set), per-provider
quickstarts, end-to-end recipes, screencast plan.

### `16-COMPLIANCE-AND-LEGAL.md` (planned)
Not-affiliated disclaimer, ToS posture for each upstream provider, license
review for transitive deps, telemetry consent.

### `17-ROADMAP.md`
Four time horizons (now / next / later / maybe), exit criteria per theme,
release-cadence proposal, success metrics.

### `18-CONTRIBUTOR-GUIDE.md` (planned)
How to pick up an improvement from this protocol, branch naming under Guardex,
PR template, OpenSpec linkage, "owned scope" rules from `AGENTS.md`.

## Conventions used in the protocol

### Priority tags

| Tag  | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `P0` | Ship-blocker for the next minor; correctness, data-loss, or security risk; do before features. |
| `P1` | Should land within the next two minors; quality bar; cumulative pain if deferred.             |
| `P2` | Nice to have within the next half-year; usually quality-of-life or platform breadth.          |
| `P3` | Research / speculative; do not start without explicit maintainer sign-off.                    |

### Effort tags

| Tag  | Rough size                                                                       |
| ---- | -------------------------------------------------------------------------------- |
| `S`  | < 1 day of focused work, ~1 PR, ≤ 200 lines diff.                                |
| `M`  | 1–3 days, possibly 2 PRs, touches a single subsystem.                            |
| `L`  | 1–2 weeks, multiple PRs behind a feature flag, cross-cutting.                    |
| `XL` | Multi-month, requires its own OpenSpec change set and explicit roadmap slot.     |

### Risk tags

| Tag    | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `low`  | Internal refactor; no behavior change visible to users; covered by tests.        |
| `med`  | Touches on-disk format, CLI output, or env-var precedence; deprecation needed.   |
| `high` | Touches the credential snapshot file itself, daemon scheduling, or upstream ToS. |

### The Evidence / Diagnosis / Proposal / Migration / Rollout pattern

Every numbered improvement in the protocol follows this shape. The pattern is
deliberately verbose so that the document remains useful even after the
codebase shifts under it.

- **Evidence** — concrete file paths, line numbers, command output, or shipped
  release notes that prove the problem exists today. No "feels brittle" without
  a pointer.
- **Diagnosis** — why the evidence indicates a deeper structural issue rather
  than a one-off bug. This is the place to invoke design principles.
- **Proposal** — the smallest design change that resolves the diagnosis, given
  with TypeScript signatures or ASCII diagrams where appropriate.
- **Migration** — the file-by-file or commit-by-commit recipe for moving from
  current state to proposed state. Includes deprecation lanes when the change
  is observable.
- **Rollout** — release notes wording, feature-flag plan, telemetry to add
  before flipping the default, and the explicit "done" criteria.

When you read an improvement and want to act on it, copy the block into an
OpenSpec change under `openspec/changes/<slug>/` and check off items as you
land them. Do not delete or shorten the block in `docs/future/` — that file
remains the long-form reference even after the change ships.

## Current-state snapshot

The snapshot below is the ground truth as of the writing of this protocol. If
you are updating the protocol after a release, update the snapshot in the same
commit so future readers can see how the project has shifted.

| Field                          | Value                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Package name                   | `authmux` (also installs as `agent-auth` per `package.json:6-9`)                                 |
| Version                        | `0.1.24` (`package.json:3`)                                                                      |
| License                        | MIT (`package.json:4`)                                                                           |
| Node engine                    | `>=18` (`package.json:18-20`)                                                                    |
| Module system                  | CommonJS-emitted TypeScript via `tsc -p tsconfig.json`                                           |
| CLI framework                  | `@oclif/core` ^3.0.0                                                                             |
| Runtime deps                   | `@oclif/core`, `prompts`, `tslib`, `typescript`                                                  |
| Bin entries                    | `authmux` and `agent-auth` -> `dist/index.js`                                                    |
| Postinstall hook               | `scripts/postinstall-login-hook.cjs` (opt-in shell-hook installation)                            |
| Source-file count              | 48 TypeScript files under `src/`                                                                 |
| Total source LOC               | ~8,583 lines (`find src -name '*.ts' \| xargs wc -l`)                                            |
| Largest single file            | `src/lib/accounts/account-service.ts` at 1,663 lines                                             |
| Second-largest                 | `src/lib/accounts/usage.ts` at 660 lines                                                         |
| Command count                  | 26 (`ls src/commands/ \| wc -l`)                                                                 |
| Test files                     | 4 (`src/tests/*.test.ts`), all small (24–73 lines each)                                          |
| Test runner                    | Node's built-in `node --test` against the compiled `dist/`                                       |
| Release notes shipped          | `releases/v0.1.6.md`, `v0.1.16.md`, `v0.1.17.md` … `v0.1.21.md`                                  |
| Supported CLI targets          | Codex (first-class), Claude Code (parallel via `CLAUDE_CONFIG_DIR`), Kiro CLI, Hermes (mirror)   |
| OS coverage for managed daemon | Linux (`systemd --user`), macOS (LaunchAgent), Windows (Scheduled Task)                          |
| Local config root              | `~/.codex` by default, overridable via `CODEX_AUTH_CODEX_DIR`                                    |
| Registry file                  | `~/.codex/accounts/registry.json` (plain JSON, single-writer)                                    |
| Auth snapshots                 | `~/.codex/accounts/<name>.json` (plaintext)                                                      |
| Active pointer                 | `~/.codex/current` (plain text containing the active account name)                               |
| Session map                    | `~/.codex/accounts/sessions.json` (per-shell-PPID pin map)                                       |
| Snapshot backup vault          | `~/.codex/accounts/.snapshot-backups/` (transient, cleared after each sync)                      |

### Command catalogue (snapshot)

The 26 commands currently in `src/commands/`:

```
auto-switch.ts   check.ts    clean.ts        config.ts    current.ts
daemon.ts        export.ts   forecast.ts     hero.ts      hook-install.ts
hook-remove.ts   hook-status.ts  import.ts   kiro-login.ts  kiro.ts
list.ts          login.ts    parallel.ts     remove.ts    restore-session.ts
save.ts          savings.ts  status.ts       switch.ts    update.ts
use.ts
```

Note the ones that bypass `BaseCommand` — `parallel.ts` and `kiro.ts` extend
`@oclif/core`'s `Command` directly, which means they do not run
`syncExternalAuthSnapshotIfNeeded` before executing and do not share the
`CodexAuthError` handler. That inconsistency is enumerated in `02-COMMANDS.md`.

## Explicit non-goals of this protocol

The protocol is opinionated about staying scoped. The following items are
**deliberately out of scope** and should not be added in a PR that merely
extends `docs/future/`:

1. **Reverse-engineering upstream provider APIs beyond what is needed for the
   already-shipped quota fetch.** `usage.ts` already talks to
   `https://chatgpt.com/backend-api/wham/usage`; we do not catalog or expand
   that surface here.
2. **A general-purpose secret-manager.** authmux's job is multiplexing
   already-issued CLI credentials, not replacing 1Password, Bitwarden, or
   `pass`.
3. **A daemon that handles non-authmux processes.** The autoswitch loop only
   evaluates and rewrites authmux-owned files.
4. **A GUI before a TUI.** A terminal-UI variant is on the roadmap; a desktop
   GUI is deferred and explicitly marked `P3` in `17-ROADMAP.md`.
5. **Cloud sync of snapshots.** Even encrypted cloud sync changes the threat
   model substantially and is intentionally out of the near-term roadmap.
6. **Rewriting in another language.** Discussions of Rust / Go ports are out
   of scope; performance bottlenecks today are I/O-bound, not CPU-bound.
7. **Replacing oclif.** The CLI framework choice is grandfathered; the
   protocol critiques *how* we use oclif, not which framework we use.
8. **Building a marketplace or paid tier.** authmux stays MIT-licensed and the
   roadmap does not assume any monetization path.

## How to evolve this protocol

- New numbered file: add it under `docs/future/NN-TITLE.md`, then add a synopsis
  in the "Reading order" section above in the same PR.
- New improvement inside an existing file: keep the Evidence / Diagnosis /
  Proposal / Migration / Rollout shape. Don't merge a half-shape block — open
  an issue for the missing half first.
- When an improvement ships: do *not* delete it from the protocol. Instead,
  add a `Status: Shipped in vX.Y.Z` line at the top of the block and link the
  PR. The protocol doubles as project history.
- When an improvement is rejected: add `Status: Rejected — see issue #N` with
  the rationale. Future agents that see the idea proposed again can route to
  the rejection record instead of relitigating.

## Glossary

A handful of terms recur across the protocol. Their meanings here are narrower
than the surrounding industry usage, on purpose.

- **Snapshot** — a single saved Codex / Claude auth blob, stored as JSON on
  disk under `~/.codex/accounts/<name>.json`. One snapshot per account-per-
  provider.
- **Active account** — the snapshot whose contents are currently materialized
  at `~/.codex/auth.json`. Tracked in `~/.codex/current` and in
  `registry.activeAccountName`.
- **Session pin** — a per-terminal binding from shell PPID (or
  `CODEX_AUTH_SESSION_KEY`) to a snapshot name, stored in
  `~/.codex/accounts/sessions.json`. Lets one terminal stay on account A while
  another switches to account B.
- **External sync** — the dance in
  `AccountService.syncExternalAuthSnapshotIfNeeded` that detects when a raw
  `codex login` wrote `auth.json` outside authmux's knowledge and folds the
  result back into the registry.
- **Materialize the symlink** — replacing a symlink at `~/.codex/auth.json`
  with a regular file holding the same bytes, so a subsequent `codex login`
  cannot clobber a saved snapshot through the link.
- **Snapshot backup vault** — `~/.codex/accounts/.snapshot-backups/`, a
  transient safety copy of every saved snapshot taken before running `codex`,
  used to recover from a clobber if the materialize step was bypassed.
- **Proxy mode** — the optional usage source where authmux talks to a local
  dashboard at `http://127.0.0.1:2455` (see `usage.ts:8`) instead of, or in
  addition to, the public usage endpoint.

This glossary is canonical for the protocol — if a later file uses one of
these terms differently, that is a bug in the later file.
