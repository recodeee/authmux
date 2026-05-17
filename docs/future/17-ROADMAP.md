# 17 — Roadmap

This file is the time-sequenced view of the improvements catalogued elsewhere
in `docs/future/`. Where `01-ARCHITECTURE.md` and the other numbered files
describe *what* and *why*, this file describes *when* and *in what order*.

The roadmap uses four horizons rather than fixed calendar quarters because
authmux is a single-maintainer-plus-agents project and absolute dates drift.
The horizons are:

| Horizon | Window           | Posture                                                |
| ------- | ---------------- | ------------------------------------------------------ |
| Now     | 0 – 4 weeks      | Committed; tracked in `openspec/changes/` or PRs.      |
| Next    | 1 – 3 months     | Funded by maintainer time; spec'd before work begins.  |
| Later   | 3 – 9 months     | Endorsed direction; needs a sponsor PR to start.       |
| Maybe   | 9+ months / R&D  | Speculative; do not start without explicit sign-off.   |

Each major theme below lists **Goals → Exit criteria → Dependencies → Risks**.
A theme is "done" only when every exit-criterion checkbox flips and the
release notes for the shipping version (`releases/vX.Y.Z.md`) mention it
explicitly. Do not declare a theme done by inference from a passing CI run.

## Now (0 – 4 weeks)

Posture: every item here must already have an OpenSpec change-slug or an open
PR. If you find an item in this section without one, that is a docs bug —
open the OpenSpec slug or move the item back to Next.

### Theme N1 — Registry & snapshot durability

**Goals.** Eliminate the two known data-loss windows in
`src/lib/accounts/registry.ts` and `account-service.ts`:

- Concurrent writer wins-and-loses on `registry.json`.
- Half-written `registry.json` after SIGKILL or laptop sleep.

**Exit criteria.**
- [ ] `src/infra/fs/atomic-write.ts` lands with `fsync`-before-rename.
- [ ] Every `fsp.writeFile` for `registry.json`, `current`, `sessions.json`,
      and snapshot files routes through `atomicWriteFile`.
- [ ] `src/infra/fs/registry-lock.ts` lands with stale-lock reaping.
- [ ] `AccountService.persistRegistry` is the only write path; it always
      reloads-under-lock then merges deltas.
- [ ] A reproduction test under `src/tests/registry-durability.test.ts`
      kills the writer between `writeFile` and `rename` and asserts the
      registry still parses.
- [ ] Release notes for the shipping version include a "Durability" section.

**Dependencies.** None outside this theme.

**Risks.**
- `fsync` adds noticeable latency on spinning disks. Mitigation: measure
  before/after on the maintainer's machine; document worst case in the PR.
- The lock-file may leak on a host that pkill -9's authmux constantly.
  Mitigation: liveness probe by PID + 30s wall-clock heuristic in
  `registry-lock.ts`.

### Theme N2 — Split `account-service.ts`

**Goals.** Reduce the largest single file (1,663 LOC) to a thin
orchestrator (~150 LOC) so subsequent themes have a tractable seam.

**Exit criteria.**
- [ ] At least eight of the ten target modules listed in
      `01-ARCHITECTURE.md` §2.1 exist.
- [ ] `account-service.ts` is below 400 LOC.
- [ ] No public method signature on `AccountService` changes; the
      singleton in `src/lib/accounts/index.ts:19` still works.
- [ ] Each extracted module has at least one unit test.
- [ ] CI passes on Linux and macOS.

**Dependencies.** Should land after or alongside N1 so the new modules write
through the locked, atomic helpers from day one.

**Risks.**
- Extraction PRs touch a lot of lines and conflict-prone. Mitigation: one
  PR per cluster, merge weekly, do not stack.
- Behavior drift if a method's private state turns out to span clusters.
  Mitigation: snapshot tests (record-replay against a fake `~/.codex`) added
  before the first extraction.

### Theme N3 — Error taxonomy + `--json` parity for the five core commands

**Goals.** Make machine consumption of authmux output viable for
shell/CI integrators by stabilizing error codes and adding `--json`
to `list`, `current`, `status`, `use`, `save`.

**Exit criteria.**
- [ ] `AuthmuxError` class lands with `code`, `severity`, `hint`, `details`,
      and `toJSON()`.
