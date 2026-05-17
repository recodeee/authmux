# 07 — Usage refresh, provider API, and the quota model

This slice owns the data side of `authmux`: how quota / rate-limit
information is obtained from upstream providers, normalised into a single
domain model, cached, and consumed by `list`, `status`, `switch`, and the
auto-switch policy described in `06-AUTO-SWITCH-AND-DAEMON.md`. The
centerpiece file is `src/lib/accounts/usage.ts` (660 LOC); supporting files
are `src/lib/usage-refresh.ts`, `src/lib/account-health.ts`,
`src/lib/account-savings.ts`, and the registry serialisation in
`src/lib/accounts/registry.ts`.

`06-AUTO-SWITCH-AND-DAEMON.md` assumes a `UsageSnapshot` already exists in
the registry. This file documents how that snapshot is produced, where it
leaks provider-specific shape, and how the data acquisition path should be
hardened before the policy engine starts depending on it for decisions
that the user has not manually authorised.

---

## Current behavior

### Two parallel usage code paths

`authmux` currently ships **two** unrelated usage refresh implementations.

| Path | File | Used by | Returns |
| ---- | ---- | ------- | ------- |
| Legacy lightweight | `src/lib/usage-refresh.ts` | `src/commands/switch.ts:50-57` (`--live` flag) | `UsageData` (`usage-refresh.ts:14-19`) |
| Registry-aware | `src/lib/accounts/usage.ts` | `AccountService.refreshAccountUsage` (`account-service.ts:701-742`); used by `list`, `daemon`, `runAutoSwitchOnce` | `UsageSnapshot` (`src/lib/accounts/types.ts:12-18`) |

The two return *different* shapes:

- `UsageData.primary.remainingPercent` (number 0..100) vs.
  `UsageSnapshot.primary.usedPercent` (number 0..100, inverted).
- `UsageData.primary.resetsAt` is a string (ISO-8601) vs.
  `UsageSnapshot.primary.resetsAt` is a number (seconds since epoch).
- `UsageData.fetchedAt` is a string vs. `UsageSnapshot.fetchedAt` is also a
  string but is produced by `new Date().toISOString()` in *both* places —
  see `usage-refresh.ts:54` and `usage.ts:111`.

Both call the same endpoint:

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <accessToken>
```

(`usage-refresh.ts:10`, `usage.ts:7`). The registry-aware path adds the
`ChatGPT-Account-Id` header (`usage.ts:547`) and the `User-Agent: authmux`
header (`usage.ts:548`); the legacy path does not. Both apply the same
5-second timeout (`usage-refresh.ts:11`, `usage.ts:13`).

### Registry-aware refresh — `usage.ts`

Three acquisition functions are exported from `src/lib/accounts/usage.ts`:

| Function | File:Line | Purpose | Source label |
| -------- | --------- | ------- | ------------ |
| `fetchUsageFromApi(snapshotInfo)` | 535-569 | Direct call to chatgpt.com `/wham/usage` | `"api"` |
| `fetchUsageFromProxy()` | 440-485 | Dashboard proxy (see below) that batches all accounts | `"proxy"` |
| `fetchUsageFromLocal(codexDir)` | 649-660 | Parses rollout logs from `~/.codex/sessions/**/*.jsonl` | `"local"` |

`fetchUsageFromApi` (`usage.ts:535-569`) does:

1. Refuses if the snapshot is not `authMode === "chatgpt"` or lacks
   `accessToken` / `accountId` (`usage.ts:536-538`). API-key snapshots are
   skipped entirely.
2. `fetch` with `AbortController` + 5s timeout.
3. On non-OK response, returns `null` (`usage.ts:553`). No retry, no
   logging.
4. Parses the response via `buildSnapshotFromRateLimits(data.rate_limit,
   "api")` (`usage.ts:98-114`), which expects `primary_window` /
   `secondary_window` objects each carrying `used_percent`,
   `window_minutes` (or `limit_window_seconds`), `resets_at` (or
   `reset_at`). Unparseable input returns `null`.
5. Backfills `planType` from the response if the rate-limit block didn't
   include it (`usage.ts:559-561`).

`fetchUsageFromProxy` (`usage.ts:440-485`) targets a local dashboard
proxy at `http://127.0.0.1:2455` by default
(`DEFAULT_PROXY_URL`, `usage.ts:8`), overridable by `CODEX_LB_URL`
(`usage.ts:428`). The proxy is part of the broader `codex-lb` ecosystem
(see the `Loongphy/agent-auth` upstream) and exposes:

- `GET /api/dashboard-auth/session` — current auth state.
- `POST /api/dashboard-auth/password/login` — password login, env var
  `CODEX_LB_DASHBOARD_PASSWORD`.
- `POST /api/dashboard-auth/totp/verify` — TOTP, env vars
  `CODEX_LB_DASHBOARD_TOTP_CODE` or `CODEX_LB_DASHBOARD_TOTP_COMMAND`
  (the latter shells out via `child_process.exec`,
  `usage.ts:355-373`).
- `GET /api/accounts` — list of accounts with `usage`, `planType`,
  `windowMinutesPrimary`, `windowMinutesSecondary`, `resetAtPrimary`,
  `resetAtSecondary`, `codexAuth.snapshotName`, etc.

The proxy response is converted to a `ProxyUsageIndex`
(`usage.ts:34-38`) keyed three ways: by account id, by email
(case-normalised via `normalizeLookupKey`, `usage.ts:165-169`), and by
snapshot name. The 2-second timeout (`PROXY_REQUEST_TIMEOUT_MS`,
`usage.ts:14`) is shorter than the direct-API timeout because the proxy
is local.

`fetchUsageFromLocal` (`usage.ts:649-660`) walks
`<codexDir>/sessions/**/*.jsonl`, takes the 5 most recently modified
rollout files (`usage.ts:605-607`), and for each scans every line looking
for a JSON record whose `rate_limits` field (possibly nested under
`payload.rate_limits` or `payload.event.rate_limits`,
`usage.ts:116-129`) decodes via `buildSnapshotFromRateLimits(..., "local")`.
The latest record by `event_timestamp_ms` / `timestamp_ms` / `timestamp`
wins. Returns `null` if nothing parseable was found.

### Legacy refresh — `usage-refresh.ts`

`fetchUsage(accountName)` (`src/lib/usage-refresh.ts:30-76`) is the
simplified path used only by `switch --live`. It:

