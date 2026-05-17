# 04 — Accounts Module Improvement Protocol

This document is a source-grounded improvement protocol for the
`src/lib/accounts/` subsystem of `authmux`. It is intentionally long because
the centerpiece — `account-service.ts` — is 1663 lines and concentrates the
project's hardest behavior: identity inference across three CLIs (Codex,
Claude Code, Kiro), per-terminal pinning, snapshot integrity, registry
reconciliation, and auto-switch orchestration. Every major proposal below
follows the same structure:

- **Evidence**: file + line citations from the current code.
- **Diagnosis**: what is wrong, why it matters.
- **Proposal**: the concrete shape of the change.
- **Migration**: how to ship without breaking existing on-disk state.
- **Rollout**: priority (P0/P1/P2/P3) and size (S/M/L/XL).

Priorities:

- **P0** — correctness or data-loss risk. Land before the next minor release.
- **P1** — significant maintainability or UX problem. Land within two releases.
- **P2** — meaningful improvement, can be queued.
- **P3** — nice-to-have, only if a contributor picks it up.

Sizes are eyeballed implementation cost:

- **S** — < 1 day.
- **M** — 1–3 days.
- **L** — 3–10 days.
- **XL** — multi-week effort that probably needs a design doc.

---

## Module purpose and current shape

`src/lib/accounts/` is the "model" layer of authmux. It owns:

- The on-disk snapshot store under `accounts/` and the JSON registry
  (`registry.json`).
- Parsing of Codex `auth.json` (`auth-parser.ts:39`), including base64-url
  decoding of the OIDC `id_token` and traversal of the
  `https://api.openai.com/auth` custom claim.
- The "current account" pointer and per-terminal session pinning
  (`account-service.ts:1384` — `resolveSessionScopeKey`).
- Reconciliation between the snapshot directory listing and the registry
  (`registry.ts:154` — `reconcileRegistryWithAccounts`).
- Auto-switch policy evaluation (`account-service.ts:597` —
  `runAutoSwitchOnce`) and daemon loop (`account-service.ts:669`).
- OS-specific managed services for the auto-switch daemon
  (`service-manager.ts`).
- Provider-agnostic usage snapshots in the registry types
  (`types.ts:12` — `UsageSnapshot`).

Public entry points are re-exported from `src/lib/accounts/index.ts:1`. The
singleton `accountService` (`index.ts:19`) is consumed by every command in
`src/commands/*` and by the daemon entry point.

The boundary between this module and the rest of the codebase is fairly
clean: command layers depend on `AccountService` plus the typed errors. The
weakness is *inside* the module — `account-service.ts` is a god-class with at
least seven distinct responsibilities glued together by `this` calls. The
rest of this document is dedicated to teasing them apart.

Dependencies inbound to the module (high level):

- `src/commands/save.ts`, `src/commands/use.ts`, `src/commands/remove.ts`,
  `src/commands/list.ts`, `src/commands/status.ts`, `src/commands/daemon.ts`,
  `src/commands/auto-switch.ts` — all instantiate or import
  `accountService`.
- `src/lib/login-flow.ts`, `src/lib/restore-session.ts` — call
  `syncExternalAuthSnapshotIfNeeded` and `restoreSessionSnapshotIfNeeded`.
- `src/lib/kiro-mirror.ts` and `src/lib/claude-parallel.ts` — adjacent
  multi-account features that today live outside this module but should be
  unified with it (see *provider-router.ts* below).

Dependencies outbound from the module:

- `src/lib/config/paths.ts` (path resolution).
- Node `fs/promises`, `child_process`, `os`.
- Hard-coded `/proc/<pid>/...` reads on Linux for PID-based pin scoping.

---

## File-by-file critique

### `index.ts` (19 LOC)

**Evidence.** Lines 1–19 re-export the class, types, and errors and
construct a process-wide singleton (`accountService`). The singleton is
mutable and stateless except for being a class instance; every method
re-reads disk.

**Diagnosis.** The singleton is convenient but couples every consumer to
"there is one global filesystem layout". Testing requires manipulating
process env and disk, not injecting a fake. The export surface is also
incomplete: `RemoveResult`, `AccountChoice`, and `StatusReport` are
exported, but `AccountMapping` (`types.ts:73`) is the dominant return type
of `listAccountMappings` and is *not* re-exported here, so command code has
to import from `./accounts/types` directly, breaking the module boundary.

**Proposal.**

1. Add `AccountMapping`, `ListAccountMappingsOptions`,
   `SaveAccountOptions`, `ResolvedDefaultAccountName`,
   `ResolvedLoginAccountName`, and `ExternalAuthSyncResult` to the
   re-export list.
2. Move the singleton construction behind a factory that accepts a
   `RuntimeEnvironment` (filesystem, clock, env reader). Keep
   `accountService` as `createAccountService(defaultRuntime())`.
3. Add a `__test_resetAccountService()` helper guarded by `NODE_ENV !==
   "production"` so tests can swap the runtime cleanly.

**Migration.** No on-disk change. Internal-only API expansion is
backwards-compatible. The singleton remains exported under the same name.

**Rollout.** **P2 / S.**

### `types.ts` (84 LOC)

**Evidence.**

- Line 1 hardcodes `DEFAULT_THRESHOLD_5H_PERCENT = 10` and line 2
  `DEFAULT_THRESHOLD_WEEKLY_PERCENT = 5`. These are used only by
  `registry.ts:88-89` and only as registry defaults.
- Line 41 fixes `version: 1` as a literal type and is the *only* version
  guard the codebase has.
- Line 49 (`ParsedAuthSnapshot`) uses an `authMode` union of three string
  literals but otherwise leaves every field optional, including
  `accessToken`. There is no discriminated narrowing: a consumer who reads
  `parsed.email` cannot tell from the type whether `authMode` was
  `chatgpt` or `apikey`.
- Line 58 (`StatusReport`) intermixes a *report* shape with implementation
  details (`serviceState: "active" | "inactive" | "unknown"`).
- Line 73 (`AccountMapping`) is a near-duplicate of
  `AccountRegistryEntry` with extra usage fields appended. The drift is
  manual and easy to break.

**Diagnosis.** The type module has decayed into a flat bag of shapes. Three
specific problems:

1. **No branded primitives.** Account names, emails, account IDs, user
   IDs, and snapshot paths are all `string`. Functions take `string`
   arguments and there is no way for the compiler to catch "I passed an
   email where a snapshot path was expected".
2. **No discriminated unions.** `ParsedAuthSnapshot.authMode === "chatgpt"`
   should narrow to a shape that *requires* `accessToken` (when we want to
   call the usage API) or at least pulls all OpenAI-specific fields into a
   nested record.
3. **No registry schema versioning beyond the literal `1`.** The
   sanitizer in `registry.ts:98` silently coerces unknown shapes to
   defaults rather than rejecting or migrating.

**Proposal.** See the dedicated *Type system tightening* section below for
the full type changes; this entry summarizes the deltas to `types.ts` only:

1. Introduce brand types in a new `branded.ts`:
   ```ts
   export type AccountName = string & { readonly __brand: "AccountName" };
   export type Email = string & { readonly __brand: "Email" };
   export type AccountId = string & { readonly __brand: "AccountId" };
   export type UserId = string & { readonly __brand: "UserId" };
   export type SnapshotPath = string & { readonly __brand: "SnapshotPath" };
   ```
   Provide smart constructors (`asAccountName(raw)`, etc.) that perform
   the validation currently scattered in
   `account-service.ts:958-974` (`normalizeAccountName`).
2. Convert `ParsedAuthSnapshot` to a discriminated union:
   ```ts
   export type ParsedAuthSnapshot =
     | { authMode: "chatgpt"; email?: Email; accountId?: AccountId;
         userId?: UserId; planType?: string; accessToken?: string }
     | { authMode: "apikey"; apiKey: string }
     | { authMode: "unknown" };
   ```
3. Make `RegistryData.version` a discriminated union of supported
   versions (`1 | 2`) once a migration arrives. Until then, expose
   `LATEST_REGISTRY_VERSION` as a `const`.
4. Split `AccountMapping` so the usage fields live on a nested
   `usage?: AccountUsageView` record. This stops the silent type drift
   with `AccountRegistryEntry`.

**Migration.** Brand types are erased at runtime, so existing values
continue to work. The discriminated union for `ParsedAuthSnapshot` may
require call-site adjustments in `account-service.ts:1599` and
`auth-parser.ts:46`. Provide a transitional alias
`AccountMappingLegacy = AccountMapping & { ... }` for one release.

**Rollout.** **P1 / M.**

### `errors.ts` (76 LOC)

**Evidence.** Ten error classes, all extending a single base
`CodexAuthError`. Names are good but the constructor signatures are not
uniform: some take no arguments (`PromptCancelledError`,
`InvalidRemoveSelectionError`, `NoAccountsSavedError`), some take a name
(`AccountNotFoundError`), some take complex tuples
(`SnapshotEmailMismatchError`). None carry a machine-readable error code.

**Diagnosis.** The current error surface is throw-and-message-only.
Consumers cannot programmatically branch on error class without a chain of
`instanceof` checks, and the CLI cannot map errors to stable exit codes.
There is no error code embedded in JSON output for shell scripts to parse
either.

**Proposal.** See the dedicated *Errors and result types* section below.
The shape change here is:

1. Add a `code: string` field on `CodexAuthError`, populated by each
   subclass with a stable token (`AM_ACCT_NOT_FOUND`,
   `AM_AUTH_PARSE_FAIL`, ...).
2. Add `cause?: unknown` (forwarded to `Error.cause`) on the base.
3. Add a `serialize()` method that emits `{ code, message, name, details }`
   for the JSON output paths in `src/commands/`.

