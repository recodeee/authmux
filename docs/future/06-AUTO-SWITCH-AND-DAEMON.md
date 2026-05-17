# 06 — Auto-switch policy engine and daemon runtime

This slice owns the operational core of `authmux`: the loop that watches the
active account, decides when it has run out of quota, picks a replacement, and
the OS-level supervisor that keeps that loop alive between user sessions. It
covers three current files in detail —
`src/commands/daemon.ts`, the `runAutoSwitchOnce` / `runDaemon` methods inside
`src/lib/accounts/account-service.ts`, and the per-platform installer in
`src/lib/accounts/service-manager.ts` — and proposes the shape of the policy
engine and runtime that should replace them before the daemon is allowed to
make decisions that the user has not explicitly authorised.

The companion file `07-USAGE-REFRESH-AND-API.md` covers how quota numbers are
acquired in the first place; this file assumes those numbers exist and focuses
on what is done with them.

---

## Current behavior

This section describes, with no editorial spin, what ships in `authmux` today.
Subsequent sections quote line numbers from these files when proposing
changes.

### Entry points

| Surface                          | File                                   | Lines |
| -------------------------------- | -------------------------------------- | ----- |
| `authmux daemon --once`          | `src/commands/daemon.ts`               | 1-41  |
| `authmux daemon --watch`         | `src/commands/daemon.ts`               | 1-41  |
| `authmux auto-switch` (legacy)   | `src/commands/auto-switch.ts`          | 1-32  |
| `authmux config auto enable`     | `src/commands/config.ts`               | 54-63 |
| `authmux config auto disable`    | `src/commands/config.ts`               | 65-72 |
| `authmux config auto --5h/--weekly` | `src/commands/config.ts`            | 78-90 |
| `authmux status`                 | `src/commands/status.ts`               | 1-15  |
| `authmux check`                  | `src/commands/check.ts`                | 1-31  |
| `authmux forecast`               | `src/commands/forecast.ts`             | 1-25  |

### `daemon --once`

`src/commands/daemon.ts:28-35` defers to
`AccountService.runAutoSwitchOnce()`. The implementation lives at
`src/lib/accounts/account-service.ts:597-667` and is the only piece of code
that performs an unattended `use`-style activation. Its behavior is:

1. Reload the registry via `loadReconciledRegistry()`
   (`account-service.ts:1285-1290`) which re-runs
   `reconcileRegistryWithAccounts` so the in-memory model always matches the
   on-disk snapshot list. If auto-switch is disabled in the registry, the run
   exits early with `{ switched: false, reason: "auto-switch is disabled" }`
   (`account-service.ts:599-601`).
2. Gate the run on having at least one saved account and a resolvable active
   account. The active account is taken from
   `getCurrentAccountName()` first and then from
   `registry.activeAccountName` as a fallback (`account-service.ts:608-611`).
3. Refresh the *active* account's usage with
   `refreshAccountUsage(registry, active, { preferApi, allowLocalFallback:
   true })` (`account-service.ts:615-618`). The `preferApi` flag mirrors
   `registry.api.usage`, i.e. the `config api enable`/`disable` toggle from
   `src/commands/config.ts:92-99`. `allowLocalFallback: true` permits the
   active-account path to fall back to the rollout-log parser in
   `src/lib/accounts/usage.ts:649-660`.
4. Call `shouldSwitchCurrent(activeUsage, thresholds, nowSeconds)`
   (`src/lib/accounts/usage.ts:521-533`). This returns `true` if either the
   5-hour window remaining is below `threshold5hPercent` or the weekly window
   remaining is below `thresholdWeeklyPercent`. Defaults live at
   `src/lib/accounts/types.ts:1-2` (`10%` and `5%` respectively).
5. Compute the active account's score with `usageScore`
   (`src/lib/accounts/usage.ts:511-519`) which is `min(5h-remaining,
   weekly-remaining)` and then enumerate all non-active candidates calling
   `refreshAccountUsage` with `allowLocalFallback: false`
   (`account-service.ts:633-646`). Local fallback is *intentionally* disabled
   for candidates because rollout logs only exist for the currently active
   Codex session.
6. Pick the highest-scoring candidate strictly greater than the current score
   (`account-service.ts:648-654`). On a tie, the active account wins.
7. If a switch is warranted, call `activateSnapshot(bestCandidate)`
   (`account-service.ts:656`, implementation at
   `account-service.ts:1297-1313`) which copies the snapshot to
   `~/.codex/auth.json` and writes the current-name marker.
8. Persist the registry. `runAutoSwitchOnce` returns
   `{ switched, fromAccount, toAccount, reason }`
   (`src/lib/accounts/types.ts:66-71`).

The `--once` surface itself is intentionally thin: the command prints either
`switched: <from> -> <to>` or `no switch: <reason>`
(`src/commands/daemon.ts:30-34`).

### `daemon --watch`

`runDaemon("watch")` (`account-service.ts:669-683`) is an unbounded `for(;;)`
loop that:

1. Calls `runAutoSwitchOnce()`.
2. Swallows any thrown error to keep the daemon alive — the `catch` block is
   completely empty (`account-service.ts:678-680`).
3. `await new Promise((r) => setTimeout(r, 30_000))` — fixed 30-second tick,
   no jitter, no backoff, no shutdown signal.

There is no signal handler, no exit path, no log line per evaluation, and no
mechanism for an external process (e.g. another `authmux` invocation) to ask
the daemon to re-evaluate immediately or to switch on demand.

### Legacy `auto-switch` command

`src/commands/auto-switch.ts:1-32` predates the daemon. It bypasses the
registry-driven policy entirely:

- Loads health state from `src/lib/account-health.ts:156-165`.
- Calls `selectBestAccount(names)` from `src/lib/account-health.ts:206-222`,
  which scores accounts by `HealthScoreTracker` (circuit breaker + token
  bucket + recovering score) rather than by usage quota.
- Activates via `AccountService.useAccount(best)` and records success/failure
  with `recordSuccess`/`recordFailure` (`account-health.ts:180-196`).

The two code paths share no state. The daemon does **not** consult
`account-health.ts` and `auto-switch` does **not** consult the usage
snapshots in the registry. See "Issues found in code" #7 below.

### Thresholds and configuration

`src/commands/config.ts:32-90` is the only place where thresholds and the
enable/disable flag can be set from the CLI. The flow is:

- `config auto enable` calls `AccountService.setAutoSwitchEnabled(true)`
  (`account-service.ts:544-564`) which **also** installs the OS service via
  `enableManagedService()` and rolls the enable flag back to `false` on
  failure to avoid a half-on state.
- `config auto disable` mirrors the above and calls
  `disableManagedService()`.
- `config auto --5h N --weekly M` writes
  `registry.autoSwitch.threshold5hPercent` and
  `registry.autoSwitch.thresholdWeeklyPercent` after clamping to `[1,100]`
  via `clampPercent` (`src/lib/accounts/registry.ts:16-21`).
- `config api enable|disable` flips `registry.api.usage`
  (`account-service.ts:566-571`), which governs whether the active and
  candidate refresh paths in `runAutoSwitchOnce` call
  `fetchUsageFromApi`/`fetchUsageFromProxy` or short-circuit to local
  fallback. See `07-USAGE-REFRESH-AND-API.md` for the wire side of that
  toggle.

The CLI surface does **not** expose:

