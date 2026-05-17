# 11 — Testing Strategy

This document is the long-form testing protocol for `authmux`. It is paired
with `10-SECURITY-AND-SECRETS.md` (security posture) and uses the same
Evidence / Diagnosis / Proposal / Migration / Rollout pattern defined in
`00-OVERVIEW.md`. Where the security file says "what must be true on disk",
this file says "what must be true in CI before the code touches disk".

The goal of the testing strategy is not coverage-for-coverage's-sake. The
goal is to make every Evidence-tagged change in `docs/future/` *cheap* to
land. Today, many changes in `account-service.ts` (1663 LOC) are scary to
review because the test surface only exercises a few branches. We fix that
by raising the test pyramid in a deliberate order, with the riskiest
files first.

## Scope

This file covers:

- The current test inventory under `src/tests/`.
- The proposed unit / integration / E2E split.
- The fixtures and fakes that need to land in `src/test-support/`.
- Coverage tooling and thresholds.
- CI matrix and gates.
- Optional layers: property-based, snapshot, mutation, performance,
  fuzzing.
- Naming and layout conventions.
- The Python test file in `src/tests/`.
- Pre-commit / pre-push hook policy.

Out of scope:

- Manual QA scripts (recorded screencasts, demo flows). See
  `15-DOCS-AND-EXAMPLES.md`.
- Load tests against the real `chatgpt.com` usage API. We never hit
  live provider endpoints from CI.
- Release-time smoke tests on the published tarball. See
  `14-RELEASE-AND-DISTRIBUTION.md`.

## Current state

The repo's tests live in `src/tests/`. They are compiled to
`dist/tests/` by `npm run build` and executed by `node --test
dist/tests/**/*.test.js`, as declared by `package.json:16`:

```
"test": "npm run build && node --test dist/tests/**/*.test.js"
```

### Inventory

| File                                                | Lines | What it covers                                                                                                                                       |
| --------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tests/save-account-safety.test.ts`             | 1772  | The crown jewels of the suite. Exercises `AccountService.saveAccount` against a tmp `~/.codex`. Covers email-mismatch protection, snapshot backup vault, symlink materialization, multi-snapshot identity. By far the largest test file in the repo. |
| `src/tests/account-list-usage-refresh.test.ts`      | 389   | Drives `AccountService.listAccountsWithDetails` (and friends) with a fake fetch that returns canned `wham/usage` payloads. Asserts that registry is updated and that stale rows are refreshed. |
| `src/tests/update-check.test.ts`                    | 258   | Exercises `src/lib/update-check.ts`: cache file shape, version-comparison, message formatting. Uses a fake fetch. |
| `src/tests/login-hook.test.ts`                      | 124   | Round-trips `installLoginHook` / `removeLoginHook` / `getLoginHookStatus` against a tmp `.bashrc`. |
| `src/tests/auth-parser.test.ts`                     | 73    | Pure-function tests for `parseAuthSnapshotData`: ChatGPT id_token claims, API-key mode, malformed input.                                              |
| `src/tests/usage.test.ts`                           | 37    | Pure-function tests for `usageScore` and `shouldSwitchCurrent` from `src/lib/accounts/usage.ts`.                                                      |
| `src/tests/registry.test.ts`                        | 36    | Sanitization round-trips for `sanitizeRegistry` and `reconcileRegistryWithAccounts`.                                                                |
| `src/tests/account-plan-display.test.ts`            | 24    | Pure-function tests for `formatAccountType`.                                                                                                         |
| `src/tests/test_kiro_account_switcher.py`           | 118   | A Python `unittest` file that imports `scripts/kiro_account_switcher.py`. Does not run under `node --test`. Effectively orphaned by the current test runner. |

Total: 8 TypeScript test files + 1 Python file. 4 files are < 100
lines; 1 file is > 1700 lines and concentrates most of the integration
behavior tests.

### Test runner

- `node --test` (built-in since Node 18). No `mocha`, no `jest`, no
  `vitest`. This is intentional: the project has zero dev-dep test
  framework and inherits Node's `assert/strict`.
- Tests run against compiled `dist/`, not `src/`. That means the
  build step is part of the test command, and a stale `dist/` would
  silently mask source changes. The current `"test"` script forces a
  rebuild, which is correct but slow.
- There is no test-watch mode, no parallel grouping, no per-file
  isolation other than what `node --test` provides natively.

### Gaps

Catalogue of things that are not tested today. Each one is a target for
a numbered improvement below.

- **`src/commands/daemon.ts`** — the auto-switch loop. No test covers
  the watch interval, the threshold evaluation, the registry write on
  switch, or the signal-handling path.
- **`src/commands/parallel.ts`** — the Claude Code per-account
  `CLAUDE_CONFIG_DIR` materialization. No test covers the directory
  layout, the env-var injection, or the cleanup on exit.
- **`src/commands/service-manager.ts`** (per the overview, this file
  exists conceptually under `service-manager.ts`) — the systemd /
  launchd / scheduled-task generation. No test covers the rendered
  unit-file contents or the `--dry-run` mode (R7 in
  `10-SECURITY-AND-SECRETS.md`).
- **`src/commands/hook-install.ts`** and friends — the
  command-layer wiring is untested; only the underlying functions in
  `src/lib/config/login-hook.ts` are tested.
- **`src/commands/kiro.ts`** — Kiro CLI mirror. No test.
- **`src/lib/hermes-mirror.ts`** — no test.
- **`src/lib/kiro-mirror.ts`** — no test.
- **`src/lib/account-health.ts`** — no test (it is hit transitively
  through `account-list-usage-refresh.test.ts`, but not directly).
- **`src/lib/account-savings.ts`** — no test.
- **`src/lib/base-command.ts`** — no test for the error-mapping or
  the `syncExternalAuthSnapshotIfNeeded` invocation.
- **No CLI smoke tests.** No test does `spawn("authmux", ["list"])`
  and asserts the rendered stdout. As a result we have no protection
  against accidental output-format regressions.
- **No coverage measurement.** `c8`, `istanbul`, and `node --test
  --experimental-test-coverage` are all absent. We do not know what
  percentage of lines / branches is exercised.
- **No property-based tests.** Percentage math
  (`registry.ts:16-21`), threshold evaluation
  (`usage.ts:shouldSwitchCurrent`), and any JSON migration runner
  would benefit from `fast-check`.
- **No snapshot tests for rendered tables.** `authmux list`,
  `authmux status`, `authmux current`, `authmux forecast` all emit
  formatted tables that have no fixture comparison.
- **No mutation tests.** Stryker on the critical files
  (`registry.ts`, `account-service.ts`, `auth-parser.ts`,
  `switcher`-related code) would tell us whether our tests *would
  notice* a regression, not just whether they execute the code.
- **No fuzzing.** `parseAuthSnapshotData` (`src/lib/accounts/auth-parser.ts`)
  takes attacker-controlled bytes and should be fuzzed against
  malformed JSON.
- **No performance benchmarks.** `authmux list --details` against
  100 / 1000 accounts has no measured baseline. The daemon's RSS
  drift over 24h has no soak test.
- **Single CI workflow.** `.github/workflows/cr.yml` runs only the
  LLM code-review bot. There is no `ci.yml` running `npm test` on
  PR. This is the highest-leverage fix in this whole document.

## Test pyramid

The proposed shape, in three layers, with rough proportions of the
total test mass.

```
            ┌───────────────────────────────────────────┐
            │  E2E (~10%)                               │
            │  - spawn `authmux` binary via child_process│
            │  - golden output diffs                    │
            │  - scripted flows: save → use → list      │
            └───────────────────────────────────────────┘
         ┌─────────────────────────────────────────────────┐
         │  Integration (~20%)                             │
         │  - AccountService against tmp ~/.codex          │
         │  - service-manager against fake OS adapters     │
         │  - HTTP-mocked usage refresh                    │
         │  - login-hook against tmp rc files              │
         └─────────────────────────────────────────────────┘
   ┌─────────────────────────────────────────────────────────────┐
   │  Unit (~70%)                                                │
   │  - pure functions: parsers, formatters, identity resolvers  │
   │  - registry sanitize/reconcile                              │
   │  - usage scoring & threshold logic                          │
   │  - plan-display, version-compare, percent math              │
   └─────────────────────────────────────────────────────────────┘