- [ ] Every class in `src/lib/accounts/errors.ts` extends `AuthmuxError`
      with a stable code (see `01-ARCHITECTURE.md` §6.2 for the list).
- [ ] The five core commands accept `--json` and write a single JSON
      object to stdout.
- [ ] Exit codes follow the table in `01-ARCHITECTURE.md` §6.3.
- [ ] `src/tests/error-taxonomy.test.ts` enforces the code/severity table.

**Dependencies.** None.

**Risks.**
- Existing scripts may grep for the old human-readable messages. Mitigation:
  keep `message` text unchanged in this round; only add structured fields.

### Theme N4 — Drop eager `paths.ts` constants

**Goals.** Remove the import-time path resolution at
`src/lib/config/paths.ts:62-67` so env-var tweaks in tests and in daemon
units take effect.

**Exit criteria.**
- [ ] No file imports the bare constants (`codexDir`, `accountsDir`, etc.).
- [ ] The constants are marked `@deprecated` with a one-release removal note.
- [ ] A test under `src/tests/paths.test.ts` proves env-var changes apply
      after module load.

**Dependencies.** None. Should land before N5 so the new orchestrator factory
can swap paths cleanly.

**Risks.** Trivial.

## Next (1 – 3 months)

Posture: maintainer has nominated these; OpenSpec slugs may not yet exist;
each item must spawn one before code is written.

### Theme X1 — `createApp` factory + dependency injection

**Goals.** Replace the module-level `accountService` singleton with a
factory that takes injected ports (`fs`, `http`, `env`, `clock`), so unit
tests can run against in-memory fakes and parallel tests don't share state.

**Exit criteria.**
- [ ] `src/app/create-app.ts` exports `createApp({ fs, http, env, clock })`.
- [ ] `BaseCommand` resolves its `app` from a factory at first use.
- [ ] At least 30% of `account-service` tests run against an in-memory fake
      filesystem.
- [ ] The singleton is `@deprecated` and emits `process.emitWarning` on first
      call.

**Dependencies.** N2 (extraction) lowers the cost of this dramatically.

**Risks.**
- Hidden global state in `oclif` (e.g. its config) may force the factory to
  carry oclif `Config` too. Mitigation: keep the factory signature additive
  during the migration.

### Theme X2 — `usage.ts` split + proxy hardening

**Goals.** Land the four-file usage split from
`01-ARCHITECTURE.md` §2.2 and harden the proxy client against the localhost
TOTP/password flow that currently lives next to public-API calls.

**Exit criteria.**
- [ ] `src/lib/accounts/usage/` directory exists with `api-client.ts`,
      `proxy-client.ts`, `local-rollout.ts`, `math.ts`, `index.ts`.
- [ ] `usage.ts` is removed (or shrunk to a re-export shim).
- [ ] Proxy client refuses to send credentials over non-loopback URLs even
      when `CODEX_LB_DASHBOARD_*` env vars are set.
- [ ] `src/tests/usage-math.test.ts` covers `remainingPercent`,
      `usageScore`, `shouldSwitchCurrent` exhaustively.

**Dependencies.** N2 (so callers already import through a barrel).

**Risks.**
- Proxy users may depend on undocumented behavior. Mitigation: gate the
  non-loopback refusal behind `AUTHMUX_PROXY_INSECURE=1` for one minor.

### Theme X3 — Observability v1: structured logs + `authmux diag`

**Goals.** Land a single structured logger (JSON lines on stderr behind
`AUTHMUX_LOG=json`) and a new `authmux diag` command that produces a
shareable bundle (redacted).

**Exit criteria.**
- [ ] `src/infra/log/logger.ts` exports a `logger` with `info/warn/error/debug`
      methods, no transitive deps.
- [ ] Daemon evaluation cycles emit one structured event per cycle with a
      correlation id.
- [ ] `authmux diag` writes a `authmux-diag-<ts>.tgz` to the current dir
      containing: version, env table (filtered), `~/.codex/accounts/`
      listing (no contents), the last 200 log lines.
- [ ] Documented redaction list: never include `auth.json` or snapshot bytes.

**Dependencies.** N3 (`AuthmuxError.toJSON()` is reused by the logger).