**Migration.** Subclass constructors gain an extra default argument that
sets `this.code`. All existing throw-sites continue to work because the
code is internal.

**Rollout.** **P1 / S.**

### `plan-display.ts` (49 LOC)

**Evidence.**

- Lines 1–9 hard-code a `CHATGPT_PLAN_LABELS` map for `plus`, `business`,
  `team`, `pro`, `max`, `enterprise`, `free`. `team` collapses to
  `Business`, which is a deliberate but undocumented relabel.
- Lines 11–21 hard-code a `USAGE_BASED_PLAN_KEYS` set with eight aliases
  for the metered plan.
- Line 47 falls back to title-casing the raw plan string when neither map
  matches.

**Diagnosis.** This file is the only place in the codebase that knows the
mapping from raw plan strings to user-visible labels. Two problems:

1. The maps are tied to Codex/ChatGPT plans only. As Claude Code and Kiro
   gain similar surfaces, every provider will want its own label table,
   and there is no extension point.
2. The relabel of `team -> Business` is silent. If a user owns a team
   seat, the CLI says "Business" with no footnote, which is confusing in
   support tickets.

**Proposal.**

1. Move the maps into a `provider-router.ts` module (see the decomposition
   plan below). Define a `ProviderPlanLabeler` interface and ship one per
   provider.
2. Add `--raw-plan` to `authmux list --details` so support can see the
   underlying string.
3. Add a short comment next to the `team` collapse explaining that
   OpenAI's web UI displays team seats under the Business marketing label.

**Migration.** None. The function signature `formatAccountType(planType:
string | undefined): string` is preserved; only its implementation moves
behind an interface.

**Rollout.** **P2 / S.**

### `auth-parser.ts` (104 LOC)

**Evidence.**

- Lines 4–17 decode the JWT payload manually with base64-url padding. The
  `padEnd` line uses `Math.ceil(base64.length / 4) * 4`, which is correct
  for the standard 4-char-block padding rule. Lines 8–16 swallow every
  exception silently.
- Lines 39–94 are a pyramid of optional-chain reads against a
  `Record<string, unknown>`. The custom claim
  `https://api.openai.com/auth` is read at line 25 and shaped into
  `authObject` for downstream extraction.
- Line 47 short-circuits on `OPENAI_API_KEY` and returns
  `{ authMode: "apikey" }` with no further fields, dropping the key
  itself. The discriminated union proposal above would force the parser
  to either expose the key or label this case explicitly.
- Line 96 (`parseAuthSnapshotFile`) returns `{ authMode: "unknown" }` for
  *any* failure — missing file, malformed JSON, IO error. The caller
  cannot distinguish "file does not exist" from "file is corrupt".

**Diagnosis.** The parser is small and mostly correct, but it is the only
defense against malformed input from external `codex login` runs. Silent
failures here are dangerous because they cascade into "no identity match,
treat as new account" in `account-service.ts:1140`. Concrete issues:

1. **Lost error context.** `parseAuthSnapshotFile` should at least
   distinguish ENOENT from JSON parse errors so the caller can decide
   whether to recover from backup (see *Snapshot integrity* below) or to
   prompt the user.
2. **Provider lock-in.** The parser is Codex-specific. Claude Code's
   credentials file is a different schema entirely (`.credentials.json`
   under `~/.claude/`), and Kiro stores SQLite. A generic
   `inferIdentity()` interface is needed (see *Identity inference*).
3. **No schema check.** A future Codex `auth.json` could add an
   `auth_mode` field that contradicts our inference; we'd never notice.
4. **Email lowercasing inconsistency.** Line 61 lowercases the email at
   parse time. `account-service.ts:1019` lowercases again. Both should
   not be necessary — pick one place.

**Proposal.**

1. Replace silent catches with a typed result:
   ```ts
   export type AuthParseError =
     | { kind: "missing" }
     | { kind: "io"; cause: NodeJS.ErrnoException }
     | { kind: "malformed"; cause: SyntaxError }
     | { kind: "rejected"; reason: string };
   export type AuthParseResult =
     | { ok: true; snapshot: ParsedAuthSnapshot }
     | { ok: false; error: AuthParseError };
   ```
2. Centralize email normalization on the brand type
   (`asEmail(raw)` normalizes once).
3. Move the OpenAI-specific traversal under a `CodexAuthAdapter`
   implementing the `ProviderAdapter` interface defined in the
   decomposition plan.

**Migration.** Provide a backwards-compatible
`parseAuthSnapshotFile(path): Promise<ParsedAuthSnapshot>` wrapper that
discards the error case and returns `{ authMode: "unknown" }` for callers
that have not been ported. Migrate callers in `account-service.ts` one at
a time so each migration is a small PR.

**Rollout.** **P1 / M.**

### `registry.ts` (181 LOC)

**Evidence.**

- Line 16 (`clampPercent`) coerces invalid numbers to a fallback. Used on
  threshold percentages.
- Lines 23–65 (`sanitizeUsageSnapshot`) silently downgrades the source
  to `"cached"` if the raw source string is unrecognized. The "proxy"
  source from `types.ts:4` is *not* listed in line 26, so a saved
  `source: "proxy"` round-trips as `"cached"`. This is a real bug.
- Lines 83–96 (`createDefaultRegistry`) hardcodes the default
  `autoSwitch.enabled = false` and `api.usage = true`.
- Lines 137–146 (`loadRegistry`) swallows every error and returns
  defaults. If `registry.json` is corrupt, the user silently loses their
  thresholds, active pointer, and cached usage.
- Lines 148–152 (`saveRegistry`) writes directly to the final path. No
  temp-file-then-rename atomicity. A crash mid-write produces a partial
  JSON file that the next `loadRegistry` will silently replace with
  defaults.
- Lines 154–181 (`reconcileRegistryWithAccounts`) drops registry entries
  for accounts that vanished from disk *and* clears
  `activeAccountName`. This is brittle: if `listAccountNames()` failed
  silently and returned `[]`, the registry would be wiped.

**Diagnosis.**

1. **Real correctness bug at line 26:** the `"proxy"` source is dropped.
2. **No atomic writes.** A SIGKILL or full disk during `saveRegistry`
   corrupts the registry irrecoverably.
3. **No corruption recovery.** `loadRegistry` returns defaults on any
   error. The user is not warned and there is no backup.
4. **Reconciliation is destructive.** If the upstream snapshot dir scan
   fails, the registry gets wiped. The function should be a no-op when
   the inputs are obviously wrong (e.g., empty list while the registry
   has entries and the snapshot dir exists but was just not readable).
5. **No schema migration runner.** `version: 1` is read but no path
   exists to bump it.

**Proposal.** See *Registry storage* below. The minimum fix slate:

1. Add `"proxy"` to the recognized source list at line 26.
2. Replace `saveRegistry` with a `writeFileAtomic` helper (temp file +
   `fs.rename`).
3. On `loadRegistry` parse failure, copy the bad file to
   `registry.json.corrupt-<isoTimestamp>` and log a warning before
   returning defaults.
4. Guard `reconcileRegistryWithAccounts` against the
   "registry-has-entries-but-list-is-empty" anomaly: refuse to drop
   entries unless the accounts directory was successfully *enumerated*
   (`fs.readdir` succeeded), as opposed to defaulted-to-empty because the
   dir didn't exist.
5. Add a `schemaVersion` field separate from the application-level
   `version`, and run migrations as a sequence of pure functions.

**Migration.** The proxy-source fix is non-breaking. Atomic writes are
non-breaking. Corruption recovery is additive. Schema migration runner
starts at version 1 with zero migrations registered, so it is a no-op
until needed.

**Rollout.**

- Proxy source fix: **P0 / S**.
- Atomic writes + corruption backup: **P0 / S**.
- Reconciliation guard: **P0 / S**.
- Migration runner scaffolding: **P2 / M**.
- Storage backend swap (SQLite/LMDB): **P3 / XL**.

### `service-manager.ts` (219 LOC)

**Evidence.**

- Lines 50–69 enable the Linux user service by writing a systemd unit
  and calling `systemctl --user daemon-reload`, `enable`, `start` in
  sequence. Each failure throws a generic `Error` with no exit code
  detail (e.g., line 58 throws `"systemctl --user daemon-reload
  failed"`).
- Lines 84–89 detect Linux service state with `systemctl --user
  is-active` and parse stdout for the literal "active" prefix.
- Lines 119–129 reload the macOS plist with `launchctl unload` followed
  by `launchctl load`. There is no probe for whether `launchctl` is
  available, just an error throw.
- Lines 147–163 use `schtasks /Create` on Windows and trigger it with
  `/Run`. The `/SC ONLOGON` choice means the task fires at the next
  logon, not now. The follow-up `/Run` triggers it for the current
  session.
- The Linux unit at line 34 hardcodes `ExecStart=authmux daemon
  --watch`. There is no `Environment=` to forward env vars like
  `CODEX_AUTH_CODEX_DIR`, `CODEX_LB_URL`, or `CODEX_AUTH_SESSION_KEY`,
  so users running with non-default paths will silently get the wrong
  daemon behavior.

**Diagnosis.**

1. **No env propagation.** Users who customize paths via env vars get a
   daemon that ignores their config.
2. **No log path.** Systemd will inherit the journal, macOS launchd will
   inherit `/dev/null` (no `StandardOutPath` set), and Windows
   `schtasks` has no log either. Debugging "why didn't auto-switch
   fire" is currently impossible without rerunning interactively.
