# 15 — Performance and Scalability

## Why perf matters here

`authmux` is not a server. It is a CLI binary that the developer types or that
an upstream wrapper invokes. Every command-line invocation is a fresh Node
process: `oclif` boots, the registry JSON is parsed, the active snapshot may be
materialized, and only then does the command body run. Whatever cost we add to
that path, the user pays in full on every `authmux current`, every `authmux
list`, and every silent `codex` wrapper that calls `authmux use` before
launching the real binary.

A CLI is judged on **felt latency**, not throughput. There is no warm JIT, no
connection pool, no in-memory cache between invocations. We get one chance per
invocation to be fast.

The cost is multiplied in three concrete ways that already exist in this
codebase today:

1. **Shell-hook wrapping.** The `codex()` shell function installed by
   `scripts/postinstall-login-hook.cjs` and `src/lib/config/login-hook.ts:31`
   re-enters `authmux` before forwarding to the real `codex` binary. Any slow
   path in our init runs once per `codex` invocation in addition to once per
   direct `authmux` invocation. A 200ms cold start the user could shrug off on
   `authmux list` becomes a 200ms tax on every `codex` chat.
2. **The init hook (`src/hooks/init/update-notifier.ts`) runs before *any*
   command.** It currently calls `fetchLatestNpmVersionCached` with a 900ms
   timeout (`src/hooks/init/update-notifier.ts:23-26`). Even when cached, the
   hook ships in the hot path.
3. **The daemon (`authmux daemon --watch`) loops every 30 seconds** (see
   `src/commands/daemon.ts:9`). Every per-tick inefficiency multiplies by 2,880
   per day per host. On a workstation that already runs a dozen background
   tools, the daemon is judged on RSS and CPU per tick, not just correctness.

The same code paths sit on three very different latency budgets at the same
time. This document picks budgets that hold for all three and proposes the
specific refactors that get us there.

## Current hotspots

These are hypothesized hotspots, line-cited where evidence is concrete. They
have **not yet** been confirmed by a profiler; "Cold-start audit" below is the
follow-up that turns hypothesis into measurement before we land any of the
proposals here.

### H1 — oclif cold start + transitive deps

- **Evidence**: `src/index.ts` is six lines and imports `@oclif/core` directly.
  `oclif` walks `./dist/commands` at boot to discover commands. With 26
  commands in `src/commands/` (see `00-OVERVIEW.md`), discovery has to load
  manifests or fall back to scanning compiled files.
- **Diagnosis**: even with `oclif` v3's lazy-load story, the *discovery* phase
  is not free, and the `prompts` library plus our own modules are pulled in by
  the first imported command. There is no `oclif.manifest.json` shipped in
  `package.json#files` (`package.json:21-26` lists only `dist`, the
  postinstall script, README, LICENSE), so oclif rebuilds its picture each run.
- **Cost surface**: every invocation pays the discovery cost; commands that
  share imports do not benefit from a warm process.

### H2 — JSON registry parse on every command

- **Evidence**: `src/lib/accounts/registry.ts:137-146` calls
  `fsp.readFile(registryPath, "utf8")` then `JSON.parse` then
  `sanitizeRegistry` on every `loadRegistry()` call. There is no in-memory
  memo and no cross-invocation cache.
- **Diagnosis**: at small N the parse is negligible (<1ms for 10 accounts).
  The hidden cost is that several call sites can each call `loadRegistry()`
  inside one command — see `AccountService` flow in
  `src/lib/accounts/account-service.ts` (status, getCurrentAccountName,
  listAccountMappings all touch the registry). One command, multiple parses,
  same bytes.
- **Cost surface**: linear in the number of registry reads per command, and
  the linear factor is in the same process where we have no excuse for
  re-reading.

### H3 — Synchronous fs reads on activation paths

- **Evidence**: `src/lib/accounts/account-service.ts:1` imports both
  `node:fs` (sync) and `node:fs/promises`. Mixed sync/async use in the same
  file is the canonical smell for hidden `fs.readFileSync` on hot paths.
- **Diagnosis**: any sync FS call inside a Promise chain stalls the event
  loop and prevents the runtime from interleaving the npm registry HTTP fetch
  in the init hook with the account-service warmup.
- **Cost surface**: invisible until the registry, the auth file, and the
  remote npm check race in the init hook.

### H4 — Sequential per-account work in `usage.ts`

