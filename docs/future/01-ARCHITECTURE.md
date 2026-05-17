# 01 — Architecture

This document captures the current architecture of `authmux` in enough detail
that a contributor can find any file in `src/` from a one-line description, and
then proposes a four-layer target architecture, a domain model, a concurrency
model, an error taxonomy, a public TypeScript API, and a plug-in story for new
CLI targets. It closes with a suggested ADR template.

Every proposal here follows the **Evidence / Diagnosis / Proposal / Migration /
Rollout** shape introduced in `00-OVERVIEW.md`.

## 1. Current architecture — module map

### 1.1 Directory tree

```
src/
  index.ts                       # oclif bootstrap: run() -> flush() -> Errors.handle
  hooks/
    init/
      update-notifier.ts         # oclif init hook (registered in package.json:62-65)
  commands/                      # 26 oclif commands; one file per CLI verb
    auto-switch.ts
    check.ts
    clean.ts
    config.ts
    current.ts
    daemon.ts
    export.ts
    forecast.ts
    hero.ts
    hook-install.ts
    hook-remove.ts
    hook-status.ts
    import.ts
    kiro-login.ts
    kiro.ts                      # does NOT extend BaseCommand
    list.ts
    login.ts
    parallel.ts                  # does NOT extend BaseCommand
    remove.ts
    restore-session.ts
    save.ts
    savings.ts
    status.ts
    switch.ts
    update.ts
    use.ts
  lib/
    base-command.ts              # BaseCommand abstract class (26 lines)
    account-health.ts            # success/failure tracking per account
    account-savings.ts           # cross-switch savings counters
    hermes-mirror.ts             # Hermes provider mirror
    kiro-mirror.ts               # Kiro provider mirror
    update-check.ts              # npm registry latest-version probe
    usage-refresh.ts             # higher-level wrapper around accounts/usage
    config/
      paths.ts                   # path resolvers (env-var aware)
      login-hook.ts              # shell rc-file hook template + I/O
    accounts/                    # the core subsystem
      index.ts                   # barrel + singleton `accountService`
      account-service.ts         # 1,663 lines — the god-file
      registry.ts                # JSON sanitizer + load/save (181 lines)
      service-manager.ts         # per-OS daemon installer (219 lines)
      usage.ts                   # API/local/proxy fetchers (660 lines)
      auth-parser.ts             # parse a single auth.json blob
      plan-display.ts            # planType -> friendly label
      types.ts                   # all shared interfaces (84 lines)
      errors.ts                  # CodexAuthError class hierarchy
  tests/                         # 4 small node:test files
    account-plan-display.test.ts
    auth-parser.test.ts
    registry.test.ts
    usage.test.ts
  types/                         # ambient .d.ts (if any)
```

### 1.2 Dependency direction (as-is)

The intended direction of dependencies is `commands/ → lib/ → lib/accounts/`,
but the reality is more tangled. The arrows below are *actual* imports, not
intended ones:

```
                +----------------------+
                |  src/index.ts        |
                | (oclif bootstrap)    |
                +----------+-----------+
                           |
            +--------------v---------------+
            |  src/commands/*.ts (26)      |
            |  via BaseCommand or direct   |
            +---+--------+--------+--------+
                |        |        |
                |        |        +-----------------+
                |        |                          |
        +-------v---+ +--v----------------+ +-------v------+
        | base-     | | account-health    | | parallel.ts  |
        | command   | | account-savings   | | kiro.ts      |
        | .ts       | | kiro-mirror       | | (bypass      |
        +----+------+ | hermes-mirror     | |  BaseCommand)|
             |        | usage-refresh     | +--------------+
             |        | update-check      |
             v        +---+---------------+
        +-------+         |
        |accounts|        |
        |/index  +<-------+
        +---+----+
            |
   +--------v---------+
   | account-service  |  --+
   | (1663 LOC)       |    |
   +---+---+----+-----+    |
       |   |    |          |
       v   v    v          |
  registry usage service-manager
       \   |    /
        \  |   /
         v v  v
       types  errors  auth-parser  paths
```

Two observations that shape the rest of this document:

1. `account-service.ts` is the **only** place where the registry, usage,
   service-manager, paths, auth-parser, and errors are all stitched together.
   That is the god-file pattern; it makes every command a thin shim over an
   already-monolithic service.
2. The boundary between `lib/` and `lib/accounts/` is leaky. `account-health`,
   `account-savings`, `kiro-mirror`, `hermes-mirror`, and `usage-refresh` all
   live one level above `accounts/`, but they semantically *are* account
   concerns. They are not yet domain-modeled.

### 1.3 BaseCommand contract

```ts
// src/lib/base-command.ts
export abstract class BaseCommand extends Command {
  protected readonly accounts = accountService;
  protected readonly syncExternalAuthBeforeRun: boolean = true;

  protected async runSafe(action: () => Promise<void>): Promise<void> {
    try {
      if (this.syncExternalAuthBeforeRun) {
        await this.accounts.syncExternalAuthSnapshotIfNeeded();
      }
      await action();
    } catch (error) {
      this.handleError(error);
    }
  }
}
```

The contract is small but load-bearing:

- Every subclass gets a singleton `accountService`.
- Every subclass gets `runSafe`, which auto-syncs external auth and folds
  `CodexAuthError` into `this.error(...)`.
- Subclasses can opt out of the pre-run sync with
  `syncExternalAuthBeforeRun = false`. Today only `login.ts` and `use.ts` do
  so — `login` because it is about to run `codex login` itself, and `use`
  because it activates a snapshot that was already known.