1. Reads the snapshot file directly and extracts
   `data?.tokens?.accessToken` (`usage-refresh.ts:21-28`). No
   `accountId` header is sent.
2. Calls `/wham/usage` with the bearer token.
3. Expects the response to be `{ rate_limits: [...] }` — an *array*, not
   the `{ primary_window, secondary_window }` object the registry-aware
   path expects. The array entries carry `remaining`, `limit`,
   `window_minutes`, `resets_at` and are bucketed as `primary` (window
   <= 300 minutes) or `secondary` (everything else),
   `usage-refresh.ts:56-69`.

This is a separate, less defensive parser pointing at the same endpoint.
Either the upstream API returns both shapes depending on plan, or one of
the two parsers is dealing with a stale schema. Both have to be tested
against current production payloads — see "Provider-specific usage
adapters" below.

### Math helpers in `usage.ts`

`usage.ts` also exposes the pure math used by the policy:

| Helper | Lines | Purpose |
| ------ | ----- | ------- |
| `resolveRateWindow(snapshot, minutes, fallbackPrimary)` | 487-499 | Pick the window with matching `windowMinutes`, falling back to primary or secondary. |
| `remainingPercent(window, nowSeconds)` | 501-509 | `100 - usedPercent`, with a special case that returns `100` when `resetsAt <= now` (the window has already reset and the cached `usedPercent` is stale). |
| `usageScore(snapshot, nowSeconds)` | 511-519 | `min(remaining5h, remainingWeekly)`. If only one is present, uses that. If neither, returns `undefined`. |
| `shouldSwitchCurrent(snapshot, thresholds, nowSeconds)` | 521-533 | Compares both windows against their respective thresholds. |

`coerceWindow` (`usage.ts:72-96`) does the heavy lifting of normalising
either `window_minutes` (preferred) or `limit_window_seconds`
(`Math.ceil(.../60)`), and either `resets_at` or `reset_at` timestamps
(integers in seconds).

### Where usage data lives

Three storage locations:

| What | Where | Schema |
| ---- | ----- | ------ |
| Per-account last snapshot | `<codex>/multi-auth/registry.json` under `accounts[<name>].lastUsage` | `UsageSnapshot` |
| Per-account last refresh time | Same file, `accounts[<name>].lastUsageAt` | ISO-8601 string |
| Rollout logs (input to local fallback) | `~/.codex/sessions/**/*.jsonl` | Codex's own JSONL |

There is no separate `usage.json` cache file; the registry is the only
on-disk store. `sanitizeUsageSnapshot` (`registry.ts:23-65`) gates what
can land in `lastUsage` during a load — invalid input collapses to
`undefined`.

### How `list` uses it

`AccountService.refreshListUsageIfNeeded` (`account-service.ts:744-795`)
is the read path. The contract is:

- `refreshUsage: "never"` — skip entirely.
- `refreshUsage: "missing"` — refresh only accounts whose `lastUsage` is
  unparseable or whose neither window can produce a `remainingPercent`
  (`account-service.ts:797-801`).
- `refreshUsage: "always"` — refresh every account.

It bounds concurrency at `LIST_USAGE_REFRESH_CONCURRENCY = 6`
(`account-service.ts:57`). When `registry.api.usage === true`, it
attempts the proxy first (`account-service.ts:773-775`) so a single proxy
call satisfies the whole pool. Inside each worker, `refreshAccountUsage`
falls back to direct API if the proxy index didn't have the account, and
to local rollout if `allowLocalFallback` is set (only true for the
currently active account in the list path,
`account-service.ts:787`).

### How `switch` uses it

`src/commands/switch.ts:50-57` calls the **legacy** `fetchUsage(name)`
from `usage-refresh.ts` for each account *serially* under the `--live`
flag. It does not consult the registry cache and does not use the proxy.

### How the daemon uses it

`runAutoSwitchOnce` (`account-service.ts:615-646`) calls
`refreshAccountUsage` once per account through the registry-aware path,
and does **not** pass `proxyUsageIndex`, so each account goes through the
direct-API call. See issue D-2 below.

---

## Quota domain model

The current model leaks provider-specific shapes. `UsageSnapshot` is
ChatGPT's two-window structure (primary 5h, secondary weekly). The math
in `usage.ts:511-519` hard-codes `300` and `10080` as the only recognised
window sizes. Anthropic and Kiro return different shapes; today the only
way to support them is by overloading the same fields, which is the path
of greatest pain.

### Proposed unified value object

```ts
export type WindowKind = "5h" | "weekly" | "monthly" | "rolling";

export interface UsageWindow {
  kind: WindowKind;
  /** UNIX seconds when this window resets; absent for `rolling`. */
  resetsAt: number | undefined;
  /** Percentage remaining: 100 = fresh, 0 = exhausted. Never the inverted "used" form. */
  remainingPct: number;
  /** Raw counters; absent when the provider does not expose them. */
  limit?: number;
  used?: number;
  /** Where this datum was obtained. */
  source: "api" | "local" | "estimated" | "cached" | "proxy";
  /** When the datum was obtained. */
  fetchedAt: string;
}

export interface UsageQuota {
  provider: ProviderId; // "codex" | "claude" | "kiro"
  windows: UsageWindow[];
  planType?: string;
  /** Provider-specific extras; never read by the policy. */
  raw?: Record<string, unknown>;
}
```

Two deliberate choices:

1. `remainingPct` replaces `usedPercent`. The whole policy layer thinks in
   "remaining" (`remainingPercent` at `usage.ts:501-509`, the
   `shouldSwitchCurrent` comparison at `usage.ts:529-532`,
   `selectBestAccount` at `account-health.ts:213`). Inverting at the
   provider adapter rather than at every read site eliminates a class of
   sign errors.
2. `windows` is an *array*. `primary` / `secondary` are not provider-
   neutral. ChatGPT happens to have two; Claude historically exposes one
   weekly quota plus per-message rate limits; Kiro's surface is unknown.
   The policy iterates the array.

The `WindowKind` discriminator is the only thing the policy needs to know
about; provider-specific labels live in `raw`.

### Migration

`UsageSnapshot` becomes a derived view over `UsageQuota` for the
transition period:

```ts
function asLegacySnapshot(quota: UsageQuota): UsageSnapshot {
  const fiveH = quota.windows.find((w) => w.kind === "5h");
  const weekly = quota.windows.find((w) => w.kind === "weekly");
  return {
    primary: fiveH ? { usedPercent: 100 - fiveH.remainingPct, windowMinutes: 300, resetsAt: fiveH.resetsAt } : undefined,
    secondary: weekly ? { usedPercent: 100 - weekly.remainingPct, windowMinutes: 10080, resetsAt: weekly.resetsAt } : undefined,
    fetchedAt: quota.windows[0]?.fetchedAt ?? new Date().toISOString(),
    source: (quota.windows[0]?.source as UsageSnapshot["source"]) ?? "cached",
    planType: quota.planType,
  };
}
```

The migration plan persists `UsageSnapshot` to disk for one minor release
(so a downgrade does not lose data) and then flips the on-disk schema to
`UsageQuota` after the next major. See "Migration" at the bottom.

---

## API mode

### Endpoint inventory

| Endpoint | Used by | Method | Headers |
| -------- | ------- | ------ | ------- |
| `https://chatgpt.com/backend-api/wham/usage` | `fetchUsageFromApi` (`usage.ts:543-551`), `fetchUsage` (`usage-refresh.ts:39-45`) | GET | `Authorization`, `ChatGPT-Account-Id` (registry path), `User-Agent` |
| `http://127.0.0.1:2455/api/dashboard-auth/session` | proxy session probe (`usage.ts:9`, `375-381`) | GET | `Accept`, `Cookie` |
| `http://127.0.0.1:2455/api/dashboard-auth/password/login` | proxy password login (`usage.ts:391-393`) | POST | `Content-Type` |
| `http://127.0.0.1:2455/api/dashboard-auth/totp/verify` | proxy TOTP (`usage.ts:414-417`) | POST | `Content-Type` |
| `http://127.0.0.1:2455/api/accounts` | proxy account list (`usage.ts:451`) | GET | `Cookie` |

There is **no** other outbound network call from the usage subsystem.
This is enforced today only by code review; see "Privacy" below for the
proposal to test-enforce it.

### Today's failure handling

- `fetch` errors → `catch` returns `null` (`usage.ts:564-566`,
  `usage-refresh.ts:73-75`).
- Non-OK HTTP → returns `null` (`usage.ts:553`,
  `usage-refresh.ts:48`). 401, 429, 500 all collapse into the same
  "no data" signal.
- Timeout (5s direct, 2s proxy) → `AbortController` aborts, caught above.
- No retries, no backoff, no circuit breaker dedicated to the network.

`AccountHealth` (`src/lib/account-health.ts`) does have a circuit
breaker, but it is only fed by `recordSuccess` / `recordFailure` calls
from `switch.ts:100,104`, `use.ts:38,42`, `auto-switch.ts:24,28`. The
usage refresh path **never** records failures into that breaker. See
issue D-1.

### Proposed `UsageHttpClient`

A small, centralised, fully testable HTTP client owns *all* outbound
requests for usage. The interface:

```ts
export interface UsageHttpClient {
  fetchUsage(req: UsageRequest): Promise<UsageResponse>;
  warmConnection(host: string): void;
  metrics(): UsageHttpMetrics;
}

export interface UsageRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** ETag for conditional requests; absent on first call. */
  ifNoneMatch?: string;
  /** Provider tag for per-provider rate-limit budgets. */
  provider: ProviderId;
}

export type UsageResponse =
  | { kind: "ok"; status: number; body: unknown; etag?: string; ageMs: number }
  | { kind: "not-modified"; etag: string; ageMs: number }
  | { kind: "transient"; status?: number; cause: "timeout" | "network" | "5xx" | "rate-limited"; retryAfterMs?: number }
  | { kind: "permanent"; status: number; cause: "auth" | "schema" | "forbidden" };
```

Behaviour:

1. **Retries with jittered exponential backoff.** Only `transient`
   responses retry, up to `maxAttempts` (default 3). Backoff base 250ms,
   cap 4s, 20% jitter.
2. **Circuit breaker per `(provider, host)` pair.** Opens after 5
   consecutive `transient` results, half-opens after 30s, closes on next
   success.
3. **Per-provider concurrency cap.** Default 4 in-flight per provider;
   surplus requests queue.
4. **ETag / `If-None-Match` support.** If the provider returns ETags
   (ChatGPT's `/wham/usage` does not as of this writing — see the
   *Provider-specific* section), the client serves stale cached responses
   when the server responds `304 Not Modified`.
5. **Connection keep-alive.** A single `undici.Agent` is shared per host
   to avoid TCP/TLS setup on every tick.

The client is injected wherever `fetch` is currently called inline. The
two existing call sites (`fetchUsageFromApi`, `fetchUsageFromProxy`)
collapse into per-provider adapter methods that build a `UsageRequest`
and parse a `UsageResponse`.

### Caching with TTL

Cached responses live in `registry.accounts[name].lastUsage` today. The
TTL is implicit: the daemon's `isUsageMissingForList`
(`account-service.ts:797-801`) treats anything with parseable windows as
fresh.

Proposal:

| Mode | TTL | Behaviour |
| ---- | --- | --------- |
| `list` (interactive) | 60s | Serve cache if fresh; refresh in background otherwise. |
| `daemon` (background) | 0s | Always refresh, but honour ETag. |
| `switch --live` | 0s | Always refresh, blocking. |
| `status` | 300s | Serve cache if fresh. |

TTL is part of `UsageRequest` so the client cannot decide for the caller.

### Stale-while-revalidate

`list` and `status` are read paths that must not be blocked by the
network. The proposed flow:

1. Read the cached `UsageQuota` from the registry.
2. If `ageMs < ttlMs`, return immediately and emit no request.
3. If `ageMs >= ttlMs`, return the cached value immediately, *and*
   asynchronously kick off a refresh via the IPC `cmd: "switch"`
   (which actually means "evaluate", see `06-AUTO-SWITCH-AND-DAEMON.md`
   § IPC) or a direct call to the client if no daemon is running.

The user-visible effect: `list` is always instant, with at most one
stale tick worth of drift. The daemon converges fresh data in the
background.

### Concurrency cap when refreshing many accounts

`LIST_USAGE_REFRESH_CONCURRENCY = 6` (`account-service.ts:57`) is the
right default but is enforced by a hand-rolled worker pool
(`account-service.ts:771-792`). Centralising on the HTTP client's
provider-level cap removes that pool and ensures any future caller is
also rate-limited.

### Errors visible to the user

Today, all errors collapse to "no usage data" rendered as `-` in the
list view. Proposal: a `usageError` field on `AccountMapping`
(`src/lib/accounts/types.ts:73-84`) carrying one of:

- `"network"` — show `[net?]` and a tooltip.
- `"auth"` — show `[auth?]`, suggest `authmux login <name>`.
- `"schema"` — show `[?]` and log a structured warning; this is the only
  signal we get that the provider changed its response shape.
- `"rate-limited"` — show `[rate]`; refresh defers via the policy
  `defer` outcome.

---

## Local fallback

### What it does today

`fetchUsageFromLocal` (`usage.ts:649-660`) is the bridge between Codex's
own session log and the registry-aware usage path. It is invoked **only**
for the active account
(`account-service.ts:617,729,787`) because rollout logs only exist for
the currently active Codex session.

Internals:

1. `collectRolloutFiles` (`usage.ts:571-607`) walks
   `<codexDir>/sessions/` recursively, filters by
   `startsWith("rollout-") && endsWith(".jsonl")`, sorts by `mtimeMs`
   descending, takes the top 5.
2. `parseRolloutForUsage` (`usage.ts:609-647`) reads each file
   completely into memory, splits on `\r?\n`, JSON-parses each non-empty
   line, and runs `findNestedRateLimits` (`usage.ts:116-129`) which
   accepts three nesting paths:
   - `record.rate_limits`
   - `record.payload.rate_limits`
   - `record.payload.event.rate_limits`
3. For each line, the timestamp is derived from `event_timestamp_ms`,
   `timestamp_ms`, or `timestamp` (`usage.ts:634-636`,
   `parseTimestampSeconds` at `usage.ts:131-147` handles ms-vs-s and
   ISO-string).
4. The latest record by timestamp wins.

### Risks today

- **No size cap.** A 100MB rollout file is read entirely into memory and
  split into a single string array. Worst case is bounded by the 5-file
  cap and by the natural session lifetime, but a long-running Codex run
  can still produce log files in the tens of MB.
- **No file-format version pinning.** The three accepted nesting paths
  are an empirical guess at what Codex versions emit. Any future Codex
  release that changes the shape silently falls back to "no usage data".
- **No partial-write defence.** If Codex is mid-write to the most recent
  rollout file, the last line may be truncated. `JSON.parse` of the
  truncated line throws → caught and the line is skipped
  (`usage.ts:625-627`). This is correct but means the most recent rate-
  limit reading can be missed entirely if it is on the truncated tail.
- **No fixture corpus.** There are no test files in the tree that
  exercise the parser; any future change to it is a refactor without a
  net.

### Proposed parser hardening

Three changes, none of which break the current call sites:

1. **Bounded streaming reader.** Replace `fsp.readFile(filePath, "utf8")`
   with a streamed line reader (`readline.createInterface({ input:
   fs.createReadStream(filePath) })`). Memory bounded to one line at a
   time. Stop after the first `findNestedRateLimits` hit in *reverse*
   order, since we only care about the latest.
2. **Schema-version registry.** A new constant
   `KNOWN_ROLLOUT_SCHEMA_PATHS: Array<{ name: string; path: (r: unknown)
   => unknown }>` enumerates accepted nesting paths with names. When the
   parser falls back to a less-preferred path, it emits a structured
   warning naming the schema (e.g. `rollout-schema=payload.event` so the
   user knows which Codex version they are on).
3. **Fixture corpus.** Add `src/lib/accounts/__fixtures__/rollouts/`
   containing one anonymised rollout file per known Codex schema
   version. Each fixture has a sibling `.expected.json` describing the
   expected `UsageQuota` output. Tests iterate the corpus.

### Why "local" cannot be the only source

The local path provides data only for the active account. For
candidates, the only sources are API and proxy. This is why
`allowLocalFallback: false` is hard-coded for candidates in
`runAutoSwitchOnce` (`account-service.ts:638`) — the policy *cannot*
score a candidate it has never seen.

If a user disables API mode entirely (`config api disable`), the daemon
degenerates into "switch only when active has visibly low rollout
data, and pick the first candidate that exists" — which is the result of
the `?? 100` fallback at `account-service.ts:641`. The user is not
warned about this degeneration. Proposal: when `registry.api.usage ===
false` and there are saved accounts other than the active one,
`runAutoSwitchOnce` returns
`{ switched: false, reason: "local-only-mode-cannot-score-candidates" }`
instead of guessing.

---

## Forecasting and savings

### What exists today

| Module | Role | Lines |
| ------ | ---- | ----- |
| `src/lib/account-health.ts` | Score, circuit breaker, token bucket. State persisted at `~/.codex/multi-auth/health-state.json`. | 227 |
| `src/lib/account-savings.ts` | Switch counters (`totalSwitches`, `autoSwitches`, `rateLimitsAvoided`, `estimatedMinutesSaved`). Hard-coded 5-minute "savings" per avoided rate limit (`account-savings.ts:60-62`). | 63 |
| `src/commands/forecast.ts` | Prints `forecastAccounts(names)` from `account-health.ts:224-227`. | 25 |
| `src/commands/check.ts` | Same input as `forecast`; categorises pool as HEALTHY / DEGRADED / UNHEALTHY (`check.ts:20`). | 31 |

`forecastAccounts` (`account-health.ts:224-227`) does **not** forecast.
It sorts accounts by the current health score (which itself recovers
over time via `recover()` at `account-health.ts:73-76`). The label
"forecast" overstates what the function does — it is a present-tense
ranking with a small time-decay smoothing.

### Proposed `Forecaster` interface

```ts
export interface Forecaster {
  readonly name: string;
  predict(account: string, deltaSeconds: number, history: UsageHistory): ForecastReading;
}

export interface ForecastReading {
  accountName: string;
  predictedRemainingPct: number;     // bounded 0..100
  predictedResetAt?: number;          // UNIX seconds, copied from upstream when known
  confidence: number;                 // 0..1; 0 = no data, 1 = strong signal
  modelVersion: string;               // for telemetry / debugging
}

export interface UsageHistory {
  /** Newest-first samples; capped at e.g. 200 entries per account. */
  samples: Array<{ atSeconds: number; remainingPct: number; windowKind: WindowKind }>;
}
```

Two reference implementations:

1. **EWMA forecaster.** Exponential weighted moving average of usage
   *rate* (delta-remainingPct per second). Predicts
   `currentRemaining - rate * deltaSeconds`, clamped to `[0, 100]`.
   Confidence rises with sample count, falls when variance is high.
2. **Simple-trend forecaster.** Linear regression over the last `N`
   samples, with the same clamp. Cheaper than EWMA, less responsive to
   recent bursts.