3. **No PATH guarantee.** `ExecStart=authmux` assumes `authmux` is on
   the user-service PATH, which on a fresh systemd-user environment can
   be very short (often just `/usr/bin:/bin`). The unit should resolve
   the absolute path of the current binary at install time.
4. **Restart storm risk.** Linux unit has `Restart=always` and
   `RestartSec=1`. A bug that causes the daemon to crash on every start
   becomes a journal flood. Should bound restarts.
5. **No idempotency on macOS.** `launchctl unload` then `load` is the
   pattern, but if the agent was loaded under a different label (legacy
   `com.openai.codex.auth.autoswitch`), the new label is loaded
   alongside it. There is no migration to clean up old labels.

**Proposal.**

1. Capture `process.execPath` and the current `argv[1]` (likely an
   `authmux` shim) at install time. Write absolute paths into the unit.
2. Capture an explicit env-var allowlist (`CODEX_AUTH_*`, `CODEX_LB_*`,
   `XDG_*`, `HOME`) and emit them under `Environment=` /
   `<key>EnvironmentVariables</key>` / `schtasks /XML` payload.
3. Add log redirection:
   - Linux: keep journal but tag with `SyslogIdentifier=authmux`.
   - macOS: `<key>StandardOutPath</key>
     <string>~/Library/Logs/authmux.out.log</string>` and
     `StandardErrorPath` likewise.
   - Windows: redirect via `cmd /c "authmux daemon --watch >> %LOCALAPPDATA%\authmux\daemon.log 2>&1"`.
4. Add `StartLimitIntervalSec=60` and `StartLimitBurst=5` on Linux.
5. Detect and remove legacy labels at enable time.
6. Add a `getManagedServicePaths()` helper that returns the resolved
   unit/plist/task path so `authmux status` can show it.

**Migration.** Re-running `authmux auto-switch --enable` should remove
the old unit and re-install the new one. Add a one-time
`migrateLegacyManagedService()` call inside `enableManagedService` that
removes legacy filenames if present.

**Rollout.**

- Env propagation: **P1 / S**.
- Absolute binary path: **P1 / S**.
- Log redirection: **P2 / S**.
- Restart caps: **P2 / S**.
- Legacy cleanup: **P3 / S**.

### `usage.ts` (660 LOC)

> **Scope note.** Another agent owns the usage-refresh entry points and the
> proxy HTTP client. This document only covers how account *records*
> carry usage state and how `account-service.ts` interacts with usage.
> Recommendations specific to the refresh mechanism itself are
> out of scope here.

**Evidence (account-record interactions only).**

- Lines 487–499 (`resolveRateWindow`) is the only function that maps a
  raw `UsageSnapshot` into the 5h vs weekly window. The 5h window is
  identified by `windowMinutes === 300` and weekly by `10080`. If the
  upstream API returns 299 or 10081 (due to rounding), both lookups
  fail and we fall back to `primary`/`secondary` order, which can swap
  the two windows.
- Lines 501–509 (`remainingPercent`) treats `resetsAt <= nowSeconds` as
  100% remaining. This is correct only if the reset has already
  occurred *and* the upstream record hasn't been refreshed. A stale
  snapshot can therefore report 100% indefinitely.
- Lines 511–519 (`usageScore`) picks `Math.min(fiveHour, weekly)` and is
  the input to `shouldSwitchCurrent`. Account records store the raw
  `UsageSnapshot`; the score is derived per call.

**Diagnosis (interaction surface only).**

1. **Window matching is brittle.** The exact-minutes check should be a
   tolerance match (e.g., `Math.abs(actual - 300) <= 1`).
2. **Stale-reset masking.** When `resetsAt` is in the past, we should
   *invalidate* the snapshot rather than report 100%. The account
   record can carry a `staleUntilRefresh: true` flag so the UI shows
   "(stale)" instead of "100%".
3. **No per-account TTL.** `account-service.ts:744`
   (`refreshListUsageIfNeeded`) refreshes on `missing` or `always` but
   has no concept of "older than 5 minutes, please refresh". A TTL
   field on `UsageSnapshot` (computed from `windowMinutes`) would let
   the list view auto-refresh sensibly.

**Proposal.**

1. Add a tolerance constant `WINDOW_MATCH_TOLERANCE_MIN = 1` and use it
   in `resolveRateWindow`.
2. When `resetsAt <= nowSeconds`, return `undefined` from
   `remainingPercent` and have the list view render `"(stale)"`.
3. Add a `freshness: { fetchedAt; nextRefreshNoSoonerThan }` block to
   `UsageSnapshot`. `refreshListUsageIfNeeded` consults it.

**Migration.** New fields are optional and ignored by older readers.