`parallel.ts:22` and `kiro.ts:27` extend `@oclif/core`'s `Command` directly,
which means they:

- skip the external-sync warm-up;
- raise raw `Error` instead of `CodexAuthError`;
- have no access to the singleton account service.

This is fine for the Claude-parallel and Kiro-symlink flows because those do
not touch Codex auth. But it leaks an inconsistency that 02-COMMANDS.md
addresses.

## 2. Critique of the god-files

### 2.1 `account-service.ts` — 1,663 lines

**Evidence.** A single class, `AccountService`, exports 20+ public methods
ranging from `syncExternalAuthSnapshotIfNeeded` (line 110) to
`isCodexProcess` (line 1585). Method clusters include:

| Method cluster                                                                 | Approx. line range | Role                          |
| ------------------------------------------------------------------------------ | ------------------ | ----------------------------- |
| `syncExternalAuthSnapshotIfNeeded`, `restoreSessionSnapshotIfNeeded`           | 110–253            | External-auth sync orchestrator |
| `listAccountNames`, `listAccountChoices`, `listAccountMappings`                | 255–339            | Read-side listings            |
| `findMatchingAccounts`, `getCurrentAccountName`                                | 341–392            | Discovery                     |
| `saveAccount`, `inferAccountNameFromCurrentAuth`                               | 394–447            | Write-side: save              |
| `useAccount`, `removeAccounts`, `removeByQuery`, `removeAllAccounts`           | 457–531            | Write-side: switch/remove     |
| `getStatus`, `setAutoSwitchEnabled`, `setApiUsageEnabled`, threshold setters   | 533–595            | Config                        |
| `runAutoSwitchOnce`, `runDaemon`, `selectBestCandidateFromRegistry`            | 597–699            | Auto-switch policy            |
| `refreshAccountUsage`, `refreshListUsageIfNeeded`, `isUsageMissingForList`     | 701–801            | Usage refresh adapter         |
| `resolveProxyUsage`, `lookupProxyUsage`                                        | 803–849            | Proxy usage shim              |
| `backupAllSnapshots`, `restoreClobberedSnapshotsFromBackup`                    | 859–956            | Crash-safety vault            |
| `normalizeAccountName`, `materializeAuthSymlink`                               | 958–999            | Name/file utilities           |
| `assertSafeSnapshotOverwrite`, `writeCurrentName`, `readCurrentNameFile`       | 1001–1062          | Snapshot I/O guards           |
| `resolveLoginAccountNameForSnapshot` and friends                               | 1127–1283          | Login-name resolution         |
| `loadReconciledRegistry`, `persistRegistry`, `activateSnapshot`                | 1285–1313          | Registry persistence          |
| `resolveSessionScopeKey`, `getSessionAccountName`, session map I/O             | 1384–1535          | Session pinning               |
| `isSessionPinnedToActiveCodex`, `readChildPids`, `isCodexProcess`              | 1537–1597          | Linux PPID heuristic          |
| `snapshotsShareIdentity`, `registryEntrySharesIdentity`, identity rendering    | 1599–1662          | Identity equality             |

**Diagnosis.** This file is the literal definition of a god-class: every
account-related concern bottoms out here, and the only reason it has not been
split is that the constituent concerns were grown organically across the
v0.1.6 → v0.1.21 releases (`releases/v0.1.*.md`). Each concern is reasonable on
its own; their cohabitation is not.

Concrete consequences observed today:

1. The file is too long to safely review in a normal PR — reviewers default to
   diff-only review and miss interactions with sibling clusters.
2. Tests sit at the registry / usage / parser boundaries only (see
   `src/tests/*.test.ts`). There is no per-cluster test seam.