Both are pluggable; the policy declares which one it wants in
`PolicyConfig.forecaster`.

### Where the forecaster fits

`ForecastAware` policy (described in `06-AUTO-SWITCH-AND-DAEMON.md` §
Proposed policy engine) is the only consumer. It uses
`predictedRemainingPct(lookaheadMinutes * 60)` to refuse switching to an
account that will be exhausted within the lookahead window.

`forecast` and `check` commands grow a `--predict 1h` flag that shows
the predicted remaining at the given delta, instead of (or in addition
to) today's present-tense score.

### Savings counters

`account-savings.ts:57-63` claims `5 min saved per rate-limit avoided`.
This is a flat constant chosen out of thin air. Proposal:

```ts
function estimateMinutesSaved(window: UsageWindow, atSeconds: number): number {
  if (!window.resetsAt) return 5;       // unknown reset → fall back to current heuristic
  return Math.max(0, Math.round((window.resetsAt - atSeconds) / 60));
}
```

i.e. "you saved the minutes you would have waited until the next reset".
The number is still a heuristic but it is no longer fictitious; it
matches the wall-clock cooldown the user would have actually experienced.

### Privacy of forecast data

History samples are stored at
`<codex>/multi-auth/usage-history.jsonl` (proposed), capped at 200
entries per account (rolling), with `at`, `remainingPct`, `windowKind`.
No prompts, no tokens, no request bodies. See § Privacy below.

---

## Provider-specific usage adapters

The current code is Codex/ChatGPT-only. The `UsageQuota` model and the
`UsageHttpClient` enable plug-in adapters for other providers.

### Codex (ChatGPT plans, usage-based)

**Known.** Endpoint, response shape (`primary_window` / `secondary_window`
with `used_percent`, `window_minutes`, `resets_at`), 5h and weekly
windows. Auth via `Authorization: Bearer` + `ChatGPT-Account-Id` header.
`auth.json` carries `tokens.accessToken` and `tokens.account.account_id`.

**Unknown.** Whether the response shape varies by plan tier. The legacy
`usage-refresh.ts:50-69` parser expects `rate_limits: [...]` as an
*array*; the registry-aware `usage.ts:556` expects `rate_limit: { ... }`
as an object. Either the API returns both shapes (depending on plan or
A/B), or one parser is dealing with a deprecated shape. The fixture
corpus proposed below resolves this.

**Adapter contract.**

```ts
class CodexUsageAdapter implements UsageProvider {
  readonly id = "codex";
  async fetch(account: AccountState, client: UsageHttpClient): Promise<UsageQuota | undefined> { ... }
  parseLocal(rolloutRecord: unknown): UsageQuota | undefined { ... } // from session jsonl
}
```

### Claude (Anthropic console)

**Known.** The user has an Anthropic console session at
console.anthropic.com that exposes per-workspace usage (`/api/usage` or
similar). The `parallel` subsystem
(`src/commands/parallel.ts`, not in scope for this doc) manages separate
Claude Code subscriptions via env var indirection but **does not**
currently fetch usage. There is no Claude usage parsing in the current
tree.

**Unknown.** Whether the Anthropic console exposes a stable JSON
endpoint compatible with the per-account flow. Whether the OAuth token
in Claude Code's `~/.claude/credentials.json` can be replayed against
the console API.

**Adapter contract.** Same as Codex; the rate-limit window kind would
likely be `"5h"` and `"monthly"`. Until the endpoint is confirmed, the
Claude adapter ships as a `LocalOnlyAdapter` that reads from Claude
Code's session logs at `~/.claude/sessions/`.

### Kiro (TBD)

**Known.** Kiro snapshots are managed by `src/lib/kiro-mirror.ts`. The
auth format and session-log shape are not currently parsed for usage.

**Unknown.** Whether Kiro has a usage endpoint at all; whether quota is
shared with the underlying provider (Claude, AWS, OpenAI?) or accounted
separately.

**Adapter contract.** Stub returning `undefined` from `fetch` and
`parseLocal`. The user-visible effect: Kiro accounts always appear in
`list` with `-` in the usage cells, and the auto-switch policy treats
them as `score = ?? 100` (i.e. always eligible as a candidate of last
resort).

### Provider registry

```ts
export const usageAdapters: Record<ProviderId, UsageProvider> = {
  codex: new CodexUsageAdapter(),
  claude: new ClaudeUsageAdapter(),   // initially local-only
  kiro: new KiroUsageAdapter(),       // initially stub
};
```

The `AccountState.provider` (a new field) selects the adapter. The
registry-aware refresh path becomes provider-agnostic:

```ts
const adapter = usageAdapters[account.provider];
const quota = await adapter.fetch(account, this.httpClient);
```

---

## Privacy and permissions

### What does not leave the machine

The usage subsystem makes outbound network calls **only** to:

- `https://chatgpt.com/backend-api/wham/usage` (Codex).
- `http://127.0.0.1:2455/*` (local dashboard proxy; loopback only).
- *Future:* Anthropic / Kiro endpoints once their adapters land.

Specifically, the following never leave the machine:

- The contents of `auth.json` beyond the bearer header on calls the user
  has already authenticated.
- Rollout logs (`~/.codex/sessions/**/*.jsonl`). Parsed locally only.
- `UsageHistory` samples.
- Savings counters (`account-savings.ts`).
- Account names, emails, account ids.
- Any data from other providers' snapshots.

### Documentation in code

The proposed `UsageHttpClient` enforces this by construction:

1. The constructor takes a list of *allowed* hostnames; any call to a
   host outside the allow-list throws synchronously.
2. The allow-list is built from the registered provider adapters; adding
   an adapter explicitly opts in to its endpoints.
3. A unit test asserts that the constructed allow-list at startup matches
   a golden list, so any code change that adds a new outbound host fails
   the test until the user explicitly updates the golden.

### Headers and identifiers

The only identifier sent off-machine is `User-Agent: authmux`
(`usage.ts:548`). No telemetry ID, no install ID, no machine ID. The
`ChatGPT-Account-Id` header (`usage.ts:547`) is the user's own account
ID being sent back to ChatGPT.

### Permissions for service install

`enableManagedService` writes to user-scoped paths only:

- `~/.config/systemd/user/` (Linux)
- `~/Library/LaunchAgents/` (macOS)
- User-scope Task Scheduler (Windows)

No `sudo`, no root. The privilege probes proposed in
`06-AUTO-SWITCH-AND-DAEMON.md` § Service install hardening assert this.