**Risks.**
- Accidental secret leakage in `authmux diag`. Mitigation: explicit allowlist
  of env vars, with a unit test that fails if `OPENAI_API_KEY` or similar
  patterns leak.

### Theme X4 — `--json` parity for remaining commands

**Goals.** Extend the `--json` flag from N3's five commands to every command
that prints user-facing data (`config`, `daemon --once`, `forecast`,
`savings`, `hero`, `export`, `import`, `parallel --list`,
`kiro` without args).

**Exit criteria.**
- [ ] Every read command has `--json`.
- [ ] A snapshot test asserts every `--json` output is valid JSON for at
      least one fixture per command.
- [ ] `docs/future/02-COMMANDS.md` (when it lands) lists the JSON schema for
      each command.

**Dependencies.** N3.

**Risks.** Bounded; mostly a typing exercise.

### Theme X5 — Provider mirrors fold into `providers/`

**Goals.** Move `src/lib/kiro-mirror.ts` and `src/lib/hermes-mirror.ts` under
`src/providers/kiro/` and `src/providers/hermes/` and rewrite them against a
stable internal `ProviderAdapter` interface (still ahead of the public plug-in
contract).

**Exit criteria.**
- [ ] New directory layout exists.
- [ ] `use.ts` calls the adapters via the providers registry, not direct
      imports.
- [ ] The Codex flow is also adapter-shaped, even if it remains the default.
- [ ] No behavior change in any provider's CLI output.

**Dependencies.** N2 + X1.

**Risks.**
- Symlink semantics differ between Kiro (`switchKiroSnapshot`) and Codex
  (regular file). Mitigation: each adapter owns its own `activate` method;
  no shared "always copy" logic.

## Later (3 – 9 months)

Posture: documented direction; needs a sponsor to start. Each theme below
should produce its own OpenSpec change set under
`openspec/changes/<theme-slug>/` before code lands.

### Theme L1 — Provider plug-in SDK

**Goals.** Make `ProviderAdapter` a public contract so external packages can
ship their own provider integration without a fork.

**Exit criteria.**
- [ ] `src/lib/index.ts` exposes the stable `ProviderAdapter` types.
- [ ] `LIB_API_VERSION` exported and documented in `releases/lib-v1.md`.
- [ ] A reference external provider lives in
      `packages/authmux-provider-example/` and is published to npm.
- [ ] Plug-in discovery honors the three safety controls in
      `01-ARCHITECTURE.md` §8.4.
- [ ] `docs/future/03-PROVIDERS.md` covers the contract end-to-end.

**Dependencies.** X1, X5.

**Risks.**
- Supply-chain. A malicious provider exfiltrates `auth.json`. Mitigation:
  explicit allowlist + SHA-256 pinning + no auto-load by default.
- API stability. Mitigation: `LIB_API_VERSION` gates loading.

### Theme L2 — Optional OS-keychain backing for snapshots

**Goals.** Let users opt into storing snapshot contents in the OS keychain
(macOS Keychain, Windows Credential Manager, Linux Secret Service) with the
on-disk JSON file becoming a metadata-only reference.

**Exit criteria.**
- [ ] `authmux config storage keychain` flips a flag in `registry.json`.
- [ ] `saveAccount` writes to keychain when flag is on; falls back to JSON
      with a warning if keychain unavailable.
- [ ] `useAccount` reads from keychain transparently.
- [ ] Migration command `authmux storage migrate` moves existing snapshots.
- [ ] `docs/future/06-SECRETS-AND-STORAGE.md` documents the threat model
      and the trade-offs.

**Dependencies.** L1 indirectly (the storage subsystem is itself adapter-
shaped). N1 (atomic writes for the JSON metadata sidecar).

**Risks.**
- Linux Secret Service availability varies (gnome-keyring vs. kwallet vs.
  none). Mitigation: documented unsupported configs; never block features
  on keychain presence.
- Increased postinstall friction. Mitigation: opt-in only; no postinstall
  prompt.

### Theme L3 — TUI for `authmux use`

**Goals.** A keyboard-driven TUI for switching accounts, viewing live quota,
and triggering refreshes — implemented without adding heavy deps.