- **Evidence**: `src/lib/accounts/usage.ts:571-660` iterates
  rollout files one by one (`for (const filePath of files)` at line 652),
  reading and parsing each in turn with `await fsp.readFile`.
- **Diagnosis**: at 10 accounts this is bounded. At 50, the wall-clock cost
  becomes `O(accounts * average_rollout_files * avg_file_kb)` because each
  rollout file parse is also sequential lines of `JSON.parse`. The proxy
  branch (`fetchUsageFromProxy`, `usage.ts:440-485`) is also single-shot
  serial.
- **Cost surface**: `authmux list --details` and the daemon tick.

### H5 — Re-rendering `list` formatting without cache

- **Evidence**: `src/commands/list.ts:32-63` calls
  `this.accounts.listAccountMappings({ refreshUsage: "missing" })` then
  string-builds every line. There is no precomputed table cached on disk.
  Even when the registry has not changed, every `authmux list` re-derives the
  same rows.
- **Diagnosis**: refresh="missing" only refetches when a snapshot lacks
  usage. That is correct for freshness but does not help layout cost. The
  list command also calls `maybeOfferGlobalUpdate` (`list.ts:74-112`), which
  reaches out to npm with a 900ms timeout.
- **Cost surface**: interactive `authmux list` for users who run it often.

### H6 — Update-notifier hook on every invocation

- **Evidence**: `src/hooks/init/update-notifier.ts:14-27` runs an init hook
  unconditionally and short-circuits only on three checks
  (`options.id`, `options.argv.length > 0`, TTY). For bare-invocation users
  (those who type `authmux<Enter>` to see the hero screen), the hook always
  runs and always issues a 900ms-timeout HTTP request via
  `fetchLatestNpmVersionCached`.
- **Diagnosis**: even with caching, the hook is the *only* code path between
  process spawn and command execution. A miss costs up to 900ms. A network
  blip during a flaky coffee-shop wifi session adds latency to a tool whose
  job is to switch credentials.
- **Cost surface**: bare invocation; interactive lists; new-shell hero
  prompt.

## Budgets

The budgets below are wall-clock targets on a 2023-class developer laptop
(M2 / Ryzen 7, NVMe SSD, warm filesystem cache) running Node 18. They are
intentionally aggressive — we are a CLI, and the user is watching.

| Command                          | p50    | p95    | Conditions                              |
| -------------------------------- | ------ | ------ | --------------------------------------- |
| `authmux --help`                 | < 80ms | < 150ms | Warm cache, no network                 |
| `authmux current`                | < 40ms | < 80ms  | Registry exists, ≤ 10 accounts         |
| `authmux use <name>`             | < 120ms| < 200ms | No Kiro mirror, no network             |
| `authmux list` (10 accounts)     | < 100ms| < 180ms | Hot cache, refreshUsage="missing"      |
| `authmux list --details` (10 ac.)| < 150ms| < 250ms | Hot cache, refreshUsage="missing"      |
| `authmux daemon` tick            | < 250ms| < 500ms | CPU per account refresh in `--watch`   |
| Daemon RSS at idle               | < 60MB | < 80MB  | Steady-state, after one tick           |
| Init-hook overhead               | < 5ms  | < 20ms  | When update-check cache is fresh       |
| Init-hook overhead (miss)        | < 50ms | < 100ms | When update-check cache is stale       |

Two budget items deserve their own discussion:

- **Init-hook overhead under cache hit (< 5ms p50).** This is only achievable
  if the hook *does not* await the npm registry on the hot path. See
  proposal P-15.6 below.
- **Daemon RSS idle (< 60MB).** Node 18 baseline is around 30-40MB. The
  remaining headroom must include the registry parse plus one usage index,
  not a held-open `oclif` Config object.

## Proposals

Each proposal carries a priority and effort tag. The tags follow
`00-OVERVIEW.md` conventions.

### P-15.1 Lazy-load command modules — `P1 / M`

**Evidence.** With 26 commands under `src/commands/`, oclif's default
discovery loads every command's metadata on boot, and any top-level imports
those files make are paid even when the user only ran `authmux current`.

**Diagnosis.** oclif v3 supports lazy command loading via the `oclif.manifest`
generated by `oclif manifest`. The manifest stores per-command flags, args,
and descriptions so oclif can show help without loading the module. The
module itself is required only when the matched command runs.

**Proposal.**

1. Add `oclif manifest` (provided by `@oclif/core`) to the build pipeline as
   a post-`tsc` step.