### Permissions for usage refresh

The daemon needs only:

- Read access to `~/.codex/accounts/*.json` (for the bearer token).
- Read access to `~/.codex/sessions/**/*.jsonl` (for local fallback).
- Outbound network to the allow-listed hosts.
- Read/write to `<codex>/multi-auth/registry.json`.

Nothing else. No `ptrace`, no kernel APIs, no system-wide directories.

---

## Caching and persistence

### Current schema

The relevant fields on `AccountRegistryEntry`
(`src/lib/accounts/types.ts:20-29`) are:

```ts
lastUsageAt?: string;     // ISO-8601
lastUsage?: UsageSnapshot;
```

`lastUsage.fetchedAt` and `lastUsageAt` are *both* timestamps and are
both ISO-8601 strings. They typically agree but the sanitiser
(`registry.ts:55-58, 78`) does not enforce that they do.

### Proposed schema

| Field | Type | Purpose |
| ----- | ---- | ------- |
| `lastUsage` | `UsageQuota` | The cached quota for this account. |
| `lastRefreshedAt` | `string` (ISO-8601) | The single source of truth for "when". `lastUsage` no longer carries its own `fetchedAt`. |
| `lastRefreshAttemptAt` | `string` (ISO-8601) | Set on every refresh attempt, success or failure. |
| `lastRefreshError` | `UsageError \| undefined` | Surfaces in `list` (`[net?]` etc.). |
| `etag` | `string \| undefined` | For conditional requests when the provider supports them. |

`UsageSnapshot.fetchedAt` is removed in the major-release migration; for
the minor-release migration it is duplicated to maintain compatibility.

### Garbage collection

Stale entries (accounts that were removed from `~/.codex/accounts/`)
already get pruned by `reconcileRegistryWithAccounts`
(`registry.ts:154-181`) on every load. The proposed
`UsageHistory.samples` array is bounded:

- Hard cap: 200 entries per account.
- Soft cap: 7 days; older samples are dropped on next write.

Both caps are applied on write, not read, so reads are O(1) on the bound.

### Atomic writes

The registry is written via `fs.writeFile` directly
(`registry.ts:148-152`). The same hardening proposed in
`06-AUTO-SWITCH-AND-DAEMON.md` (issue #14, "atomic registry writes")
also covers usage writes since both flows go through the same
`saveRegistry`.

---

## Issues found in code (consolidated)

`D-` prefix for daemon-adjacent; `U-` prefix for usage-specific.

### U-1. Two parallel API parsers — `P1 S`

**Evidence.** `usage-refresh.ts:50-69` and `usage.ts:556-563` parse two
different shapes returned from the same endpoint. **Diagnosis.** One of
them is stale, or the API returns both. Either way, the legacy
`fetchUsage` is a code-smell; collapse it into the registry-aware
adapter and have `switch --live` consume the unified path.

### U-2. `fetchUsageFromApi` returns `null` on every error class — `P1 S`

**Evidence.** `usage.ts:553-554` and `:564-566` both produce `null` for
HTTP 401, 429, 500, network timeout, and JSON parse failure. **Diagnosis.**
The caller cannot distinguish "the user's token is bad" from "the
network is flaky". Surface a discriminated `UsageError` (see § API mode
"Errors visible to the user").

### U-3. `usageScore` does not weight remaining time until reset — `P2 S`

**Evidence.** `usage.ts:511-519`. **Diagnosis.** A candidate at 30%
remaining whose window resets in 5 minutes is functionally better than
one at 30% remaining whose window resets in 6 hours. The policy treats
them identically. Proposed: `usageScore(snapshot, nowSeconds, weights)`
takes a weights argument and the policy injects it.

### U-4. Rollout parser loads entire file into memory — `P2 S`

**Evidence.** `usage.ts:610-614`. **Diagnosis.** See § Local fallback
"Risks today". Bounded by file size and the 5-file cap, but should be
streamed in reverse.

### U-5. Rollout schema accepted paths are undocumented — `P2 S`

**Evidence.** `usage.ts:116-129`. **Diagnosis.** The three accepted
nesting paths are an empirical contract with Codex's evolving session
format. Document them, name them, and detect drift.

### U-6. `fetchUsageFromProxy` shells out to TOTP command — `P0 S`

**Evidence.** `usage.ts:365-373` uses `child_process.exec(command)` where
`command` comes from `CODEX_LB_DASHBOARD_TOTP_COMMAND`. **Diagnosis.**
The env var is user-controlled, so this is not technically an injection
vulnerability *within* the user's own session — but a malicious shared
shell rc, a compromised dotfile sync, or a process started in a sandbox
with hostile env can cause arbitrary code execution. Mitigations:
(a) require the command path to be absolute, (b) execute via
`spawn(file, args)` not `exec(string)` so shell metacharacters are not
interpreted, (c) document the risk in `--help`. `P0` because the failure
mode is unauthenticated remote-ish (env-var-driven) code execution.

### U-7. Proxy index re-built on every list call — `P2 S`

**Evidence.** `account-service.ts:773-775`. The proxy index has no
caching; each `list` triggers a fresh `fetchUsageFromProxy()`.
**Diagnosis.** The proxy is local and fast (2s timeout), so the impact
is limited, but the daemon path **does not** call the proxy at all
(`runAutoSwitchOnce` does not pass `proxyUsageIndex` to
`refreshAccountUsage`), missing an obvious batching opportunity. Daemon
should attempt the proxy first, then fall back to per-account API.

### U-8. `coerceWindow` accepts `used_percent` only — `P3 S`

**Evidence.** `usage.ts:76-78`. **Diagnosis.** The math discards usage
records that report only `remaining` and `limit` (which is the shape the
legacy parser handles, `usage-refresh.ts:57-63`). If the API ever moves
exclusively to that shape, the registry-aware path goes dark while the
legacy one keeps working. Add a fallback that computes
`used_percent = 100 * (1 - remaining/limit)` when only those fields are
present.

### U-9. `remainingPercent` returns `100` when `resetsAt <= now` — `P3 S`

**Evidence.** `usage.ts:503`. **Diagnosis.** Correct in spirit (the
window has reset, the cached `usedPercent` is stale), but it means the
cache can lie until a refresh happens. The policy can switch *to* an
account based on a phantom "100% remaining" reading. Mitigation: the
policy refuses to switch to an account whose data is older than
`maxAcceptableStalenessMs` regardless of the computed remaining.