3. Cross-cluster invariants (e.g. "session pin must always reference an
   existing snapshot") are enforced ad-hoc in multiple call sites instead of
   one.
4. Any concurrency story has to consider all 1,663 lines, since every method
   eventually touches `~/.codex/`.

**Proposal.** Split into ten focused files under `src/lib/accounts/`, each
≤ 250 lines and each exporting a function/class that the new top-level
`AccountService` only orchestrates. Target layout:

| New file                                       | Responsibility                                                | Pulls from `account-service.ts` lines |
| ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| `sync/external-sync.ts`                        | `syncExternalAuthSnapshotIfNeeded`, `restoreSessionSnapshotIfNeeded` | 110–253                          |
| `read/listing.ts`                              | `listAccountNames`, `listAccountChoices`, `listAccountMappings`, `findMatchingAccounts` | 255–355 |
| `write/save.ts`                                | `saveAccount`, `assertSafeSnapshotOverwrite`, `inferAccountNameFromCurrentAuth` | 394–447, 1001–1030 |
| `write/use.ts`                                 | `useAccount`, `activateSnapshot`, `resolveUsableAccountName` | 457–468, 1297–1335                    |
| `write/remove.ts`                              | `removeAccounts`, `removeByQuery`, `removeAllAccounts`        | 470–531                               |
| `config/auto-switch-config.ts`                 | Threshold setters, `getStatus`, `setApiUsageEnabled`          | 533–595                               |
| `auto-switch/policy.ts`                        | `runAutoSwitchOnce`, `runDaemon`, scoring                     | 597–699                               |
| `usage/adapter.ts`                             | `refreshAccountUsage`, `refreshListUsageIfNeeded`, proxy shim | 701–849                               |
| `safety/snapshot-vault.ts`                     | Backup vault + clobber recovery                                | 859–956                               |
| `session/pin.ts`                               | All session-map I/O + Linux PPID heuristic                    | 1384–1597                             |
| `identity/equality.ts`                         | Snapshot identity comparisons                                  | 1599–1662                             |
| `naming.ts`                                    | `normalizeAccountName`, name pattern, inference utilities      | 958–998, 1214–1283                    |

A trimmed top-level `account-service.ts` would shrink to ~150 lines and exist
only to wire these pieces together for callers that want a single import.

**Migration.**
1. Create `src/lib/accounts/_internal/` and move helpers there first, with no
   public-API change.
2. For each cluster, extract a free function, leave a thin wrapper method on
   `AccountService` that delegates to it. One PR per cluster.
3. Add a `__test__` test alongside each new file as the cluster moves out.
4. Once every method is a delegate, mark `AccountService` `@deprecated` in
   favor of named imports from `src/lib/accounts/index.ts`.
5. After two minor releases, remove the wrapper methods.

**Rollout.** No user-visible change. Behind a `AUTHMUX_LEGACY_SERVICE=1` env
opt-out for one minor, in case an embedder depended on the class. Telemetry
counter `account_service.method_call{method=...}` to catch external usage
before removal. Tag: `P1`, `L`, `med` risk.

### 2.2 `usage.ts` — 660 lines

**Evidence.** `src/lib/accounts/usage.ts` mixes:

- HTTP client to `https://chatgpt.com/backend-api/wham/usage` (line 7);
- HTTP client to a localhost dashboard proxy at `http://127.0.0.1:2455`
  (line 8) with its own session/login/TOTP dance (constants on lines 9–17);
- Local `rollout-*.jsonl` file walker under `~/.codex/sessions/` (line 571);
- The scoring/threshold pure functions (`remainingPercent`, `usageScore`,
  `shouldSwitchCurrent`, `resolveRateWindow`).

**Diagnosis.** Three distinct subsystems are co-resident in one file: a remote
API client, a remote proxy client with auth, and a local-file parser. Each has
its own retry profile, timeout, and failure mode. Co-resident, they share
nothing useful but inflate the file's blast radius for any change.

**Proposal.** Split into:

- `usage/api-client.ts` — public `fetchUsageFromApi(parsed)`; one fetch with
  `REQUEST_TIMEOUT_MS` (5000) timeout.
- `usage/proxy-client.ts` — public `fetchUsageFromProxy()` returning
  `ProxyUsageIndex`; encapsulates the dashboard session, password env, and TOTP
  helper.
- `usage/local-rollout.ts` — public `fetchUsageFromLocal(codexDir)`; walks
  `sessions/` and parses jsonl.
- `usage/math.ts` — pure functions `remainingPercent`, `usageScore`,
  `shouldSwitchCurrent`, `resolveRateWindow`. No I/O.
- `usage/index.ts` — barrel re-export, with types `RateLimitWindow`,
  `UsageSnapshot` re-exported from `accounts/types.ts`.

**Migration.** Three small PRs, each moving one client. The math file goes
first so tests can exercise it without mocking HTTP.

**Rollout.** Internal refactor; no telemetry. Tag: `P1`, `M`, `low`.

## 3. Layering target — the four-layer model

### 3.1 Before (today)

```
+-----------------------------------------------------+
| oclif Command subclasses (src/commands/*.ts)        |
| - I/O: stdout, stderr, prompts                      |
| - Logic: occasionally inline                        |
| - Mirrors: kiro-mirror, hermes-mirror called here   |
+--------------------------+--------------------------+
                           |
                           v
+-----------------------------------------------------+
| AccountService (1663 LOC)                           |
| - Orchestration, policy, persistence, I/O           |
| - Direct fs calls; direct fetch; direct spawnSync   |
+--------------------------+--------------------------+
                           |
                           v
+-----------------------------------------------------+
| Pure-ish helpers: registry, usage, auth-parser,     |
| service-manager (all directly fs/network bound)     |
+-----------------------------------------------------+
```

### 3.2 After (target)

```
+-----------------------------------------------------+
| Layer 1 — CLI / Commands  (src/cli/commands/*.ts)   |
|                                                     |
|  Parse oclif flags; format output; prompt user.     |
|  No business logic. No fs/network.                  |
+--------------------------+--------------------------+
                           |
                           v
+-----------------------------------------------------+
| Layer 2 — Application orchestrators                 |
|          (src/app/{login,switch,daemon,...}.ts)     |
|                                                     |
|  One file per use case. Pure async functions that   |
|  take domain inputs and return domain results.      |
+--------------------------+--------------------------+
                           |
                           v
+-----------------------------------------------------+
| Layer 3 — Domain                                    |
|          (src/domain/accounts/, src/domain/usage/,  |
|           src/domain/session/, src/domain/provider/)|
|                                                     |
|  Entities, value objects, invariants. No I/O.       |
|  Provider adapters are injected as ports.           |
+--------------------------+--------------------------+
                           |
                           v
+-----------------------------------------------------+
| Layer 4 — Infrastructure (src/infra/...)            |
|                                                     |
|  fs/ for atomic writes and locking                  |
|  http/ for upstream APIs and proxy                  |
|  os-service/ for systemd/launchd/schtasks           |
|  shell-hooks/ for rc-file mutation                  |
|  process/ for spawnSync / spawn                     |
+-----------------------------------------------------+
```

Layers may only import downward. A Layer 3 file may not import from `node:fs`,
`node:child_process`, or `node:net`; those calls must come through Layer 4
ports.

### 3.3 Why four and not three

Three layers (CLI → service → infra) is what the project has informally today.
The extra middle layer (application orchestrators) exists because there is a
recurring need for "one use case, many sources of truth" — for example
`syncExternalAuthSnapshotIfNeeded` reads `auth.json`, the snapshot dir, the
registry, the session map, and the backup vault. Today that lives in
`account-service.ts:110-204`, where it is hard to test because the domain
objects are entangled with disk paths. An orchestrator function in Layer 2
can take a `FileSystemPort`, a `Registry`, and a `SessionMap` as parameters,
and return an `ExternalAuthSyncResult` — testable in isolation.

## 4. Domain model proposals

The domain types below are written as TypeScript interfaces in their proposed
final form. Today's equivalents live in `src/lib/accounts/types.ts` (84
lines); the proposal expands the model and renames some fields to remove the
Codex-only assumptions.

