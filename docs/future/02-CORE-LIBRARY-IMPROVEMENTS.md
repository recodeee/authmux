# 02 — Core Library Improvements

Scope: every file under `src/lib/` that is **not** inside `src/lib/accounts/` or `src/lib/config/`. Concretely:

- `src/lib/base-command.ts`
- `src/lib/kiro-mirror.ts`
- `src/lib/account-savings.ts`
- `src/lib/usage-refresh.ts`
- `src/lib/update-check.ts`
- `src/lib/hermes-mirror.ts`
- `src/lib/account-health.ts`

The companion file `01-ACCOUNTS-AND-CONFIG-IMPROVEMENTS.md` covers `src/lib/accounts/` and `src/lib/config/`. The companion file `03-COMMANDS-IMPROVEMENTS.md` covers `src/commands/`.

Each section below uses the structure:

1. Current responsibilities (with line refs).
2. Concrete issues (Evidence).
3. Refactor proposal (Diagnosis + Proposal).
4. API sketch.
5. Testing strategy.
6. Migration steps.
7. Risk and rollback.
8. Priority and effort tags.

Tags:

- Priority: `P0` (blocker / correctness), `P1` (next release), `P2` (within quarter), `P3` (nice to have).
- Effort: `S` (≤1 day), `M` (2–4 days), `L` (1–2 weeks), `XL` (>2 weeks).

---

## src/lib/base-command.ts

### Current responsibilities

A thin abstract class extending oclif's `Command` (`src/lib/base-command.ts:4`). It:

- Holds a shared `accountService` singleton (`src/lib/base-command.ts:5`).
- Exposes a `runSafe(action)` wrapper that optionally calls `accounts.syncExternalAuthSnapshotIfNeeded()` before delegating to the supplied callback (`src/lib/base-command.ts:8-17`).
- Maps `CodexAuthError` instances onto oclif's `this.error()`, re-throws everything else (`src/lib/base-command.ts:19-25`).

This is the only shared command-level abstraction in the codebase. Almost every command in `src/commands/` either extends it or — in five "legacy" cases (`auto-switch.ts`, `check.ts`, `clean.ts`, `export.ts`, `forecast.ts`, `hero.ts`, `import.ts`, `kiro.ts`, `kiro-login.ts`, `parallel.ts`, `savings.ts`) — extends oclif's `Command` directly and therefore opts out of the shared error handling and the external-auth sync hook.

### Concrete issues

**Evidence:**