### U-10. Local fallback never sets `accountId` on the entry — `P3 S`

**Evidence.** `account-service.ts:714-717` populates entry metadata from
the parsed snapshot file before usage fetching, then `usage` is added
without touching `accountId`. Local rollouts do contain
`accountId` in some Codex versions and could opportunistically fill in
missing metadata; today this is left on the floor.

### U-11. `account-savings.ts:60-62` constant minutes — `P3 S`

See § Forecasting and savings "Savings counters".

### U-12. `account-health.ts` state is not consulted by the daemon — `P2 S`

Cross-reference: this is issue #10 in `06-AUTO-SWITCH-AND-DAEMON.md`.
Listed here too because the proposed `PolicyInputs.accounts[i].health`
field is the bridge between the two subsystems.

---

## Migration plan

Three phases, designed to land independently and to keep the on-disk
schema stable across each.

### Phase 1 — normalise the read path (P0/P1)

| Change | Files | Tag |
| ------ | ----- | --- |
| Add `UsageQuota` value object and `asLegacySnapshot` view | new `src/lib/accounts/usage-quota.ts` | `P1 S` |
| Atomic write of registry (also covers usage cache) | `src/lib/accounts/registry.ts` | `P0 S` |
| Single `UsageHttpClient` with retries + circuit breaker; replace inline `fetch` in `usage.ts` and `usage-refresh.ts` | new `src/lib/accounts/usage-http.ts`, edits to `usage.ts`, `usage-refresh.ts` | `P1 M` |
| Switch `child_process.exec` to `spawn` for TOTP command | `usage.ts:365-373` | `P0 S` |
| Wire `recordFailure` / `recordSuccess` into the usage refresh path | `usage.ts`, `account-health.ts` | `P1 S` |
| Collapse legacy `fetchUsage` into the registry-aware path; `switch --live` calls `refreshAccountUsage` instead | `usage-refresh.ts`, `src/commands/switch.ts` | `P1 S` |

Acceptance: existing tests pass; new tests cover the retry/circuit
breaker behaviour with a mocked HTTP client and confirm `switch --live`
output is unchanged.

### Phase 2 — provider adapters

| Change | Files | Tag |
| ------ | ----- | --- |
| `UsageProvider` interface; `CodexUsageAdapter` as default | new `src/lib/accounts/usage-provider.ts`, `codex-usage-adapter.ts` | `P1 M` |
| `AccountState.provider` field with default `"codex"` | `types.ts`, registry sanitiser | `P1 S` |
| Stub `ClaudeUsageAdapter` and `KiroUsageAdapter` returning `undefined` | new files | `P2 S` |
| Rollout parser hardening: streaming, schema-version registry, fixture corpus | `usage.ts`, new fixtures | `P2 M` |
| Per-account `UsageHistory` capped at 200 / 7d | `registry.ts`, `usage.ts` | `P2 S` |

Acceptance: `list` and `status` produce identical text output before/
after; daemon decisions unchanged (the policy still consumes the same
`UsageQuota` view); fixture corpus runs in CI.

### Phase 3 — forecaster and provider expansion

| Change | Files | Tag |
| ------ | ----- | --- |
| `Forecaster` interface, EWMA and SimpleTrend implementations | new `src/lib/policy/forecaster.ts` | `P2 M` |
| Wire forecaster into `ForecastAware` policy | `src/lib/policy/forecast-aware.ts` | `P2 M` |
| `forecast --predict 1h` flag | `src/commands/forecast.ts` | `P3 S` |
| Live `ClaudeUsageAdapter` once the endpoint is confirmed | `claude-usage-adapter.ts` | `P2 M` |
| `KiroUsageAdapter` once Kiro exposes a usable signal | `kiro-usage-adapter.ts` | `P3 M` |
| Stale-while-revalidate in `list` and `status` | `account-service.ts`, `src/commands/list.ts`, `src/commands/status.ts` | `P2 S` |

Acceptance: policy decisions are deterministic given history; SWR does
not produce flickering UI for users running `list` repeatedly.

---

## Rollout

### Pre-flight (every phase)

1. `npm test`.
2. Run `authmux list --details` against a real account pool; diff text
   output against pre-change baseline.
3. Run the daemon (`daemon --once`) against the same pool; confirm the
   `AutoSwitchRunResult.reason` string is unchanged for at least 50
   iterations across varying registry states.
4. Recorded HTTP fixtures pass without network (see § Testing).

### Phase 1 rollout

- Patch release.
- Release notes call out the `UsageHttpClient` and the TOTP
  `spawn` change. The latter may require users with shell-quoted TOTP
  commands to revisit their env var.

### Phase 2 rollout

- Minor release.
- Registry version stays at `1`; new fields (`provider`, `etag`,
  `lastRefreshError`) are additive.
- Rollout parser hardening is observable only via the new structured
  log; behaviour is identical except for previously-uncaught partial
  writes which now succeed.

### Phase 3 rollout

- Minor release per adapter, gated on the upstream endpoint being
  documented internally.
- `Forecaster` lands disabled by default; user opts in via
  `config policy set forecast-aware`.
- `UsageHistory` is collected from the moment Phase 2 ships; Phase 3
  benefits from up to a week of warm-up data on existing installs.

---

## Testing

The HTTP layer, the parser, the forecaster, and the policy interplay
each need their own test surface. The common thread: **no live network
calls in CI, ever.**

### Recorded HTTP fixtures

`src/lib/accounts/__fixtures__/http/` contains JSON files describing
recorded request/response pairs. Schema:

```ts
interface HttpFixture {
  name: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  response: { status: number; headers: Record<string, string>; body: string };
  notes?: string;
}
```

A `RecordedHttpClient` implements `UsageHttpClient` by matching incoming
requests against the fixture set (by method + URL + selected headers).
Tests assert that the produced `UsageQuota` matches an expected golden.

Fixture set covers:

- ChatGPT Plus seat — both the `rate_limit` (object) and `rate_limits`
  (array) shapes if both are real.
- ChatGPT usage-based plan.
- 401 (expired token).
- 429 (rate-limited) with `retry-after` header.
- 5xx transient.
- Network timeout.
- Proxy `/api/accounts` response with mixed-case email keys.
- Proxy session probe + password login flow.

Re-recording fixtures is a deliberately manual step (a `scripts/`
helper) requiring a maintainer's real credentials. The recorded files
are sanitised: real account ids are replaced by deterministic
placeholders.

### Property tests for percentage math