```

### Unit layer

- **Target.** All pure functions and value objects.
- **Examples already present.** `auth-parser.test.ts`,
  `account-plan-display.test.ts`, `usage.test.ts`,
  `registry.test.ts`, parts of `update-check.test.ts`.
- **What we still need.**
  - `src/lib/accounts/identity-resolver.ts` (when extracted from
    `account-service.ts` per `01-ARCHITECTURE.md`).
  - `src/lib/accounts/switcher.ts` (decision logic for which account
    a daemon evaluation should pick).
  - `src/lib/config/paths.ts` — env-var precedence is currently
    untested.
  - `src/lib/accounts/usage.ts` — `coerceWindow`,
    `buildSnapshotFromRateLimits`, and the proxy-payload
    normalization.
  - `src/lib/accounts/errors.ts` — error formatting, structured
    codes.

### Integration layer

- **Target.** `AccountService` end-to-end against a tmp `~/.codex`,
  with the real filesystem and a faked clock + faked HTTP.
- **Examples already present.** `save-account-safety.test.ts` and
  `account-list-usage-refresh.test.ts` are the model. Both create a
  tmp dir, set `CODEX_AUTH_CODEX_DIR` to that dir, drive
  `AccountService` through real method calls, and assert on the
  files left behind.
- **What we still need.**
  - End-to-end `save → use → switch → remove` flow.
  - Daemon evaluation loop against a fake clock that advances in
    discrete steps, with a fake usage-fetcher that returns scripted
    values.
  - `parallel` command — assert that the per-account
    `CLAUDE_CONFIG_DIR` directory contains the right files and that
    cleanup runs on exit.
  - `service-manager` install on each platform via fake OS adapters
    (don't actually invoke `systemctl`, `launchctl`, `schtasks`).
  - Snapshot-backup vault eviction policy.
  - Symlink materialization against a tmp dir on platforms that
    support symlinks.

### E2E layer

- **Target.** Spawn the compiled `dist/index.js` (or `node
  dist/index.js`) as a child process and assert on exit code, stdout,
  stderr.
- **Examples present.** None.
- **What we need.**
  - A small harness that:
    - Creates a tmp `HOME` (or `CODEX_AUTH_CODEX_DIR`).
    - Spawns `node dist/index.js <args>` with `PATH=...` and a
      pinned env.
    - Captures stdout / stderr / exit code.
    - Returns a typed result object for assertions.
  - Scripted flows:
    - `authmux --help` (golden file).
    - `authmux list` against an empty registry (empty-state golden).
    - `save → list → use → list → remove → list` against a tmp
      auth.json fixture.
    - `authmux current` after `use` (golden).
    - `authmux check` (golden, with each known posture).
  - Each golden file lives at
    `src/tests/fixtures/golden/<command>/<scenario>.txt`. Diff is
    asserted with `assert.equal(stdout, expected)`. To update goldens,
    set `UPDATE_GOLDENS=1` in env and re-run.

## Fakes and fixtures

### `src/test-support/` package

Today, helpers are inlined into the larger test files (e.g.
`save-account-safety.test.ts` has a 50-line `encodeBase64Url` /
`buildAuthSnapshot` block at the top of the file). This duplication
discourages writing new tests. Propose a `src/test-support/` package
shipped in `dist/` but excluded from the published tarball.

Layout:

```
src/test-support/
  index.ts                # re-exports
  fixtures/
    auth-fixture.ts       # AuthFixture builders
    registry-fixture.ts   # RegistryFixture builders
    usage-fixture.ts      # UsageSnapshot builders
    jwt.ts                # encodeJwt / decodeJwt helpers
  fakes/
    in-memory-fs.ts       # InMemoryFs implementing the subset of fsp we use
    fake-clock.ts         # FakeClock with .now(), .advance(ms)
    fake-fetch.ts         # FakeFetch with route registration & call log
    fake-provider.ts      # FakeProviderAdapter for testing the daemon
    fake-os-adapter.ts    # FakeOsAdapter for service-manager tests
    fake-keychain.ts      # FakeKeychainStore (paired with R3 from doc 10)
  matchers/
    auth-matchers.ts      # custom assertion helpers (e.g. expectSnapshotEqualIgnoringTimestamps)
  harness/
    cli-harness.ts        # spawn-based CLI harness for E2E
    tmp-home.ts           # makeTmpHome() + cleanup