### 4.1 `Account`

```ts
export interface Account {
  readonly name: AccountName;
  readonly provider: ProviderId;
  readonly createdAt: IsoTimestamp;
  readonly identity: Identity;
  readonly currentSnapshot: SnapshotRef;
  readonly metadata: AccountMetadata;
}

export type AccountName = string & { readonly __brand: "AccountName" };
export type ProviderId = "codex" | "claude" | "kiro" | "hermes" | (string & {});
export type IsoTimestamp = string & { readonly __brand: "Iso" };

export interface AccountMetadata {
  readonly plan?: PlanLabel;
  readonly lastUsedAt?: IsoTimestamp;
  readonly tags?: ReadonlyArray<string>;
}
```

Branded types prevent accidental cross-typing of `AccountName` with an
arbitrary string at the boundary between Layer 1 and Layer 3.

### 4.2 `Snapshot`

```ts
export interface Snapshot {
  readonly ref: SnapshotRef;
  readonly providerId: ProviderId;
  readonly capturedAt: IsoTimestamp;
  readonly authMode: AuthMode;
  readonly identity: Identity;
}

export interface SnapshotRef {
  readonly path: AbsolutePath;
  readonly version: SnapshotVersion;
  readonly checksum: Sha256;
}

export type AuthMode = "oauth" | "apikey" | "device" | "unknown";
```

`SnapshotRef` decouples "the account knows which snapshot is active" from "the
filesystem stores the bytes". Today these are conflated in
`AccountService.activateSnapshot` (`account-service.ts:1297`).

### 4.3 `Identity`

```ts
export interface Identity {
  readonly email?: EmailAddress;
  readonly providerUserId?: string;
  readonly providerAccountId?: string;
  readonly workspace?: string;
}
```

The existing `ParsedAuthSnapshot` in `types.ts:49-56` already carries these
fields; lifting them into a value object lets `snapshotsShareIdentity`
(`account-service.ts:1599`) move to a single 6-line pure function on
`Identity`.

### 4.4 `UsageQuota`

```ts
export interface UsageQuota {
  readonly primary?: QuotaWindow;
  readonly secondary?: QuotaWindow;
  readonly plan?: PlanLabel;
  readonly fetchedAt: IsoTimestamp;
  readonly source: UsageSource;
}

export interface QuotaWindow {
  readonly usedPercent: PercentInt;
  readonly windowMinutes?: number;
  readonly resetsAt?: UnixSeconds;
}

export type UsageSource = "api" | "local" | "cached" | "proxy";
export type PercentInt = number & { readonly __brand: "Percent" };
```

This is the rename of today's `UsageSnapshot` (`types.ts:12-18`). The rename
is justified because callers consume *usage*, not a *snapshot of usage*; the
word "snapshot" is heavily overloaded in this codebase already.

### 4.5 `Pin`

```ts
export interface Pin {
  readonly key: SessionKey;
  readonly accountName: AccountName;
  readonly authFingerprint?: AuthFingerprint;
  readonly updatedAt: IsoTimestamp;
}

export type SessionKey =
  | { readonly kind: "ppid"; readonly pid: number }
  | { readonly kind: "explicit"; readonly value: string };
```

`SessionKey` as a discriminated union replaces today's string scheme
(`"ppid:1234"` vs `"session:xyz"`) computed in
`AccountService.resolveSessionScopeKey` (`account-service.ts:1384-1396`).
Parsing strings is a thing the discriminated union obviates.

### 4.6 `Session`

```ts
export interface Session {
  readonly pin: Pin;
  readonly activeAccount: Account | null;
  readonly providerProcessAlive: boolean;
}
```

`providerProcessAlive` captures the result of today's
`isSessionPinnedToActiveCodex` heuristic (`account-service.ts:1537`). Hoisting
it to the type system means callers stop calling the heuristic ad hoc.

### 4.7 `Provider` and `ProviderAdapter`

```ts
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;

  detectInstalledBinary(): Promise<BinaryPresence>;
  readActiveAuth(): Promise<Snapshot | null>;
  writeActiveAuth(snapshot: Snapshot): Promise<void>;
  parseSnapshotFile(path: AbsolutePath): Promise<Identity>;
  fetchQuota?(identity: Identity): Promise<UsageQuota | null>;
}

export interface BinaryPresence {
  readonly installed: boolean;
  readonly path?: AbsolutePath;
  readonly version?: string;
}
```

Each provider plugs into the same interface. The current Codex-specific paths
(`resolveAuthPath`, `parseAuthSnapshotFile`) become the implementation of
`CodexProviderAdapter`. The Claude-parallel and Kiro flows become
`ClaudeProviderAdapter` and `KiroProviderAdapter`. The Hermes mirror becomes
`HermesProviderAdapter` and stops being a one-off `lib/hermes-mirror.ts`.

## 5. Concurrency and locking model

### 5.1 Today's behavior