**Rollout.** **P2 / M.** (Lower priority because the usage subsystem is
otherwise covered by the parallel agent's slice.)

### `account-service.ts` (1663 LOC)

This file gets its own decomposition section below. Here, the file-level
critique highlights cross-cutting concerns:

**Evidence and diagnosis.**

1. **God class.** `AccountService` has 26 public methods and 35 private
   methods. The public surface mixes seven distinct responsibilities:
   external-sync orchestration, snapshot store CRUD, identity inference,
   current-pointer management, session pinning, registry persistence,
   and auto-switch policy. The seven concerns are explicit:
   - External sync: `syncExternalAuthSnapshotIfNeeded` (line 110),
     `restoreSessionSnapshotIfNeeded` (line 206),
     `backupAllSnapshots` (line 859), `restoreClobberedSnapshotsFromBackup`
     (line 895), `clearSnapshotBackupVault` (line 949).
   - Snapshot store: `listAccountNames` (line 255), `accountFilePath`
     (line 851), `saveAccount` (line 394), `removeAccounts` (line 470),
     `activateSnapshot` (line 1297).
   - Identity inference: `inferAccountNameFromCurrentAuth` (line 420),
     `resolveDefaultAccountNameFromCurrentAuth` (line 435),
     `resolveLoginAccountNameFromCurrentAuth` (line 449),
     `resolveLoginAccountNameForSnapshot` (line 1127),
     `resolveExistingAccountNameForIncomingSnapshot` (line 1140),
     `resolveRegistryAccountNameForIncomingSnapshot` (line 1180),
     `orderReloginSnapshotCandidates` (line 1214),
     `resolveUniqueInferredName` (line 1243),
     `inferAccountNameFromSnapshot` (line 1275),
     `snapshotsShareIdentity` (line 1599),
     `registryEntrySharesIdentity` (line 1625),
     `registryEntrySharesEmail` (line 1645),
     `snapshotsShareEmail` (line 1651),
     `renderSnapshotIdentity` (line 1657).
   - Current pointer: `getCurrentAccountName` (line 357),
     `writeCurrentName` (line 1043), `readCurrentNameFile` (line 1050),
     `clearActivePointers` (line 1368).
   - Session pinning: `resolveSessionScopeKey` (line 1384),
     `getSessionAccountName` (line 1398),
     `getSessionAuthFingerprint` (line 1413),
     `getActiveSessionAccountName` (line 1426),
     `setSessionAccountName` (line 1437),
     `clearSessionAccountName` (line 1451),
     `readSessionMap` (line 1461), `writeSessionMap` (line 1510),
     `rememberSessionAuthFingerprint` (line 1516),
     `isSessionPinnedToActiveCodex` (line 1537),
     `readChildPids` (line 1573), `isCodexProcess` (line 1585).
   - Registry persistence helpers: `loadReconciledRegistry` (line 1285),
     `persistRegistry` (line 1292), `hydrateSnapshotMetadata` (line 1103),
     `hydrateSnapshotMetadataIfMissing` (line 1118).
   - Auto-switch policy: `getStatus` (line 533),
     `setAutoSwitchEnabled` (line 544),
     `setApiUsageEnabled` (line 566),
     `configureAutoSwitchThresholds` (line 573),
     `runAutoSwitchOnce` (line 597), `runDaemon` (line 669),
     `selectBestCandidateFromRegistry` (line 685),
     `refreshAccountUsage` (line 701),
     `refreshListUsageIfNeeded` (line 744),
     `isUsageMissingForList` (line 797),
     `resolveProxyUsage` (line 803),
     `lookupProxyUsage` (line 838).

2. **Implicit shared state.** Many private methods read the same
   resolved path (`resolveAccountsDir()`, `resolveAuthPath()`) on every
   call. There is no caching, and there is also no invalidation. Tests
   that mutate env vars between calls work today only because of this.

3. **Deeply nested control flow.** `syncExternalAuthSnapshotIfNeeded`
   (line 110) has six early-return branches and a `rememberAuthState`
   wrapper closure. The intent (skip sync if nothing changed) is buried.

4. **No telemetry / debug logging.** Every branch returns silently. A
   user who is debugging "why was my account not saved?" has zero
   information to work from.

5. **`for (;;)` in `runDaemon`.** Line 675 is an infinite loop with a
   bare `catch {}` and a 30-second sleep. No backoff, no jitter, no
   shutdown signal handling.

**Proposal.** See the decomposition plan in the next section. Logging,
telemetry, and the daemon loop also get their own treatment in the
*Concurrency and pinning* section.

**Rollout.** Decomposition: **P1 / XL**. Logging: **P1 / S**. Daemon
hardening: **P2 / M**.

---

## `account-service.ts` decomposition plan

The centerpiece. Goal: split 1663 lines across seven cohesive files, each
under ~300 lines, while keeping the public `index.ts` re-exports stable.
The current `AccountService` becomes a thin facade that holds references
to the new collaborators and re-exposes the legacy method names so
existing command code keeps working.

### Target file layout

```
src/lib/accounts/
  index.ts                  # facade re-exports (unchanged surface)
  types.ts                  # branded types + discriminated unions
  errors.ts                 # tagged error taxonomy
  branded.ts                # smart constructors for AccountName, Email, ...
  plan-display.ts           # unchanged
  auth-parser.ts            # parser returns AuthParseResult
  registry.ts               # registry IO with atomic writes + migrations
  service-manager.ts        # OS service installer with env propagation
  usage.ts                  # usage fetch + scoring (owned by other agent)

  snapshot-store.ts         # NEW — disk CRUD for snapshots
  identity-resolver.ts      # NEW — name inference + identity matching
  current-pointer.ts        # NEW — current-name file + activation
  pin-store.ts              # NEW — session map (per-PPID / per-key pins)
  switcher.ts               # NEW — useAccount / removeAccounts orchestration
  profile-manager.ts        # NEW — parallel-profile lifecycle (Claude-side)
  provider-router.ts        # NEW — provider adapter selection (Codex/Claude/Kiro)

  account-service.ts        # SHRUNK — facade only; ~250 lines
```

### `snapshot-store.ts`

**Responsibility.** Pure disk CRUD on the `accounts/<name>.json` directory.
No identity logic, no registry mutation, no current-pointer side-effects.

**Public API.**

```ts
export interface SnapshotStore {
  list(): Promise<AccountName[]>;
  exists(name: AccountName): Promise<boolean>;
  read(name: AccountName): Promise<ParsedAuthSnapshot>;
  readRaw(name: AccountName): Promise<Buffer>;
  write(name: AccountName, raw: Buffer): Promise<void>;
  copyFrom(source: SnapshotPath, name: AccountName): Promise<void>;
  delete(name: AccountName): Promise<void>;
  pathFor(name: AccountName): SnapshotPath;
  backupAll(): Promise<void>;
  restoreClobberedFromBackup(): Promise<RestoreReport>;
  clearBackupVault(): Promise<void>;
}
export interface RestoreReport {
  restored: AccountName[];
  skipped: AccountName[];
  errors: Array<{ name: AccountName; reason: string }>;
}
```

**Code moves from:**

- `listAccountNames` — `account-service.ts:255-279`.
- `accountFilePath` — `account-service.ts:851-853`.
- `snapshotBackupPath` — `account-service.ts:855-857`.
- `backupAllSnapshots` — `account-service.ts:859-893`.
- `restoreClobberedSnapshotsFromBackup` — `account-service.ts:895-947`.
- `clearSnapshotBackupVault` — `account-service.ts:949-956`.
- `pathExists`, `filesMatch`, `removeIfExists`, `ensureDir` — small
  helpers from `account-service.ts:986-1080` move into a co-located
  `fs-helpers.ts`.

**Behavior changes embedded in the move.**

1. The list filter at `account-service.ts:267-278` excludes hard-coded
   filenames (`registry.json`, `update-check.json`, the session map
   basename). Replace with an `isSnapshotFile(entry)` predicate that
   asks the store's own reserved-name registry. This removes the
   layering violation where `SnapshotStore` knows about
   `update-check.json` (which is owned by an entirely different
   subsystem).
2. `backupAll()` should be a single transactional vault swap: write the
   new vault to `accounts/.snapshot-backups.next/`, fsync, then rename
   over `accounts/.snapshot-backups/`. Today the implementation
   `rm -rf`s the vault first (line 870), which means a crash mid-backup
   leaves the user with neither the old nor the new vault.

**Why now.** This split unblocks unit testing of the snapshot store with
a `memfs`-style fake, which is currently impossible because the file IO
is tangled with identity logic.

### `identity-resolver.ts`

**Responsibility.** Decide *which* saved account a given parsed snapshot
corresponds to, infer a new name from a snapshot, and rank candidates for
re-login matching.

**Public API.**

```ts
export interface IdentityResolver {
  inferName(snapshot: ParsedAuthSnapshot): Promise<AccountName>;
  resolveExisting(
    incoming: ParsedAuthSnapshot,
    activeName: AccountName | null,
  ): Promise<ResolvedExistingAccount | null>;
  resolveLogin(
    incoming: ParsedAuthSnapshot,
    activeName: AccountName | null,
  ): Promise<ResolvedLoginAccountName>;
  shareIdentity(a: ParsedAuthSnapshot, b: ParsedAuthSnapshot): boolean;
  shareEmail(a: ParsedAuthSnapshot, b: ParsedAuthSnapshot): boolean;
  registryShareIdentity(
    entry: AccountRegistryEntry,
    snapshot: ParsedAuthSnapshot,
  ): boolean;
  renderIdentity(snapshot: ParsedAuthSnapshot, fallback: Email): string;
}
export interface ResolvedExistingAccount {
  name: AccountName;
  source: "active" | "existing";
  forceOverwrite?: boolean;
}
```

**Code moves from:**

- `inferAccountNameFromCurrentAuth` — `account-service.ts:420-433`.
- `resolveDefaultAccountNameFromCurrentAuth` —
  `account-service.ts:435-447`.
- `resolveLoginAccountNameFromCurrentAuth` —
  `account-service.ts:449-455`.
- `resolveLoginAccountNameForSnapshot` —
  `account-service.ts:1127-1138`.
- `resolveExistingAccountNameForIncomingSnapshot` —
  `account-service.ts:1140-1178`.
- `resolveRegistryAccountNameForIncomingSnapshot` —
  `account-service.ts:1180-1212`.
- `orderReloginSnapshotCandidates` —
  `account-service.ts:1214-1241`.
- `resolveUniqueInferredName` — `account-service.ts:1243-1273`.
- `inferAccountNameFromSnapshot` — `account-service.ts:1275-1283`.
- `snapshotsShareIdentity` — `account-service.ts:1599-1623`.
- `registryEntrySharesIdentity` — `account-service.ts:1625-1643`.
- `registryEntrySharesEmail` — `account-service.ts:1645-1649`.
- `snapshotsShareEmail` — `account-service.ts:1651-1655`.
- `renderSnapshotIdentity` — `account-service.ts:1657-1662`.

**Behavior changes embedded in the move.**

1. Today, `resolveUniqueInferredName` (line 1243) tries `baseName`,
   then `baseName--dup-2`, ..., up to `--dup-99`. This is silent
   collision avoidance. The new resolver should emit a debug event
   ("inferred name X collides with existing identity Y, trying Z") and
   should not silently rename when the identity matches an existing
   snapshot — instead it should return the existing snapshot's name.
2. The fallback-to-email-match path (line 1168) sets
   `forceOverwrite: true`. That force flag flows into
   `saveAccount` (line 405). Document this contract: "email match
   without identity match implies the user's identity tokens have
   rotated; we overwrite by design."
3. Replace the `for` loop at `account-service.ts:1261-1270` with a
   bounded async iteration that breaks early on the first identity
   match. Today the loop scans up to 98 files even when an obvious
   match exists.

### `current-pointer.ts`

**Responsibility.** Manage the `current` file under the codex dir and the
materialization of `auth.json` from a chosen snapshot.

**Public API.**

```ts
export interface CurrentPointer {
  get(): Promise<AccountName | null>;
  setFromSnapshot(name: AccountName): Promise<ActivationReport>;
  clear(): Promise<void>;
  materializeAuthSymlink(): Promise<void>;
}
export interface ActivationReport {
  name: AccountName;
  authFingerprint?: string;
}
```

**Code moves from:**

- `getCurrentAccountName` — `account-service.ts:357-392`.
- `writeCurrentName` — `account-service.ts:1043-1048`.
- `readCurrentNameFile` — `account-service.ts:1050-1062`.
- `clearActivePointers` — `account-service.ts:1368-1374`.
- `activateSnapshot` — `account-service.ts:1297-1313`.
- `materializeAuthSymlink` — `account-service.ts:990-999`.
- `readAuthSyncState`, `createAuthSyncFingerprint` —
  `account-service.ts:1082-1101`.

**Behavior changes embedded in the move.**

1. `getCurrentAccountName` does too much: it consults the session pin,
   then the `current` file, then a symlink heuristic on `auth.json`. The
   new pointer treats the `current` file as authoritative and delegates
   pin lookups to `PinStore`. The symlink-detection path becomes a
   `recoverFromAuthSymlink()` method that callers invoke explicitly when
   the `current` file is missing and they want to be lenient.
2. `activateSnapshot` writes to both `current` and the session map (via
   `writeCurrentName`). Pull the session-map side-effect out;
   `Switcher` (below) will compose the two stores.

### `pin-store.ts`

**Responsibility.** Read and write `accounts/sessions.json`, including the
session-scope key derivation and the Linux `/proc` introspection used to
decide if the pin is still "live" (a codex process is actually running
under our PPID).

**Public API.**

```ts
export enum PinScope {
  ExplicitSessionKey = "session",
  ParentPid = "ppid",
}
export interface PinStoreEntry {
  accountName: AccountName;
  authFingerprint?: string;
  updatedAt: string;
  scope: PinScope;
}
export interface PinStore {
  resolveCurrentScopeKey(): string | null;
  resolveCurrentScope(): PinScope | null;
  get(): Promise<PinStoreEntry | null>;
  getActive(): Promise<PinStoreEntry | null>;
  set(name: AccountName, opts?: { authFingerprint?: string }): Promise<void>;
  rememberFingerprint(fingerprint: string): Promise<void>;
  clear(): Promise<void>;
  gcStalePins(opts: { olderThanMs: number }): Promise<number>;
}
```

**Code moves from:**

- `resolveSessionScopeKey` — `account-service.ts:1384-1396`.
- `getSessionAccountName` — `account-service.ts:1398-1411`.
- `getSessionAuthFingerprint` — `account-service.ts:1413-1424`.
- `getActiveSessionAccountName` — `account-service.ts:1426-1435`.
- `setSessionAccountName` — `account-service.ts:1437-1449`.
- `clearSessionAccountName` — `account-service.ts:1451-1459`.
- `readSessionMap`, `writeSessionMap` —
  `account-service.ts:1461-1514`.
- `rememberSessionAuthFingerprint` —
  `account-service.ts:1516-1535`.
- `isSessionPinnedToActiveCodex`, `readChildPids`, `isCodexProcess` —
  `account-service.ts:1537-1597`.
- `sessionSnapshotExists` — `account-service.ts:1360-1366` (becomes a
  store query: "does the snapshot named by my pin still exist?").

**Behavior changes embedded in the move.**

1. The session map has no GC. Every PPID we ever saw stays in the map
   forever. Add `gcStalePins({ olderThanMs })`, called opportunistically
   on every write and periodically by the daemon, that removes entries
   older than 7 days *and* whose `ppid:` key no longer maps to a live
   process.
2. The Linux `/proc/<pid>/task/<pid>/children` read at
   `account-service.ts:1575` is the *only* way pin liveness is verified
   on Linux; macOS and Windows always return `true` from
   `isSessionPinnedToActiveCodex` (line 1551–1552). Add at least a
   Darwin path using `ps -p <pid>` to verify the parent process is
   still alive even when we cannot enumerate children.
3. Embed an explicit `PinScope` field in each entry (today the scope is
   re-derived from the key prefix each time). Storing it makes the file
   self-describing and lets us version per-scope cleanup rules.

### `switcher.ts`

**Responsibility.** Orchestrate `use`, `save`, and `remove` flows by
composing `SnapshotStore`, `CurrentPointer`, `PinStore`, `Registry`,
and `IdentityResolver`.

**Public API.**

```ts
export interface Switcher {
  saveCurrentAuth(rawName: string, opts?: SaveAccountOptions): Promise<AccountName>;
  use(rawName: string): Promise<AccountName>;
  removeMany(names: AccountName[]): Promise<RemoveResult>;
  removeByQuery(query: string): Promise<RemoveResult>;
  removeAll(): Promise<RemoveResult>;
  findMatching(query: string): Promise<AccountChoice[]>;
  listChoices(): Promise<AccountChoice[]>;
  listMappings(opts?: ListAccountMappingsOptions): Promise<AccountMapping[]>;
}
```

**Code moves from:**

- `saveAccount` — `account-service.ts:394-418`.
- `useAccount` — `account-service.ts:457-468`.
- `removeAccounts` — `account-service.ts:470-514`.
- `removeByQuery` — `account-service.ts:516-526`.
- `removeAllAccounts` — `account-service.ts:528-531`.
- `findMatchingAccounts` — `account-service.ts:341-355`.
- `listAccountChoices` — `account-service.ts:281-293`.
- `listAccountMappings` — `account-service.ts:295-339`.
- `resolveUsableAccountName` — `account-service.ts:1315-1335`.
- `findSnapshotNamesByExactEmail` —
  `account-service.ts:1337-1358`.
- `selectBestCandidateFromRegistry` —
  `account-service.ts:685-699`.

**Behavior changes embedded in the move.**

1. `removeAccounts` currently re-derives the post-removal active
   account by calling `selectBestCandidateFromRegistry` on whatever
   was loaded. Make this an explicit `pickFallbackActive()` strategy
   so it can be tested in isolation.
2. `useAccount` ends with `saveRegistry(registry)` but does not call
   `persistRegistry` (which reconciles). This is the only path that
   skips reconciliation. Bring it in line with the others by going
   through the `Switcher` helper `persistRegistry()` always.
3. `assertSafeSnapshotOverwrite` (`account-service.ts:1001-1030`) is
   identity-aware and belongs on the resolver, but the *throw* (raising
   `SnapshotEmailMismatchError`) is a switcher-level policy. Split: the
   resolver returns a `mismatch` verdict; the switcher decides whether
   to throw or proceed-with-force.

### `provider-router.ts`

**Responsibility.** Pick the correct `ProviderAdapter` for the account at
hand. Today the entire module is Codex-specific. A future where
`account-service` orchestrates Codex, Claude Code, and Kiro accounts in a
single registry needs a routing layer.

**Public API.**

```ts
export type ProviderId = "codex" | "claude" | "kiro";

export interface ProviderAdapter {
  readonly id: ProviderId;

  inferIdentity(rawAuth: Buffer): ParsedAuthSnapshot;
  authFilePath(): SnapshotPath;
  fetchUsage?(snapshot: ParsedAuthSnapshot): Promise<UsageSnapshot | null>;
  planLabel(planType: string | undefined): string;
}

export interface ProviderRouter {
  forAccount(name: AccountName): Promise<ProviderAdapter>;
  forSnapshot(snapshot: ParsedAuthSnapshot): ProviderAdapter;
  default(): ProviderAdapter;
  register(adapter: ProviderAdapter): void;
}
```

**Code moves from:**

- `auth-parser.ts:39-94` becomes `CodexAuthAdapter.inferIdentity`.
- `plan-display.ts` becomes the body of `CodexAuthAdapter.planLabel`.
- `fetchUsageFromApi`, `fetchUsageFromLocal` (in `usage.ts`) become
  `CodexAuthAdapter.fetchUsage` (the other agent owns the migration).

**New code:**

- `ClaudeAuthAdapter` reads `~/.claude/.credentials.json` (or
  `~/.claude-accounts/<profile>/.credentials.json` for parallel
  profiles) and extracts the email from the OAuth user record.
- `KiroAuthAdapter` reads `~/.local/share/kiro-cli/data.sqlite3` and
  returns identity by querying the `auth` table. (Today `kiro-mirror.ts`
  uses raw symlink swapping; the adapter would centralize identity
  extraction without changing the mirror strategy.)

**Why this matters.** Right now, `auth-parser.ts:46` short-circuits on
`OPENAI_API_KEY` and returns a near-empty record. There is *no* path for
the parser to identify a Claude credentials file or a Kiro database. By
routing through an adapter, each provider owns its parsing and the
shared identity machinery (`shareIdentity`, `shareEmail`, fallback
ordering) becomes generic.

### `profile-manager.ts`

**Responsibility.** The Claude Code "parallel profiles" feature
(documented in `README.md:207`) currently lives in
`src/lib/claude-parallel.ts` and a shell helper script. Move the
non-shell parts here so the `accounts/` module owns the *concept* of a
named profile across providers.

**Public API.**

```ts
export interface ProfileManager {
  list(): Promise<ProfileSummary[]>;
  add(name: AccountName): Promise<ProfileSummary>;
  remove(name: AccountName): Promise<void>;
  isolatedConfigDir(name: AccountName): string;
}
export interface ProfileSummary {
  name: AccountName;
  configDir: string;
  hasCredentials: boolean;
  email?: Email;
}
```

This file does not duplicate `claude-parallel.ts` — it consumes it. The
goal is to make `AccountService` aware that some "accounts" are actually
parallel profiles and treat them in `listMappings` accordingly.

### Migration sequence

The decomposition must keep `accountService` (the singleton from
`index.ts:19`) functionally identical at every step. Recommended ordering:

1. **Extract `snapshot-store.ts`.** Replace internal `accountFilePath`
   and `listAccountNames` calls with `store.pathFor()` and `store.list()`.
   No behavior change. Land first; it unblocks unit tests.
2. **Extract `pin-store.ts`.** Move all `session*` private methods.
   Replace with `pins.get()`, `pins.set()`, etc. No behavior change.
3. **Extract `current-pointer.ts`.** Move `current` file IO and
   `activateSnapshot`. The facade keeps its old method names and
   delegates.
4. **Extract `identity-resolver.ts`.** This is the hardest because the
   private methods call each other and `this.pathExists` quite a lot.
   Introduce an `IdentityResolver` constructor that takes a
   `SnapshotStore` and a `Registry`. Replace one method at a time.
5. **Extract `switcher.ts`.** Move the public orchestrators
   (`save`, `use`, `remove*`, `find*`, `list*`). The facade now
   delegates almost everything.
6. **Introduce `provider-router.ts`** with one adapter (`Codex`) and
   wire `IdentityResolver` through it. No behavior change.
7. **Add `ClaudeAuthAdapter` and `KiroAuthAdapter`** behind a feature
   flag (e.g., `CODEX_AUTH_PROVIDER_ROUTER=1`) and start exposing
   `--provider` on commands.
8. **Add `profile-manager.ts`** by absorbing `claude-parallel.ts` API
   under it.

Each step is a single PR. The facade `AccountService` shrinks
proportionally; the goal is < 250 lines for the final facade.

**Rollout for the full decomposition.** **P1 / XL**, split across at
least seven PRs.

---

## Type system tightening

This section expands on the `types.ts` critique above, with concrete
proposals.

### Branded primitives

**Evidence.** `account-service.ts` accepts `string` everywhere. Examples:

- `accountFilePath(name: string)` — line 851.
- `removeAccounts(accountNames: string[])` — line 470.
- `findMatchingAccounts(query: string)` — line 341.

The validation at `normalizeAccountName` (line 958) is the only line of
defense. A bug that bypasses it would let a caller write
`accountFilePath("../outside")` and traverse out of the snapshots dir.

**Diagnosis.** Without brands, the compiler cannot enforce that the
validation has run. Cross-method correctness depends entirely on
discipline.

**Proposal.**

```ts
// branded.ts
declare const AccountNameBrand: unique symbol;
export type AccountName = string & { readonly [AccountNameBrand]: true };

declare const EmailBrand: unique symbol;
export type Email = string & { readonly [EmailBrand]: true };

declare const SnapshotPathBrand: unique symbol;
export type SnapshotPath = string & { readonly [SnapshotPathBrand]: true };

declare const AccountIdBrand: unique symbol;
export type AccountId = string & { readonly [AccountIdBrand]: true };

declare const UserIdBrand: unique symbol;
export type UserId = string & { readonly [UserIdBrand]: true };

export function asAccountName(raw: unknown): AccountName {
  if (typeof raw !== "string") throw new InvalidAccountNameError();
  const trimmed = raw.trim().replace(/\.json$/i, "");
  if (!ACCOUNT_NAME_PATTERN.test(trimmed)) throw new InvalidAccountNameError();
  return trimmed as AccountName;
}

export function asEmail(raw: unknown): Email | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized.includes("@") || normalized.length > 254) return null;
  return normalized as Email;
}

// SnapshotPath is constructed only inside SnapshotStore.
```

**Migration.** Brand types erase at runtime so `string` values pass
through unchanged. Introduce the brand types first, then change one
public signature at a time (`save`, `use`, `remove*` are good
candidates).

**Rollout.** **P1 / M.**

### Discriminated unions for parsed snapshots

**Evidence.** `ParsedAuthSnapshot` (line 49) is a flat record with
optional fields. Consumers like `account-service.ts:1599`
(`snapshotsShareIdentity`) and `usage.ts:535` (`fetchUsageFromApi`)
all guard with `if (snapshot.authMode === "chatgpt")` and then read
fields that are typed as optional but logically required.

**Diagnosis.** The compiler does not know that `chatgpt` mode implies
`accessToken`, `accountId`, etc. Every consumer needs runtime checks.

**Proposal.**

```ts
export type ParsedAuthSnapshot = ChatGptAuthSnapshot | ApiKeyAuthSnapshot | UnknownAuthSnapshot;

export interface ChatGptAuthSnapshot {
  authMode: "chatgpt";
  email?: Email;          // OIDC may omit
  accountId?: AccountId;  // present once user has selected an org
  userId?: UserId;        // from sub
  planType?: string;
  accessToken?: string;   // present in fresh tokens, may be expired
}

export interface ApiKeyAuthSnapshot {
  authMode: "apikey";
  // Today the API key itself is dropped. Surface it if the consumer
  // needs to call usage endpoints, but mark it secret.
  apiKey?: string;
}

export interface UnknownAuthSnapshot {
  authMode: "unknown";
  reason?: string;
}
```

**Migration.** Update `auth-parser.ts:39-94` to construct one of the
three shapes. Update `account-service.ts:1599-1623` to narrow with the
discriminant. Most code already does the discriminant check, so the
change is largely mechanical.

**Rollout.** **P1 / S.**

### Provider-tagged registry entries

**Evidence.** `AccountRegistryEntry` (line 20) has no provider tag. The
codebase implicitly assumes "Codex".

**Diagnosis.** Once the `provider-router.ts` lands, the registry needs to
remember which provider an entry was sourced from. Without a tag, a
Claude account written by `ClaudeAuthAdapter` would be re-parsed as
Codex when read back.

**Proposal.**

```ts
export interface AccountRegistryEntry {
  name: AccountName;
  provider: ProviderId;        // NEW
  email?: Email;
  accountId?: AccountId;
  userId?: UserId;
  planType?: string;
  createdAt: string;
  lastUsageAt?: string;
  lastUsage?: UsageSnapshot;
}
```

**Migration.** When loading a registry without `provider`, default to
`"codex"`. Bump the schema version to 2 with a migration step that adds
the field.

**Rollout.** **P2 / M**, conditional on the provider-router landing.

### Eliminate ambient any in the registry sanitizer

**Evidence.** `registry.ts:67-81` (`sanitizeEntry`) and `registry.ts:98-135`
(`sanitizeRegistry`) repeatedly cast `unknown` to `Record<string,
unknown>`. The code is correct but verbose and error-prone.

**Proposal.** Adopt a small parser library (e.g., `valibot` or a
hand-rolled `parseRegistry()` using `zod`-like primitives) so the schema
is declarative and provides better error messages on rejection.

**Rollout.** **P2 / M.**

---

## Errors and result types

### Tagged error taxonomy

**Evidence.** `errors.ts` defines ten classes but no error codes. Callers
use `instanceof` (e.g., `src/commands/save.ts` patterns).

**Diagnosis.**

1. No stable code means JSON output for scripts cannot reliably branch.
2. Adding a new error subclass requires every consumer that switches on
   error type to add a new `instanceof` arm.
3. The error message is the only payload; structured data (e.g., the
   conflicting email pair in `SnapshotEmailMismatchError`) is rendered
   into the message string, not preserved as fields.

**Proposal.**

```ts
export type ErrorCode =
  | "AM_ACCT_NOT_FOUND"
  | "AM_ACCT_AMBIGUOUS"
  | "AM_ACCT_NAME_INVALID"
  | "AM_ACCT_NAME_INFER_FAIL"
  | "AM_ACCT_NONE_SAVED"
  | "AM_AUTH_FILE_MISSING"
  | "AM_AUTH_PARSE_FAIL"
  | "AM_AUTH_MISMATCH"
  | "AM_REMOVE_NO_SELECTION"
  | "AM_AUTOSWITCH_CONFIG"
  | "AM_AUTOSWITCH_SERVICE"
  | "AM_PROMPT_CANCELLED"
  | "AM_REGISTRY_CORRUPT"
  | "AM_REGISTRY_WRITE"
  | "AM_PIN_WRITE"
  | "AM_SNAPSHOT_WRITE"
  | "AM_UNKNOWN";

export class AuthmuxError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthmuxError";
    this.code = code;
    this.details = Object.freeze(details ?? {});
  }
  serialize(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}
```

Then provide thin factories:

```ts
export const accountNotFound = (name: AccountName) =>
  new AuthmuxError("AM_ACCT_NOT_FOUND", `No saved account named "${name}".`, { name });

export const snapshotEmailMismatch = (args: {
  accountName: AccountName;
  existingEmail: Email;
  incomingEmail: Email;
}) =>
  new AuthmuxError(
    "AM_AUTH_MISMATCH",
    `Refusing to overwrite snapshot "${args.accountName}" — existing identity ${args.existingEmail} differs from incoming ${args.incomingEmail}.`,
    args,
  );
```

Keep the legacy subclasses (`AccountNotFoundError`, etc.) as
`@deprecated` thin wrappers that construct an `AuthmuxError` and proxy
`instanceof` for one release.

### Throw vs Result<T, E>

**Decision.** Keep throws as the default for the public service API but
introduce `Result<T, E>` *internally* for hot paths where every failure
is recoverable (parsers, optional fetches, identity probes). Two
reasons:

1. The current CLI flow is already structured around `try/catch` at
   command entry points; flipping the whole module to `Result` is a
   massive churn for marginal benefit at the surface.
2. Internally, the parser and identity helpers fail constantly during
   normal operation (e.g., probing whether a snapshot's identity matches
   the incoming snapshot). Encoding that as a thrown exception is
   wrong; `Result` is the right shape there.

**Proposal.**

```ts
export type Result<T, E = AuthmuxError> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

Migrate `parseAuthSnapshotFile` first (low risk, high value), then the
identity helpers. Keep the facade methods (`save`, `use`, `remove`)
throwing.

**Rollout.** Tagged errors: **P1 / S**. Internal Result type: **P2 / M**.

---

## Registry storage

### Atomic writes

**Evidence.** `registry.ts:148-152` writes the registry directly to the
final path.

**Diagnosis.** A crash, SIGKILL, full disk, or container restart during
the write leaves the registry in an indeterminate state. `loadRegistry`
will silently replace it with defaults.

**Proposal.**

```ts
async function writeFileAtomic(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  const handle = await fsp.open(tempPath, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tempPath, targetPath);
}
```

Use this for the registry, the session map, the `current` file, and the
snapshot writes. (Note: `fsync` on the directory after the rename is
technically required for full crash safety on Linux ext4; depending on
appetite, add `fs.opendir` + `dir.sync()` or accept the slightly weaker
guarantee.)

**Rollout.** **P0 / S.**

### Schema versioning and migrations

**Evidence.** `types.ts:42` (`version: 1`) is checked once at
`account-service.ts:1288` and any non-1 input is discarded. There is no
forward path.

**Proposal.**

```ts
export const LATEST_REGISTRY_VERSION = 2;
export type AnyRegistry = RegistryV1 | RegistryV2;

const migrations: Array<{
  from: number;
  to: number;
  migrate(input: AnyRegistry): AnyRegistry;
}> = [
  {
    from: 1,
    to: 2,
    migrate(input) {
      // add provider field to every entry
      const v1 = input as RegistryV1;
      return {
        ...v1,
        version: 2,
        accounts: Object.fromEntries(
          Object.entries(v1.accounts).map(([name, entry]) => [
            name,
            { ...entry, provider: "codex" as ProviderId },
          ]),
        ),
      };
    },
  },
];

export function migrateRegistry(input: AnyRegistry): RegistryV2 {
  let current: AnyRegistry = input;
  while (current.version < LATEST_REGISTRY_VERSION) {
    const step = migrations.find((m) => m.from === current.version);
    if (!step) throw new AuthmuxError("AM_REGISTRY_CORRUPT", `No migration from v${current.version}`);
    current = step.migrate(current);
  }
  return current as RegistryV2;
}
```

**Migration.** Ship with zero migrations registered so the runner is a
no-op. Land the provider field migration with the provider-router work.

**Rollout.** **P2 / M.**

### Corruption recovery

**Evidence.** `loadRegistry` (line 137) returns defaults on any error.

**Proposal.**

```ts
export async function loadRegistry(): Promise<RegistryData> {
  const registryPath = resolveRegistryPath();
  let raw: string;
  try {
    raw = await fsp.readFile(registryPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return createDefaultRegistry();
    throw new AuthmuxError("AM_REGISTRY_CORRUPT", `Could not read registry: ${err.message}`, { path: registryPath }, { cause: err });
  }
  try {
    return sanitizeRegistry(JSON.parse(raw));
  } catch (e) {
    const quarantinePath = `${registryPath}.corrupt-${Date.now()}`;
    await fsp.copyFile(registryPath, quarantinePath).catch(() => undefined);
    // Emit a warning the CLI can surface.
    process.emitWarning(`Registry at ${registryPath} was corrupt; quarantined to ${quarantinePath}`, "AuthmuxRegistry");
    return createDefaultRegistry();
  }
}
```

**Rollout.** **P0 / S.**

### File locking

**Evidence.** Multiple processes can race on the registry: the daemon
loop (`account-service.ts:669`) and a foreground `authmux use` call can
both `loadRegistry` → mutate → `saveRegistry`. Last-write-wins.

**Diagnosis.** Lost updates are real. A user pressing `authmux remove
foo` while the daemon is updating usage cache can lose the removal.

**Proposal.**

1. Wrap every read-modify-write cycle in a `withRegistryLock(async (r)
   => { ... })` helper that acquires an OS-level lock on
   `registry.json.lock` using `proper-lockfile` (or the equivalent
   homegrown lock).
2. The lock is held for the duration of the mutation. Avoid holding it
   across `await` boundaries that do network IO (e.g., fetching usage):
   load → close lock → fetch → reopen lock → re-load → merge → save.

**Migration.** Add the helper, opt the daemon's `runAutoSwitchOnce` and
`refreshListUsageIfNeeded` in first. Foreground commands second.

**Rollout.** **P1 / M.**

### Optional storage backend

**Evidence.** Today the registry is a single JSON file. As accounts
multiply (some users in tickets report 30+ Codex accounts), JSON
serialization is fine but the all-or-nothing write pattern starts to
hurt.

**Proposal (long horizon).** Behind a flag (`CODEX_AUTH_STORAGE=sqlite`),
back the registry with `better-sqlite3`. The registry types stay
identical; only the store changes.

- One table for accounts, one for usage snapshots (1:N), one for
  pins, one for kv settings (auto-switch config).
- Atomic transactions replace the temp-file dance.
- Per-account updates become surgical instead of rewriting the world.

**Rollout.** **P3 / XL.** Only worth doing if telemetry shows the JSON
store is actually causing pain.

---

## Identity inference

### Codex quirks

**Evidence.** `auth-parser.ts:23-28` looks for the
`https://api.openai.com/auth` claim and treats it as the source of
truth for `chatgpt_account_id`, `chatgpt_user_id`, and
`chatgpt_plan_type`. Fallbacks at `auth-parser.ts:62-84` look at:

- `tokens.account_id`, `tokens.chatgpt_account_id`,
  `tokens.default_account_id`.
- `auth.chatgpt_account_id`, `auth.account_id`,
  `auth.default_account_id`.
- Root-level `account_id` and `chatgpt_account_id`.

This shotgun approach exists because OpenAI has shipped at least three
variations of the field layout over time. The order matters: nested
auth claim wins because it is the freshest.

**Diagnosis.** Codex is the well-trodden path; the inference is
correct. The brittleness is in the fallback ordering not being
documented and not being version-aware.

### Claude Code quirks

**Evidence.** `src/lib/claude-parallel.ts` and the README section at line
207 describe parallel profiles via `CLAUDE_CONFIG_DIR`. Identity
extraction from Claude's `.credentials.json` is *not* implemented in
`auth-parser.ts`.

**Diagnosis.** Claude stores credentials in a different schema
(`{ access_token, refresh_token, expires_at, user_id, email, organization_id }`
under varying keys depending on auth method). Without a dedicated
adapter, we cannot match incoming Claude logins to existing snapshots.

### Kiro quirks

**Evidence.** `src/lib/kiro-mirror.ts:5` reads from
`~/.local/share/kiro-cli/data.sqlite3`. Identity is implicit in which
named snapshot directory is symlinked.

**Diagnosis.** SQLite means a different IO model entirely. The adapter
needs to query a database, not parse JSON. The schema is also
undocumented and may change between Kiro releases.

### Proposal: `ProviderAdapter.inferIdentity()`

```ts
export interface ProviderAdapter {
  readonly id: ProviderId;
  /**
   * Given the raw on-disk auth artifact for this provider (JSON,
   * SQLite, whatever), produce a normalized identity record.
   */
  inferIdentity(): Promise<ParsedAuthSnapshot>;
  /**
   * The "live" auth path the provider's CLI reads from. Used by
   * activateSnapshot to know where to materialize.
   */
  livePath(): SnapshotPath;
  /**
   * Per-provider rules for whether two parsed snapshots represent the
   * same identity. Most providers can delegate to a shared helper,
   * but Kiro might need a SQLite-specific equality check.
   */
  shareIdentity(a: ParsedAuthSnapshot, b: ParsedAuthSnapshot): boolean;
}
```

Implementations:

- `CodexAuthAdapter` — wraps existing `auth-parser.ts` and the file at
  `~/.codex/auth.json`.
- `ClaudeAuthAdapter` — reads `~/.claude/.credentials.json` and
  extracts user email and id. Falls back to `~/.claude-accounts/<name>/`
  for parallel profiles.
- `KiroAuthAdapter` — reads `~/.local/share/kiro-cli/data.sqlite3`,
  queries the auth table, returns the stored email/id.

Selection rule for `ProviderRouter.forSnapshot(snapshot)`: inspect the
shape of the file (extension, magic bytes, top-level keys). Cache the
decision per snapshot path.

**Rollout.** **P2 / L**, gated on the provider-router scaffolding
landing first.

---

## Snapshot integrity

### Checksum on save

**Evidence.** Snapshots are written by `fsp.copyFile(authPath,
destination)` at `account-service.ts:408`. No checksum is recorded.

**Diagnosis.** Snapshots can be corrupted by:

1. A partial write if the source `auth.json` was being rewritten by
   Codex at the moment we copied.
2. A subsequent clobber via a stale symlink (which is what the backup
   vault at line 859 partially mitigates).
3. Filesystem-level corruption that we cannot detect.

**Proposal.** Store a `sha256` of the snapshot bytes in the registry
entry. On read (`saveAccount` follow-up, `useAccount`, `runAutoSwitchOnce`),
verify the digest. If it mismatches:

1. Attempt restore from the backup vault.
2. If that fails too, mark the entry as `quarantined: true` in the
   registry and skip it for auto-switch.

```ts
export interface AccountRegistryEntry {
  // ...existing fields...
  snapshotSha256?: string;       // NEW
  quarantined?: boolean;          // NEW
}
```

### Tamper detection on activation

When `activateSnapshot` (line 1297) copies a saved snapshot into
`auth.json`, it should:

1. Verify the saved snapshot's digest before copy.
2. After copy, re-read `auth.json` and verify the digest matches
   what was written.

If either check fails, abort the activation and emit a structured error.

### Partial-write guard

Use the same `writeFileAtomic` helper proposed for the registry on
snapshot writes. Today `copyFile` is atomic enough on most filesystems
but not guaranteed cross-platform.

**Rollout.**

- Digest storage: **P1 / S**.
- Verify-on-read: **P1 / S**.
- Quarantine flow: **P2 / M**.

---

## Concurrency and pinning

### The PPID-scoped pin model

**Evidence.** README line 81 states:

> Set `CODEX_AUTH_SESSION_KEY=<id>` to explicitly scope session-memory
> identity (optional; default uses shell PPID).

The implementation is at `account-service.ts:1384-1396`
(`resolveSessionScopeKey`). The intent: each terminal has its own
"active" account, derived from the shell's PPID, so two terminals can
run two different Codex accounts side-by-side without trampling each
other.

**Diagnosis.**

1. **PPID is racy and short-lived.** A PID can be recycled, and
   `process.ppid` only refers to the *immediate* parent. When the user
   runs `authmux use foo` from a wrapped shell (e.g., tmux + zsh +
   subshell), the PPID can refer to the subshell, not the tmux pane.
2. **The pin liveness check at line 1537 only works on Linux.** macOS
   and Windows return `true` unconditionally (line 1551–1552). A pin
   set in terminal A persists forever in the session map for those
   platforms.
3. **No GC.** Pins accumulate indefinitely.
4. **`session:` keys are trusted unconditionally.** Line 1547–1549
   returns `true` for any `session:` key. This is correct (the user
   explicitly opted in) but means a stale `session:` pin on disk
   silently controls behavior.

### Proposal: explicit `PinScope`

(See `pin-store.ts` API above.)

Concrete behaviors:

1. **Scope tagging at write time.** Every pin entry stores its scope so
   later GC can apply scope-appropriate rules.
2. **Live-process verification on every read.**
   - Linux: existing `/proc/<ppid>/task/<ppid>/children` scan.
   - macOS: `ps -p <ppid>` returns non-zero → pin is stale.
   - Windows: `tasklist /FI "PID eq <ppid>"` parse.
3. **Time-based GC.** Pins older than 7 days are dropped on the next
   write, regardless of scope.
4. **Active-process GC.** `pin-store.gcStalePins({ olderThanMs: 0 })`
   walks every PPID-scoped pin and drops those whose parent process is
   gone.
5. **Explicit reset command.** `authmux pin --reset` clears all pins
   for the current scope (or all pins with `--all`). Today there is no
   way to do this without manually editing the session map.

### Lock contention with the daemon

**Evidence.** The daemon (`runDaemon`, line 669) wakes every 30s and
calls `runAutoSwitchOnce`, which reads the registry, refreshes usage,
writes the registry, and may activate a different snapshot. If the user
runs `authmux use foo` at the same moment:

- The daemon may overwrite the user's choice with its own switch.
- The two writes may race and the user's update may be lost.

**Diagnosis.** No coordination exists between the foreground command
and the background daemon.

**Proposal.**

1. Adopt the `withRegistryLock` helper (see *Registry storage* above).
2. The daemon writes a heartbeat into the lock file metadata
   (timestamp + PID). Foreground commands that wait for the lock can
   surface "waiting on daemon..." after 1s.
3. The daemon respects a "user pinned this terminal to account X"
   signal: if the active terminal's pin matches the current active
   account, the daemon refuses to auto-switch away. Today the daemon
   only checks `registry.activeAccountName` (line 608) and is
   pin-blind.

### Pin GC policy

```ts
const STALE_PIN_TTL_DAYS = 7;
const FOREGROUND_GC_BUDGET_MS = 50;

async function gcOnEveryWrite(pins: PinStore): Promise<void> {
  await pins.gcStalePins({ olderThanMs: STALE_PIN_TTL_DAYS * 24 * 60 * 60 * 1000 });
}
```

Foreground GC runs opportunistically with a strict time budget so it
never delays the user-facing command. The daemon runs a thorough GC
every hour.

**Rollout.**

- Scope tagging + GC: **P1 / S**.
- Live-process verification on macOS/Windows: **P1 / M**.
- Registry locking: **P1 / M**.
- Daemon respects pins: **P2 / M**.

---

## Testing

The accounts module has very few unit tests today. The decomposition
proposed above is what *enables* meaningful testing; this section lays
out what to test once the seams exist.

### Boundaries to fake

1. **Filesystem.** Use `memfs` or a thin in-memory abstraction so tests
   are deterministic and parallel-safe. Every store
   (`SnapshotStore`, `PinStore`, `Registry`) accepts an injectable
   `Fs` interface.
2. **Clock.** Pass a `Clock = { now(): number }` into the modules that
   timestamp (registry writes, pin updates, usage freshness checks).
3. **Process introspection.** Wrap `process.ppid`, `process.env`,
   `process.platform` behind a `Runtime` interface so tests can
   simulate Linux/macOS/Windows.
4. **Child process / spawnSync.** `service-manager.ts` calls
   `systemctl`, `launchctl`, `schtasks`. Inject a fake `Runner` that
   captures invocations.
5. **HTTP fetch.** `usage.ts` calls `fetch` for the proxy and the
   ChatGPT usage endpoint. Inject a fake `Fetcher`.
6. **Provider adapters.** Each `ProviderAdapter` should be testable in
   isolation by providing canned auth artifacts.

### Recommended test taxonomy

1. **Pure unit tests** (no IO) for:
   - `auth-parser.ts:39-94` — many JWT and root-level shapes including
     malformed inputs.
   - `plan-display.ts` — every entry in the label maps plus several
     hostile inputs.
   - `usage.ts:487-533` — window selection, score computation,
     `shouldSwitchCurrent` boundary cases.
   - `identity-resolver.ts` — `shareIdentity` and `shareEmail` truth
     tables; `orderReloginSnapshotCandidates` ordering.
2. **Integration tests** with `memfs` for:
   - `SnapshotStore` — save/list/read/delete round-trips, atomic write
     under simulated crashes, reserved-name filter.
   - `Registry` — sanitize-then-roundtrip, corruption quarantine,
     atomic write, migration runner with golden fixtures.
   - `PinStore` — write, GC, live-process verification (fake `/proc`).
   - `CurrentPointer` — current-file + auth-symlink materialization.
   - `Switcher` end-to-end:
     - Save new account; subsequent save with overlapping email rejects
       without `--force`.
     - Use account; pin is updated; daemon switch is blocked.
     - Remove active account; fallback chosen by best-score.
3. **Property tests** (with `fast-check`) for:
   - `normalizeAccountName` accepts every legal input and rejects every
     illegal one.
   - `sanitizeRegistry` is idempotent: `sanitize(sanitize(x)) ===
     sanitize(x)`.
   - `reconcileRegistryWithAccounts` is idempotent and stable.
4. **Golden tests** for registry migrations:
   - Each `from -> to` migration ships with `before.json` and
     `after.json` fixtures committed in `tests/fixtures/registry/`.
   - The test asserts `migrate(before) === after` byte-for-byte.
5. **End-to-end tests** in a sandbox temp dir:
   - Run the real CLI (`authmux save`, `authmux use`) against a fake
     `~/.codex/auth.json` produced by a fixture generator. The tests
     verify the snapshot dir, registry, and current pointer end up in
     the expected state.

### Test-only seams to add now

Even before the decomposition lands, two seams cost nothing and unlock
tests:

1. Export `parseAuthSnapshotData` already-exported (`auth-parser.ts:39`)
   so unit tests can feed in raw objects instead of files. Done.
2. Add an `accountServiceFor({ fs, clock, runtime })` factory next to
   the default singleton so integration tests can construct a
   service against a fake filesystem.

**Rollout.** Test scaffolding (memfs + runtime fakes): **P1 / M**.
First wave of unit tests for `auth-parser`, `plan-display`, `usage`
helpers: **P1 / S** each.

---

## Cross-cutting recommendations

A short closing list of cross-cutting items that don't fit cleanly under
any single file:

1. **Add structured logging.** Every silent return in
   `syncExternalAuthSnapshotIfNeeded`, `restoreSessionSnapshotIfNeeded`,
   and `runAutoSwitchOnce` should emit a debug event behind
   `DEBUG=authmux:accounts`. The current "returns silently with no
   reason" pattern (e.g., `account-service.ts:165-167`) is the most
   common source of support tickets that can't be triaged.
2. **Surface decisions in `authmux status`.** Today `getStatus` (line
   533) returns a minimal report. Augment it with `lastSync: { atIso,
   action, savedName? }` so users can see what the most recent shell
   hook did.
3. **Document the "force" semantics.** The `force` flag flows through
   `saveAccount` (line 405) and `resolveLoginAccountNameForSnapshot`
   (line 1127) and is set automatically when an email match exists
   without an identity match (line 1172). Add a top-of-file comment in
   `identity-resolver.ts` once the split lands so future contributors
   understand the contract.
4. **Stop calling `os.homedir()` at module load.** `paths.ts:62-67`
   evaluates the paths at import time. Combined with env-driven
   overrides, this guarantees that any code that *first* sets
   `process.env.CODEX_AUTH_CODEX_DIR` and *then* imports `paths`
   gets the wrong value. Make those exports getters or remove them
   entirely. (Covered in detail in `05-CONFIG-AND-PATHS.md`.)
5. **Cap `LIST_USAGE_REFRESH_CONCURRENCY`.** Line 57 sets it to 6. For
   users with 30+ accounts hitting the ChatGPT usage endpoint, this is
   reasonable, but the constant is hidden. Surface it as
   `CODEX_AUTH_USAGE_REFRESH_CONCURRENCY` env var so support can dial
   it down if a user is being rate-limited.
6. **Add a `--dry-run` to mutating commands.** Most of the proposals
   above produce side effects on disk. A `--dry-run` mode that runs
   every path through the same code with a "FS = noop" runtime would
   give users (and support) a safe way to preview behavior.

---

## Summary of priorities

| Item | Priority | Size |
|---|---|---|
| Fix `"proxy"` source being dropped (`registry.ts:26`) | P0 | S |
| Atomic writes for registry + snapshots + session map | P0 | S |
| Registry corruption recovery with quarantine | P0 | S |
| Guard reconciliation against empty-list false positive | P0 | S |
| Tagged error taxonomy with codes | P1 | S |
| Branded primitives (`AccountName`, `Email`, ...) | P1 | M |
| Discriminated `ParsedAuthSnapshot` | P1 | S |
| Typed `AuthParseResult` and parser error context | P1 | M |
| Structured logging behind `DEBUG=authmux:accounts` | P1 | S |
| Snapshot digest + verify-on-read | P1 | S |
| Service-manager env propagation + absolute binary path | P1 | S |
| File locking around registry writes | P1 | M |
| PinScope tagging + GC + cross-platform liveness | P1 | M |
| `snapshot-store.ts` extraction | P1 | M |
| `pin-store.ts` extraction | P1 | M |
| `current-pointer.ts` extraction | P1 | M |
| `identity-resolver.ts` extraction | P1 | L |
| `switcher.ts` extraction | P1 | L |
| Test scaffolding (memfs + runtime fakes) | P1 | M |
| Daemon respects pins | P2 | M |
| Window-match tolerance + stale-reset masking | P2 | M |
| Schema migration runner + provider field | P2 | M |
| Provider router with Claude + Kiro adapters | P2 | L |
| `profile-manager.ts` consolidation | P2 | M |
| Snapshot quarantine flow | P2 | M |
| Service-manager log redirection | P2 | S |
| Internal Result<T, E> for hot paths | P2 | M |
| Surface decisions in `authmux status` | P2 | S |
| Optional SQLite/LMDB registry backend | P3 | XL |
| Legacy managed-service label cleanup | P3 | S |

The combined effort (excluding P3) is roughly six to eight weeks of
focused work for one engineer, or two to three sprints for a pair. The
P0 items together are less than a day and should ship in the next
release.