**Exit criteria.**
- [ ] `authmux tui` command exists.
- [ ] Renders the account list, current account, 5h/weekly windows, and last
      refresh time in a single panel.
- [ ] Arrow keys + Enter switch accounts; `r` refreshes; `q` quits.
- [ ] No dependency added beyond what the project already ships, except
      possibly a single small TUI library that has zero transitive deps.

**Dependencies.** X1 (DI), X3 (logger).

**Risks.**
- Terminal capability detection. Mitigation: fall back to plain `authmux
  list` if `process.stdout.isTTY` is false.

### Theme L4 — Telemetry-with-consent

**Goals.** A purely opt-in telemetry channel that helps the maintainer
prioritize provider work and catch regressions.

**Exit criteria.**
- [ ] `authmux config telemetry enable` / `disable` exist; default off.
- [ ] When enabled, sends only: authmux version, OS family, command name,
      success/failure flag, error code. Never sends account names, emails,
      paths, or any auth bytes.
- [ ] Local opt-in receipt in `~/.config/authmux/telemetry-consent.json`
      records the exact text shown to the user.
- [ ] Endpoint is owned by the project; PR template lists the data schema.
- [ ] `docs/future/16-COMPLIANCE-AND-LEGAL.md` documents the policy.

**Dependencies.** X3 (the event shape mirrors structured log fields).

**Risks.**
- User trust. Mitigation: default off, plain-English consent text, ability
  to inspect the buffered payload before send.

### Theme L5 — Team / shared-credential mode (v0)

**Goals.** Let a small team share a *named* pool of accounts via a shared
encrypted bundle, without inventing a server. Initial implementation backs
on a single repo / S3 bucket the team controls.

**Exit criteria.**
- [ ] `authmux team init` writes a `team.json` describing the backing
      store and the encryption mode.
- [ ] `authmux team push` / `authmux team pull` move snapshots through the
      configured backing store, encrypted with age (or equivalent).
- [ ] Per-snapshot owner field records who last logged in.
- [ ] A documented threat model spells out what an attacker with read access
      to the backing store can and cannot do.

**Dependencies.** L2 (storage subsystem must be adapter-shaped first).

**Risks.**
- ToS exposure for the upstream providers. Mitigation: documented warning
  that some providers prohibit account sharing; default behavior refuses to
  push snapshots whose plan label is enterprise.
- Encryption-key management. Mitigation: delegate to age; do not invent.

### Theme L6 — MCP server exposure

**Goals.** Expose authmux as a Model Context Protocol server so AI agents
can list, switch, and query quota without shelling out.

**Exit criteria.**
- [ ] `authmux mcp serve` runs an MCP server on stdio.
- [ ] Tools: `list_accounts`, `current_account`, `switch_account`,
      `account_quota`, `auto_switch_status`.
- [ ] No tool that writes auth bytes is exposed without explicit
      `AUTHMUX_MCP_ALLOW_WRITE=1`.
- [ ] Documented in `docs/future/03-PROVIDERS.md` cross-reference.

**Dependencies.** X1 (the MCP server constructs an `App` per session).

**Risks.**
- A misconfigured MCP host could let any prompt switch the active account
  silently. Mitigation: write tools off by default; logging on every call.

## Maybe (9+ months / research)

Posture: speculative. Do not start without explicit sign-off from the
maintainer. The point of listing them is so future agents do not propose
them again as "new ideas".

### Theme M1 — Browser-extension companion

**Goal.** A WebExtension that talks to a local authmux daemon over a
loopback UDS and can prefill provider account selectors in the browser.
**Why deferred.** UDS-from-browser is awkward; native messaging requires
per-browser packaging. Project bandwidth is the bottleneck.

### Theme M2 — GUI desktop app

**Goal.** Tauri or Electron desktop app wrapping the TUI feature set, plus
a system-tray icon for the active account.
**Why deferred.** Until the plug-in SDK (L1) and team mode (L5) stabilize,
a GUI commits the project to a much larger maintenance surface.

### Theme M3 — Automated quota negotiation

**Goal.** When all accounts in the pool are below threshold, automatically
queue work and pause until a window reset, rather than failing requests.
**Why deferred.** Requires deep integration with each provider's request
queue, which authmux explicitly does not touch today.

### Theme M4 — Cloud sync of snapshots