**Evidence.** `loadRegistry` / `saveRegistry` in
`src/lib/accounts/registry.ts:137-152` are unsynchronized JSON
read/serialize/write. `saveRegistry` does:

```ts
await fsp.mkdir(path.dirname(registryPath), { recursive: true });
await fsp.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
```

with no temp-file + rename and no lock file. `AccountService.persistRegistry`
(`account-service.ts:1292-1295`) reconciles in-memory first, then calls
`saveRegistry` directly.

**Diagnosis.** Three concrete failure modes exist today:

1. **Lost write under daemon + interactive race.** If `authmux daemon --watch`
   is mid-write while a user runs `authmux use foo`, the second writer can
   truncate the file between the daemon's `readFile` and `writeFile`. The
   user-initiated write wins, silently discarding the daemon's mutation.
2. **Partial-write corruption on crash.** A SIGKILL or laptop sleep mid-
   `writeFile` leaves a half-written `registry.json` that
   `JSON.parse` then rejects. `loadRegistry` swallows the parse error
   (`registry.ts:142-145`) and returns the defaults — every saved account
   pointer is lost. The snapshots themselves survive, so the data isn't gone,
   but `activeAccountName` and `lastUsage` are.
3. **Symlink-clobber race.** `materializeAuthSymlink`
   (`account-service.ts:990`) reads the link target, deletes the link, and
   writes the bytes back. A concurrent `codex login` issuing a write between
   the read and the unlink will write into the snapshot through the link;
   `restoreClobberedSnapshotsFromBackup` (`account-service.ts:895`) exists
   precisely because this race is real.

### 5.2 Proposed model

Three layered protections:

#### 5.2.1 Atomic file writes everywhere

All writes to `registry.json`, `current`, `sessions.json`, and snapshot files
go through a single helper:

```ts
// src/infra/fs/atomic-write.ts
export async function atomicWriteFile(
  target: AbsolutePath,
  data: Buffer | string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fsp.open(tmp, "w", options.mode ?? 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, target);
}
```

The `fsync` before rename is required on Linux/macOS to avoid the well-known
`ext4` rename-without-fsync data-loss pattern.

#### 5.2.2 Advisory lock on the registry

Per-process advisory lock using a sibling lock file:

```ts
// src/infra/fs/registry-lock.ts
export async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${resolveRegistryPath()}.lock`;
  // 1. Open with O_EXCL; on EEXIST, read pid from file.
  // 2. If pid is alive and not stale (< 30s), retry up to 5s with backoff.
  // 3. If stale, replace the lock atomically (atomic-write of own pid).
  // 4. On success, register process exit handlers to remove the lock.
  // 5. On crash, lock is reaped on next acquire because the stored pid is dead.
}
```

`AccountService.persistRegistry` becomes:

```ts
await withRegistryLock(async () => {
  const fresh = await loadRegistry();
  const merged = mergeRegistryUpdates(fresh, mutations);
  await atomicWriteFile(resolveRegistryPath(), serialize(merged));
});
```

`mutations` is a list of typed deltas (`SetActiveAccount`, `UpsertAccount`,
`SetAutoSwitch`, …) rather than a whole-object replace. This is what makes
the merge correct: two writers cannot race-lose each other's mutations as
long as both go through `withRegistryLock`.

#### 5.2.3 Single-writer daemon mode

When `authmux daemon --watch` is running, it elects itself as the single
writer for usage updates by acquiring the lock on startup and renewing it
on every cycle. Interactive commands continue to write the `current` pointer
themselves; the daemon and interactive paths only contend on
`autoSwitch.*` and `accounts[*].lastUsage`, which are now delta-merged.

#### 5.2.4 Optimistic concurrency for `current`

The `current` pointer is the high-frequency contended cell (every `use`, every
shell hook, every daemon switch). Replace today's plain text file with:

```
<account-name>\n<monotonic-counter>\n<sha256-of-account-name>\n
```

Writers do a compare-and-swap: read the counter, increment it, write back only
if the counter on disk still matches. On mismatch, the writer re-reads the
intended account name and either retries or yields, depending on whether the
intent has changed.

### 5.3 Crash-safety guarantees promised

After the proposal lands, the project promises:

| Crash scenario                                  | Guaranteed outcome                                                |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| SIGKILL mid `saveAccount`                       | Either old snapshot intact, or new snapshot intact. Never partial.|
| SIGKILL mid `persistRegistry`                   | Old registry intact. Lock file is reaped on next acquire.         |
| Power loss between snapshot write and rename    | Snapshot rolled back to last successful rename.                   |
| Concurrent `use` and `daemon` writing registry  | Mutations merged; neither is silently discarded.                  |
| Concurrent `codex login` clobbering via symlink | Backup vault restores the clobbered snapshot (current behavior).  |

Tags for the locking proposal: `P0` (correctness), `L` effort, `high` risk
(touches storage layout; needs migration of the existing
`registry.json` / `current` files).

## 6. Error taxonomy

### 6.1 Today

`src/lib/accounts/errors.ts` defines a small class hierarchy
(`CodexAuthError`, `AuthFileMissingError`, `AccountNotFoundError`,
`NoAccountsSavedError`, `InvalidAccountNameError`, `AccountNameInferenceError`,
`SnapshotEmailMismatchError`, `PromptCancelledError`,
`InvalidRemoveSelectionError`, `AmbiguousAccountQueryError`,
`AutoSwitchConfigError`). Strings are human-readable; there are no stable
machine codes.

### 6.2 Proposal

Add a `code` and `severity` to the base class:

```ts
export type ErrorCode =
  | "E_AUTH_MISSING"
  | "E_AUTH_INVALID"
  | "E_ACCOUNT_NOT_FOUND"
  | "E_NO_ACCOUNTS"
  | "E_NAME_INVALID"
  | "E_NAME_INFERENCE_FAILED"
  | "E_SNAPSHOT_EMAIL_MISMATCH"
  | "E_PROMPT_CANCELLED"
  | "E_REMOVE_EMPTY_SELECTION"
  | "E_QUERY_AMBIGUOUS"
  | "E_AUTOSWITCH_CONFIG"
  | "E_REGISTRY_LOCKED"
  | "E_REGISTRY_CORRUPT"
  | "E_SNAPSHOT_CLOBBERED"
  | "E_DAEMON_UNSUPPORTED_OS"
  | "E_PROVIDER_NOT_INSTALLED"
  | "E_USAGE_FETCH_FAILED";