- `handleError` (`src/lib/base-command.ts:19-25`) only recognises one error type (`CodexAuthError`). Every other custom error in `src/lib/accounts/index.ts` (`NoAccountsSavedError`, `PromptCancelledError`, `AccountNotFoundError`, `InvalidRemoveSelectionError`) reaches it as a plain `Error`, then re-throws, then oclif prints a stack trace with `Error:` prefix instead of the message.
- The pre-action sync (`syncExternalAuthSnapshotIfNeeded`) runs unconditionally for any subclass that does not flip `syncExternalAuthBeforeRun = false`. Every legacy command (e.g. `src/commands/auto-switch.ts:6`) extends `Command` directly and therefore silently skips this hook even when the side-effect is desired (e.g. `auto-switch` reads account names and absolutely needs registry to be in sync).
- The `runSafe` wrapper allocates a Promise per command even when the inner action would be synchronous, and silently swallows the return value of the action (forcing every command to `this.log` instead of returning structured data).
- There is no `--quiet`, `--json`, or `--config-dir` flag inheritance. Commands have to re-declare these flags individually (currently they don't, see Section 03 cross-command notes).
- The class is not exported from a barrel (`src/lib/index.ts` does not exist), so command files have to import `../lib/base-command` and `../lib/accounts` separately, creating import-path drift (`.js` vs no `.js`, e.g. `src/commands/switch.ts:3` uses `.js` extensions while `src/commands/login.ts:3` does not).
- `accountService` is a module-level singleton imported from `./accounts` (`src/lib/base-command.ts:2`) — there is no DI seam for tests; tests for commands cannot inject a fake service without monkey-patching the import (see `src/tests/save-account-safety.test.ts`).

**Diagnosis:** `BaseCommand` is doing two unrelated jobs (DI of `accountService` and error normalisation) and doing both weakly. The error path lets non-`CodexAuthError` errors bubble as stack traces, the DI path is a hard singleton, and the pre-run side effect is implicit. Subclasses also have inconsistent opt-out patterns (`syncExternalAuthBeforeRun` is a public field, not a static config, so it can only be overridden at the instance level which is awkward with oclif's static-flag model).

### Refactor proposal

Split into:

1. `BaseCommand` — purely error normalisation + structured output (`--json`, `--quiet`, exit-code mapping).
2. `AccountCommand extends BaseCommand` — opt-in mixin that exposes `this.accounts` and runs `syncExternalAuthSnapshotIfNeeded()` by default. Legacy commands that touch accounts should migrate to this class.
3. `Services` container — replace the module-level singleton with a small factory `createServices({ configDir })` so tests can construct an isolated service with a temp config dir without env mutation.

Move the error-to-exit-code mapping into a typed table (`ErrorCode`) so that the registry of recoverable errors is explicit and tests can assert the mapping (Section 03 covers the command-facing aspects).

### API sketch

```ts
// src/lib/base-command.ts
import { Command, Flags } from "@oclif/core";
import { Services, createServices } from "./services";

export interface CommandOutput<T = unknown> {
  ok: boolean;
  data?: T;
  message?: string;
  errorCode?: ErrorCode;
}

export type ErrorCode =
  | "no-accounts-saved"
  | "account-not-found"
  | "prompt-cancelled"
  | "auth-snapshot-missing"
  | "auth-snapshot-invalid"
  | "invalid-remove-selection"
  | "external-tool-missing"
  | "config-write-failed"
  | "network-unavailable"
  | "internal";

export abstract class BaseCommand<T = void> extends Command {
  static baseFlags = {
    json: Flags.boolean({ description: "Emit machine-readable JSON" }),
    quiet: Flags.boolean({ char: "q", description: "Suppress non-error output" }),
  };

  protected abstract execute(): Promise<CommandOutput<T>>;

  async run(): Promise<void> {
    try {
      const result = await this.execute();
      this.emit(result);
      if (!result.ok) this.exit(this.exitCodeFor(result.errorCode));
    } catch (err) {
      const normalised = this.normaliseError(err);
      this.emit(normalised);
      this.exit(this.exitCodeFor(normalised.errorCode));
    }
  }

  protected emit(out: CommandOutput<T>): void { /* json vs human */ }
  protected normaliseError(err: unknown): CommandOutput<T> { /* table lookup */ }
  protected exitCodeFor(code?: ErrorCode): number { /* table lookup */ }
}

export abstract class AccountCommand<T = void> extends BaseCommand<T> {
  protected readonly services: Services = createServices();
  protected readonly autoSyncExternalAuth: boolean = true;

  async run(): Promise<void> {
    if (this.autoSyncExternalAuth) {
      await this.services.accounts.syncExternalAuthSnapshotIfNeeded();
    }
    await super.run();
  }
}
```

### Testing strategy

- Unit tests for `normaliseError`: assert every public error class in `src/lib/accounts/errors.ts` maps to the right `ErrorCode` and human message.
- Unit tests for `exitCodeFor`: assert the canonical exit-code map (e.g. `prompt-cancelled` → `130`, `no-accounts-saved` → `2`, `internal` → `1`).
- Unit tests for `emit`: snapshot one example each of human-mode and JSON-mode output.
- Fake `Services` via a `createServicesForTest({ accountsDir, registryPath })` helper that wires an in-memory or temp-dir backing store, used by every command test.
- Edge cases: unknown error class, `Error` without `.message`, error with circular reference (must still JSON-serialise), `process.exitCode` already set.

### Migration steps

1. Add `Services` factory in `src/lib/services.ts`, re-exporting the existing `accountService` instance behind it (no behaviour change yet).
2. Introduce the new `BaseCommand`/`AccountCommand` split alongside the current class. Keep the old class re-exported as `BaseCommand` for one release.
3. Migrate `BaseCommand` subclasses one command at a time, adding `--json` + `--quiet` per Section 03.
4. Migrate the legacy `Command`-extending commands (`auto-switch`, `check`, `clean`, `export`, `forecast`, `import`, `kiro`, `kiro-login`, `parallel`, `savings`) to `AccountCommand` so they pick up shared error normalisation. Each migration is its own PR.
5. Once all consumers are migrated, delete the legacy class.

Backward compatibility: the public export shape (`BaseCommand`) is preserved. The `syncExternalAuthBeforeRun` instance field can be deprecated as a setter that maps to `autoSyncExternalAuth` for one release, then dropped.

### Risk and rollback

Risk: misclassifying an error in `normaliseError` would mask a real bug behind a user-friendly message. Mitigation: keep an `internal` bucket that always exits non-zero and includes `--debug`-gated stack traces.

Rollback: each migrated command is independent, so reverting a single command back to the old base class is a small revert. The `Services` factory is a pure additive change.

**Priority:** P1. **Effort:** M.

---

## src/lib/kiro-mirror.ts

### Current responsibilities

Wraps the on-disk layout used by `kiro-cli` (`~/.local/share/kiro-cli/data.sqlite3`) plus an authmux-owned active marker (`~/.local/share/kiro-account-switcher/active`). It exposes:

- `listKiroSnapshots()` — `src/lib/kiro-mirror.ts:20-27`.
- `hasKiroSnapshot(name)` — `src/lib/kiro-mirror.ts:29-32`.
- `getActiveKiroSnapshot()` — `src/lib/kiro-mirror.ts:34-51`.
- `switchKiroSnapshot(name)` — `src/lib/kiro-mirror.ts:53-108`.

`switchKiroSnapshot` is the only mutating function. It refuses to clobber an unmanaged real database, removes the existing symlink, creates a new symlink, then writes the active marker.

### Concrete issues

**Evidence:**

- All filesystem operations are synchronous (`fs.existsSync`, `fs.readdirSync`, `fs.symlinkSync`, `fs.writeFileSync`) on what is otherwise an async control-flow path. Commands (e.g. `src/commands/use.ts:48`, `src/commands/switch.ts:117`) call `switchKiroSnapshot` from inside async actions; the sync calls block the event loop.
- `getActiveKiroSnapshot` reads `KIRO_ACTIVE_FILE` and then falls back to the symlink readlink. The two sources can disagree (active file says `foo`, symlink points at `bar.sqlite3`); the function silently prefers the file, which is wrong because the symlink is the canonical state.
- The symlink fallback at `src/lib/kiro-mirror.ts:42-50` returns `undefined` if the file exists but is not a symlink. Callers (e.g. `kiro.ts`) cannot distinguish "no active account" from "unmanaged DB present" — both produce `undefined`.
- The `unlinkSync` failure path at `src/lib/kiro-mirror.ts:80-87` returns `attempted: true, switched: false`, but it does not attempt to restore the previous symlink target. A failed switch could leave the system with no Kiro DB at all.
- The active-file write (`src/lib/kiro-mirror.ts:100-105`) is best-effort, but the symlink is described in the comment as "authoritative" — yet `getActiveKiroSnapshot` reads from the file first. The two truths fight each other.
- No locking. Two concurrent `use` calls can race between `unlinkSync` and `symlinkSync` and leave the DB in an inconsistent state.
- Path resolution hardcodes `os.homedir()` and `XDG_DATA_HOME`. There is no `KIRO_HOME` override for tests or for users who customised their Kiro install path.
- The error path uses `(err as Error).message` (`src/lib/kiro-mirror.ts:85`), which loses `errno`/`code` and prevents callers from distinguishing `EACCES` from `EBUSY`.
- Snapshot names are not validated. A name containing `..` or `/` would yield a path traversal in `path.join(KIRO_DATA_DIR, \`${name}.sqlite3\`)`. The validation exists in `kiro-login.ts:13-15` (`validName`) but is duplicated, not reused here.
- 70-character magic substrings (the rejection message in `src/lib/kiro-mirror.ts:75-77`) reference the legacy command name `agent-auth kiro-login` even though the binary is now `authmux`. This message will mislead new users.

**Diagnosis:** The module conflates I/O, path policy, validation, and state observation. Three of its four functions are technically idempotent observers; the fourth (`switchKiroSnapshot`) is non-atomic and has no rollback. The active-file vs symlink ambiguity is a real correctness defect, and the lack of a path-policy seam blocks both testing and future provider mirroring (Hermes faces the same problem).

### Refactor proposal

Extract a generic `ProviderMirror` interface (also used by `hermes-mirror.ts`) and reduce `kiro-mirror.ts` to a concrete implementation:

```
src/lib/providers/
  provider-mirror.ts        // interface, shared types
  kiro/
    kiro-paths.ts           // KIRO_HOME, snapshot path policy, name validation
    kiro-mirror.ts          // implements ProviderMirror
    kiro-state.ts           // single source of truth: read symlink, write active marker as cache
  hermes/
    hermes-mirror.ts
```

Make `switchKiroSnapshot` atomic via "write to tmp + rename" semantics: write a new symlink at `data.sqlite3.next`, then `renameSync` it onto `data.sqlite3`. `renameSync` on POSIX is atomic for same-filesystem renames; if it fails the previous symlink survives.

Make `getActiveKiroSnapshot` derive state from the symlink only. Treat the active marker file as a denormalised cache used solely for cheap reads when the symlink target's basename equals the file contents; on mismatch, prefer the symlink and rewrite the cache.

### API sketch

```ts
// src/lib/providers/provider-mirror.ts
export interface ProviderMirrorResult {
  attempted: boolean;
  switched: boolean;
  reason?: string;
  active?: string;
  errorCode?: ProviderMirrorError;
}

export type ProviderMirrorError =
  | "not-installed"
  | "snapshot-not-found"
  | "unmanaged-state-present"
  | "permission-denied"
  | "io-error"
  | "name-invalid";

export interface ProviderMirror {
  readonly id: "kiro" | "hermes";
  isInstalled(): Promise<boolean>;
  listSnapshots(): Promise<string[]>;
  hasSnapshot(name: string): Promise<boolean>;
  getActive(): Promise<{ name?: string; unmanaged: boolean }>;
  switchTo(name: string): Promise<ProviderMirrorResult>;
}

// src/lib/providers/kiro/kiro-paths.ts
export interface KiroPaths {
  dataDir: string;
  dataFile: string;
  switcherDir: string;
  activeFile: string;
  snapshotPath(name: string): string;
}
export function resolveKiroPaths(env?: NodeJS.ProcessEnv): KiroPaths;
export function isValidProviderName(name: string): boolean;

// src/lib/providers/kiro/kiro-mirror.ts
export class KiroMirror implements ProviderMirror { /* … */ }
```

### Testing strategy

- Use a temp-dir `KIRO_HOME` per test (set via `resolveKiroPaths({ HOME: tmp })`).
- Unit boundaries:
  - `kiro-paths` — pure path joiner; trivial tests for XDG override.
  - `kiro-state` — given a symlink + an active file, return the canonical name, including: (a) only file, (b) only symlink, (c) both agreeing, (d) both disagreeing, (e) symlink dangling, (f) unmanaged regular file.
  - `kiro-mirror.switchTo` — happy path; snapshot missing; unmanaged DB present; symlink unlink fails (mock `fs.promises.unlink` to throw `EACCES`); rename atomicity (verify previous symlink target on simulated failure).
- Fixtures: precreated SQLite-stub files (zero-byte `.sqlite3` files are sufficient since the mirror never opens them).
- Edge cases: name with `..`, name with leading `-`, empty name, names with Unicode normalisation differences.

### Migration steps

1. Add `src/lib/providers/provider-mirror.ts` with the interface.
2. Add `src/lib/providers/kiro/` with new pure helpers; keep `src/lib/kiro-mirror.ts` as a thin facade that delegates to the new module. Re-export the existing function names to preserve the public surface.
3. Switch consumers (`src/commands/use.ts:7-8`, `src/commands/switch.ts:8`, `src/commands/kiro.ts`, `src/commands/kiro-login.ts`) one at a time to consume the new `KiroMirror` class via `services.kiro`.
4. Delete the legacy `kiro-mirror.ts` after one release.

Backward compatibility: existing function exports remain stable through the facade. The `KiroMirrorResult` shape gains an `errorCode` field which is additive.

### Risk and rollback

Risk: the atomic rename change touches the real on-disk Kiro state for every user. A bug here could leave a user without a usable Kiro DB. Mitigation: add an integration test that exercises the real `fs.symlink` / `fs.rename` sequence in a temp dir, and gate the new path behind an env flag (`AUTHMUX_KIRO_ATOMIC=1`) for one release before flipping the default.

Rollback: the facade pattern allows reverting to the legacy implementation by editing one re-export.

**Priority:** P1. **Effort:** M.

---

## src/lib/account-savings.ts

### Current responsibilities

Persists a tiny "savings ledger" at `~/.codex/multi-auth/savings.json` with four counters and a timestamp (`src/lib/account-savings.ts:14-20`). Three mutators (`recordSwitch`, `recordAutoSwitch`, `recordRateLimitAvoided`) bump counters and rewrite the file synchronously; one accessor (`getSavingsReport`) returns the parsed JSON or a default.

Used from `src/commands/use.ts:6`, `src/commands/switch.ts:6`, `src/commands/auto-switch.ts:4`, `src/commands/savings.ts:2`.

### Concrete issues

**Evidence:**

- Every mutator performs a read-modify-write with no locking. Two concurrent `authmux use` invocations race, and the loser's increment is lost.
- `JSON.parse` is called inside a `try`/`catch` that returns the default on any error — including transient `EBUSY` on Windows during a concurrent write — which means a corrupted file is silently masked and the corrupted state is overwritten on the next write. The corruption itself is never surfaced.
- All errors are swallowed (`catch { /* ignore */ }`, `src/lib/account-savings.ts:41`). A user with a read-only home dir would never know their savings counters never increment.
- `defaultSavings()` (`src/lib/account-savings.ts:22-24`) sets `lastUpdated: new Date().toISOString()` and is also the seed for the merge in `getSavingsReport`. This means a read of a file that lacks `lastUpdated` (older format) reports the current time as the "last update", which is wrong.
- Counters are unbounded and there is no rollover or compaction. A long-running daemon will increment forever.
- The estimate `estimatedMinutesSaved += 5` (`src/lib/account-savings.ts:61`) is hard-coded with no source attribution and is presented to users as a precise number in `src/commands/savings.ts:14` (`~${s.estimatedMinutesSaved} minutes`). A user reading "saved 240 minutes" will assume measurement, not a 5-minute-per-event guess.
- The file path is hard-coded to `~/.codex/multi-auth/savings.json`. There is no `--config-dir` override and no integration with the path policy in `src/lib/config/paths.ts` (which already exposes `resolveAccountsDir`). The legacy directory `multi-auth/` survives from the codex-multi-auth lineage and should be consolidated under the authmux config root.
- No tests. The ledger has zero coverage despite being a write path on every switch.

**Diagnosis:** This is a metrics sink masquerading as durable storage. The right model is an append-only event log that a reader aggregates lazily — that gives us crash safety, concurrency safety, and the ability to derive any future statistic without a migration.

### Refactor proposal

Replace the counter file with an append-only JSONL event log at `~/.config/authmux/savings.log` (one event per line). Each event is a structured record with a monotonic timestamp. `getSavingsReport()` becomes a pure function over the event stream.

```
event types:
  { ts, kind: "switch", account: "...", trigger: "manual" | "auto", reason?: string }
  { ts, kind: "rate-limit-avoided", account: "...", windowMinutes: number }
```

Append-only writes are concurrency-safe on POSIX when bytes ≤ `PIPE_BUF` (4 KiB), which our records easily satisfy. On Windows we can fall back to `fs.appendFile` (which acquires a per-call handle).

Add a rotation policy: when the log exceeds N MB, compact older events into a `savings-summary.json` and truncate the log. Compaction is run lazily on read (with a lock) or on demand by a `savings --compact` flag (Section 03).

Stop presenting "minutes saved" as a number; instead report a derived range (`p50` / `p90` of avoided-cooldown estimates) or attach a unit-disclaimer.

### API sketch

```ts
// src/lib/observability/savings-events.ts
export type SavingsEvent =
  | { ts: number; kind: "switch"; account: string; trigger: "manual" | "auto" }
  | { ts: number; kind: "rate-limit-avoided"; account: string; windowMinutes: number };

export interface SavingsLog {
  append(event: Omit<SavingsEvent, "ts">): Promise<void>;
  read(): AsyncIterable<SavingsEvent>;
  compact(opts?: { keepEventsSince?: number }): Promise<void>;
}

export function createSavingsLog(path?: string): SavingsLog;

// src/lib/observability/savings-report.ts
export interface SavingsReport {
  windowDays: number;
  totalSwitches: number;
  autoSwitches: number;
  rateLimitsAvoided: number;
  estimatedCooldownMinutesAvoided: { low: number; high: number };
  lastEventAt?: string;
}

export async function buildSavingsReport(
  log: SavingsLog,
  opts?: { windowDays?: number; now?: () => Date },
): Promise<SavingsReport>;
```

### Testing strategy

- Unit boundaries:
  - `createSavingsLog` against a temp file — appends, reads, handles missing dir, handles malformed lines (skip with warning, do not throw).
  - `buildSavingsReport` against a fixture stream — windowing, counter math, range computation, empty stream → zeros.
- Edge cases:
  - 10 concurrent `append` calls produce 10 valid lines.
  - Partial-line on read (simulate truncation): reader skips trailing partial JSON.
  - Clock skew: events with `ts` in the future are still reported but flagged.
- No need for `fs` mocks; temp directories suffice.

### Migration steps

1. Add the new modules under `src/lib/observability/`.
2. Add a one-shot importer that reads the legacy `savings.json` (if present) and emits a single `migration` summary event into the new log; mark the old file with a `.migrated` suffix and stop touching it.
3. Update the three call sites (`use`, `switch`, `auto-switch`) to call `services.savings.append(...)`.
4. Rewrite `src/commands/savings.ts` against `buildSavingsReport` (see Section 03).
5. Delete the legacy module after one release.

Backward compatibility: the public function names (`recordSwitch`, `recordAutoSwitch`, `recordRateLimitAvoided`, `getSavingsReport`) are re-exported from a facade that maps onto the new log. The legacy JSON shape is preserved on read for one release via the importer.

### Risk and rollback

Risk: log grows unbounded for long-lived daemons. Mitigation: rotation and lazy compaction; document a hard ceiling (e.g. 50 MiB) above which writes are no-ops with a warning.

Rollback: the facade lets us reroute writes back to `savings.json` by flipping one env var.

**Priority:** P2. **Effort:** S.

---

## src/lib/usage-refresh.ts

### Current responsibilities

Fetches per-account quota data from the ChatGPT usage endpoint (`src/lib/usage-refresh.ts:10`) for a single account by reading the account's snapshot file to extract a bearer token, then calling `fetch` with a 5-second timeout and parsing `rate_limits` into a 5h "primary" and longer "secondary" window. Also exports a tiny CLI formatter `formatUsageCell` (`src/lib/usage-refresh.ts:78-83`).

### Concrete issues

**Evidence:**

- Token extraction (`extractAccessToken`, `src/lib/usage-refresh.ts:21-28`) does a sync `readFileSync` on the snapshot every time `fetchUsage` is called. For `list --details` (which iterates over every account) this serialises N sync reads inside an async function.
- The accounts directory is hard-coded (`ACCOUNTS_DIR = path.join(os.homedir(), ".codex", "accounts")`, `src/lib/usage-refresh.ts:12`) and does not respect `resolveAccountsDir()` from `src/lib/config/paths.ts`. Two modules now have independent opinions about where snapshots live, and a `--config-dir` override would not work for usage refresh.
- The endpoint URL is hardcoded (`src/lib/usage-refresh.ts:10`). There is no override for testing, no environment fallback, and no support for staging/preview endpoints.
- No retry, no backoff. A single transient 5xx or network blip yields `undefined`, and the caller in `src/lib/accounts/account-service.ts` has to either retry or accept stale data.
- All errors are swallowed and return `undefined` (`src/lib/usage-refresh.ts:73-75`). The caller cannot distinguish "no token" from "401 invalid token" from "network down". For an auto-switch daemon, "401 invalid token" must invalidate the account; "network down" must not.
- The window-bucket heuristic (`windowMinutes <= 300`, `src/lib/usage-refresh.ts:65`) maps any window ≤ 5h to "primary". A server-side change that introduces a 1h or 24h window will land in the wrong bucket. There is no schema versioning.
- `Math.round((remaining / limit) * 100)` (`src/lib/usage-refresh.ts:63`) loses precision and makes 0.4% and 0.0% indistinguishable. The auto-switch threshold check (`5h < 1`) cannot fire on values rounded to 0 vs 1.
- `formatUsageCell` returns Unicode warning icons unconditionally. There is no `--no-color` / TTY check, so JSON-piped output contains decorative glyphs. Belongs in `src/lib/ui/` not in the data layer.
- The 5-second timeout is hardcoded. The auto-switch daemon iterates over every account; for 10 accounts in the worst case that's 50 seconds — longer than the daemon's 30-second loop in `src/commands/daemon.ts`.
- No tests. The only adjacent test (`src/tests/account-list-usage-refresh.test.ts`) targets `account-service` usage refresh, not this module directly.

**Diagnosis:** Three concerns are tangled here: HTTP client behaviour (timeouts, retries, error typing), domain parsing (`rate_limits` → typed `UsageWindow`), and presentation (`formatUsageCell`). The HTTP and parsing concerns should be split from presentation, and the HTTP concern should share a single client with `update-check.ts` (which currently uses `spawn("npm")`, see below).

### Refactor proposal

```
src/lib/usage/
  usage-types.ts            // UsageData, UsageWindow, UsageFetchError
  usage-parser.ts           // pure: response body -> UsageData
  usage-client.ts           // HTTP-only: getRateLimits(token, opts)
  usage-refresh.ts          // orchestrator: token lookup + client + parse
src/lib/ui/
  usage-cell.ts             // formatUsageCell, format helpers
```

Use a shared `HttpClient` (see "Cross-cutting library concerns" below) so timeouts, retries, and error typing are not reinvented per module.

Replace the boolean "primary vs secondary" with a typed list of `UsageWindow` records carrying the original `windowMinutes`. Let callers pick the window they care about.

Return a discriminated union from the client (`ok` / `err`) so callers can differentiate "auth invalid" from "network unavailable".

### API sketch

```ts
// src/lib/usage/usage-types.ts
export interface UsageWindow {
  windowMinutes: number;
  remaining: number;
  limit: number;
  remainingPercent: number; // float, not rounded
  resetsAt?: string;
}

export interface UsageData {
  windows: UsageWindow[];
  planType?: string;
  fetchedAt: string;
}

export type UsageFetchOutcome =
  | { ok: true; value: UsageData }
  | { ok: false; error: UsageFetchError };

export type UsageFetchError =
  | { kind: "no-token" }
  | { kind: "token-rejected"; status: number }
  | { kind: "network"; cause: string }
  | { kind: "timeout" }
  | { kind: "server-error"; status: number }
  | { kind: "schema-mismatch"; detail: string };

// src/lib/usage/usage-client.ts
export interface UsageClient {
  getRateLimits(token: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<UsageFetchOutcome>;
}

// src/lib/usage/usage-refresh.ts
export interface UsageRefresher {
  fetchForAccount(name: string): Promise<UsageFetchOutcome>;
}

// src/lib/ui/usage-cell.ts
export function formatUsageCell(pct: number | undefined, opts?: { color: boolean }): string;
```

### Testing strategy

- `usage-parser` is pure and trivially unit-tested with fixture JSON bodies (good response, missing `rate_limits`, empty windows, malformed window entry, ChatGPT plan vs Codex plan).
- `usage-client` uses a fake `HttpClient` (no real network) — verify the timeout path returns `{ ok: false, error: { kind: "timeout" } }`, 401 returns `token-rejected`, 5xx returns `server-error`, network ECONNRESET returns `network`.
- `usage-refresh` orchestrates the two with a fake token extractor; verify a missing snapshot returns `no-token` without touching the network.
- `formatUsageCell` snapshot tests with and without colour.
- Edge cases: bearer token with surrounding whitespace, snapshot file present but empty, very small `limit` (1), `remaining` > `limit`, NaN safe.

### Migration steps

1. Add the new modules under `src/lib/usage/` and `src/lib/ui/`. Leave the legacy file in place re-exporting `fetchUsage` and `formatUsageCell` from the new modules (preserving the rounded-int contract for one release).
2. Plumb the path-policy seam: `usage-refresh` takes `accountsDir` from `services.paths.accountsDir` instead of hardcoded `~/.codex/accounts`.
3. Update callers in `src/lib/accounts/account-service.ts` to use the new typed outcome, branching on `error.kind` so that auto-switch can mark an account as "invalid token" rather than "no data".
4. Once all callers consume `UsageData.windows[]`, drop the legacy `primary`/`secondary` shape.

Backward compatibility: `fetchUsage`'s signature stays, but the return now resolves to a richer `UsageData` while preserving the old `primary`/`secondary` fields via a compatibility adaptor for one release.

### Risk and rollback

Risk: error reclassification could trigger the daemon to disable accounts on transient 5xx. Mitigation: a defensive policy in the daemon — only `token-rejected` invalidates an account; `network` / `timeout` / `server-error` retain the previous quota estimate.

Rollback: keep the legacy file as a 5-line facade, reverting is one edit.

**Priority:** P0 (the "no error context" + hardcoded path issues are blocking real users). **Effort:** M.

---

## src/lib/update-check.ts

### Current responsibilities

Self-update plumbing. Provides:

- Version parsing and comparison (`parseVersionTriplet`, `isVersionNewer`, `getUpdateSummary`, `src/lib/update-check.ts:73-109`).
- Two human-format renderers (`formatUpdateSummaryCard`, `formatUpdateSummaryInline`, `src/lib/update-check.ts:111-137`).
- npm install command formatters (`formatGlobalInstallSpec`, `formatGlobalInstallCommand`, `formatUpdateCompletedMessage`, `src/lib/update-check.ts:139-160`).
- Prompt helpers (`shouldProceedWithYesDefault`, `src/lib/update-check.ts:162-168`).
- `fetchLatestNpmVersion`: shells out to `npm view` (`src/lib/update-check.ts:170-220`).
- Cached variant with TTL split (long TTL when out of date, short when up to date) `fetchLatestNpmVersionCached` (`src/lib/update-check.ts:222-266`).
- `runGlobalNpmInstall`: shells out to `npm i -g` (`src/lib/update-check.ts:268-285`).

### Concrete issues

**Evidence:**

- `fetchLatestNpmVersion` spawns the `npm` CLI to read a single registry field. On most systems `npm view authmux version --json` takes 0.5–2 seconds and adds a Node startup tax. The npm registry exposes the same data over plain HTTP (`https://registry.npmjs.org/authmux/latest`) which is typically <100 ms.
- The npm shell-out depends on the user's network npm configuration. Behind a corporate proxy or a private registry that mirrors but lags upstream, the result is wrong without any way to override the URL.
- `SEMVER_TRIPLET` (`src/lib/update-check.ts:6`) accepts pre-release tags via `[-+].*` but `isVersionNewer` discards them. `1.2.3-rc.1` will compare equal to `1.2.3`, so a rc-on-rc bump never registers as "newer".
- `formatUpdateSummaryInline` emits `⬆`, `✓`, `ℹ` glyphs unconditionally. Same TTY-detection issue as `formatUsageCell`.
- `formatUpdateSummaryCard` (`src/lib/update-check.ts:111-125`) uses Unicode box-drawing in a fixed layout — but never accounts for terminals narrower than the longest version string, and never escapes ANSI in tests.
- `runGlobalNpmInstall` always runs `npm i -g` (`src/lib/update-check.ts:273`). Users with `pnpm`, `yarn`, `bun`, or `volta` end up with two copies of `authmux` (one from npm, one from the original package manager) silently shadowed by `$PATH`. There is no detection of the package manager that actually installed the binary.
- The install path requires write access to the global npm prefix. On systems where the user installed Node via Homebrew or apt, that prefix is root-owned. The install will fail with a permission error and we surface only `exit code 1`. We should detect the prefix ahead of time and surface a suggested `sudo` / `--prefix` workaround.
- The cache record schema version is 1 (`src/lib/update-check.ts:48`) but the loader returns `null` on unknown versions — there is no migration path. A bump to v2 would simply lose the cache.
- The cache TTL constants (`6h` when out of date, `60s` when up to date) are sensible defaults but not configurable per environment.
- The cache path is derived from `resolveAccountsDir()` (`src/lib/update-check.ts:37-39`), which leaks an "accounts" concept into something orthogonal to accounts.
- `shouldProceedWithYesDefault` is a UI concern in a data module.
- No retry, no backoff, no abort signal on `runGlobalNpmInstall`.

**Diagnosis:** The module mixes presentation, version arithmetic, registry I/O, and process spawning. The registry I/O is implemented via the worst available transport (a CLI shell-out). The install path is opinionated about npm but the project is consumed via multiple package managers.

### Refactor proposal

Split:

```
src/lib/update/
  semver.ts                 // parseVersionTriplet, isVersionNewer, prerelease-aware comparison
  npm-registry.ts           // fetch latest via https://registry.npmjs.org over HttpClient
  update-cache.ts           // versioned cache with migration
  package-manager.ts        // detect npm | pnpm | yarn | bun | volta; produce install spec
  install-runner.ts         // run install via detected PM, stream output, capture exit
src/lib/ui/
  update-render.ts          // formatUpdateSummaryCard / Inline (colour-aware)
  update-prompts.ts         // shouldProceedWithYesDefault
```

Use the shared `HttpClient` (Cross-cutting section) for the registry call. The fallback chain becomes:

1. HTTP `GET https://registry.npmjs.org/authmux/latest` (≤500 ms timeout, 1 retry).
2. On HTTP failure, shell out to `npm view` (current behaviour) as a last resort.

Detect the installing package manager:

- Inspect `process.env.npm_execpath` (set by npm/pnpm/yarn during scripts).
- Inspect the parent of `process.argv[1]` (Homebrew puts binaries under `…/Cellar/node/.../bin`, volta uses `~/.volta/bin/...`).
- Fall back to npm.

### API sketch

```ts
// src/lib/update/semver.ts
export interface ParsedSemver {
  major: number; minor: number; patch: number;
  prerelease?: string[]; build?: string;
}
export function parseSemver(version: string): ParsedSemver | null;
export function compareSemver(a: ParsedSemver, b: ParsedSemver): -1 | 0 | 1;
export function isNewer(currentVersion: string, latestVersion: string): boolean;

// src/lib/update/npm-registry.ts
export interface NpmRegistryClient {
  getLatestVersion(packageName: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string | null>;
}
export function createNpmRegistryClient(http: HttpClient, registry?: string): NpmRegistryClient;

// src/lib/update/package-manager.ts
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "volta" | "unknown";
export interface InstallTarget {
  manager: PackageManager;
  command: string[];                // ["npm", "i", "-g", "authmux@latest"]
  prefixWritable: boolean;
  suggestedSudo?: boolean;
}
export function detectPackageManager(env?: NodeJS.ProcessEnv): PackageManager;
export function planGlobalInstall(packageName: string, version: string): Promise<InstallTarget>;

// src/lib/update/install-runner.ts
export interface InstallResult {
  exitCode: number;
  stderrTail?: string;
  failureKind?: "permission-denied" | "network" | "package-not-found" | "unknown";
}
export function runInstall(target: InstallTarget, opts?: { signal?: AbortSignal }): Promise<InstallResult>;

// src/lib/update/update-cache.ts
export interface UpdateCache {
  read(): Promise<{ latestVersion: string; checkedAt: number } | null>;
  write(latestVersion: string, checkedAt: number): Promise<void>;
}
```

### Testing strategy

- `semver`: comprehensive table-driven tests including prereleases (`1.0.0-rc.1` < `1.0.0`, `1.0.0-rc.2` > `1.0.0-rc.1`), build metadata ignored, invalid input.
- `npm-registry`: fake `HttpClient` returning 200, 404, 5xx, slow body; verify timeout and retry policy.
- `update-cache`: corrupt JSON, unknown version → migration, concurrent reads.
- `package-manager`: drive `detectPackageManager` with synthetic env (`npm_execpath` variants, volta paths).
- `install-runner`: fake spawn that exits 1 with `EACCES` stderr → classified as `permission-denied`; fake spawn that streams to stdout → output relayed.
- Integration test (skipped on CI by default): hit the real registry once and assert the schema we depend on.

### Migration steps

1. Add `src/lib/update/` and `src/lib/ui/update-*` modules.
2. Make `fetchLatestNpmVersion` and `fetchLatestNpmVersionCached` in the legacy file delegate to the new client. Preserve their signatures.
3. Make `runGlobalNpmInstall` delegate to `planGlobalInstall` + `runInstall`. Default to npm to preserve existing behaviour; emit a one-line notice if a different package manager is detected.
4. Move the renderers to `src/lib/ui/update-render.ts`. The legacy exports stay as re-exports for one release.
5. Migrate `src/commands/update.ts` and the inline update-check in `src/commands/list.ts:74-112` to consume the new types directly (Section 03).

Backward compatibility: every existing export keeps its signature and rough semantics. The cache file format is preserved (v1) and a v2 is introduced additively.

### Risk and rollback

Risk: HTTP-first registry path could be blocked by corporate proxies. Mitigation: the npm shell-out remains as a fallback when HTTP fails or when `AUTHMUX_DISABLE_HTTP=1` is set.

Rollback: each delegated function in the legacy file can be reverted independently; the new modules are additive.

**Priority:** P1. **Effort:** M.

---

## src/lib/hermes-mirror.ts

### Current responsibilities

Mirrors the current Codex `auth.json` into the `hermes-agent` Python project's token store by executing a small Python script inside the Hermes virtualenv (`src/lib/hermes-mirror.ts:20-52`). Two helpers (`hermesInstalled`, `mirrorHermesCodexAuth`) and one result type.

Called from `src/commands/switch.ts:108`.

### Concrete issues

**Evidence:**

- The project root is hardcoded to `~/Documents/hermes-agent` (`src/lib/hermes-mirror.ts:6`). This is a developer-machine assumption and is almost certainly wrong on any other user's machine.
- `spawnSync` (`src/lib/hermes-mirror.ts:38-42`) blocks the event loop for up to 5 seconds inside an async command path.
- The Python script is embedded as a multi-line string with JSON-string interpolation of the auth path (`src/lib/hermes-mirror.ts:31`). If the path contains a single quote it would not break (we use `JSON.stringify`), but the interpolation strategy is brittle — any future addition of a literal `${…}` would need careful escaping.
- The script calls a private function `_save_codex_tokens` (`src/lib/hermes-mirror.ts:33`). Relying on a leading-underscore symbol from a third-party project is a guaranteed breakage point at the next Hermes release.
- Token presence is checked Python-side, but the failure message is then truncated to the last stderr line (`src/lib/hermes-mirror.ts:48`). On a multi-line traceback this loses the cause.
- The `reason` for `attempted=false` is the string `"hermes-agent not installed"`. We don't differentiate "venv missing" from "hermes_cli missing".
- No way to disable: users who do not use Hermes still get a `mirrorHermesCodexAuth()` call on every `switch` (`src/commands/switch.ts:108`), and although it returns silently when not installed, the cost is two `fs.existsSync` calls and the cognitive cost of an opaque integration.
- No tests.

**Diagnosis:** Hermes mirroring is a personal-workflow integration that should not live in the core CLI without an opt-in. The mechanism (run Python in a venv) is also fragile and slow. It should either become a plug-in (out-of-tree) or a generic "post-switch hook" that users can script themselves.

### Refactor proposal

Two layers:

1. Introduce a generic `PostSwitchHook` interface and a config-driven loader. Hermes becomes one optional built-in hook; user-scripted hooks are also supported (`~/.config/authmux/post-switch.d/*.sh`).
2. Refactor the Hermes-specific code to fit the `ProviderMirror` interface alongside Kiro (see "Cross-cutting library concerns" → provider-mirror framework).

For the Hermes hook itself:

- Read project root from `~/.config/authmux/hermes.json` or `AUTHMUX_HERMES_HOME`.
- Replace the Python shell-out with a file-based handoff: write a sentinel `~/.config/hermes-agent/codex-auth.json` that the Hermes side can pick up on its own schedule. This removes the private-API dependency entirely.
- Time out at 2 s, not 5 s.
- Make the call truly opt-in: it only runs if the user has set `hermes.enabled = true` in config or if `~/.config/authmux/hermes.json` exists.

### API sketch

```ts
// src/lib/providers/hermes/hermes-paths.ts
export interface HermesPaths {
  projectRoot: string;
  venvPython: string;
  cliDir: string;
  handoffFile: string;
}
export function resolveHermesPaths(env?: NodeJS.ProcessEnv): HermesPaths;

// src/lib/providers/hermes/hermes-mirror.ts
export class HermesMirror implements ProviderMirror {
  readonly id = "hermes";
  // (same shape as KiroMirror)
}

// src/lib/hooks/post-switch.ts
export interface PostSwitchHookContext {
  account: string;
  fromAccount?: string;
  trigger: "manual" | "auto";
}

export interface PostSwitchHook {
  id: string;
  shouldRun(ctx: PostSwitchHookContext): boolean | Promise<boolean>;
  run(ctx: PostSwitchHookContext): Promise<ProviderMirrorResult>;
}

export interface PostSwitchHookRegistry {
  register(hook: PostSwitchHook): void;
  runAll(ctx: PostSwitchHookContext): Promise<ProviderMirrorResult[]>;
}
```

### Testing strategy

- `resolveHermesPaths`: env override, default to `~/Documents/hermes-agent` only when nothing else is set, document path priority.
- `HermesMirror.isInstalled`: test against a temp dir with/without `venv/bin/python3` and `hermes_cli/` present.
- `HermesMirror.switchTo`: in handoff mode, verify the handoff file gets written with the expected JSON, atomic-rename semantics.
- `PostSwitchHookRegistry`: verify multiple hooks run in registration order, that one hook's failure does not block the others, that timing each hook is reported.

### Migration steps

1. Add `HermesPaths` and gate `mirrorHermesCodexAuth` on `resolveHermesPaths().projectRoot` existing.
2. Add the `PostSwitchHookRegistry` and adapt the existing Kiro + Hermes calls in `src/commands/switch.ts` to go through the registry.
3. Build the handoff-file alternative behind a flag (`AUTHMUX_HERMES_MODE=handoff`) so early adopters can validate it without breaking the existing Python flow.
4. After a release with telemetry showing handoff mode works for users, flip the default.
5. Delete the legacy Python shell-out.

Backward compatibility: existing `mirrorHermesCodexAuth()` export remains as a thin wrapper over `HermesMirror.switchTo()`. The Python-script mode is preserved as an opt-out.

### Risk and rollback

Risk: changing the integration mechanism could break the existing in-house Hermes setup. Mitigation: feature flag, parallel-mode for one release.

Rollback: revert the feature-flag default back to `python`.

**Priority:** P2. **Effort:** M.

---

## src/lib/account-health.ts

### Current responsibilities

Three independent reliability primitives (`CircuitBreaker`, `HealthScoreTracker`, `TokenBucketTracker`) plus a singleton container and persistence (`loadState`, `saveState`) and a public API around the singleton (`recordSuccess`, `recordRateLimit`, `recordFailure`, `getAccountHealth`, `selectBestAccount`, `forecastAccounts`). All scored per account name.

Used by `src/commands/use.ts`, `src/commands/switch.ts`, `src/commands/auto-switch.ts`, `src/commands/check.ts`, `src/commands/forecast.ts`.

### Concrete issues

**Evidence:**

- The three classes are useful and self-contained, but the module-level singleton (`health`, `tokens`, `circuits`, `src/lib/account-health.ts:141-143`) and the eager `loadState()` in `selectBestAccount` (`src/lib/account-health.ts:208`) and `forecastAccounts` (`src/lib/account-health.ts:225`) make every read a full file parse. The state file is also rewritten on every record event via `saveState()` (`src/lib/account-health.ts:183, 189, 195`).
- `saveState` writes to `~/.codex/multi-auth/health-state.json` synchronously — same legacy path as `account-savings.ts`. Same path-policy concerns.
- `recordSuccess`, `recordRateLimit`, `recordFailure` call `saveState()` after every event. In an auto-switch loop where each pass touches every account, this is N writes per loop.
- `loadState` only loads `data.health` (`src/lib/account-health.ts:160`), not circuit-breaker state or token-bucket state. So circuit breakers are reset to "closed" on every process boot, defeating the point of persistence — a 30-failure account looks healthy after `authmux daemon --once` re-launches.
- `TokenBucketTracker.tryConsume` is never called from `record*` paths, only `getTokens` from `getAccountHealth`. The bucket therefore never decrements unless callers explicitly call it; today no caller does. The "tokens remaining" reported by `check` / `forecast` is always 50.
- `CircuitBreaker.getState` mutates state inside what looks like a getter (`src/lib/account-health.ts:30-35`) — confusing for readers and impossible to call in a const context.
- `selectBestAccount`'s fallback (`src/lib/account-health.ts:218-221`) uses `health.getScore` on each candidate via a `.reduce`. When all accounts are unusable it picks the highest-scoring even if its circuit is open — which is exactly the case where we should refuse to switch.
- `forecastAccounts` sorts by score desc, then by `usable === b.usable ? 0 : a.usable ? -1 : 1` (`src/lib/account-health.ts:226`) — but usable accounts will usually score higher than unusable ones, so the secondary sort key is rarely meaningful. More importantly, two equally-scored accounts have an undefined order, hurting reproducibility.
- Health-score recovery is hardcoded at `+2 points per hour` (`src/lib/account-health.ts:74`) and never persisted; on process restart, recovery clock resets to `lastUpdated` from disk but `lastUpdated` is the moment of last event, not a wall-clock checkpoint. Multi-hour idle periods recover fine; a process that restarts every minute also recovers fine. There is no bug here, but the model is not documented anywhere.
- No tests.

**Diagnosis:** Three sound primitives, one weak singleton with persistence gaps. The "everything writes immediately" pattern is unsustainable for a daemon. Circuit-breaker / token-bucket state should also be persisted or — better — replayed from the savings event log proposed above.

### Refactor proposal

Restructure into pure primitives + a stateful service:

```
src/lib/health/
  circuit-breaker.ts         // pure class, no singleton
  health-score.ts            // pure class
  token-bucket.ts            // pure class
  health-store.ts            // persisted state for circuits + scores + buckets
  health-service.ts          // orchestrates the three; debounced writes
```

Make `HealthService` the only persistence boundary. Debounce writes (e.g. flush on shutdown + every 5s on change). Persist circuit-breaker state and token-bucket state along with health scores.

Fix `selectBestAccount` to refuse to switch when no account is usable (return `undefined` + a `reason`).

Fix `CircuitBreaker.getState` to be a const getter, and add a separate `tick(now)` method that advances state.

### API sketch

```ts
// src/lib/health/circuit-breaker.ts
export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitConfig {
  failureThreshold: number;     // default 3
  failureWindowMs: number;      // default 60_000
  resetTimeoutMs: number;       // default 30_000
}

export class CircuitBreaker {
  constructor(config?: Partial<CircuitConfig>, snapshot?: CircuitSnapshot);
  readonly state: CircuitState;          // pure getter
  isAvailable(now?: number): boolean;    // pure
  tick(now: number): CircuitState;       // returns new state
  recordSuccess(now?: number): void;
  recordFailure(now?: number): void;
  toSnapshot(): CircuitSnapshot;
}

export interface CircuitSnapshot {
  state: CircuitState;
  failures: number[];
  lastStateChange: number;
}

// src/lib/health/health-service.ts
export interface AccountHealthReport {
  name: string;
  score: number;
  circuit: CircuitState;
  tokensAvailable: number;
  usable: boolean;
  reasons?: string[];
}

export interface HealthService {
  recordSuccess(account: string): Promise<void>;
  recordFailure(account: string): Promise<void>;
  recordRateLimit(account: string): Promise<void>;
  consumeToken(account: string): Promise<boolean>;
  report(account: string): AccountHealthReport;
  forecast(accounts: string[]): AccountHealthReport[];
  selectBest(accounts: string[]): { account?: string; reason?: string };
  flush(): Promise<void>;
}

export function createHealthService(opts?: { statePath?: string; flushDebounceMs?: number }): HealthService;
```

### Testing strategy

- `CircuitBreaker`: table-driven failure sequences with controlled `now`; verify state transitions including `half-open` → `closed` on success and `half-open` → `open` on failure.
- `HealthScoreTracker`: deterministic recovery with injected clock; verify clamping to `[0,100]`.
- `TokenBucketTracker`: verify refill math and `tryConsume` semantics across multiple consumers.
- `HealthService`: round-trip persistence (write, restart, read), debounced flush via fake timers, `selectBest` returns `undefined` when all accounts are unusable.
- Property tests for `selectBest`: ordering is total and deterministic given a snapshot.

### Migration steps

1. Refactor primitives into `src/lib/health/` with no behaviour change; re-export from `src/lib/account-health.ts`.
2. Move singleton state into a `HealthService` that the `Services` container holds.
3. Add circuit + bucket persistence to `HealthService.flush`. Migrate the on-disk format with a `version: 2` field; readers fall back to `version: 1` (current shape) for one release.
4. Audit call sites to switch to the new instance-based API and to actually call `consumeToken` from `runAutoSwitchOnce`.
5. Fix `selectBest` to refuse-on-all-unusable; this is a behaviour change so it goes behind a flag for one release.
6. Delete the legacy singleton exports.

Backward compatibility: existing function exports are preserved as adapters delegating to the global service; the on-disk schema is versioned.

### Risk and rollback

Risk: the behaviour change in `selectBest` (returning `undefined` instead of the highest-scoring unusable account) will cause auto-switch to do nothing in degraded clusters. Mitigation: surface a clear log line ("no usable account"), keep the legacy behaviour behind `AUTHMUX_HEALTH_FALLBACK_TO_BEST_UNHEALTHY=1`.

Rollback: revert the call sites; primitives remain compatible.

**Priority:** P1. **Effort:** M.

---

## Cross-cutting library concerns

The seven modules above share several patterns that are independently reinvented. Consolidating them is the largest leverage point for the codebase.

### 1. Shared logger

**Evidence.** Every module logs via `console.*` indirectly through oclif's `this.log` / `this.warn` (or by swallowing errors entirely — `kiro-mirror.ts`, `hermes-mirror.ts`, `account-savings.ts`, `account-health.ts` all have `catch { /* ignore */ }` blocks). There is no log level, no structured output, no correlation id, no way to silence library noise in tests.

**Diagnosis.** Mixing presentation with library code makes it impossible to (a) emit machine-readable output from the CLI without leaking library logs, (b) capture library logs in tests, (c) attach a request id to chains like `daemon → fetchUsage → http`.

**Proposal.** Introduce `src/lib/observability/logger.ts` with a minimal interface:

```ts
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(opts?: { level?: LogLevel; sink?: (rec: LogRecord) => void }): Logger;
```

Default sink writes one line per record to stderr; in `--json` mode the records are still on stderr (machine output goes to stdout). Tests inject a memory sink and assert specific log lines.

**Migration.** Every `catch { /* ignore */ }` becomes `catch (err) { log.warn("operation_failed", { err }) }`. Every `this.log` in a command stays — it's user output. Library modules never call `console.*`.

**Rollout.** Add the logger, wire it through `Services`, migrate one module per PR. Default level `warn` in production, `debug` when `AUTHMUX_LOG=debug`.

**Priority:** P1. **Effort:** S.

### 2. Shared filesystem abstraction

**Evidence.** Six of seven modules import `node:fs` (sync API) directly. Path policy is reinvented in each: `account-savings.ts:12`, `usage-refresh.ts:12`, `account-health.ts:154`, `hermes-mirror.ts:6-8`, `kiro-mirror.ts:5-11`. `update-check.ts` is the only one that consults `resolveAccountsDir()` (`src/lib/update-check.ts:4`), and it then misuses that path for a non-account concern.

**Diagnosis.** No seam for tests, no `--config-dir` override, no atomic-write helper, no concurrent-safe append helper. Each module reinvents `mkdirSync(dir, { recursive: true })` + `writeFileSync`.

**Proposal.** Add `src/lib/io/`:

```ts
// src/lib/io/paths.ts
export interface AuthmuxPaths {
  configDir: string;        // ~/.config/authmux (XDG)
  legacyCodexDir: string;   // ~/.codex (preserved for back-compat)
  accountsDir: string;
  registryFile: string;
  savingsLog: string;
  healthState: string;
  updateCache: string;
  kiro: KiroPaths;
  hermes: HermesPaths;
}
export function resolvePaths(env?: NodeJS.ProcessEnv & { AUTHMUX_HOME?: string }): AuthmuxPaths;

// src/lib/io/atomic.ts
export async function writeJsonAtomic(path: string, value: unknown): Promise<void>;
export async function readJsonOr<T>(path: string, fallback: T): Promise<T>;
export async function appendJsonl<T>(path: string, record: T): Promise<void>;
```

`writeJsonAtomic` writes to `${path}.tmp.${pid}.${rand}` then `rename`s; safe for crash and concurrency on POSIX. `appendJsonl` uses `fs.appendFile` (atomic for ≤PIPE_BUF on POSIX).

**Migration.** Every module replaces direct `fs.*` calls with `services.io.*`. Path constants move into `AuthmuxPaths`.

**Rollout.** Land `io` first, refactor modules one at a time. Preserve all current on-disk paths via `legacyCodexDir` defaults.

**Priority:** P0. **Effort:** M.

### 3. Shared HTTP client

**Evidence.** `usage-refresh.ts:39` uses raw `fetch` with a manual `AbortController`. `update-check.ts:170-220` shells out to `npm view`. There is no shared timeout policy, no retry policy, no shared user-agent, no shared error taxonomy.

**Diagnosis.** Two ways to make outbound calls, two ways to fail, two ways to time out. A third caller (future Anthropic/Codex telemetry) would invent a third.

**Proposal.** Add `src/lib/net/http-client.ts`:

```ts
export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;       // default 3000
  retries?: number;         // default 1
  retryDelayMs?: number;    // default 250
  signal?: AbortSignal;
}

export type HttpOutcome<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; error: HttpError };

export type HttpError =
  | { kind: "timeout" }
  | { kind: "network"; cause: string }
  | { kind: "status"; status: number; body?: unknown }
  | { kind: "parse"; cause: string };

export interface HttpClient {
  request<T = unknown>(req: HttpRequest): Promise<HttpOutcome<T>>;
}

export function createHttpClient(opts?: { defaultUserAgent?: string }): HttpClient;
```

Defaults: timeout 3 s, 1 retry on `timeout` / `network` / `5xx`, exponential backoff capped at 1 s, user-agent `authmux/<version> (+https://github.com/recodeee/authmux)`.

**Migration.** `usage-refresh` consumes `HttpClient.request`. `update-check.npm-registry` consumes `HttpClient.request`. `npm view` shell-out remains as an explicit fallback only.

**Rollout.** Land client + tests, migrate `usage-refresh`, then `update-check`. Feature-flag the HTTP-first registry path for `update-check` for one release.

**Priority:** P0. **Effort:** S.

### 4. Retry / timeout policy

**Evidence.** Timeouts are scattered: 5000 ms (`usage-refresh.ts:11`), 2500 ms (`update-check.ts:7`), 5000 ms (`hermes-mirror.ts:42`). No retries anywhere. No policy doc.

**Diagnosis.** Each module picks a number. Operations end up either too slow (auto-switch daemon timing out across all accounts) or too quick (`update-check` failing on a 3 s npm view).

**Proposal.** A single `src/lib/net/policy.ts` exporting named policies:

```ts
export const TimeoutPolicy = {
  registry: 1_500,
  usage: 4_000,
  hermesHandoff: 1_500,
  install: 120_000,
} as const;

export const RetryPolicy = {
  registry: { retries: 2, backoffMs: 200 },
  usage: { retries: 1, backoffMs: 300 },
  hermesHandoff: { retries: 0, backoffMs: 0 },
} as const;
```

**Migration.** Each call site references a named policy instead of a literal. Changing the value is one edit.

**Priority:** P2. **Effort:** S.

### 5. Provider-mirror framework

**Evidence.** `kiro-mirror.ts` and `hermes-mirror.ts` solve similar problems (mirror Codex auth state into another tool's storage) with no shared abstraction. Both have `installed` checks, both define a result type with `attempted` / `switched` / `reason`, both are called serially from `src/commands/switch.ts:108-121`.

**Diagnosis.** Independent evolution will produce more divergence. Adding a third provider (Claude Code, Cursor, …) would multiply the boilerplate.

**Proposal.** Promote `ProviderMirror` (interface sketched in the kiro-mirror section) to a first-class library concept. Add a `ProviderMirrorRegistry`:

```ts
// src/lib/providers/registry.ts
export interface ProviderMirrorRegistry {
  list(): ProviderMirror[];
  get(id: string): ProviderMirror | undefined;
  runAll(name: string, opts?: { exclude?: string[] }): Promise<Map<string, ProviderMirrorResult>>;
}

export function createProviderMirrorRegistry(mirrors: ProviderMirror[]): ProviderMirrorRegistry;
```

`src/commands/switch.ts` and `src/commands/use.ts` call `services.providers.runAll(activated)` instead of hardcoding Kiro and Hermes calls. Skip-flags become generic: `--skip-provider kiro,hermes`.

**Migration.**

1. Introduce the registry; built-in mirrors are Kiro and Hermes (no behaviour change).
2. Switch command call sites to the registry.
3. Add a `--skip-provider` flag (Section 03) and deprecate `--no-kiro` over one release.

**Priority:** P1. **Effort:** M.

### 6. Proposed `src/lib/io/` and `src/lib/net/` packages

**Evidence.** `src/lib/` is currently flat. As the codebase grows (providers, observability, update), the lack of subpackages forces every concern to either pollute the root or invent its own subdirectory.

**Proposal.** End state:

```
src/lib/
  accounts/                     // owned by Section 01
  config/                       // owned by Section 01
  io/
    paths.ts
    atomic.ts
    locks.ts
  net/
    http-client.ts
    policy.ts
  observability/
    logger.ts
    savings-events.ts
    savings-report.ts
  update/
    semver.ts
    npm-registry.ts
    update-cache.ts
    package-manager.ts
    install-runner.ts
  usage/
    usage-types.ts
    usage-parser.ts
    usage-client.ts
    usage-refresh.ts
  providers/
    provider-mirror.ts
    registry.ts
    kiro/
    hermes/
  health/
    circuit-breaker.ts
    health-score.ts
    token-bucket.ts
    health-store.ts
    health-service.ts
  hooks/
    post-switch.ts
  ui/
    usage-cell.ts
    update-render.ts
    update-prompts.ts
  base-command.ts
  services.ts                   // factory + container
```

The current flat files (`base-command.ts`, `kiro-mirror.ts`, `account-savings.ts`, `usage-refresh.ts`, `update-check.ts`, `hermes-mirror.ts`, `account-health.ts`) remain as thin re-export facades for one release, then are deleted.

**Migration.** Each section above defines its own migration; the package skeleton is created in one PR and then populated incrementally.

**Priority:** P1. **Effort:** L (sum of the per-module migrations).

### 7. Deduplicating `kiro-mirror` vs `hermes-mirror`

Covered by sections 2, 5, and 6 above. Specifically:

- Both modules currently embed path policy. They should both consume from `AuthmuxPaths` (Section 2).
- Both modules currently expose a bespoke result type. They should both return `ProviderMirrorResult` (Section 5).
- Both modules are called serially from `switch.ts`. They should go through `ProviderMirrorRegistry.runAll` (Section 5), with timing logged via the shared logger (Section 1).

**Expected payoff:** the existing `hermes-mirror.ts` (52 lines) and `kiro-mirror.ts` (108 lines) collapse to roughly 30 lines each plus shared infrastructure; adding a third provider becomes a single-file change.

### 8. Process spawning consistency

**Evidence.** `update-check.ts:175-219, 268-285` uses `spawn` from `node:child_process`. `hermes-mirror.ts:38-42` uses `spawnSync`. The login flow (`src/commands/login.ts:73-103`) and `kiro-login.ts:37` use `spawn` and `execSync` respectively. Each handles `error` / `exit` / `signal` differently; none capture stderr cleanly.

**Diagnosis.** Five different ways to run a child process, none of them tested, all of them subtly wrong (`execSync` blocks, `spawnSync` blocks, signal handling varies).

**Proposal.** Introduce `src/lib/io/process.ts`:

```ts
export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdio?: "inherit" | "pipe";
  signal?: AbortSignal;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
}

export async function runCommand(command: string, args: string[], opts?: SpawnOptions): Promise<SpawnResult>;
```

Always async, always with timeout, always captures stderr tail. Used by `runCodexLogin`, `runGlobalNpmInstall`, `kiro-cli login`, the Hermes Python shell-out (until it's replaced), and `npm view`.

**Priority:** P1. **Effort:** S.

### 9. Cross-section summary

The cross-cutting work above totals roughly:

| Concern              | Priority | Effort | Section blockers |
| -------------------- | -------- | ------ | ---------------- |
| Logger               | P1       | S      | none             |
| Filesystem abstraction (`io/`) | P0 | M  | unblocks every per-module refactor |
| HTTP client (`net/`) | P0       | S      | unblocks `usage-refresh`, `update-check` |
| Retry/timeout policy | P2       | S      | depends on HTTP client |
| Provider-mirror framework | P1   | M      | depends on `io/`, used by `kiro` + `hermes` |
| Subpackage skeleton  | P1       | L      | umbrella |
| Process spawning     | P1       | S      | unblocks `update-check` and any subprocess code in `commands/` |

Sequencing: `io/` + `net/` first, then per-module refactors. The provider framework + logger can land in parallel. The subpackage skeleton (Section 6) is created at the start so that every per-module PR lands files in its final home.