2. Add `dist/oclif.manifest.json` to `package.json#files`
   (`package.json:21-26`).
3. Verify that no top-level side-effect import in a command file pulls in
   `account-service.ts` or `usage.ts` (those should sit behind `BaseCommand`
   property access, not module-scope `import`s).

**Migration.**
- `npm run build` becomes `tsc -p tsconfig.json && oclif manifest`.
- Add CI assertion: `dist/oclif.manifest.json` is non-empty and contains all
  26 command IDs.

**Rollout.** Ship behind no flag; the manifest is purely additive. Verify
with `time authmux --help` before / after on a clean Node process.

### P-15.2 Memoize the registry within and across invocations — `P1 / M`

**Evidence.** `loadRegistry()` reads, parses, and sanitizes on every call
(`registry.ts:137-146`). `AccountService` instances can re-read it many
times per command.

**Diagnosis.** Two layers of caching are missing: in-process memo, and
cross-process disk cache keyed on the registry's mtime.

**Proposal.**

1. Add a process-level `registryCache: { mtimeMs: number; data: RegistryData } | null`
   on `AccountService`. The first `loadRegistry()` call populates it; later
   calls in the same process reuse the parsed object if the file's
   `mtimeMs` has not changed.
2. Persist a cross-invocation cache under
   `${XDG_CACHE_HOME:-$HOME/.cache}/authmux/registry.cache.json` with the
   schema:
   ```json
   { "version": 1, "registryMtimeMs": 1700000000000, "data": { ... } }
   ```
   On startup, compare against `stat(registryPath).mtimeMs`. If equal, skip
   the full read of the source registry and use the cache. If not equal,
   read the source and rewrite the cache.
3. Invalidate the cache whenever `saveRegistry()` is called — write the
   updated cache in the same `await` block, so we never observe a stale
   `mtimeMs` mismatch on the next invocation.

**Migration.**
- Add a one-time migration that simply deletes the cache file on first run
  after upgrade.
- Document the cache path in `11-CONFIGURATION.md`.
- Honor `CODEX_AUTH_CACHE_DIR` as an override.

**Rollout.** Ship in a minor; no breaking change. Document with a single
release note: "registry reads are now memoized and disk-cached".

### P-15.3 Async-first FS API with a single fan-out — `P2 / S`

**Evidence.** Mixed sync/async imports in `account-service.ts:1-3`.

**Diagnosis.** Sync FS calls block the event loop and prevent overlap of
independent reads. For account-level work that touches N snapshot files,
the right pattern is one `Promise.all` over `fsp.readFile`.

**Proposal.**

1. Remove the `import fs from "node:fs"` line and replace any remaining sync
   call sites with `fsp` equivalents.
2. Introduce a small helper `readAllAccountSnapshots(accountNames: string[])`
   that fans out via `Promise.all`.
3. Use `node:fs/promises` `readFile` with `{ encoding: "utf8" }` only — do
   not pass `Buffer` if a string is needed immediately, to avoid the
   intermediate buffer.

**Migration.** Internal refactor; covered by existing tests in
`src/tests/save-account-safety.test.ts`. Verify `node --test dist/tests`
passes before merge.

**Rollout.** Internal-only; no release-note copy needed beyond a one-liner.

### P-15.4 Concurrency cap for usage refresh — `P1 / S`

**Evidence.** `LIST_USAGE_REFRESH_CONCURRENCY = 6` is already defined in
`account-service.ts:57` but is not visibly enforced via a semaphore in
`usage.ts`. The proxy path and the local rollout path are both single-shot
serial.

**Diagnosis.** When you fan out to 10 accounts × ~5 rollout files, an
uncapped `Promise.all` can spike file-handle usage and put pressure on the
upstream usage endpoint when the API path is used. A bounded semaphore caps
both.

**Proposal.**

1. Add a tiny inline `pLimit(concurrency)` helper (do not pull in `p-limit`
   for one function unless the dev-dep cost is justified — current deps in
   `package.json:50-55` are: `@oclif/core`, `prompts`, `tslib`, `typescript`).
2. Apply the limit at the call site that fans out per-account usage refresh.
3. Make the limit configurable via `AUTHMUX_USAGE_REFRESH_CONCURRENCY` env
   var, defaulting to the existing `6`.

**Migration.** Internal; ship with a release note "usage refresh now caps
parallelism at 6 by default".

**Rollout.** Track p95 of `authmux list --details` before / after on a
fixture with 10 accounts.