**Goal.** End-to-end encrypted sync of snapshots across personal devices.
**Why deferred.** Listed as a non-goal in `00-OVERVIEW.md` §"Explicit non-
goals". The threat model shift is large enough to warrant a separate
project rather than a feature of authmux.

### Theme M5 — Rewrite in Rust / Go

**Goal.** Single-binary distribution; faster cold start.
**Why deferred.** Today's perf bottlenecks are I/O, not CPU. Rewrite would
delay every L-tier theme by 6+ months for no user-visible win.

### Theme M6 — Web dashboard for team mode

**Goal.** Hosted web UI on top of L5.
**Why deferred.** Project stays self-hosted-only until at least 1.0.

## Release cadence

### Versioning

authmux currently ships under semantic versioning (`package.json:3` reads
`0.1.24`). Proposed cadence going forward:

- **Pre-1.0 (current).** Minor releases (`0.X.0`) every 4–6 weeks if there
  are user-facing changes; patch releases (`0.X.Y`) as needed for fixes.
  Breaking changes are allowed in minor releases but must be flagged in the
  release notes under "BREAKING" with a migration line.
- **1.0 and beyond.** Strict semver. Breaking changes only in major
  releases; minor adds capability; patch fixes regressions. The library
  surface (`src/lib/index.ts`) follows its own `LIB_API_VERSION` that
  changes only when the public contract changes (see
  `01-ARCHITECTURE.md` §7.3).
- **Calver considered, rejected.** Calver was considered for tracking
  release recency in CLI output. Rejected because the only signal that
  matters to users is "is there a newer one and what does it change", and
  the existing `update-notifier` hook already surfaces that. Adopting calver
  would force every dependency consumer to handle the format mismatch.

### LTS branches

No LTS branch before 1.0. After 1.0:

- `release/1.x` branch maintained for security fixes for 6 months after
  `2.0.0` ships.
- Backports of fixes only — never feature backports.
- Documented in the README under a small "Versions" section.

### Deprecation policy

- A feature or flag is `Marked` deprecated by emitting `process.emitWarning`
  on first use and adding a `@deprecated` JSDoc tag.
- Minimum dwell time in `Marked` before `Removed`: two minor releases or six
  months, whichever is longer.
- Every `Removed` line in a release note links to the original
  `Marked` line.
- The protocol document for the removed feature is **not** deleted; it
  gains a `Status: Removed in vX.Y.Z` header.

### Release-notes shape

Each release note in `releases/vX.Y.Z.md` must have the following sections
in this order, even if a section is empty:

1. `Added`
2. `Changed`
3. `Fixed`
4. `Deprecated`
5. `Removed`
6. `Security`
7. `Migration` (only when `Changed` or `Removed` is non-empty)

Existing notes (`releases/v0.1.6.md` through `v0.1.21.md`) predate this
shape and are not retroactively edited; the shape applies starting with
the first release after this protocol lands.

## Success metrics

The metrics below are the contract for "did this roadmap actually deliver".
Each is measurable from the codebase or from `authmux status --json` after
the relevant theme ships.

### Latency budgets

| Operation                          | Today (informal) | Budget after Now horizon | Budget after Next horizon |
| ---------------------------------- | ---------------- | ------------------------ | ------------------------- |
| `authmux current`                  | ~30 ms           | ≤ 50 ms p50, ≤ 120 ms p95 | ≤ 30 ms p50, ≤ 80 ms p95  |
| `authmux use <name>` (no Kiro)     | ~80 ms           | ≤ 120 ms p50, ≤ 250 ms p95| ≤ 80 ms p50, ≤ 180 ms p95 |
| `authmux list` (no usage refresh)  | ~60 ms           | ≤ 100 ms p50, ≤ 220 ms p95| ≤ 60 ms p50, ≤ 150 ms p95 |
| Account switch end-to-end (use + verify) | ~120 ms    | ≤ 200 ms p50, ≤ 400 ms p95| ≤ 120 ms p50, ≤ 300 ms p95|
| Daemon evaluation cycle (per-account, API mode) | ~250 ms | ≤ 400 ms p50            | ≤ 300 ms p50              |