`usage.ts` math (`coerceWindow`, `remainingPercent`, `usageScore`,
`shouldSwitchCurrent`) is pure and ideal for property tests with
`fast-check`:

- *clamp*: `remainingPercent` is always in `[0, 100]`.
- *idempotence*: `remainingPercent(window, now)` does not depend on the
  *order* of fields in `window`.
- *reset semantics*: when `resetsAt <= nowSeconds`, the result is
  exactly `100`.
- *score monotonicity*: increasing `usedPercent` in either window
  decreases (or leaves unchanged) `usageScore`.
- *threshold consistency*: if `shouldSwitchCurrent(snapshot, t, now)` is
  true and `t'.threshold5hPercent >= t.threshold5hPercent` and
  `t'.thresholdWeeklyPercent >= t.thresholdWeeklyPercent`, then
  `shouldSwitchCurrent(snapshot, t', now)` is also true.

### Time-based tests with injected clock

`UsageHttpClient` and the forecaster each take a `Clock` (the same
interface used by the daemon runtime, see
`06-AUTO-SWITCH-AND-DAEMON.md` § Testing). Tests advance time
explicitly:

```ts
const clock = new AdvancingClock(0);
const client = new UsageHttpClient({ clock, ... });
// transient response triggers backoff
mock.respondTransient();
const p = client.fetchUsage(req);
clock.advance(250);   // base backoff
mock.respondOk(quota);
expect(await p).toMatchObject({ kind: "ok" });
```

For the forecaster:

```ts
const f = new EwmaForecaster();
const history = sampleHistory({
  startAt: 0, sampleEverySec: 60, count: 60,
  fn: (t) => 100 - t,  // 1% per minute decay
});
const r = f.predict("acc", 600, history);
expect(r.predictedRemainingPct).toBeCloseTo(30, 0);  // 60 min in, 10 min ahead
expect(r.confidence).toBeGreaterThan(0.7);
```

### Local rollout parser tests

Fixture corpus under
`src/lib/accounts/__fixtures__/rollouts/`:

| Fixture | What it exercises |
| ------- | ----------------- |
| `rollout-v1-simple.jsonl` | Top-level `rate_limits`. |
| `rollout-v2-payload.jsonl` | Nested under `payload.rate_limits`. |
| `rollout-v3-payload-event.jsonl` | Nested under `payload.event.rate_limits`. |
| `rollout-truncated.jsonl` | Last line is partial JSON; parser must skip and recover. |
| `rollout-empty.jsonl` | Empty file. |
| `rollout-non-rate.jsonl` | Many lines, none with rate-limit. |
| `rollout-multi-timestamp.jsonl` | Mixed `event_timestamp_ms` and `timestamp_ms`; latest wins. |

Each fixture has a sibling `.expected.json`. Tests run the parser and
diff.

### Adapter tests

`CodexUsageAdapter`, `ClaudeUsageAdapter`, `KiroUsageAdapter` each run
against their own fixture set. The adapter contract is enforced by a
shared test suite (`describeUsageAdapter(adapter, fixtures)`) so any new
adapter automatically inherits the same correctness bar.

### Privacy test

A unit test constructs the production `UsageHttpClient` and asserts that
its allow-list is exactly the union of allow-lists declared by the
registered adapters. Any new outbound host fails the test until
explicitly added.

### Coverage targets

- `src/lib/accounts/usage.ts` math helpers — 100% lines.
- `src/lib/accounts/usage-http.ts` — 95% lines, 100% branches for retry
  and circuit-breaker state transitions.
- `src/lib/accounts/codex-usage-adapter.ts` — 95%.
- Forecaster implementations — 90%.
- Rollout parser — 100% for the schema-detection branches.

---

## Open questions

- **Does the ChatGPT API return both `rate_limit` (object) and
  `rate_limits` (array) shapes?** If yes, the two parsers must be
  reconciled; if no, the legacy one is stale and should be removed
  outright. Resolving this requires logging actual response shapes from
  real installs (proposed: a `--debug-usage` flag that prints the raw
  body).
- **Should `UsageQuota.windows` be ordered?** Today's `primary` /
  `secondary` ordering is implicit. The proposed array form needs a
  documented ordering (probably "shortest window first") for stable
  rendering in `list`.
- **Where do plan tiers live?** `planType` is currently a free-form
  string. A typed enum would make `list`'s plan-renderer
  (`src/lib/accounts/plan-display.ts`) safer but requires a per-provider
  taxonomy maintained alongside upstream changes.
- **Do we forecast against the candidate or the active account?** Both
  matter, but a forecast on a candidate that has never been active is
  guesswork (no history). The forecaster needs a "cold-start" mode that
  emits low confidence and lets the policy degrade gracefully.
- **Should `UsageHistory` survive `authmux clean`?** Probably not —
  history is per-account and `clean` typically resets account state.
  Worth confirming.
- **How aggressive should ETag handling be?** ChatGPT's `/wham/usage`
  does not currently send ETags. If a future endpoint does, naive
  ETag caching can mask provider-side mutations that we care about
  (e.g. plan tier change). Use ETag for *bandwidth* not for *staleness*.

---

## Glossary

| Term | Meaning |
| ---- | ------- |
| **Adapter** | Provider-specific module implementing `UsageProvider`. |
| **Allow-list** | The set of hostnames the `UsageHttpClient` is permitted to call. |
| **Cache** | `lastUsage` field on each account in the registry. |
| **Candidate** | Any saved account other than the active one. |
| **EWMA** | Exponentially weighted moving average; one of the forecaster implementations. |
| **Fixture** | Recorded JSON describing a request/response pair, used in lieu of live network in tests. |
| **Forecast** | Predicted remainingPct at a future delta. |
| **Hysteresis** | The enter/exit band; defined in `06-AUTO-SWITCH-AND-DAEMON.md`. |
| **Local fallback** | Reading usage from rollout logs when the API is unavailable. |
| **Proxy** | The local `127.0.0.1:2455` dashboard from the `codex-lb` ecosystem. |
| **Quota** | The `UsageQuota` value object proposed in this document. |
| **Rollout** | A `rollout-*.jsonl` file produced by Codex inside `~/.codex/sessions/`. |
| **SWR** | Stale-while-revalidate: return the cached value, refresh in the background. |
| **Snapshot** | The on-disk account file at `~/.codex/accounts/<name>.json`. |
| **Source** | The label on a `UsageWindow` describing where the datum came from. |
| **Window** | One rate-limit period reported by a provider. |