### P-15.5 Pre-rendered list cache invalidated on registry mtime — `P2 / M`

**Evidence.** `list.ts:32-63` re-derives the formatted rows on every call.

**Diagnosis.** The output of `authmux list` is a pure function of the
registry plus the active pointer plus the cached usage snapshots. We can
write the rendered ASCII to
`${XDG_CACHE_HOME}/authmux/list.cache.txt` keyed by the same mtime as the
registry cache, and short-circuit when the cache is valid.

**Proposal.**

1. After rendering, write the rendered lines plus a header
   `# registry-mtime: <ms>` to the cache file.
2. On the next `authmux list` (no flags), if the registry mtime matches and
   `flags.details` is `false`, print the cached file verbatim and exit.
3. Always bypass the cache when `--details` is set, when `--json` is set
   (future flag, see `12-CLI-UX.md`), or when an unknown flag is passed.

**Migration.** Behind a quiet feature flag for one minor; default on once
test coverage confirms no stale output.

**Rollout.** Track wall-clock on the cached path; budget < 30ms p50.

### P-15.6 Move update-check off the hot path — `P0 / M`

**Evidence.** `src/hooks/init/update-notifier.ts:23-26` calls
`fetchLatestNpmVersionCached` with `timeoutMs: 900` synchronously inside the
init hook. The `list.ts:74-112` `maybeOfferGlobalUpdate` repeats the pattern
inside a command body.

**Diagnosis.** A CLI should never block on a network round-trip before the
user's command body has had a chance to start. Even the cached path involves
a file read and version-compare; the miss path can be ~1s.

**Proposal.**

1. Refactor `fetchLatestNpmVersionCached` so the *read* of the cached value
   is synchronous (cache file read at startup), and the *refresh* of the
   cache is a fire-and-forget background process spawned via
   `child_process.spawn("node", [updateCheckerScript])` with `detached: true`
   and `stdio: "ignore"`. The background process writes
   `${XDG_CACHE_HOME}/authmux/latest-version.json` and exits.
2. The init hook reads `latest-version.json` instantly (one
   `fs.readFileSync` of ~50 bytes), compares versions, and only prompts when
   there is an upgrade.
3. If the cache is older than 24h *and* the user is on a TTY, spawn the
   background updater. Never await it.

**Migration.**
- Add `dist/update-check-worker.js` to `package.json#files`.
- Document `AUTHMUX_DISABLE_UPDATE_CHECK=1` to fully opt out.

**Rollout.** Track init-hook p95 latency by parsing a hidden env trace
`AUTHMUX_TRACE=1` that writes timings to stderr. Budget set above.

### P-15.7 Cold-start audit recipe — `P1 / S`

The proposals above are hypotheses. Before flipping any defaults we should
*measure*. Add to the repo (under `docs/perf/cold-start.md`, when 16's docs
plan lands):

```sh
# Profile a cold start of `authmux --help`
node --cpu-prof --cpu-prof-dir=./perf ./dist/index.js --help

# Inspect with Chrome DevTools' "Performance" panel (Load profile…).
# Pay attention to:
#   - oclif config load
#   - require() of './commands/index.js' children
#   - first reach into account-service.ts
```

Track results in `docs/perf/baseline.md` and update on any release that
touches a hot-path file.

### P-15.8 Optional Bun runtime — `P3 / L`

Bun's startup is consistently sub-30ms because it skips the V8 bootstrap
overhead. We do not depend on Node-specific APIs beyond `node:fs/promises`,
`node:child_process`, `node:readline/promises`, and `node:path`. All of
those are supported by Bun.

**Proposal.** Feature-detect Bun (`typeof Bun !== "undefined"`) in
`src/index.ts` and document the optional install path
`bun install -g authmux`. Do not require Bun. Do not block on it.

**Migration.** Add a smoke test in CI that runs `bun ./dist/index.js
--help`. Treat failure as informational only until Bun reaches feature
parity for our test set.

**Rollout.** Speculative; tag `P3` until there is user demand evidenced in
an issue.

## Scalability ceilings

The system today is designed for "a handful of accounts on a workstation".
It is worth being honest about where that breaks.

### 10–50 accounts (today)

- Registry JSON: < 50KB, parses in < 5ms.
- Listing: dominated by usage refresh, not by registry parse.
- Daemon: one tick per 30s, well within budget.

### 100 accounts