- Cooldown between switches.
- Per-account weights or priority pins.
- A separate "switch-back" threshold (hysteresis band).
- A per-terminal pin that overrides daemon decisions.
- Strategy selection (round-robin, weighted, forecast-aware, etc.).
- Daemon log level.

### Managed service install

`src/lib/accounts/service-manager.ts` is the single source of truth for OS
integration. It exports `enableManagedService`, `disableManagedService`, and
`getManagedServiceState` and dispatches per `process.platform`:

| Platform | Unit type | Path | Install command | State probe |
| -------- | --------- | ---- | --------------- | ----------- |
| `linux`  | user systemd unit | `~/.config/systemd/user/authmux-autoswitch.service` (`service-manager.ts:29-31`) | `systemctl --user daemon-reload`, `enable`, `start` (`service-manager.ts:55-69`) | `systemctl --user is-active` (`service-manager.ts:84-89`) |
| `darwin` | LaunchAgent plist | `~/Library/LaunchAgents/com.codex.auth.autoswitch.plist` (`service-manager.ts:91-94`) | `launchctl unload` then `launchctl load` (`service-manager.ts:119-129`) | `launchctl list <label>` (`service-manager.ts:141-145`) |
| `win32`  | Scheduled Task | task name `authmux-autoswitch` (`service-manager.ts:10`) | `schtasks /Create /SC ONLOGON /TR "cmd /c authmux daemon --watch" /F` (`service-manager.ts:147-163`) | `schtasks /Query ... /V /FO LIST` and string match `running` (`service-manager.ts:169-180`) |

All unit-file contents are hand-built string arrays inside the same file
(`service-manager.ts:33-48`, `95-117`). There is no template directory and
nothing in the repository under `assets/`.

State strings reported by `getManagedServiceState()` are typed as
`"active" | "inactive" | "unknown"` (`service-manager.ts:6`) and surfaced by
`authmux status` (`src/commands/status.ts:9-12`).

### Where state lives

| Concern | Path | Format |
| ------- | ---- | ------ |
| Registry (autoswitch flag, thresholds, usage cache) | `<codex>/multi-auth/registry.json` (via `resolveRegistryPath()` in `src/lib/config/paths.ts`) | JSON object sanitised by `sanitizeRegistry` (`src/lib/accounts/registry.ts:98-135`) |
| Account snapshots | `~/.codex/accounts/<name>.json` | Codex `auth.json` shape |
| Health (score/circuit/tokens) | `~/.codex/multi-auth/health-state.json` (`src/lib/account-health.ts:154`) | JSON `{ health: { name: { score, lastUpdated, consecutiveFailures } } }` |
| Savings counters | `~/.codex/multi-auth/savings.json` (`src/lib/account-savings.ts:12`) | JSON `SavingsData` (`account-savings.ts:14-20`) |
| Active Codex auth | `~/.codex/auth.json` | Codex format, written by `activateSnapshot` (`account-service.ts:1297-1313`) |
| Snapshot backup vault | `<codex>/multi-auth/snapshot-backup/` | Mirror of `~/.codex/accounts/` for clobber recovery (`account-service.ts:859-893`) |

### How `status` reports

`AccountService.getStatus()` (`account-service.ts:533-542`) returns a
`StatusReport` (`src/lib/accounts/types.ts:58-64`) with
`autoSwitchEnabled`, `serviceState`, `threshold5hPercent`,
`thresholdWeeklyPercent`, `usageMode`. The command prints four lines
(`src/commands/status.ts:9-12`). There is no field for "last evaluation
time", "last switch time", "current strategy", or "daemon PID".

---

## Issues found in code

Each issue cites the file:line that proves it and tags the severity used
throughout this protocol: `P0` (correctness), `P1` (stability), `P2`
(operability), `P3` (polish). Size: `S` (<200 LOC), `M` (200-600 LOC),
`L` (600-1500 LOC), `XL` (>1500 LOC).

### 1. Threshold-only policy with no hysteresis — `P1 M`

**Evidence.** `shouldSwitchCurrent` (`src/lib/accounts/usage.ts:521-533`)
compares remaining percent against a single threshold. The selection logic
in `runAutoSwitchOnce` (`account-service.ts:642-646`) is "highest score wins
by any amount". There is no minimum delta and no separate
`switchBackThresholdPercent`.