```

### Fixture builders

A fixture builder is a curried, chainable factory that produces a
realistic on-disk shape with sensible defaults. Example for the auth
snapshot:

```ts
const auth = AuthFixture.codexChatGPT()
  .withEmail("alice@example.com")
  .withPlan("business")
  .withRefreshTokenTtl(Duration.days(60))
  .build(); // returns { json: string, parsed: ParsedAuthSnapshot, bytes: Buffer }
```

Builders should exist for:

- `AuthFixture.codexChatGPT()` — ChatGPT-mode snapshot.
- `AuthFixture.codexChatGPTBusiness({ email })` — convenience for
  business-plan tests.
- `AuthFixture.codexApiKey({ apiKey })` — `apikey` mode.
- `AuthFixture.codexMalformed()` — known-bad JSON for negative tests.
- `AuthFixture.claudeCode()` — Claude Code-shaped credentials (for
  `parallel.ts` tests).
- `RegistryFixture.empty()`, `.withAccount(...)`,
  `.withActive(...)`, `.withThresholds({ p5h, weekly })`.
- `UsageFixture.fresh(...)`, `.stale(...)`, `.exceeded(...)`.

### Fakes

Where direct dependencies on Node primitives make tests slow or
non-deterministic, we replace them with fakes. Each fake must:

- Implement the same TypeScript interface as the real thing.
- Be a single file under `src/test-support/fakes/`.
- Have its own `*.test.ts` proving the fake's behavior matches a
  trivial subset of the real thing's behavior.
- Document its limits at the top (e.g. "FakeFs does not implement
  symlinks; tests requiring symlinks must use tmpdir on a platform
  that supports them").

Key fakes:

- **`InMemoryFs`** — implements the `fsp` subset we use (`readFile`,
  `writeFile`, `mkdir`, `rm`, `rename`, `stat`, `lstat`, `readdir`,
  `copyFile`, `chmod`). Backed by a `Map<string, Buffer>` for files
  and a `Set<string>` for directories. Throws `ENOENT` / `EACCES` /
  `EEXIST` with realistic shapes.
- **`FakeClock`** — `.now(): number`, `.advance(ms: number)`,
  `.setTimeout(cb, ms)`, `.runUntil(predicate, maxMs)`. Replaces
  `setTimeout` for tests of the daemon loop.
- **`FakeFetch`** — `route("GET", "https://chatgpt.com/backend-api/wham/usage", handler)`,
  `.lastRequest()`, `.requestLog()`. Asserts that each request hit
  a registered route; throws if not.
- **`FakeProviderAdapter`** — implements the `ProviderAdapter`
  interface from `01-ARCHITECTURE.md`. Returns scripted snapshots
  and records `activate(name)` calls.
- **`FakeOsAdapter`** — implements the OS-specific surface that
  `service-manager.ts` shells out to. Captures `systemctl` /
  `launchctl` / `schtasks` invocations without executing them.
- **`FakeKeychainStore`** — implements the `SnapshotStore` interface
  from R3 of doc 10. Backed by an in-memory `Map`.

### HTTP record/replay

For `usage.ts`, we already use a fake fetch via dependency injection
(see `account-list-usage-refresh.test.ts`). Codify this pattern:

- Live recordings live under `src/tests/fixtures/http/<scenario>.json`
  with the shape `{ url, method, status, body, headers }[]`.
- A `FakeFetch.fromFixture("scenario-name")` factory loads the
  fixture and replays requests in order.
- To capture a new fixture, set `RECORD_HTTP=1` and a developer-only
  bearer token; the harness writes to the fixture path. **Never**
  commit a fixture that contains a real bearer token; the harness
  scrubs `Authorization` and any `Set-Cookie` headers before writing.

## Coverage policy

### Tool

- `c8` (the Istanbul-compatible coverage tool for V8). Avoids the
  source-map noise of `nyc` with TypeScript and works natively with
  `node --test`.
- Added under `devDependencies`. Pinned via lockfile.

### Wiring

- New script: `"test:coverage": "c8 --reporter=text --reporter=lcov
  --reporter=html npm test"`.
- Coverage report uploaded as a job artifact in CI.
- A second job step runs `c8 check-coverage --lines 80 --branches 70`
  and fails the build if the global thresholds are not met.

### Per-package thresholds

| Package / file                                          | Lines | Branches | Functions | Statements | Notes                                       |
| ------------------------------------------------------- | ----- | -------- | --------- | ---------- | ------------------------------------------- |
| `src/lib/accounts/registry.ts`                          | 95    | 90       | 95        | 95         | Pure data; should be near-100%.             |
| `src/lib/accounts/auth-parser.ts`                       | 95    | 90       | 95        | 95         | Pure data; attacker-controlled input.       |
| `src/lib/accounts/usage.ts`                             | 85    | 80       | 85        | 85         | HTTP-heavy; needs more fakes.               |
| `src/lib/accounts/account-service.ts`                   | 80    | 70       | 80        | 80         | Until refactored per `01-ARCHITECTURE.md`.  |
| `src/lib/config/paths.ts`                               | 100   | 100      | 100       | 100        | Trivial; no excuse.                         |
| `src/lib/config/login-hook.ts`                          | 95    | 90       | 95        | 95         | Already well-tested; cement the bar.        |
| `src/lib/update-check.ts`                               | 85    | 80       | 85        | 85         | Already well-tested.                        |
| `src/commands/*.ts`                                     | 70    | 60       | 70        | 70         | Mostly orchestration; lower bar acceptable. |
| `src/lib/account-health.ts`, `account-savings.ts`       | 80    | 70       | 80        | 80         | Currently untested; bring up before next minor. |
| `src/lib/hermes-mirror.ts`, `kiro-mirror.ts`            | 70    | 60       | 70        | 70         | Provider mirrors; touch via integration.    |