- Registry JSON: ~100-200KB. Still fine. Parse ~10-20ms.
- Listing: `Promise.all`-fan-out of 100 file reads strains default file
  handle limits on macOS (256 by default). The P-15.4 cap to 6 saves us.
- Daemon: per-tick CPU goes from negligible to noticeable on a quiet
  machine; budget breached if usage refresh is unbounded.

### 1,000 accounts

- Registry JSON: ~1MB. Parse 50-100ms per invocation. Now within the budget
  for `authmux current` (40ms) only if memoized. This is where
  **registry sharding** becomes interesting:
  - Option A: split into one JSON per account under
    `~/.codex/accounts/registry.d/<name>.json`, plus a small `index.json`
    that lists names and active pointer. Reads become O(1) for "current",
    O(N) only for "list".
  - Option B: keep one file but switch to streaming JSON parse for the
    accounts map (`JSONStream` or hand-rolled), so we never hold the full
    parsed object in memory.
- Daemon: candidate for SQLite if we want fast secondary indexes
  (per-plan-type filters, "accounts with usage > X%").

### 10,000 accounts

- JSON is the wrong format. Switch to SQLite via `better-sqlite3` if the use
  case ever exists. This is also the threshold where a TUI variant of
  `authmux list` (`12-CLI-UX.md`) becomes mandatory — a `printf` of 10k rows
  is unusable.
- Proposed migration trigger: **when any user reports > 1,000 accounts in
  their registry, open an OpenSpec change to plan the SQLite migration.**
  Until then, leave the JSON code alone — premature DB migration adds an
  install dependency for zero current value.

### Memory ceiling

- Cap the in-memory registry to 32MB. Above that, refuse to load and log a
  clear error: `E_REGISTRY_TOO_LARGE` (`10-ERROR-MODEL.md`).
- Cap the in-memory proxy index (`ProxyUsageIndex` in `usage.ts:34-38`) to
  the same 32MB. Today three `Map`s grow without bound.

## Memory

The daemon path is the only long-lived process. Three rules apply.

1. **Close file handles eagerly.** Every `fsp.readFile` returns and closes.
   Avoid building a long-lived `fs.createReadStream` unless we explicitly
   need streaming, because each open handle is a kernel resource.
2. **Drop large strings after parse.** After `JSON.parse(raw)`, the `raw`
   string is still reachable until the function returns. For large registry
   files, set `raw = ""` (or scope it inside `{}`) so V8 can collect it
   while the parsed object is still in use.
3. **Do not retain the full registry between daemon ticks.** Each tick is a
   fresh `loadRegistry()` (or memo hit). Hold no references to the parsed
   object across `setTimeout` boundaries — that defeats the GC.

In `account-service.ts` there is already a precedent of caching session
state per process. Extend that pattern explicitly to the registry parse so
the daemon's per-tick allocation is bounded.

## Benchmarks

Without benchmarks, every "perf fix" is hand-waving. Propose:

### `npm run bench`

Use `mitata` or `tinybench` as a dev dependency. Fixtures live under
`bench/fixtures/`:

```
bench/
  fixtures/
    registry.small.json     # 10 accounts
    registry.medium.json    # 100 accounts
    registry.large.json     # 1000 accounts
    rollouts.small/         # 5 rollout files
    rollouts.large/         # 50 rollout files
  cold-start.bench.ts
  load-registry.bench.ts
  list-render.bench.ts
  usage-refresh.bench.ts
```

A single command should be runnable in CI on PRs that touch any of:
- `src/lib/accounts/account-service.ts`
- `src/lib/accounts/registry.ts`
- `src/lib/accounts/usage.ts`
- `src/commands/list.ts`
- `src/commands/use.ts`
- `src/commands/daemon.ts`
- `src/hooks/init/update-notifier.ts`

CI should fail if any of the budgets above is breached by > 25% relative to
the baseline stored in `bench/baseline.json`.

### Continuous tracking

Store benchmark output as a checked-in `bench/results/<commit-sha>.json`
artifact so regressions can be bisected. This costs ~1KB per commit and is
cheap.

## Done criteria

A perf improvement is "done" only when:

1. The proposal block exists in this document with priority + effort tags.
2. The before/after numbers are captured in `bench/results/`.
3. The release notes for the version that ships it call out the budget item
   and the measured improvement.
4. A regression test exists in `bench/` for the specific scenario.

Anything less ships as "we hope it's faster", which is not a category of
work this project should accept.