**Diagnosis.** When `threshold5hPercent = 10` and the active account hovers
at 9-10% (which is common immediately after a switch in burst usage
scenarios) the daemon will switch on every tick where the API reports `<10%`
and the candidate happens to score anything `>=10%`. As soon as usage on the
new account dips, the same conditions hold in reverse and the daemon can
"flap" between two accounts within a single 5-hour window. Each flap
triggers a Codex auth.json rewrite, a Kiro mirror, and a Hermes mirror (see
the post-switch wiring in `src/commands/switch.ts:96-125` — although note
the daemon does **not** mirror Kiro/Hermes; see issue #11).

**Why this is `P1` and not `P0`.** Real-world telemetry has not yet
confirmed flapping in the wild — but the conditions for it are present on
every install and there is no recorded history to detect it after the fact.

Migration path: see "Proposed policy engine" / "Hysteresis bands".

### 2. No exponential backoff on API failures — `P1 S`

**Evidence.** `runDaemon` (`account-service.ts:669-683`) sleeps a fixed 30s
between iterations. `refreshAccountUsage` (`account-service.ts:701-742`)
returns `undefined` on any error, never throws. `fetchUsageFromApi`
(`src/lib/accounts/usage.ts:535-569`) and `fetchUsageFromProxy`
(`src/lib/accounts/usage.ts:440-485`) similarly swallow errors.

**Diagnosis.** When the ChatGPT usage endpoint is degraded the daemon will
still tick every 30s and re-issue requests for every account on every tick.
There is no rate-limiting on the *outbound* refresh, no jitter, and the
"no usage data" reason cannot be distinguished from "endpoint is down" in
the registry — both end up as `usage === undefined`. A pool of 5 accounts
under a chatgpt.com outage emits 10 outbound requests per minute (5 active +
5 candidate paths × 2 because `runAutoSwitchOnce` refreshes the active
twice in some control paths).

**Severity.** `P1` because it amplifies provider outages rather than
absorbing them.

### 3. No graceful shutdown or signal handling — `P0 S`

**Evidence.** `runDaemon` is a literal `for(;;)` with `setTimeout`
(`account-service.ts:675-682`). There is no `process.on("SIGTERM", ...)`,
no `AbortController`, no shared `running` flag, no opportunity to flush the
registry on shutdown.

**Diagnosis.** Three concrete failure modes:

1. systemd sends `SIGTERM` on `systemctl --user stop authmux-autoswitch`.
   With `Restart=always` and no `Type=notify` in the unit
   (`service-manager.ts:33-48`), systemd waits `TimeoutStopSec=90s`
   (default) before sending `SIGKILL`. During that window the daemon is
   completely unresponsive and the user thinks it is hung.
2. If a registry write is in flight (`saveRegistry` →
   `fs.writeFile`, `src/lib/accounts/registry.ts:148-152`) when `SIGKILL`
   arrives, the registry can be truncated. There is no atomic rename — see
   issue #14 below and `04-USAGE-AND-QUOTA.md` for the proposal.
3. On macOS, LaunchAgent restarts the process immediately with `KeepAlive
   true` (`service-manager.ts:111-112`). A daemon that crash-loops because
   of an unhandled exception will produce one restart per 30 seconds with
   nothing in the log to indicate why.

**Why `P0`.** Data loss on registry write is a correctness issue even if
small, and the user-visible behavior on `systemctl stop` is "command
appears to hang".

### 4. Service install lacks uninstall verification — `P2 M`

**Evidence.** `disableLinuxService` (`service-manager.ts:71-82`) calls
`systemctl stop`, `systemctl disable`, `rm` the unit file, then
`daemon-reload`. None of these check exit codes. If the user manually
edited the unit, `rm` will silently leave the file. If `daemon-reload`
fails (PID 1 down, exotic), the next `enable` will pick up a stale unit
without noticing.

`disableWindowsService` (`service-manager.ts:165-167`) is a single
`schtasks /Delete /F` with no readback.

`disableMacService` (`service-manager.ts:131-139`) ignores the result of
`launchctl unload` and tolerates a missing plist.

**Diagnosis.** After `config auto disable` the user is told `auto-switch
disabled` (`src/commands/config.ts:71`) regardless of whether the OS
actually believes the unit is gone. `authmux status` does not run a second
probe after disable, so a subsequent `status` call may still report
`service: active` and be technically correct yet confusing.

### 5. No privilege detection on Linux user systemd — `P2 S`

**Evidence.** `enableLinuxService` (`service-manager.ts:50-69`) assumes
`systemctl --user` works. On containers without a user systemd instance
(common in WSL2 default installs, in cron-running CI, and in some headless
Docker images) `systemctl --user daemon-reload` fails with `Failed to
connect to bus: No medium found` and the call throws `systemctl --user
daemon-reload failed`, but the **enable flag in the registry is already
flipped on**. The catch in `setAutoSwitchEnabled`
(`account-service.ts:548-557`) does roll the flag back, which is correct,
but the user has no actionable signal about *why* it failed.

**Diagnosis.** The user experience is `Failed to enable managed auto-switch
service: systemctl --user daemon-reload failed`. There is no detection of
"you are in WSL without `systemd-genie`", no fallback to a
nohup-with-pidfile mode, and no diagnostic for "is your user lingering
enabled" (i.e. `loginctl enable-linger $USER`).

### 6. Hand-written unit/plist templates — `P2 S`

**Evidence.** All three unit files are produced by literal `[...].join("\n")`
inside `service-manager.ts:33-48`, `95-117`, `147-157`. Changing
`KeepAlive`, adding `ProcessType=Background`, switching to `Type=notify`,
or substituting an absolute path for `authmux` requires editing the
generator function rather than a template file.

**Diagnosis.** Three concrete problems:

1. There is no resource-budget hardening (no `MemoryHigh`, no `CPUQuota`)
   because adding it requires a code edit not a config edit.
2. There is no dry-run mode: the user cannot ask "what would you write?"
   without actually writing it.
3. There is no test that compares the rendered unit against a golden file —
   regressions to the unit text would only be caught by manual install.

### 7. No structured logs from the daemon — `P1 S`

**Evidence.** The only print statement in the daemon path is
`src/commands/daemon.ts:30-34` and that fires only on `--once`. The `--watch`
path is silent. `BaseCommand.runSafe` (referenced from
`src/commands/daemon.ts:19`) only logs on error.

**Diagnosis.** Operations on a managed service that prints nothing is
operating blind. The user has no way to answer:

- When did the daemon last evaluate?
- How long did the last refresh take?
- Which account did it consider switching to but reject?
- What was the most recent reason returned by `runAutoSwitchOnce`?

The information is computed (`AutoSwitchRunResult.reason`,
`src/lib/accounts/types.ts:70`) and then discarded.

### 8. Race between manual `use` and daemon `switch` — `P0 M`

**Evidence.** `useAccount` (called from `src/commands/use.ts:37` and
`src/commands/switch.ts:99`) and `runAutoSwitchOnce`
(`account-service.ts:597-667`) both go through `activateSnapshot`
(`account-service.ts:1297-1313`) which:

1. Validates the source snapshot path exists.
2. Calls `fsp.copyFile(source, authPath)` to write `~/.codex/auth.json`.
3. Writes the current-name marker.

There is no file lock around the registry, no lock around `auth.json`, and
no coordination between processes that may both be writing concurrently.

**Diagnosis.** The most realistic scenario is a user running `authmux use
work` in a terminal at the same moment the daemon evaluates. Because the
daemon also calls `loadReconciledRegistry` / `persistRegistry` on every
tick (`account-service.ts:598`, `624`, `649`, `659`) and the user command
also persists, the *last* writer wins for the registry, but the *order* in
which `auth.json` gets written is not deterministic. The user may run
`codex` immediately after `authmux use work` and unknowingly hit a
daemon-installed account.

**Why `P0`.** This is the failure mode most likely to be reported as "the
daemon switched my account without telling me" and the hardest to reproduce
because of the timing.

### 9. Empty catch in `runDaemon` swallows errors — `P1 S`

**Evidence.** `account-service.ts:676-680`:

```ts
try {
  await this.runAutoSwitchOnce();
} catch {
  // keep daemon alive
}
```

**Diagnosis.** This is correct in intent — the loop must survive
transient errors — but is wrong in execution. The error is neither logged,
classified, nor counted. A daemon that throws on every tick because the
registry is corrupt will silently loop forever doing nothing. There is no
circuit breaker on the *daemon itself*; only on the per-account health
tracker (`src/lib/account-health.ts:18-58`).

### 10. `auto-switch` and daemon use independent state — `P2 M`

**Evidence.** `auto-switch.ts:17` calls `selectBestAccount(names)` from
`account-health.ts:206-222`. `runAutoSwitchOnce` calls
`refreshAccountUsage` and `usageScore`. The two functions do not share
inputs and do not consult each other's output. `recordSuccess` and
`recordFailure` are only called from `switch.ts:100,104`, `use.ts:38,42`,
and `auto-switch.ts:24,28` — never from the daemon path.

**Diagnosis.** A daemon-driven switch does not update the health tracker,
which means:

- `forecast`/`check` output drifts from reality (the daemon-installed
  active account is not credited for its successful activation).
- The circuit breaker in `account-health.ts` never opens against an account
  the daemon repeatedly fails to switch to because no `recordFailure` is
  called in the daemon's catch path.

### 11. Daemon does not mirror to Kiro or Hermes — `P2 S`

**Evidence.** `src/commands/switch.ts:108-125` mirrors a successful switch
to `hermes-agent` and Kiro. `src/commands/use.ts:48-53` mirrors to Kiro.
`runAutoSwitchOnce` (`account-service.ts:656-666`) calls `activateSnapshot`
directly and returns. There is no mirror call.

**Diagnosis.** A user running both Codex and Kiro side by side will see
Codex flip to a different account while Kiro keeps using the prior one.
Whether mirroring is desirable from the daemon is a policy choice; today it
is not even a choice — it is simply absent.

### 12. Threshold defaults are very low — `P3 S`

**Evidence.** `DEFAULT_THRESHOLD_5H_PERCENT = 10` and
`DEFAULT_THRESHOLD_WEEKLY_PERCENT = 5`
(`src/lib/accounts/types.ts:1-2`).

**Diagnosis.** A user who turns auto-switch on without reading
`config.ts --help` will only see switches at the very tail end of the
window, which is the most disruptive time (active conversation in flight).
Defaults probably want to be in the `20-25% / 15%` range with documentation
explaining the tradeoff.

### 13. `runAutoSwitchOnce` re-refreshes the active account inside the
candidate loop — `P3 S`

**Evidence.** `account-service.ts:615-618` refreshes the active account.
`account-service.ts:633-646` iterates candidates and skips the active one.
On a 5-account pool with API mode enabled, the active account contributes
1 request, plus 4 candidate requests, plus a proxy fetch
(`refreshAccountUsage` may call `fetchUsageFromProxy` when invoked via
the list path; the daemon path does not pass `proxyUsageIndex` so each
call goes direct to the API). No batching, no shared client.

**Diagnosis.** Wasted requests, no shared connection pool, no shared
proxy index. See `07-USAGE-REFRESH-AND-API.md` for the HTTP client
proposal.

### 14. No atomic write of `registry.json` — `P0 S`

**Evidence.** `saveRegistry` (`src/lib/accounts/registry.ts:148-152`) calls
`fs.writeFile` directly without a temp-rename. A `SIGKILL` mid-write (see
issue #3) leaves a partially-written file. `loadRegistry`
(`registry.ts:137-146`) catches all JSON parse errors and silently returns
`createDefaultRegistry()` — meaning a crash mid-write would reset all
thresholds, usage cache, and pin metadata back to defaults the next time
the daemon ticks.

**Diagnosis.** `P0`. Silent reset is worse than a loud failure because the
user may not notice until the daemon's next switch is wrong.

### 15. `status` does not show last-run information — `P3 S`

**Evidence.** `StatusReport` (`src/lib/accounts/types.ts:58-64`) has five
fields, none of which is temporal. There is no `lastEvaluatedAt`,
`lastSwitchedAt`, or `lastReason`. `status.ts:6-13` prints only what is
in the report.

**Diagnosis.** Operators have no way to confirm the daemon is *doing
anything* without reading the systemd journal (which itself has no
structured logs — see #7).

### 16. Threshold flags are integer-only — `P3 S`

**Evidence.** `src/commands/config.ts:22-30` declares `5h` and `weekly` as
`Flags.integer`. Sanitiser rounds to nearest integer
(`registry.ts:16-21`).

**Diagnosis.** Probably correct for UX (no point in `12.5%`) but worth
documenting; some users will assume `--5h 0.1` means 10%.

---

## Proposed policy engine

The current code has *one* policy ("switch when below threshold, pick the
highest-scoring candidate, break ties by current"). Anything more complex
than that requires the same logic to live somewhere isolatable so it can be
tested without a real registry and replaced for users with different needs.
This section proposes the smallest interface that lets the existing policy
become "the default `Policy` implementation" and lets new strategies plug in.

### `Policy` interface

```ts
export interface PolicyInputs {
  /** Wall-clock seconds; injected so tests can pin time. */
  nowSeconds: number;
  /** Snapshot list, already validated and ordered by user preference. */
  accounts: ReadonlyArray<AccountState>;
  /** The account currently bound to ~/.codex/auth.json, if any. */
  activeAccountName: string | undefined;
  /** Daemon-wide config (thresholds, hysteresis, cooldown, weights). */
  config: PolicyConfig;
  /** Per-terminal or persistent pin that should outrank the policy. */
  pin: PolicyPin | undefined;
  /** Recent decision history for cooldown / churn detection. */
  recentDecisions: ReadonlyArray<PolicyDecision>;
}

export interface AccountState {
  name: string;
  usage: UsageSnapshot | undefined;
  health: AccountHealth; // from account-health.ts
  weight: number;        // default 1
  flags: { isPinned: boolean; isQuarantined: boolean };
}

export type PolicyOutcome =
  | { kind: "noop"; reason: string }
  | { kind: "switch"; target: string; reason: string; confidence: number }
  | { kind: "defer"; until: number; reason: string };

export interface Policy {
  readonly name: string;
  readonly version: number;
  decide(inputs: PolicyInputs): PolicyOutcome;
}
```

The decision is a *value*, not a side effect. The daemon runtime is the
only place that executes the outcome by calling `activateSnapshot`. This
makes every policy unit-testable with a fake clock and a fixture pool.

### Built-in strategies

| Name                    | Behavior |
| ----------------------- | -------- |
| `LowestRemainingHealthy` | Current default. Switches when active is below `enterThreshold`, picks the candidate with the *highest* `usageScore` *and* `health.usable`. Hysteresis: does not switch back within `exitThreshold` of the original. |
| `RoundRobin`            | Switches on a fixed cadence (e.g. every 4 hours) ignoring usage, useful for users who want predictable session distribution. Honors `quarantined` flag. |
| `Weighted`              | Probability-weighted pick from healthy candidates using `account.weight`. Defaults to `1` per account; user may set `5` on a paid account and `1` on free fallbacks. |
| `PinnedFallback`        | Always honors the active pin until the pinned account is exhausted, then falls back to `LowestRemainingHealthy` over the remaining pool. |
| `ForecastAware`         | Reads `EWMA` forecast from `forecast.ts` (proposed extension; see `07-USAGE-REFRESH-AND-API.md` §Forecasting) and refuses to switch *to* an account predicted to be exhausted within `lookaheadMinutes`. |

`LowestRemainingHealthy` is the only strategy that needs to ship in the
first migration step. The others can land as optional plug-ins.

### Hysteresis bands

The single threshold becomes two:

```ts
interface ThresholdBand {
  enterAt: number;    // switch *away* when remaining < enterAt
  exitAt: number;     // switch *back* only when remaining >= exitAt
}
```

With `5h: { enterAt: 10, exitAt: 30 }`, the daemon will switch off an
account when it drops below 10% but will not consider switching back to it
until it has recovered above 30%. Both numbers are bounded by
`enterAt < exitAt <= 100`.

The two-band approach eliminates flapping without requiring a cooldown
timer (though the cooldown below is still useful for other reasons).

### Cooldown after switch

```ts
interface CooldownPolicy {
  minSecondsBetweenSwitches: number;        // hard floor (default: 300)
  perAccountQuarantineSeconds: number;      // do not pick this account again for N seconds
  globalChurnWindow: { count: number; seconds: number; quarantineAll: number };
}
```

`globalChurnWindow` is a kill-switch: "if we have switched 5 times in the
last 600 seconds, refuse to switch for the next 1800 seconds and log
`POLICY_CHURN_DETECTED`". This is the daemon's own circuit breaker, sitting
above the per-account `CircuitBreaker` in `account-health.ts`.

### Per-terminal pin override

Pins are addressed in detail in a separate slice of the protocol. For the
policy engine, the contract is:

- If `PolicyInputs.pin` is set and the pin target is healthy, the policy
  **must** return `{ kind: "noop", reason: "pin-active" }` when the active
  account matches the pin.
- If the pin target is not yet active, the policy **must** return
  `{ kind: "switch", target: pin.target, reason: "honoring-pin" }`.
- Only when the pin target is unhealthy does the strategy take over.

This makes pinning the highest-priority signal in every strategy without
each strategy re-implementing it.

### Forecast input

`forecast.ts` (`src/commands/forecast.ts:17-23`) currently calls
`forecastAccounts(names)` from `src/lib/account-health.ts:224-227`, which
sorts accounts by their *health score* — not by predicted future usage.

The proposed extension is a `Forecaster` interface (full detail in
`07-USAGE-REFRESH-AND-API.md` §Forecasting) that emits

```ts
interface ForecastReading {
  accountName: string;
  predictedRemainingIn: (deltaSec: number) => number;  // 0..100
  confidence: number; // 0..1
}
```

`ForecastAware` uses this to refuse switching to an account where
`predictedRemainingIn(lookaheadMinutes * 60) < exitThreshold * 0.5`.

### Sample built-in implementation

Below is the reference shape of `LowestRemainingHealthy` written
deliberately small so the test surface is bounded.

```ts
export class LowestRemainingHealthy implements Policy {
  readonly name = "lowest-remaining-healthy";
  readonly version = 1;

  constructor(private readonly logger: PolicyLogger = noopLogger) {}

  decide(inputs: PolicyInputs): PolicyOutcome {
    const { activeAccountName, accounts, config, recentDecisions, nowSeconds, pin } = inputs;

    // 0. Pin always wins (see "Per-terminal pin override").
    if (pin) {
      if (activeAccountName === pin.target) {
        return { kind: "noop", reason: "pin-active" };
      }
      const target = accounts.find((a) => a.name === pin.target);
      if (target && target.health.usable) {
        return { kind: "switch", target: pin.target, reason: "honoring-pin", confidence: 1 };
      }
    }

    // 1. Cooldown floor.
    const lastSwitch = recentDecisions.find((d) => d.kind === "switch");
    if (lastSwitch && nowSeconds - lastSwitch.atSeconds < config.cooldown.minSecondsBetweenSwitches) {
      return { kind: "defer", until: lastSwitch.atSeconds + config.cooldown.minSecondsBetweenSwitches, reason: "cooldown" };
    }

    // 2. Global churn breaker.
    const w = config.cooldown.globalChurnWindow;
    const recentSwitches = recentDecisions.filter(
      (d) => d.kind === "switch" && nowSeconds - d.atSeconds < w.seconds,
    );
    if (recentSwitches.length >= w.count) {
      return { kind: "defer", until: nowSeconds + w.quarantineAll, reason: "global-churn" };
    }

    // 3. Need an active account to compare against.
    const active = accounts.find((a) => a.name === activeAccountName);
    if (!active) {
      return { kind: "noop", reason: "no-active-account" };
    }

    // 4. Has the active account fallen below the enter threshold?
    const activeRemaining = scoreRemaining(active.usage, nowSeconds);
    if (typeof activeRemaining !== "number") {
      return { kind: "noop", reason: "no-usage-data-for-active" };
    }
    if (activeRemaining >= config.bands.fiveHour.enterAt) {
      return { kind: "noop", reason: "active-above-enter-threshold" };
    }

    // 5. Search for the best candidate that satisfies the *exit* band.
    let best: { name: string; score: number } | undefined;
    for (const a of accounts) {
      if (a.name === active.name) continue;
      if (!a.health.usable) continue;
      const s = scoreRemaining(a.usage, nowSeconds);
      if (typeof s !== "number") continue;
      if (s < config.bands.fiveHour.exitAt) continue;
      if (!best || s > best.score) best = { name: a.name, score: s };
    }

    if (!best) {
      return { kind: "noop", reason: "no-candidate-above-exit-band" };
    }

    return {
      kind: "switch",
      target: best.name,
      reason: `active-at-${activeRemaining}-below-${config.bands.fiveHour.enterAt}`,
      confidence: Math.min(1, (best.score - config.bands.fiveHour.exitAt) / 30),
    };
  }
}
```

The two helpers `scoreRemaining` and `noopLogger` are deliberately omitted;
they collapse into the existing `usageScore` (`usage.ts:511-519`) and a
minimal `console.warn` shim.

### Where the policy plugs into the runtime

`runAutoSwitchOnce` is rewritten to:

1. Build `PolicyInputs` from the registry and account-health state.
2. Call `policy.decide(inputs)`.
3. Translate the `PolicyOutcome` into a side effect:
   - `noop` → return a no-op `AutoSwitchRunResult` with `reason` matching
     the outcome reason.
   - `defer { until }` → return a no-op, daemon respects `until` for the
     next sleep target.
   - `switch { target }` → call `activateSnapshot(target)`, append a
     `PolicyDecision` to the rolling history, optionally mirror to
     Kiro/Hermes (see issue #11).

The decision side effect is the **only** place that mutates the activate
state; the policy itself stays pure.

---

## Daemon runtime

The runtime is the "how" that surrounds the policy engine. It should be
small enough to be reviewed in one sitting and explicit enough that operators
can reason about its lifecycle.

### Single-instance lock

**Problem.** Two `authmux daemon --watch` processes started by a confused
user (or by both systemd and an interactive shell) both think they own the
auto-switch loop.

**Proposal.** A lockfile at `<codex>/multi-auth/daemon.lock` containing the
PID and start time. Acquisition uses `O_CREAT | O_EXCL` write, then
`flock(LOCK_EX | LOCK_NB)` on POSIX. On Windows, an exclusive
`fs.open(..., "wx")` on the file is sufficient; PID identity comes from the
file contents.

```ts
interface DaemonLock {
  /** Throws if another live daemon holds the lock. */
  acquire(): Promise<void>;
  /** Idempotent; safe to call from shutdown hooks. */
  release(): Promise<void>;
  /** Best-effort liveness probe: PID exists and matches start time. */
  describe(): Promise<{ pid: number; startedAt: string } | undefined>;
}
```

A "stale lock" (PID no longer alive) is reclaimed automatically with a
warning logged to the structured log (see below).

### Health endpoint

**Problem.** Operators have no way to ask the daemon "are you alive and
what did you just do?" without reading service-manager state, which only
answers "is the process running".

**Proposal.** A Unix domain socket at
`<codex>/multi-auth/daemon.sock` (POSIX) or a TCP listener on
`127.0.0.1:<ephemeral>` written to `daemon.lock` (Windows). Default for
both platforms is "loopback only, no auth".

The line protocol is newline-delimited JSON. Each line is a request, each
response is one line. There is no streaming and no long-poll.

| Request | Response |
| ------- | -------- |
| `{ "cmd": "ping" }` | `{ "ok": true, "uptimeSec": 8421 }` |
| `{ "cmd": "status" }` | `{ "ok": true, "lastDecision": { ... }, "policy": "lowest-remaining-healthy" }` |
| `{ "cmd": "switch", "target": "work" }` | `{ "ok": true, "result": { "switched": true, "fromAccount": "old", "toAccount": "work" } }` |
| `{ "cmd": "reload" }` | `{ "ok": true }` after re-reading the registry without restarting the process |
| `{ "cmd": "quit" }` | `{ "ok": true }`, then closes the socket and exits cleanly |

`authmux status` becomes:

1. If `daemon.sock` exists and `{ cmd: "ping" }` succeeds, render the live
   `status` response.
2. Otherwise, fall back to the current `getStatus()` flow which probes the
   OS service.

### IPC contract (full)

The full schema lives in `src/lib/accounts/daemon-ipc.ts` (proposed). Each
request includes:

```ts
interface DaemonRequest {
  id: string;            // client-chosen, echoed in response
  cmd: "ping" | "status" | "switch" | "reload" | "quit";
  args?: Record<string, unknown>;
  authToken?: string;    // ignored on loopback-only sockets
}
```

Responses:

```ts
interface DaemonResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}
```

Error codes:

| Code | When |
| ---- | ---- |
| `ENOTAUTH` | Reserved for the day we add token auth. |
| `EUNKCMD` | `cmd` not recognized. |
| `EBADARGS` | `args` failed validation. |
| `EBUSY` | Daemon currently performing an evaluation; client may retry. |
| `EPOLICY` | Policy refused the operation (e.g. cooldown). |

### Graceful reload of config

`reload` triggers a re-read of the registry without restarting. The
implementation is:

```ts
class DaemonRuntime {
  private currentConfig: PolicyConfig;
  // ...
  private async handleReload(): Promise<void> {
    const registry = await loadRegistry();
    this.currentConfig = deriveConfig(registry);
    this.logger.info("config-reloaded", { thresholds: this.currentConfig.bands });
  }
}
```

Crucially, `reload` does **not** force an immediate evaluation; the next
tick will pick up the new config. Forcing an evaluation is `cmd: "switch"`
(with no target, meaning "let the policy decide now").

### Backoff and jitter

The evaluation tick is currently 30s fixed. Proposed schedule:

```ts
const BASE_TICK_MS = 30_000;
const MAX_TICK_MS = 5 * 60_000;

function nextTick(state: TickState): number {
  if (state.lastWasError) {
    const expo = Math.min(MAX_TICK_MS, BASE_TICK_MS * 2 ** state.consecutiveErrors);
    return expo + Math.floor(Math.random() * expo * 0.2); // 20% jitter
  }
  if (state.lastOutcome.kind === "defer") {
    return Math.max(state.lastOutcome.until - nowSec(), 1) * 1000;
  }
  return BASE_TICK_MS + Math.floor(Math.random() * 5_000); // small jitter
}
```

Jitter prevents N daemons on the same network (e.g. an enterprise install)
from all hitting `chatgpt.com/backend-api/wham/usage` at the same wall
clock second.

### Resource budget

Self-throttle when the process exceeds resource caps. Caps are advisory,
not enforced; the daemon merely *backs off* harder.

```ts
interface ResourceBudget {
  maxRssMb: number;      // default 96
  maxCpuPercentRolling: number; // default 5% over 60s
  onExceed: "log" | "log-and-throttle" | "log-and-restart";
}
```

`log-and-throttle` doubles the tick interval until RSS drops back under
the cap. `log-and-restart` exits with code `0` so the service supervisor
restarts a clean process. This is the daemon's own answer to the slow
memory creep that V8 inevitably produces.

### Concurrency model

Inside a single daemon process, the inner loop is strictly single-threaded
JavaScript. Network refresh is parallelised via `Promise.all` with a
concurrency cap (already `LIST_USAGE_REFRESH_CONCURRENCY = 6` at
`account-service.ts:57`, see `07-USAGE-REFRESH-AND-API.md` for the
proposed `UsageHttpClient`). The IPC server runs on the same event loop;
heavy operations (`switch`) acquire an internal mutex that is also held by
the tick handler to prevent racing.

### Lifecycle (state machine)

```
            ┌─────────┐
   start →  │ Booting │
            └────┬────┘
                 │ acquire lock ok
                 ▼
            ┌─────────┐    SIGTERM    ┌──────────┐
            │ Running │ ────────────► │ Draining │
            └────┬────┘                └────┬────┘
                 │ unrecoverable             │ ipc drained
                 ▼                            ▼
            ┌─────────┐                  ┌─────────┐
            │ Crashed │                  │ Stopped │
            └─────────┘                  └─────────┘
```

`Draining` rejects new IPC requests, waits for the in-flight tick to
finish (max 10s), flushes the registry, releases the lock, then exits.

---

## Service install hardening

The current installer works; this section is about making it correct and
*re-runnable*. The default goals are:

- A user can `enable` and `disable` repeatedly without leaving leftover
  units on the system.
- A user on an unusual environment (no user systemd, locked-down Windows)
  gets a clear error instead of a half-installed state.
- The unit text is reviewable in the source tree, not generated by string
  concatenation inside the installer.

### Privilege detection

Before writing any unit, `enableManagedService` should call a
platform-specific probe:

| Platform | Probe |
| -------- | ----- |
| Linux    | `systemctl --user is-system-running` returns non-error; `XDG_RUNTIME_DIR` exists and is writable. If neither, advise `loginctl enable-linger`. |
| macOS    | `~/Library/LaunchAgents` is writable; `launchctl print user/$UID` returns 0. If not, advise re-login. |
| Windows  | `whoami /priv` includes `SeBatchLogonRight` and `schtasks /Query /TN \Microsoft\Windows` returns 0. |

The probe returns a `PrivilegeReport` and the installer fails fast with a
diagnosis-grade error:

```ts
interface PrivilegeReport {
  ok: boolean;
  reason?: string;
  suggestedFix?: string;
}
```

### macOS LaunchAgent

Augment the plist with:

- `<key>ProcessType</key><string>Background</string>` — tells launchd to
  treat the process as long-running and lower its priority appropriately.
- `<key>KeepAlive</key>` becomes a dict with `Crashed: true,
  SuccessfulExit: false` so a clean exit (e.g. shutting down for upgrade)
  is not relaunched immediately.
- `<key>StandardOutPath</key>` and `<key>StandardErrorPath</key>` pointing
  at `~/Library/Logs/authmux/daemon.log` so structured logs land in a
  consistent place.
- `<key>EnvironmentVariables</key>` carrying `AUTHMUX_DAEMON=1` so the
  daemon process can detect that it was started by launchd.

### Linux systemd

Augment the user unit with:

```ini
[Service]
Type=simple
Restart=on-failure
RestartSec=2s
StartLimitIntervalSec=300
StartLimitBurst=10
MemoryHigh=128M
MemoryMax=192M
CPUQuota=10%
StandardOutput=append:%h/.local/share/authmux/daemon.log
StandardError=append:%h/.local/share/authmux/daemon.log
WatchdogSec=120s
NotifyAccess=main
Environment=AUTHMUX_DAEMON=1
```

`WatchdogSec` requires `Type=notify` and a `sd_notify(WATCHDOG=1)` heartbeat
from the daemon. Implementing this needs a small native dependency (or a
`socket(SOCK_DGRAM)` to `$NOTIFY_SOCKET`); the protocol is trivial. The
benefit is automatic restart if the daemon livelocks.

### Windows

The current Scheduled Task approach has known weaknesses:

- Tasks set with `/SC ONLOGON` do not run if no user is logged in.
- Task Scheduler has no native restart-on-failure that matches systemd's
  `Restart=on-failure`.
- The state probe relies on string matching on `schtasks /Query /V /FO LIST`
  output which is locale-dependent (`running` vs. `In Esecuzione` on
  Italian Windows).

Short-term hardening:

- Use `/RL HIGHEST` only when the user opts in explicitly; default is
  `LIMITED`.
- Use `/SC ONLOGON /MO 1 /RI 5 /DU 9999:00` plus a wrapper batch that
  re-runs `authmux daemon --watch` on exit code != 0.
- Probe via `schtasks /Query /TN <name> /XML` and parse XML instead of
  scraping `LIST` output.

Long-term recommendation: ship a Windows Service shim. Two viable
implementations are:

1. `node-windows` — small, well-tested, but heavy dependency for a CLI.
2. A Rust shim (~150 LOC of `windows-service` crate) that runs `authmux
   daemon --watch` as a child process and forwards SCM events.

The Rust shim is preferred for distribution because it does not add a
runtime dependency to the npm package and because the wrapper itself can
be signed independently.

### Uninstall verification

`disableManagedService` returns void today. Proposed signature:

```ts
type DisableReport = {
  removed: boolean;
  leftovers: string[];   // file paths or registry keys that survived removal
  warnings: string[];
};

export async function disableManagedService(): Promise<DisableReport>;
```

The CLI surface (`config auto disable`) reports any non-empty `leftovers`
prominently:

```
auto-switch disabled
warning: leftover unit at ~/.config/systemd/user/authmux-autoswitch.service
  → run `rm` manually or re-run `authmux config auto disable --force`
```

### Templated unit files

Move the per-platform unit text out of `service-manager.ts` and into a new
`assets/service/` directory in the repository:

```
assets/service/
  linux/authmux-autoswitch.service.tmpl
  darwin/com.codex.auth.autoswitch.plist.tmpl
  windows/authmux-autoswitch.xml.tmpl
```

Templates use a minimal substitution syntax (`{{authmux_bin}}`,
`{{home_dir}}`, `{{log_dir}}`). The installer reads the template, performs
substitution, and writes the result. The same files are also the source
material for unit tests that diff rendered output against a golden.

The bundled package ships the templates via `package.json` `"files"`. At
runtime, `serviceManager.renderTemplate(platform)` reads from the bundled
location.

### Dry-run mode

```sh
authmux config auto enable --dry-run
```

Prints the rendered unit and the commands that *would* be executed without
making any changes. This is essential for users in regulated environments
who must review system changes before they happen.

---

## Migration plan

The transition from the current single-function loop to the policy/runtime
pair is broken into three phases. Each phase is independently shippable.

### Phase 1 — internalise the current behavior (P0/P1 fixes)

Goal: stop the bleeding without changing user-visible behavior.

| Change | Files | Tag |
| ------ | ----- | --- |
| Atomic registry writes (temp + rename) | `src/lib/accounts/registry.ts` | `P0 S` |
| `SIGTERM`/`SIGINT` handlers with 10s drain | `src/lib/accounts/account-service.ts` | `P0 S` |
| Wrap `runAutoSwitchOnce` errors and log to stderr in JSON | `account-service.ts`, new `src/lib/log.ts` | `P1 S` |
| Single-instance lockfile | new `src/lib/accounts/daemon-lock.ts` | `P1 S` |
| Disable returns `DisableReport` with leftovers | `service-manager.ts` | `P2 S` |
| Re-probe service state after enable/disable; surface in CLI | `service-manager.ts`, `src/commands/config.ts` | `P2 S` |

Acceptance: existing tests still pass; new tests cover registry atomicity
(SIGKILL mid-write) and graceful shutdown timing.

### Phase 2 — extract the policy

Goal: refactor `runAutoSwitchOnce` into `Policy` + executor.

| Change | Files | Tag |
| ------ | ----- | --- |
| Define `Policy`, `PolicyInputs`, `PolicyOutcome` types | new `src/lib/policy/types.ts` | `P1 S` |
| Implement `LowestRemainingHealthy` as default | new `src/lib/policy/lowest-remaining-healthy.ts` | `P1 M` |
| Add hysteresis fields to registry; migrate on read | `registry.ts`, `types.ts` | `P1 S` |
| Rewrite `runAutoSwitchOnce` as `executePolicy(decision)` | `account-service.ts` | `P1 M` |
| Add cooldown + global churn breaker | `policy/lowest-remaining-healthy.ts` | `P1 S` |
| Daemon writes `PolicyDecision` history to registry | `account-service.ts`, `registry.ts` | `P2 S` |
| Mirror Kiro/Hermes on daemon switch (with opt-out) | `account-service.ts` | `P2 S` |

Migration of existing users: `thresholdNN_Percent` becomes
`bands.fiveHour.enterAt`; the existing single value is duplicated into both
`enterAt` and `exitAt` on first read so behavior is preserved until the
user explicitly sets a band.

### Phase 3 — daemon runtime and IPC

Goal: turn the watch loop into a supervisable runtime with a control plane.

| Change | Files | Tag |
| ------ | ----- | --- |
| `DaemonRuntime` class with state machine | new `src/lib/accounts/daemon-runtime.ts` | `P1 M` |
| Unix socket / TCP IPC server | new `src/lib/accounts/daemon-ipc.ts` | `P1 M` |
| Update `status` to prefer live IPC over OS probe | `src/commands/status.ts`, `account-service.ts` | `P2 S` |
| New commands: `daemon ping`, `daemon switch`, `daemon reload`, `daemon stop` | `src/commands/daemon.ts` (split or subcommand) | `P2 S` |
| Backoff + jitter in tick scheduler | `daemon-runtime.ts` | `P2 S` |
| Resource budget self-throttle | `daemon-runtime.ts` | `P3 S` |
| Templated unit files in `assets/service/` | new `assets/service/`, `service-manager.ts` | `P2 M` |
| systemd `WatchdogSec` + `sd_notify` | `daemon-runtime.ts`, `service-manager.ts` | `P3 S` |
| Privilege probes per platform | `service-manager.ts` | `P2 S` |
| Dry-run flag for `config auto enable` | `src/commands/config.ts`, `service-manager.ts` | `P3 S` |

### Cross-phase: `auto-switch` deprecation

`src/commands/auto-switch.ts` is the legacy health-driven command. It
predates the registry and uses an independent state model
(`account-health.ts`). Plan:

1. Phase 2 — change `auto-switch` to delegate to the new policy
   (`LowestRemainingHealthy.decide`) so both code paths produce identical
   results.
2. Phase 3 — print a deprecation notice on `auto-switch` invocation
   pointing at `daemon --once`.
3. Next major release — remove `src/commands/auto-switch.ts`.

The `account-health.ts` module itself stays; it remains the source of
`AccountHealth` for the `PolicyInputs.accounts[i].health` field.

---

## Rollout

Rollouts for the daemon work require special care because the failure mode
of "auto-switch fires on the wrong account" is hard to detect and embarrassing
to revert.

### Pre-flight (every phase)

1. Run the full test suite (`npm test`) with TS strict.
2. Run the daemon under `--once` against a fixture registry that contains
   the new fields; confirm the no-op result.
3. Run the daemon under `--watch` for 10 minutes with a fake clock and a
   stubbed usage refresh; confirm decision history matches expected
   sequence.

### Phase 1 rollout

- Ship as a patch release.
- Release notes call out the atomic-write change.
- Existing users see no behavior change.

### Phase 2 rollout

- Ship as a minor release.
- Registry version stays at `1`; new fields are additive and have safe
  defaults.
- Add a `config auto bands --5h 10,30 --weekly 5,20` migration command for
  users who want explicit bands.
- The first ten daemon ticks after upgrade log `policy-upgrade-detected`
  with the migration result.

### Phase 3 rollout

- Ship as a minor or major release depending on whether `status` JSON
  output stability is a contract (it is not, today — `status.ts:6-13` only
  prints text).
- The IPC socket is created with `0600` permissions and lives under the
  user's HOME; no system-wide socket is created.
- On macOS, document the system permission prompt for "authmux would like
  to control launchctl" if a security tool intercepts it.

### Telemetry (opt-in)

A future slice will propose an opt-in local telemetry log
(`<codex>/multi-auth/telemetry.jsonl`) that records every
`PolicyDecision`. This is the only way to detect regressions in policy
behavior without asking users to read systemd logs. Strict local-only;
never sent off-machine. See the privacy section in
`07-USAGE-REFRESH-AND-API.md`.

---

## Testing

The current `src/commands/daemon.ts` and `runAutoSwitchOnce` are difficult
to test because they depend on real time, real disk, and a live network.
The proposed split makes both pieces independently testable.

### Fake clock

A `Clock` interface (`{ nowSec(): number; sleepMs(ms): Promise<void> }`)
is injected into the daemon runtime and into every call site that uses
`Date.now()` or `setTimeout` today. The test harness provides
`AdvancingClock` (the test advances time explicitly with `clock.advance(ms)`)
which is enough to deterministically reproduce flapping scenarios, cooldown
expiry, and global churn windows.

### Fake provider

`UsageProvider` interface (proposed in `07-USAGE-REFRESH-AND-API.md`) is
mocked with a fixture that returns precomputed `UsageSnapshot` per account
per "clock tick". The fixture supports modes such as:

| Mode | Behavior |
| ---- | -------- |
| `stable` | Returns the same snapshot until the test changes it. |
| `decaying(decayPercentPerTick)` | Linearly drops remaining percent. |
| `random(seed)` | Deterministic pseudo-random for property tests. |
| `outage` | Returns `undefined` to simulate API down. |

### In-memory FS

`fs` calls in `registry.ts` and `service-manager.ts` route through a thin
adapter (`FileStore`). The test harness substitutes
`InMemoryFileStore` so registry-write atomicity, lock acquisition, and
unit-file rendering are all unit-testable without touching the real
filesystem.

### Integration test

Boot the daemon in a sandbox:

```ts
const env = await createSandbox({
  accounts: ["work", "personal"],
  registry: { autoSwitchEnabled: true, bands: { fiveHour: { enterAt: 10, exitAt: 30 } } },
  clock,
  usageProvider: new ScriptedUsageProvider([
    { tick: 0, work: snapshot(5), personal: snapshot(80) },   // expect switch
    { tick: 1, work: snapshot(15), personal: snapshot(70) },  // no switch back
    { tick: 2, work: snapshot(40), personal: snapshot(60) },  // still no switch back
  ]),
});

await env.runDaemonTicks(3);

expect(env.decisions).toMatchObject([
  { kind: "switch", target: "personal" },
  { kind: "noop", reason: "active-above-enter-threshold" },
  { kind: "noop", reason: "active-above-enter-threshold" },
]);
```

This shape catches the flapping regression directly and would have failed
on the current code (which would have switched back at tick 1 because the
single threshold path has no exit band).

### Property tests

The policy is pure (`decide(inputs): outcome`) and therefore amenable to
property-based testing:

- Property 1 — *cooldown respected*: for any sequence of inputs, two
  consecutive `switch` outcomes are at least
  `config.cooldown.minSecondsBetweenSwitches` apart.
- Property 2 — *pin sovereignty*: if `pin` is set and the pin target is
  healthy, the outcome is either `noop` (pin active) or `switch` to the
  pin target. Never another target.
- Property 3 — *no flap inside band*: if active drops below `enterAt` and
  the only candidate is between `enterAt` and `exitAt`, the outcome is
  `noop` (not a switch to an account that is also in the danger zone).
- Property 4 — *global churn breaker fires*: if `count` switches happen
  within `seconds`, the next outcome is `defer` for `quarantineAll`
  seconds.

### Service install tests

Per-platform, render the unit template against fixed inputs and diff
against a golden file. The diff catches accidental whitespace changes that
systemd / launchd / Task Scheduler can be picky about.

For end-to-end install behavior, the per-platform install commands are
mocked via `runCommand`: tests assert that the correct sequence of
`systemctl` / `launchctl` / `schtasks` calls is issued with the correct
arguments. Real install is exercised by a CI matrix
(`linux-systemd`, `macos`, `windows`) that runs `enableManagedService`,
verifies the unit is loaded, and runs `disableManagedService` followed by
a leftover scan.

### Coverage targets

- `src/lib/policy/*` — 95% lines, 100% branches.
- `src/lib/accounts/daemon-runtime.ts` — 90% lines.
- `src/lib/accounts/daemon-ipc.ts` — 90% lines.
- `src/lib/accounts/service-manager.ts` — 80% lines (real install paths
  are exercised by CI, not unit tests).
- `src/lib/accounts/registry.ts` — 95% lines, atomic-write fault injection.

---

## Open questions

- **Should the daemon mirror to Kiro / Hermes?** The current `switch`
  command does (`src/commands/switch.ts:108-125`) but the daemon does not
  (issue #11). Mirroring is a side effect that takes the user's other
  tools out from under them silently. A per-mirror opt-in flag in the
  registry (`mirrors: { kiro: true, hermes: false }`) is the proposed
  middle ground; default `kiro: true, hermes: false` because Kiro is
  user-visible and Hermes is internal tooling.
- **Where does the activity log live?** Two options: structured JSONL at
  `<codex>/multi-auth/daemon.log` (own format), or stdout consumed by the
  service supervisor (systemd journal / launchd unified log / Event
  Viewer). The latter is more idiomatic but harder for `authmux status` to
  read back. Proposal: write JSONL to both and let the supervisor pick up
  stdout for users who configure it.
- **Is `auto-switch` worth keeping as a command name?** The historical
  health-based command predates the daemon-based one and the two share
  no state. Either we deprecate `auto-switch` (current proposal) or we
  fold the daemon into `auto-switch run`. The current naming
  (`auto-switch` vs. `daemon`) is confusing for new users.
- **Does the daemon need a JSON output mode for `status`?** Today
  `status.ts:9-12` only prints text. A `--json` flag is trivial to add and
  unblocks downstream tooling (taskbar widgets, IDE plugins).
- **How aggressively should the runtime self-restart?** `log-and-restart`
  on resource breach is convenient but masks real leaks. The default
  should be `log-and-throttle` with `log-and-restart` opt-in.

---

## Glossary

| Term | Meaning in this document |
| ---- | ------------------------ |
| **Active account** | The snapshot currently copied to `~/.codex/auth.json`. |
| **Activate** | Copy a snapshot to `auth.json` and update the current-name marker. |
| **Band** | The pair `(enterAt, exitAt)` defining a hysteresis region for a usage window. |
| **Candidate** | Any saved account other than the active one. |
| **Cooldown** | Minimum elapsed seconds between two consecutive `switch` outcomes. |
| **Daemon** | The long-running `authmux daemon --watch` process supervised by the OS. |
| **Decision** | The `PolicyOutcome` produced by `Policy.decide`. |
| **Drain** | Phase where the runtime stops accepting new work and finishes in-flight work. |
| **Evaluation** | One pass of `Policy.decide` + executor. |
| **Flapping** | Repeated switches between two or more accounts within a short window. |
| **Hysteresis** | The gap between enter and exit thresholds that prevents oscillation. |
| **Lock** | The single-instance file lock at `<codex>/multi-auth/daemon.lock`. |
| **Pin** | A user-set override that forces the daemon to use a specific account. |
| **Policy** | The pure decision function described in this document. |
| **Quarantine** | A time window during which an account is excluded from candidacy. |
| **Runtime** | The wrapper around `Policy` that owns the lock, IPC, ticks, and side effects. |
| **Switch** | The act of executing a `switch` outcome by activating the target snapshot. |
| **Tick** | One iteration of the watch loop. |
| **Window** | A rate-limit period reported by the provider (5h / weekly / monthly). |