"Today" numbers are informal maintainer measurements on a Linux laptop with
`~/.codex/accounts/` holding eight snapshots. Replace with measured numbers
when N1 lands (it adds an `fsync` that may move the floor).

### Memory budget

- Daemon `authmux daemon --watch` RSS at steady state: ≤ 80 MB.
- Per-cycle allocations: ≤ 5 MB churn (verify with `--inspect` heap
  snapshots before/after).
- Hard cap: a memory-leak alarm in CI if RSS grows by > 10 MB across
  100 cycles in a soak test.

### Test coverage targets

| Layer / package                                   | Target after Now | Target after Next |
| ------------------------------------------------- | ---------------- | ----------------- |
| `src/lib/accounts/*` (post-split)                 | 70% line         | 85% line          |
| `src/lib/config/*`                                | 80% line         | 90% line          |
| `src/app/*` (new orchestrators after X1)          | n/a              | 80% line          |
| `src/commands/*`                                  | 40% line         | 60% line          |
| `src/infra/*` (new after N1)                      | n/a              | 75% line          |

Coverage is measured with `c8` against the compiled `dist/`, the same way
`node --test dist/tests/**/*.test.js` is run today.

### Reliability metrics

- Zero data-loss bugs in `registry.json` reported after N1. Tracked by
  triage label `data-loss`.
- Zero "clobbered snapshot" reports after the materialize-symlink race is
  closed (current backup-vault recovery becomes a defensive log-only path).
- 99% of daemon cycles complete without error in a 24h soak test on Linux
  and macOS.

### Adoption / ecosystem (post-1.0)

- At least one external `authmux-provider-*` package on npm (signal that L1
  has actual users).
- At least three release-notes lines per quarter referencing community PRs.
- README "supported providers" list grows by ≥ 1 per quarter on average.

## Cross-references

Each theme above is exhaustively documented elsewhere in the protocol:

| Roadmap theme | Detailed treatment                                              |
| ------------- | ---------------------------------------------------------------- |
| N1            | `01-ARCHITECTURE.md` §5; `07-CONCURRENCY-AND-LOCKING.md` (planned) |
| N2            | `01-ARCHITECTURE.md` §2.1                                        |
| N3, X4        | `01-ARCHITECTURE.md` §6; `10-ERROR-MODEL.md` (planned); `12-CLI-UX.md` (planned) |
| N4            | `01-ARCHITECTURE.md` §10.2; `11-CONFIGURATION.md` (planned)      |
| X1            | `01-ARCHITECTURE.md` §10.1                                       |
| X2            | `01-ARCHITECTURE.md` §2.2; `04-USAGE-AND-QUOTA.md` (planned)     |
| X3            | `09-OBSERVABILITY.md` (planned)                                  |
| X5, L1        | `01-ARCHITECTURE.md` §8; `03-PROVIDERS.md` (planned)             |
| L2            | `06-SECRETS-AND-STORAGE.md` (planned)                            |
| L3            | `12-CLI-UX.md` (planned)                                         |
| L4            | `09-OBSERVABILITY.md` (planned); `16-COMPLIANCE-AND-LEGAL.md` (planned) |
| L5            | `03-PROVIDERS.md` (planned); `06-SECRETS-AND-STORAGE.md` (planned) |
| L6            | `02-COMMANDS.md` (planned); `03-PROVIDERS.md` (planned)          |
| M*            | This file only; do not write detail until promoted.              |

## How to use this roadmap

1. **As a contributor picking a task.** Start at the top of Now. If every
   item there has an owner, drop to Next. Open an OpenSpec change for the
   theme before writing code, link the change in the theme's exit-criteria
   list, then work the boxes top-to-bottom.
2. **As a reviewer.** When a PR claims to advance a theme, check that the
   PR's description ticks the right boxes here. Reject PRs that ship a
   theme item without updating this file in the same PR.
3. **As an AI agent under Guardex.** Treat the Now horizon as the only
   list you may auto-suggest work on. Anything in Next, Later, or Maybe
   requires explicit user direction.
4. **At release time.** Before tagging vX.Y.Z, sweep this file: every
   checked box added in the release window must show up in the release
   note under the right section.

The roadmap is a contract, not a wish-list. If you cannot defend an item's
position in the right horizon with the evidence already in this protocol,
the item does not belong here yet.