export type ErrorSeverity = "fatal" | "warn" | "info";

export class AuthmuxError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly severity: ErrorSeverity,
    message: string,
    public readonly hint?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthmuxError";
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        severity: this.severity,
        message: this.message,
        hint: this.hint,
        details: this.details,
      },
    };
  }
}
```

Existing classes (e.g. `AccountNotFoundError`) become thin factories:

```ts
export class AccountNotFoundError extends AuthmuxError {
  constructor(name: string) {
    super(
      "E_ACCOUNT_NOT_FOUND",
      "fatal",
      `No saved account named "${name}" was found.`,
      `Run "authmux list" to see available names.`,
      { name },
    );
  }
}
```

### 6.3 JSON mode

Every command gains a `--json` flag (some already have it). When set, the
process writes a single JSON object to stdout and nothing else:

```jsonc
// success
{ "ok": true, "data": { ... } }

// error
{ "ok": false, "error": { "code": "E_ACCOUNT_NOT_FOUND", "severity": "fatal", "message": "...", "hint": "...", "details": { "name": "alice" } } }
```

Exit codes:

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| 0    | Success.                                   |
| 1    | Generic failure.                           |
| 2    | Usage error (oclif default).               |
| 3    | Auth missing (`E_AUTH_MISSING`).           |
| 4    | Not found (`E_ACCOUNT_NOT_FOUND`).         |
| 5    | Conflict (`E_SNAPSHOT_EMAIL_MISMATCH`).    |
| 6    | Locked / busy (`E_REGISTRY_LOCKED`).       |
| 7    | Corrupt state (`E_REGISTRY_CORRUPT`).      |
| 8    | Provider missing (`E_PROVIDER_NOT_INSTALLED`). |
| 64   | Cancelled by user (`E_PROMPT_CANCELLED`).  |

Tags: `P1`, `M`, `med` risk (CI scripts may rely on current exit codes).

## 7. Public TypeScript API

### 7.1 Today

`src/lib/accounts/index.ts` is the only barrel and exports:

```ts
export { AccountService } from "./account-service";
export type { AccountChoice, RemoveResult } from "./account-service";
export {
  AccountNotFoundError, AmbiguousAccountQueryError, AuthFileMissingError,
  AutoSwitchConfigError, CodexAuthError, InvalidAccountNameError,
  InvalidRemoveSelectionError, NoAccountsSavedError, PromptCancelledError,
  SnapshotEmailMismatchError,
} from "./errors";
export type { AutoSwitchRunResult, StatusReport } from "./types";
export const accountService = new AccountService();
```

`package.json:11` already advertises `types: "dist/index.d.ts"`, but the root
`src/index.ts` only contains the oclif bootstrap. Embedders who import
`authmux` get only the bootstrap typing, not the account service.

### 7.2 Proposal

Promote a stable public surface under `src/lib/index.ts` (re-exported by
`src/index.ts` next to the oclif bootstrap), versioned independently of CLI
flags:

```ts
// src/lib/index.ts — public API surface
export type {
  Account, AccountName, Identity, Snapshot, SnapshotRef, UsageQuota,
  QuotaWindow, Pin, SessionKey, Session, ProviderId, ProviderAdapter,
  BinaryPresence, AuthMode, UsageSource,
} from "./domain";

export {
  AuthmuxError, type ErrorCode, type ErrorSeverity,
} from "./domain/errors";

export {
  loadAccounts, saveAccount, useAccount, removeAccounts,
  runAutoSwitchOnce, configureAutoSwitch, configureUsageSource,
  installManagedService, uninstallManagedService,
} from "./app";

export { registerProvider, listProviders } from "./domain/provider/registry";
```

The class form (`AccountService`) is kept as a deprecated re-export under
`src/lib/accounts/index.ts` for one major release.

### 7.3 Versioning policy

- The CLI flags / output continue to follow the headline package version.
- The library surface declared in `src/lib/index.ts` follows semver against
  its own `LIB_API_VERSION` constant exported alongside the types.
- Breaking changes to the library surface bump the package's major version
  even if the CLI surface is unaffected.

### 7.4 Deprecation lane

| Stage      | What happens                                                                   |
| ---------- | ------------------------------------------------------------------------------ |
| `Marked`   | Export carries `@deprecated` JSDoc and a `process.emitWarning` on first call. |
| `Hidden`   | Export removed from `index.ts` barrel; still importable from deep path.        |
| `Removed`  | Deep path also removed. Mention in CHANGELOG under "Removed".                  |

Minimum dwell time per stage: one minor release for `Marked`, one minor for
`Hidden`. So `Marked → Removed` is two minors minimum.

## 8. Plug-in story: `ProviderAdapter` registry

### 8.1 Goal

Today, every new CLI target (Cursor, Aider, Cline, Gemini-CLI, etc.) requires
shipping new code in the `authmux` repo. A plug-in interface lets external
authors add a provider without forking.

### 8.2 Discovery

Two channels, evaluated in order:

1. **Bundled providers.** First-party adapters under `src/providers/`
   (`codex`, `claude`, `kiro`, `hermes`) are registered eagerly at startup.
2. **External providers.** Any npm package matching the name pattern
   `authmux-provider-*` that the user has installed globally (or referenced
   via `AUTHMUX_PROVIDERS` env var) is `require()`d at startup. Each must
   default-export a `ProviderAdapter`.

### 8.3 Registration API

```ts
// src/domain/provider/registry.ts
const providers = new Map<ProviderId, ProviderAdapter>();