Global rollup threshold: 80 / 70 / 80 / 80. PR fails coverage if
*either* the global rollup or any per-file floor is breached.

### Coverage gaming

We explicitly reject the following anti-patterns:

- `/* istanbul ignore next */` without a comment explaining why.
- Tests that call a function once and assert nothing meaningful
  (coverage chasing).
- Tests that share state across files (flaky-prone).
- Snapshot tests as a sole assertion in unit-layer code.

The PR review checklist (per `02-COMMANDS.md` and `18-CONTRIBUTOR-GUIDE.md`)
includes "does this change move coverage in the right direction?". A
PR that lowers coverage on a critical file blocks until the author
adds tests or justifies the regression in the description.

## CI improvements

### Today

The repo has one workflow: `.github/workflows/cr.yml`, which runs an
LLM code-review bot on PRs. It does not run tests. PRs can merge
without any green build.

This is the single highest-leverage fix in this whole document.

### Proposal: `ci.yml`

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    name: test (${{ matrix.os }} / node ${{ matrix.node }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: ['18', '20', '22']
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with:
          node-version: ${{ matrix.node }}
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - run: npm test
      - if: matrix.os == 'ubuntu-latest' && matrix.node == '20'
        run: npm run test:coverage
      - if: matrix.os == 'ubuntu-latest' && matrix.node == '20'
        uses: actions/upload-artifact@<SHA>
        with:
          name: coverage
          path: coverage/

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx tsc --noEmit

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high
      - run: npm audit signatures

  smoke-install:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with:
          node-version: '20'
      - run: npm pack
      - run: npm i -g authmux-*.tgz
        env:
          CODEX_AUTH_SKIP_POSTINSTALL: '1'
      - run: authmux --version
      - run: authmux --help
```

### Matrix decisions

- **Node versions.** 18 (current LTS minimum per
  `package.json:18-20`), 20 (active LTS), 22 (current). Drop 18 when
  it goes EOL.
- **OS.** Linux is the primary, macOS and Windows are required
  because the daemon's service-manager differs on each. Smoke-install
  on all three catches OS-specific postinstall regressions.
- **Caching.** `actions/setup-node`'s built-in npm cache is enough.
  No need for `actions/cache`.
- **Concurrency.** A `concurrency:` block at the workflow level
  cancels superseded PR runs:

  ```yaml
  concurrency:
    group: ci-${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: ${{ github.event_name == 'pull_request' }}
  ```

### Required status checks

Once `ci.yml` lands, set the following as required for merge to
`main`:

- `test (ubuntu-latest / node 20)` — always green.
- `lint` — always green.
- `audit` — always green (with break-glass for known-false-positive).
- `smoke-install (ubuntu-latest)` — always green.
- The remaining matrix entries are advisory.

### Telemetry on flakes

- Re-run failed jobs are recorded; if any job needs >1 attempt to
  go green, the test owner is responsible for fixing the flake or
  marking it `@quarantine` (a custom test annotation) within 7
  days.

## Property-based testing

`fast-check` (zero native deps, ~30 KB) is the right choice for
property-based tests in this repo. It is added under `devDependencies`
and used selectively where it provides the most leverage.

### Targets

- **Percentage math.** `registry.ts:16-21` clamps and rounds
  unknown inputs. Property: for any number `n`, `clampPercent(n,
  fallback)` returns a value in `[1, 100]` ∪ `{fallback}`.
- **Threshold evaluator.** `shouldSwitchCurrent(snapshot,
  thresholds)` should be monotonic in `usedPercent`: if usage
  increases, the function never goes from "switch" to "stay".
- **JSON migration runner.** When a registry migration lands
  (`01-ARCHITECTURE.md` proposes versioned migrations), every
  migration `M_v→v+1` should be idempotent and round-trippable for
  any valid input shape at version `v`.
- **Snapshot sanitization.** `sanitizeRegistry(JSON.parse(s))` for
  any `s` produced by `JSON.stringify(sanitizeRegistry(x))` should
  equal `sanitizeRegistry(x)` (fixed point).
- **Identity resolution.** For any combination of
  `email` / `account_id` / `chatgpt_account_id`, the inferred
  identity name is deterministic and stable across calls.

### Anti-patterns to avoid

- Property-based tests that use `fc.anything()` without a generator
  scoped to the type under test. They surface unhelpful failures and
  slow CI.
- Property-based tests that touch the filesystem or network. Keep
  them pure.

## Snapshot testing

For rendered tables in `list`, `status`, `current`, `forecast`,
`savings`, and `check`:

- Snapshot fixtures live under `src/tests/fixtures/render/<command>/<scenario>.txt`.
- A small `assertMatchesSnapshot(actual, fixturePath)` helper diffs
  the strings. On mismatch, prints a unified diff and includes the
  command to update: `UPDATE_SNAPSHOTS=1 npm test -- --grep
  "<scenario>"`.
- Snapshots are reviewed as part of the PR diff, exactly the same
  as code. A snapshot update with no behavioral PR text is a flag in
  review.
- Snapshots include ANSI-stripped text by default; a separate
  fixture captures the ANSI-enabled version for color-affecting
  tests.

## Mutation testing

`StrykerJS` is the canonical mutation tester for TypeScript. It
mutates source files (e.g. flips `>` to `<`, removes branch arms)
and re-runs the test suite to confirm tests *fail*. The score
("mutation score indicator") tells us whether our tests would
notice a regression.

### Targets

Run mutation testing on a small set of critical files, not the
whole codebase. Whole-codebase mutation runs take hours; targeted
runs take minutes.

- `src/lib/accounts/registry.ts`
- `src/lib/accounts/auth-parser.ts`
- `src/lib/accounts/usage.ts` (pure helpers only)
- `src/lib/accounts/identity-resolver.ts` (when extracted)
- `src/lib/accounts/switcher.ts` (decision logic)

### Wiring

- New script: `"test:mutation": "stryker run"`.
- Config in `stryker.conf.js` pinning the mutator set, the test
  runner (`node --test`), and the per-file target.
- Runs nightly on `main`, not on PRs. Reports are uploaded to a
  job artifact and (optionally) to Stryker Dashboard.
- Target MSI: ≥ 80 on each listed file.

### Bar for new code

- A PR that adds a new file to the mutation-tested set must report
  MSI ≥ 80 locally. CI runs are advisory because they are slow.

## Performance tests

### Why

`authmux list --details` walks every snapshot, parses each, hits
the usage API or local cache, and renders a table. At 10 accounts it
is fast. At 100 accounts it may not be. At 1000 (large org dev box)
it will not be. The daemon also accumulates closures and timers
over its lifetime; an RSS leak in a daemon kills the user's laptop.

### Targets and budgets

| Scenario                                   | p50 budget | p95 budget | Where measured                                     |
| ------------------------------------------ | ---------- | ---------- | -------------------------------------------------- |
| `authmux list` (10 accounts, cached usage) | 50 ms      | 100 ms     | E2E harness with tmp `~/.codex`.                   |
| `authmux list --details` (100 accounts)    | 300 ms     | 600 ms     | Integration test with `FakeFetch`.                 |
| `authmux list --details` (1000 accounts)   | 2 s        | 4 s        | Integration test with `FakeFetch`.                 |
| `authmux use <name>` (cold)                | 80 ms      | 150 ms     | E2E harness.                                       |
| Daemon RSS after 1h soak                   | 80 MB      | 120 MB     | Soak test in nightly CI.                           |
| Daemon RSS after 24h soak                  | 100 MB     | 150 MB     | Soak test on a self-hosted runner.                 |

Budgets are advisory in CI today (warn but do not fail) and
hardened to required status after one minor of data collection.

### Implementation

- Benchmarks live under `src/tests/perf/*.bench.ts` and use
  `node --test` with manual `performance.now()` measurement (no
  framework dep).
- A `runWithBudget(name, budgetMs, fn)` helper measures and
  records.
- Benchmarks run in their own CI job
  (`perf` job in `ci.yml`) with a single matrix entry to keep
  results comparable.
- Daemon soak test runs nightly on a self-hosted runner.

## Fuzzing

### `parseAuthSnapshotData`

`src/lib/accounts/auth-parser.ts` consumes attacker-controlled bytes.
It must not throw on bad JSON, must not pollute the prototype chain
via `__proto__` or `constructor.prototype`, and must not consume
unbounded memory on adversarial inputs.

- Use `fast-check` to generate arbitrary JSON values and assert
  that `parseAuthSnapshotData(JSON.stringify(input))` never throws.
- A separate fuzz target uses `jsfuzz` (or homegrown loop over
  random bytes) and feeds raw byte strings; expected outcome is
  "parses or throws a known error class", never an uncaught
  exception.
- Fuzz corpus seeded from `src/tests/fixtures/auth/*.json`.

### Registry sanitization

`sanitizeRegistry` (`registry.ts:98-135`) takes arbitrary JSON. Same
property: never throws, always returns a `RegistryData`.

### Login-hook rc-file mutation

`installLoginHook` reads an existing rc file. Fuzz with random
strings containing the marker substrings to ensure the hook block
regex does not catastrophically backtrack.

## Test naming and layout convention

### Today

All tests are centralized under `src/tests/`. File names are
descriptive (`save-account-safety.test.ts`).

### Two options

1. **Keep centralized `src/tests/`.** Pros: easy to find every
   test; easy to exclude from the published tarball; mirrors the
   current state. Cons: bloated test files (1700+ lines for
   `save-account-safety`); the test for `foo.ts` may live nowhere
   near `foo.ts`.
2. **Co-locate `*.test.ts` next to source.** Pros: discoverability;
   small, focused files; encourages testing as you write. Cons: the
   compiled `dist/` includes test artifacts unless excluded;
   requires `tsconfig` adjustment and a build-time exclude.

### Recommendation

- Pure-function unit tests: **co-located** as `<file>.test.ts`
  next to `<file>.ts`. Build excludes `**/*.test.ts`.
- Integration tests, E2E tests, perf benchmarks, fuzz harnesses:
  **centralized** under `src/tests/integration/`,
  `src/tests/e2e/`, `src/tests/perf/`, `src/tests/fuzz/`.
- Fixtures: `src/tests/fixtures/<category>/<name>.<ext>`.

### Migration recipe

- Add `"exclude": ["**/*.test.ts", "**/*.bench.ts",
  "src/test-support/**"]` to `tsconfig.json`.
- Add a second `tsconfig.test.json` that *includes* tests, used by
  `npm test`.
- Rename existing tests that are clearly pure-unit
  (`account-plan-display.test.ts`,
  `auth-parser.test.ts`, `usage.test.ts`, `registry.test.ts`,
  `update-check.test.ts`) to live next to their source files.
- Leave the integration giants
  (`save-account-safety.test.ts`,
  `account-list-usage-refresh.test.ts`,
  `login-hook.test.ts`) under `src/tests/integration/`.
- Split `save-account-safety.test.ts` into ≤ 300-line files,
  grouped by behavior (overwrite policy, vault, symlink,
  identity).

### Test file naming

- `<thing>.test.ts` — unit tests of `<thing>.ts`.
- `<flow>.integration.test.ts` — integration tests of a flow that
  spans modules.
- `<command>.e2e.test.ts` — E2E tests of `authmux <command>`.
- `<thing>.bench.ts` — benchmark for `<thing>`.
- `<thing>.fuzz.ts` — fuzz target for `<thing>`.

### `describe` / `test` block naming

- Use `node --test`'s `test("does X when Y")` plain-prose style.
  Avoid bare `test("works")`.
- Group via `describe(...)` only when there is ≥ 3 related
  tests; single tests can sit at the top level.

## Python test policy

`src/tests/test_kiro_account_switcher.py` is an outlier. It is the
only Python file inside `src/`, and `node --test` will silently skip
it. Today it is effectively orphaned — `npm test` does not run it.

### Recommendation

Choose one:

- **Convert to TypeScript.** Re-implement
  `scripts/kiro_account_switcher.py` in TypeScript under
  `src/lib/kiro-mirror.ts` (which already exists). Move the tests
  to `src/lib/kiro-mirror.test.ts`. Delete the Python script and
  the Python test.
- **Move to `tests-python/`** at the repo root. Add a `pytest`
  config and a separate CI job `python-test` that runs `pytest
  tests-python/`. Document the dual-runtime story in
  `CONTRIBUTING.md`.

Mixed-runtime test directories are confusing. The current state
("Python test file under `src/tests/` that nothing runs") is the
worst of both worlds — pick one.

### Suggested action

- For v0.2: convert to TypeScript. The Kiro switcher logic is
  small enough and the project already exposes
  `src/lib/kiro-mirror.ts`.
- If conversion slips: move the file to `tests-python/` and wire a
  CI job in the same PR, so it is not silently skipped.

## Pre-commit and pre-push hooks

### Today

No `.githooks/` directory is referenced. Git hooks are not enforced.

### Recommendation

- Add `.githooks/pre-commit` and `.githooks/pre-push` shipped in the
  repo. Onboard developers by adding a `prepare` script to
  `package.json`:

  ```
  "scripts": {
    "prepare": "git config core.hooksPath .githooks"
  }
  ```

  (Per `00-OVERVIEW.md` repo conventions, only add `prepare` if
  the project is willing to take that opinionated step. Otherwise
  document the hook setup in `CONTRIBUTING.md` and leave it
  opt-in.)

### `pre-commit` policy

- Run `npx tsc --noEmit` on staged TypeScript files only (using
  `tsc --project tsconfig.json` is fine for a small project; for
  speed, use `lint-staged`-style filtering when the repo grows).
- Run `node --test dist/tests/<affected>.test.js` for tests whose
  source dependency is in the staged set. Heuristic: if any file
  under `src/lib/accounts/` is staged, run all `src/tests/account-*`
  and any co-located tests under `src/lib/accounts/`.
- Reject the commit on any failure.
- Time budget: 10 seconds. If `pre-commit` exceeds this, the policy
  is wrong; move the slow checks to `pre-push`.

### `pre-push` policy

- Run the full `npm test` suite.
- Run `npm audit --audit-level=high --omit=dev`.
- Reject the push on any failure.
- Time budget: 60 seconds. Use the smoke-install pack/install in
  CI, not on `pre-push`.

### Bypass

- Both hooks honour `--no-verify` because Git does, but the project
  policy is: do not push `--no-verify` without an explicit reason
  in the commit / PR body.

## Numbered improvements

Each improvement below is tagged and follows Evidence → Diagnosis →
Proposal → Migration → Rollout.

### T1. Create `ci.yml` running `npm test` on PRs — `P0 / S / low`

- **Evidence.** `.github/workflows/cr.yml` is the only workflow,
  and it is an LLM code-review bot, not a test runner.
- **Diagnosis.** PRs can merge with broken tests. This is the
  single biggest risk multiplier in the repo.
- **Proposal.** Land the `ci.yml` skeleton from the "CI
  improvements" section. Start with `test` and `lint` jobs only;
  add `audit`, `smoke-install`, `perf` in follow-up PRs.
- **Migration.** Single PR. Mark `test (ubuntu-latest / node 20)`
  and `lint` as required status checks once they have been green
  on `main` for 3 days.
- **Rollout.** Add a CI badge to README.

### T2. Stand up `src/test-support/` — `P0 / M / low`

- **Evidence.** `save-account-safety.test.ts` reimplements
  `encodeBase64Url`, `buildAuthSnapshot`, and tmp-dir setup in
  every file that needs them.
- **Diagnosis.** Duplication discourages new tests and silently
  diverges over time.
- **Proposal.** Create the layout from the "Fakes and fixtures"
  section. Start with `AuthFixture`, `RegistryFixture`,
  `FakeFetch`, `FakeClock`, `tmpHome` helper.
- **Migration.** Add `src/test-support/` and migrate one test
  file (`account-list-usage-refresh.test.ts`) to use it. Land in
  a second PR.
- **Rollout.** Mention in CONTRIBUTING.md once added.

### T3. Add `c8` coverage with global threshold 80/70 — `P0 / S / low`

- **Evidence.** No coverage tooling today.
- **Diagnosis.** Without coverage we cannot tell where the test
  pyramid is hollow.
- **Proposal.** Add `c8` to `devDependencies`, add
  `test:coverage` script, wire to CI, fail on global threshold
  miss.
- **Migration.** Land the tool first. The first run sets the
  baseline; bump the threshold gradually in follow-ups.
- **Rollout.** Coverage report uploaded as a CI artifact. Add a
  Codecov-or-equivalent badge if maintainers want public coverage
  history.

### T4. Split `save-account-safety.test.ts` into ≤ 300-line files — `P1 / M / low`

- **Evidence.** `src/tests/save-account-safety.test.ts` is 1772
  lines. Even with `node --test`'s isolation per-file, a single
  edit forces every reviewer to scroll for context.
- **Diagnosis.** The file mixes overwrite-policy tests, vault
  tests, symlink-materialization tests, and identity tests. They
  share fixture builders but not assertions.
- **Proposal.** Split into:
  - `overwrite-policy.integration.test.ts`
  - `snapshot-vault.integration.test.ts`
  - `symlink-materialization.integration.test.ts`
  - `identity-resolution.integration.test.ts`
- **Migration.** Move file-by-file behind a single PR. Use
  fixture builders from T2.
- **Rollout.** Internal cleanup; mention in release notes only as
  a maintenance note.

### T5. Add E2E harness with golden output diffs — `P1 / M / med`

- **Evidence.** No E2E tests today. Output-format regressions
  ship.
- **Diagnosis.** A CLI's stdout is its public API. Golden diffs
  are the cheapest way to detect drift.
- **Proposal.** Build `src/test-support/harness/cli-harness.ts`.
  Cover `--help`, `list` (empty / populated), `current`, `save →
  use → remove` end-to-end, `check` for each known posture.
- **Migration.** Land harness; add 3-5 golden tests; ratchet up
  over time.
- **Rollout.** Document `UPDATE_GOLDENS=1` flow in
  CONTRIBUTING.md.

### T6. Tests for `daemon`, `parallel`, `service-manager`, `kiro` — `P1 / L / med`

- **Evidence.** Four command files with zero direct test
  coverage.
- **Diagnosis.** These are the most platform-sensitive parts of
  the codebase; regressions show up only on the affected platform.
- **Proposal.** Per-command, write:
  - At least one integration test using fakes.
  - At least one E2E smoke test on each supported platform.
- **Migration.** One PR per command. `daemon` first; `parallel`
  next; `service-manager` after the fake OS adapter lands;
  `kiro` after T11 (Python test policy).
- **Rollout.** Update the gaps section of this document as each
  ships.

### T7. Property-based tests on percentage math and threshold logic — `P2 / S / low`

- **Evidence.** `registry.ts:16-21` clamps; `usage.ts` has
  `shouldSwitchCurrent`. Neither has property-based coverage.
- **Diagnosis.** Both are deterministic on simple types — perfect
  for `fast-check`.
- **Proposal.** Add `fast-check` to `devDependencies`. Write
  properties listed in "Property-based testing" section.
- **Migration.** One PR.
- **Rollout.** None needed.

### T8. Snapshot tests for rendered tables — `P2 / M / low`

- **Evidence.** Every command that renders a table is untested
  for output shape.
- **Diagnosis.** Output regressions discovered by users only.
- **Proposal.** Add `assertMatchesSnapshot`, capture fixtures
  for `list`, `status`, `current`, `forecast`, `savings`,
  `check`.
- **Migration.** One PR per command, paired with E2E tests from
  T5.
- **Rollout.** Document `UPDATE_SNAPSHOTS=1` flow.

### T9. Mutation testing on critical files — `P2 / M / low`

- **Evidence.** No mutation testing today.
- **Diagnosis.** Coverage tells us we *execute* a line; mutation
  tells us we *would notice* a change. For
  `registry.ts` / `auth-parser.ts` the latter matters.
- **Proposal.** Add Stryker. Target MSI ≥ 80 on the named files.
  Nightly run only.
- **Migration.** New devDependency; new config; new nightly job.
- **Rollout.** Report MSI in PRs that touch the targeted files.

### T10. Performance benchmarks and budgets — `P2 / M / med`

- **Evidence.** No measured latency for `list --details`; no
  measured RSS for the daemon.
- **Diagnosis.** Without baselines, regressions are invisible
  until they hurt enough to be reported.
- **Proposal.** Add `src/tests/perf/` with the scenarios listed
  in the "Performance tests" section. Advisory in CI for one
  minor; required after.
- **Migration.** New CI job; new directory; new helper.
- **Rollout.** Publish results as a CI artifact.

### T11. Resolve the Python test file — `P1 / S / low`

- **Evidence.** `src/tests/test_kiro_account_switcher.py` is
  never run by `npm test`.
- **Diagnosis.** Mixed-runtime test directories are confusing.
- **Proposal.** Convert to TypeScript (preferred) or move to
  `tests-python/` with its own CI job (acceptable).
- **Migration.** Single PR.
- **Rollout.** Note in release.

### T12. Fuzz the auth parser and registry sanitizer — `P2 / S / low`

- **Evidence.** Both functions take attacker-controlled bytes.
- **Diagnosis.** Today's negative tests are hand-written; fuzz
  would surface unknowns.
- **Proposal.** Add `fast-check`-based fuzz targets under
  `src/tests/fuzz/`. Run in nightly CI.
- **Migration.** One PR.
- **Rollout.** None.

### T13. Pre-commit / pre-push hooks — `P2 / S / low`

- **Evidence.** No `.githooks/` today.
- **Diagnosis.** Cheap to add; pays back in fewer red PRs.
- **Proposal.** Land `.githooks/pre-commit` and
  `.githooks/pre-push` from the policy section. Opt-in via
  `CONTRIBUTING.md`; do not auto-install.
- **Migration.** One PR. Document the opt-in.
- **Rollout.** Reference from PR template.

### T14. Smoke install on the published tarball — `P1 / S / low`

- **Evidence.** No CI test verifies that `npm pack && npm i -g
  <tarball>` works on a fresh box.
- **Diagnosis.** Publish-time regressions (e.g. missing files
  from the `files` array, broken postinstall) ship.
- **Proposal.** Add the `smoke-install` job from "CI
  improvements". Set `CODEX_AUTH_SKIP_POSTINSTALL=1` to avoid the
  interactive hook prompt.
- **Migration.** Land alongside T1.
- **Rollout.** Required check.

### T15. HTTP record/replay codification — `P2 / S / low`

- **Evidence.** `account-list-usage-refresh.test.ts` uses a hand-
  rolled fake fetch.
- **Diagnosis.** Each new HTTP test reinvents the harness.
- **Proposal.** Codify `FakeFetch.fromFixture` and migrate the
  existing test to use it.
- **Migration.** One PR.
- **Rollout.** None.

## Anti-goals

These are testing patterns we explicitly do not adopt.

1. **Live provider calls in CI.** Never hit `chatgpt.com` or any
   real provider endpoint from CI. All HTTP is faked or replayed.
2. **Test-only code in production paths.** No
   `if (process.env.NODE_ENV === "test")` branches in `src/lib/` or
   `src/commands/`. Dependency injection or seam exports only.
3. **Shared mutable test state.** Each `test()` owns its own tmp
   dir and its own fixture state. No `before(all)` shared mutable.
4. **Snapshot tests as the sole assertion.** Snapshots catch
   *changes* but do not state *intent*. Always pair a snapshot
   assertion with at least one prose assertion.
5. **Skipping flaky tests indefinitely.** A `t.skip` without a
   tracking issue is a bug. Pre-commit grep blocks new `t.skip`
   without an attached `// owner: @x, due: YYYY-MM-DD`.
6. **Coverage-only tests.** Tests that exist solely to bump a
   coverage number with no behavioural assertion are rejected at
   review.
7. **Custom assertion libraries.** Stick to `node:assert/strict`.
   No `chai`, no `jest-extended`. Helpers in `src/test-support/`
   should compose `assert.*`, not replace it.

## Appendix A — Test naming examples

Good:

```ts
test("saveAccount refuses to overwrite a different identity by default", ...);
test("saveAccount overwrites a different identity when force=true", ...);
test("loadRegistry returns defaults when the file is malformed JSON", ...);
test("daemon does not switch when usage is below threshold", ...);
test("daemon switches to the next eligible account when threshold is crossed", ...);
```

Bad:

```ts
test("saveAccount works", ...);            // says nothing
test("test1", ...);                        // numbered placeholder
test("regression for #42", ...);           // future readers don't have #42
test("integration", ...);                  // not a behavior
test("AccountService.save", ...);          // describes target, not behavior
```

## Appendix B — Fixture catalogue (seed)

The following fixtures should exist after T2 lands. Each lives at
the path indicated, with a one-line comment at the top describing
the scenario.

- `src/tests/fixtures/auth/chatgpt-plus.json`
- `src/tests/fixtures/auth/chatgpt-business.json`
- `src/tests/fixtures/auth/chatgpt-pro.json`
- `src/tests/fixtures/auth/codex-apikey.json`
- `src/tests/fixtures/auth/malformed-missing-tokens.json`
- `src/tests/fixtures/auth/malformed-bad-jwt.json`
- `src/tests/fixtures/auth/malformed-extra-fields.json`
- `src/tests/fixtures/auth/symlinked-to-other.json` (paired with a
  small README explaining the symlink target setup at test time)
- `src/tests/fixtures/registry/empty.json`
- `src/tests/fixtures/registry/three-accounts.json`
- `src/tests/fixtures/registry/active-account-missing.json`
- `src/tests/fixtures/registry/thresholds-out-of-range.json`
- `src/tests/fixtures/http/usage-fresh.json`
- `src/tests/fixtures/http/usage-stale.json`
- `src/tests/fixtures/http/usage-exhausted.json`
- `src/tests/fixtures/http/usage-401.json`
- `src/tests/fixtures/http/usage-500.json`
- `src/tests/fixtures/http/proxy-accounts-multi.json`
- `src/tests/fixtures/render/list/empty.txt`
- `src/tests/fixtures/render/list/three-accounts.txt`
- `src/tests/fixtures/render/list/details.txt`
- `src/tests/fixtures/render/current/active.txt`
- `src/tests/fixtures/render/current/no-active.txt`
- `src/tests/fixtures/render/check/healthy.txt`
- `src/tests/fixtures/render/check/insecure-perms.txt`

## Appendix C — CI cost estimate

Rough order-of-magnitude estimates for the proposed CI matrix on
GitHub-hosted runners. Numbers will move as the test suite grows.

| Job                                     | Duration | Per-PR cost (cost-unit minutes) |
| --------------------------------------- | -------- | ------------------------------- |
| `test (ubuntu-latest / node 18)`        | 90 s     | 1.5                             |
| `test (ubuntu-latest / node 20)`        | 90 s     | 1.5                             |
| `test (ubuntu-latest / node 22)`        | 90 s     | 1.5                             |
| `test (macos-latest / node 20)`         | 180 s    | 30  (10× multiplier)            |
| `test (windows-latest / node 20)`       | 240 s    | 8   (2× multiplier)             |
| `lint`                                  | 30 s     | 0.5                             |
| `audit`                                 | 30 s     | 0.5                             |
| `smoke-install (ubuntu-latest)`         | 60 s     | 1.0                             |
| `smoke-install (macos-latest)`          | 90 s     | 15  (10× multiplier)            |
| `smoke-install (windows-latest)`        | 120 s    | 4   (2× multiplier)             |
| `perf` (advisory, one platform)         | 120 s    | 2.0                             |
| **Total per PR**                        | ~12 min  | ~65 cost-units                  |

These costs are within the free-tier budget for an MIT project of
this size. Mutation and soak jobs run on a schedule, not per PR.

## Appendix D — Migration order

The recommended order for landing the testing improvements, optimized
for "biggest safety net first":

1. **T1** — CI runs `npm test` on PRs. (Without this, nothing else
   matters.)
2. **T14** — smoke install on every PR.
3. **T3** — `c8` coverage with a baseline.
4. **T11** — resolve the Python test orphan.
5. **T2** — stand up `src/test-support/`.
6. **T4** — split `save-account-safety.test.ts`.
7. **T5** — E2E harness with goldens.
8. **T6** — tests for `daemon`, `parallel`, `service-manager`,
   `kiro`.
9. **T8** — snapshot tests for rendered tables.
10. **T15** — codify HTTP record/replay.
11. **T7** — property-based tests on math.
12. **T12** — fuzzing.
13. **T9** — mutation testing on critical files.
14. **T10** — performance benchmarks and budgets.
15. **T13** — pre-commit / pre-push hooks.

Items 1-4 should land before any new feature work. Items 5-9 can
ride alongside feature PRs. Items 10-15 are polish.

## Appendix E — How this document evolves

- When a numbered improvement (T1, T2, …) lands, add `Status: Shipped
  in vX.Y.Z` at the top of its block — do not delete the block.
- When a new gap is discovered, add it to the "Gaps" section with a
  new T-number and a Proposal block. Do not let "TODO" notes
  accumulate elsewhere.
- When CI cost estimates drift by > 2× the table in Appendix C,
  update the table in the same PR that changes the matrix.
- When a flaky test is quarantined, list it in this document under
  a new "Quarantined tests" section with owner and due date. If
  the section grows past three entries, raise a meta-issue.