export function registerProvider(adapter: ProviderAdapter): void {
  if (providers.has(adapter.id)) {
    throw new AuthmuxError(
      "E_PROVIDER_DUPLICATE",
      "fatal",
      `Provider "${adapter.id}" is already registered.`,
    );
  }
  providers.set(adapter.id, adapter);
}

export function getProvider(id: ProviderId): ProviderAdapter | undefined {
  return providers.get(id);
}

export function listProviders(): ReadonlyArray<ProviderAdapter> {
  return Array.from(providers.values());
}
```

### 8.4 Safety controls

External-provider loading respects three controls:

- `AUTHMUX_DISABLE_EXTERNAL_PROVIDERS=1` — only bundled providers load.
- `AUTHMUX_PROVIDER_ALLOWLIST="codex,claude,authmux-provider-cursor"` — only
  the listed ids load.
- A SHA-256 pin per provider in `~/.config/authmux/providers.lock` — load
  rejected unless the on-disk package matches.

These exist because a provider has full read/write access to whatever auth
directory it advertises. A compromised provider is, by construction, an
auth-exfiltration vector.

### 8.5 Compatibility contract

A provider declares the API version it was built against:

```ts
export const adapter: ProviderAdapter & { apiVersion: number } = {
  apiVersion: 1,
  id: "cursor",
  displayName: "Cursor",
  // ...
};
```

authmux refuses to load adapters with a different `apiVersion` until a manual
override flag is passed. Each bump of the host's `LIB_API_VERSION` lists the
breaking changes in `releases/lib-vN.md`.

Tag for the whole plug-in story: `P2`, `L`, `med`.

## 9. ADR template suggestion

Architecture Decision Records (ADRs) live alongside this protocol but answer
a smaller, more pointed question: "what did we decide, why, and what did we
reject?". Suggested location: `docs/adr/NNNN-slug.md`. Suggested template:

```markdown
# ADR NNNN — <Title>

- Status: Proposed | Accepted | Superseded by ADR NNNN | Deprecated
- Date: YYYY-MM-DD
- Deciders: <handles>
- Related: <docs/future/*.md anchor, openspec change slug>

## Context
What forces are at play? What is true today that makes this decision
necessary now? Quote real file paths and line numbers.

## Decision
The chosen option, stated in one or two sentences without hedging.

## Consequences
- Positive: ...
- Negative: ...
- Neutral: ...

## Alternatives considered
For each rejected option, one paragraph: what it would have looked like,
and the single deciding reason it was rejected.

## Migration plan
Pointer to the relevant block in `docs/future/`, or inline if the decision
was small.

## Verification
The command, test, or shipped release that proves the decision landed.
```

ADRs are append-only. When superseded, the new ADR cites the old one in its
`Related` line; the old ADR's status flips to `Superseded by ADR NNNN`.

## 10. Cross-cutting architectural risks

The improvements above are individually scoped, but several risks span the
whole codebase and deserve a single home for cross-reference.

### 10.1 Hidden global singletons

**Evidence.** `src/lib/accounts/index.ts:19` exports `accountService` as a
module-level singleton. Every `BaseCommand` subclass shares it via
`this.accounts = accountService` (`base-command.ts:6`).

**Diagnosis.** Module-level singletons are testable only by mocking the
module. They cannot be instantiated against a fake filesystem in a unit test
without polluting other tests in the same process.

**Proposal.** Replace with a `createApp({ fs, http, env, clock })` factory
that returns an object exposing the public functions from §7.2. The CLI
constructs one at startup and passes it down via `BaseCommand`. Tests
construct one against in-memory fakes.

**Migration.** New factory lives in parallel with the singleton for one
release; commands switch one-by-one; singleton removed in the next minor.

**Rollout.** Internal. Tag: `P1`, `M`, `low`.

### 10.2 Implicit `~/.codex` everywhere

**Evidence.** `src/lib/config/paths.ts` resolves every path at import time
(see exported `codexDir`, `accountsDir`, `authPath`, `currentNamePath`,
`registryPath`, `sessionMapPath` constants on lines 62–67).

**Diagnosis.** Resolving at import time freezes env-var values to whatever
they were when the module first loaded. Tests that set
`CODEX_AUTH_JSON_PATH` after `require()` have no effect. Daemons that get
spawned with a different `HOME` (e.g. systemd `--user` units) may pick up
different paths than the user-facing CLI.

**Proposal.** Remove the eager constants entirely. Keep only the
`resolveX()` functions, which already re-read env on every call.

**Migration.** Find every importer of the constants (`grep -n
'from.*paths'` shows a handful) and switch them to call the resolvers.
Mark the constants `@deprecated` for one minor.

**Rollout.** Tag: `P1`, `S`, `low`.

### 10.3 Provider mirrors live outside `accounts/`

**Evidence.** `src/lib/kiro-mirror.ts` (108 lines) and
`src/lib/hermes-mirror.ts` (52 lines) sit alongside accounts/ but are not
inside it.

**Diagnosis.** They represent provider adapters in everything but name. They
predate the proposed plug-in architecture (§8) and should fold into it once
that lands.

**Proposal.** Move under `src/providers/kiro/mirror.ts` and
`src/providers/hermes/mirror.ts` as part of the plug-in extraction.

**Migration.** Single PR; no behavior change.

**Rollout.** Bundled-providers section of the plug-in PR. Tag: `P2`, `S`,
`low`.

## 11. Sequence diagrams for the two hot paths

### 11.1 `authmux login` (today)

```
user        LoginCommand        AccountService          codex CLI       fs
 |  authmux login  |                  |                    |              |
 |---------------->|                  |                    |              |
 |                 | getStatus()      |                    |              |
 |                 |----------------->|                    |              |
 |                 |  status          |                    |              |
 |                 |<-----------------|                    |              |
 |                 | (if autoSwitch)  |                    |              |
 |                 | setAutoSwitchEnabled(false)           |              |
 |                 |----------------->|                    |              |
 |                 |                  | disableManagedService            |
 |                 |                  |--------------------|------------->|
 |                 |                  | persistRegistry    |              |
 |                 |                  |--------------------|------------->|
 |                 | spawn("codex", ["login"])             |              |
 |                 |-------------------------------------->|              |
 |                 |                  |                    |  write auth.json |
 |                 |                  |                    |------------->|
 |                 | waitForCodexAuthSnapshot()            |              |
 |                 |---------------------(poll)----------->|              |
 |                 | resolveLoginAccountNameFromCurrentAuth                |
 |                 |----------------->|                    |              |
 |                 |                  | parseAuthSnapshot  |              |
 |                 |                  |--------------------|------------->|
 |                 |                  | listAccountNames + scan           |
 |                 |                  |--------------------|------------->|
 |                 | saveAccount(name)                     |              |
 |                 |----------------->|                    |              |
 |                 |                  | copyFile auth.json -> snapshot    |
 |                 |                  |--------------------|------------->|
 |                 |                  | hydrate + persistRegistry         |
 |                 |                  |--------------------|------------->|
 |  message        |<-----------------|                    |              |
```

Pain points called out by the architecture proposal:

- The orchestration between `LoginCommand` and `AccountService` is split with
  no single owner; the disable-auto-switch step has to know to re-enable on
  the inverse path (which today nothing does).
- The "wait for snapshot" polling is in the command layer (`login.ts:106`),
  not in the domain or infra layer.
- Every `persistRegistry` round-trips through `loadReconciledRegistry` again
  (`account-service.ts:1292-1295`) — three full registry reads per login.

### 11.2 `authmux use foo` with Kiro mirror

```
user      UseCommand     AccountService    KiroMirror     fs
 |  authmux use foo |          |                |          |
 |---------------->|           |                |          |
 |                 | useAccount("foo")           |          |
 |                 |---------->|                 |          |
 |                 |           | resolveUsableAccountName   |
 |                 |           |---------------->|--------->|
 |                 |           | activateSnapshot           |
 |                 |           |---------------------------->| (copyFile)
 |                 |           | persistRegistry            |
 |                 |           |---------------------------->|
 |                 | recordSuccess / recordSwitch (lib/*)   |
 |                 | switchKiroSnapshot(activated)          |
 |                 |---------->|--------------->|--------->|
 |  message        |<----------|                |          |
```

The Kiro mirror is invoked from the command layer (`use.ts:48-53`) rather
than from the domain. Under the target architecture, the mirror is just
another `ProviderAdapter.writeActiveAuth` call, scheduled by the
application-layer orchestrator for `useAccount`, with a known fan-out policy
(parallel, best-effort, structured per-provider result).

## 12. Summary of architecture-level priorities

The block below is the consolidated priority list for this file. Each item
links back to its full Evidence / Diagnosis / Proposal / Migration / Rollout
treatment above.

| ID | Priority | Effort | Risk | Theme                                          | Anchor    |
| -- | -------- | ------ | ---- | ---------------------------------------------- | --------- |
| A1 | P0       | L      | high | Atomic writes + advisory lock on registry       | §5.2      |
| A2 | P0       | M      | high | Atomic writes on snapshot files + auth.json     | §5.2.1    |
| A3 | P1       | L      | med  | Split `account-service.ts` into 10–12 modules   | §2.1      |
| A4 | P1       | M      | low  | Split `usage.ts` into api / proxy / local / math | §2.2     |
| A5 | P1       | M      | med  | Error taxonomy with codes + JSON mode parity    | §6        |
| A6 | P1       | M      | low  | Replace module-singleton with `createApp` factory| §10.1    |
| A7 | P1       | S      | low  | Drop eager `paths.ts` constants                 | §10.2     |
| A8 | P2       | L      | med  | `ProviderAdapter` interface + plug-in registry  | §8        |
| A9 | P2       | M      | low  | Move Kiro / Hermes mirrors under `providers/`   | §10.3     |
| A10| P2       | M      | med  | Domain model rename (UsageSnapshot → UsageQuota)| §4        |
| A11| P3       | S      | low  | ADR directory + template                        | §9        |

Items A1 and A2 ship first because they fix data-loss windows. Items A3 and A4
make every subsequent change cheaper. Items A5, A6, A7 are quality-of-life
that unblocks third-party usage. A8 onward is the platform play.
