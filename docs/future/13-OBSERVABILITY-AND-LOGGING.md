# 13 — Observability and Logging

This file specifies the observability story for `authmux`: structured
logging, on-disk diagnostics, a one-shot support bundle, opt-in telemetry,
optional Prometheus metrics for the daemon, and OpenTelemetry tracing.

Cross-references: release/distribution context for log-related deprecations
is in `docs/future/12-RELEASE-AND-DISTRIBUTION.md`; cross-platform
log-path conventions are in `docs/future/14-CROSS-PLATFORM.md`; secret
handling is in `docs/future/06-SECURITY-AND-SECRETS.md`.

## Current

### Logging

`authmux` does not have a logger. Every command uses oclif's `this.log` /
`this.warn` / `this.error`, which are thin wrappers around `process.stdout`
and `process.stderr`. Representative call sites:

- `src/commands/list.ts:35`, `41`, `50`, `56`–`60`, `89`, `99`, `105`
- `src/commands/update.ts:42`, `50`, `53`, `59`–`67`, `79`, `87`, `91`
- `src/commands/save.ts:43`
- `src/commands/parallel.ts:60`, `64`–`90`, `108`–`141`
- `src/hooks/init/update-notifier.ts:31`, `48`, `50`
- `src/lib/base-command.ts:21` (`this.error(error.message)`)

There are no `console.log` calls anywhere under `src/` outside test files,
which is good — the surface is concentrated in oclif primitives. But there
is also no log level, no structured shape, no log file, no rotation, no
correlation id, and no per-module logger. A user reporting "switch
sometimes shows the wrong account" has no log file to attach.

### Daemon

`src/commands/daemon.ts` runs `accounts.runDaemon("watch")` or
`runDaemon("once")`. The `watch` variant runs indefinitely. When started
by `systemctl --user start authmux-autoswitch.service`
(`src/lib/accounts/service-manager.ts:50`–`69`), stdout and stderr go to
the user's `journald`. When started by macOS `launchd`, stdout/stderr go
nowhere — the plist in `service-manager.ts:95`–`117` does not set
`StandardOutPath` / `StandardErrorPath`. On Windows, the scheduled task
defined at `service-manager.ts:147`–`163` runs `cmd /c authmux daemon
--watch` with no redirection. A daemon failure on macOS or Windows leaves
zero forensic trail.

### Cache files

The update-check cache (`src/lib/update-check.ts:37`–`71`) writes
`<accountsDir>/update-check.json` with a 4-field record. That is the only
persistent file authmux currently writes for its own operational use
besides snapshots, registry, sessions, and snapshot backups
(`src/lib/config/paths.ts:45`–`60`).

### Diagnostics

There is no `authmux diag` command. `authmux status`
(`src/commands/status.ts`) prints managed-service state, auto-switch
configuration, and active thresholds (per README §"Managed background
service"). That is the closest existing surface to a diagnostic command,
but it does not include version, platform, paths, log tail, or registry
shape.

### Telemetry

None. No network calls beyond the npm registry version check
(`update-check.ts:175`) and provider HTTPS calls when API mode is enabled.

### Metrics

None. The daemon does not expose any introspection endpoint.

### Tracing

None.

## Goals

Any observability story for `authmux` must satisfy these constraints, in
order:

1. **Never leak secrets.** Auth tokens, refresh tokens, account JWTs, and
   cookies must never enter a log file, a support bundle, or a telemetry
   payload. This is the dominant constraint.
2. **Be useful in user-reported bugs.** A user pasting `authmux diag`
   output and (optionally) a `support-bundle` should let a maintainer
   reconstruct the failure without further back-and-forth in 80% of
   cases.
3. **Be low overhead.** The CLI's hot path is `authmux use` and `authmux
   list`; the logger must not add measurable latency to either. The
   daemon tick must not allocate growing logger state.
4. **Be no-network by default.** Telemetry is strictly opt-in. Logging
   writes only to local files.
5. **Be platform-honest.** Log paths follow XDG on Linux, `Library/Logs`
   on macOS, `%LOCALAPPDATA%` on Windows. See doc 14.
6. **Be self-rotating.** No tooling required. Bounded disk footprint.
7. **Be deterministic in tests.** The logger must accept an injected
   clock and an injected sink so unit tests can assert exact output.

## Proposal

### Logger contract (P0, M)

Introduce `src/lib/log/logger.ts`. No new runtime dependencies.

```ts
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;             // ISO 8601, UTC, millisecond precision
  level: LogLevel;
  module: string;         // e.g. "account-service.save"
  msg: string;            // short, human-readable, no PII
  // Structured fields. Values are stringified or JSON-safe. Never include
  // tokens. The redactor below scrubs any value whose key matches a
  // sensitive name.
  [key: string]: unknown;
}

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(module: string): Logger;
}

export interface LoggerSink {
  write(record: LogRecord): void;
  flush(): Promise<void>;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  module: string;
  sinks: LoggerSink[];
  now?: () => Date;
}
```

Implementation rules:

1. `child(module)` returns a logger that prepends the parent module name
   with a `.` separator. The bus is flat — there is no logger hierarchy
   beyond name concatenation.
2. Every method short-circuits when the record's level is below the
   configured threshold, *before* allocating the record object. The hot
   path for a disabled level must be a single integer comparison.
3. `error` records always include a `stack` field if an `Error` is in
   the fields under key `err`. The redactor never strips `stack`.
4. Records produced by `error` and `warn` always go to *every* sink even
   if a sink's per-sink threshold is higher. This guarantees the on-disk
   per-run file always contains all warnings and errors regardless of
   pretty-print verbosity.
5. The default level is `info`. Override by env var
   `AUTHMUX_LOG_LEVEL=debug` (or any valid level), and by per-module
   override `AUTHMUX_LOG_LEVEL_<module>=debug` where module is uppercased
   with `.` → `_` (e.g. `AUTHMUX_LOG_LEVEL_ACCOUNT_SERVICE_SAVE=trace`).

### Format (P0, S)

Two output formats, selected by `AUTHMUX_LOG_FORMAT`:

- `pretty` (default for TTY stderr): one line per record:
  ```
  2026-05-17T14:32:18.123Z INFO  account-service.save name=work email=*** snapshot=ok
  ```
  Level is colored on TTY only. Module name is padded to a stable width
  (truncate to 36 chars, no wrapping). Fields are appended in insertion
  order, `key=value`. Strings with whitespace are JSON-quoted.

- `json`: one record per line, RFC 8259 JSON:
  ```json
  {"ts":"2026-05-17T14:32:18.123Z","level":"info","module":"account-service.save","msg":"snapshot=ok","name":"work","email":"***"}
  ```

The on-disk file sink always uses `json`. The stderr sink uses the
TTY-driven default unless overridden.

### Redaction (P0, M)

`src/lib/log/redact.ts`. A deterministic, side-effect-free function:

```ts
const SENSITIVE_KEY_RE =
  /^(token|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|cookie|set[-_ ]?cookie|authorization|bearer|api[-_ ]?key|secret|password|client[-_ ]?secret|session(?!.*key)|jwt)$/i;

export function redact(value: unknown, keyPath: string[] = []): unknown {
  // 1. If the immediate key (last segment of keyPath) matches
  //    SENSITIVE_KEY_RE, return "***".
  // 2. For strings, scan for JWT-like patterns
  //    (/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/) and replace
  //    with "***".
  // 3. For arrays, redact each element.
  // 4. For plain objects, recurse with extended keyPath.
  // 5. Otherwise return value unchanged.
}
```

Rules:

- Redaction runs once, in the sink's `write()`, not in each command.
- Redaction is **mandatory** on the file sink and the telemetry sink. It
  is **opt-out** on the stderr sink (set `AUTHMUX_LOG_REDACT=off` to
  disable, intended only for developer debugging).
- Email addresses are not redacted by default. They are not secrets in
  this codebase — `authmux list` already prints them. They *are* redacted
  in telemetry payloads (see below).
- Account names are not redacted; the user typed them.

### Per-run file sink (P0, M)

`src/lib/log/file-sink.ts`. Behavior:

1. Path: `<XDG_STATE_HOME>/authmux/logs/run-<utc-iso-compact>-<pid>.log`.
   - XDG resolution uses `$XDG_STATE_HOME` if set, else
     `$HOME/.local/state`. See doc 14 for macOS/Windows mapping.
   - `utc-iso-compact` is `YYYYMMDDTHHMMSSZ`.
2. The file is opened lazily on the first non-trace record.
3. `write()` appends a single line and a `\n`. Buffered through a
   `WriteStream` with `highWaterMark` of 64KB.
4. `flush()` awaits drain. Called from `BaseCommand`'s shutdown path
   and from the daemon's loop tick.
5. On process exit, the sink registers a `process.on("exit")` handler
   that performs a synchronous best-effort flush via `fs.writeSync` for
   any unflushed buffer. This is the only synchronous I/O in the logger.

### Rotation (P0, S)

`src/lib/log/rotator.ts`. On logger creation:

1. List files matching `run-*.log` under the log dir.
2. Sort by mtime ascending.
3. Delete the oldest until at most `AUTHMUX_LOG_KEEP_FILES` remain
   (default 50).
4. Also enforce a total size cap of `AUTHMUX_LOG_MAX_BYTES` (default
   50 MiB) using the same age-based eviction.

The rotation cost is O(N) in number of files, paid once at startup.
Daemons that run for weeks must re-rotate every 6h; schedule the rotator
to run from the daemon's existing tick rather than a separate timer.

### Daemon log sink (P0, M)

`src/lib/log/daemon-sink.ts`. Distinct from the per-run sink:

1. Path: `<XDG_STATE_HOME>/authmux/logs/daemon.log`, plus rotated
   `daemon.log.1` through `daemon.log.5`.
2. Rotate when the active file crosses 5 MiB. Rotation renames
   `daemon.log → daemon.log.1`, shifts older numbered files up, and
   deletes anything beyond `.5`.
3. On systemd, the existing journald sink stays in place; the file sink
   is additive, not a replacement. Journald is the right tool for
   structured query (`journalctl --user -u authmux-autoswitch`), but
   most users do not know how to use it, and the file is what
   `support-bundle` will grab.
4. On macOS, update the LaunchAgent plist in `service-manager.ts:95` to
   add `StandardOutPath` / `StandardErrorPath` pointing at
   `~/Library/Logs/authmux/daemon-stdio.log`. This is a one-line plist
   addition; see doc 14 for the exact patch.
5. On Windows, redirect via the scheduled task command:
   `cmd /c authmux daemon --watch >> "%LOCALAPPDATA%\authmux\logs\daemon-stdio.log" 2>&1`.
   The file sink continues to write structured records; the stdio file
   captures any pre-logger output and uncaught exceptions.

### BaseCommand integration (P0, S)

`src/lib/base-command.ts` currently has `this.error(error.message)` at
line 21. Extend `BaseCommand`:

1. Construct a per-invocation logger child with `module = cli.<command-id>`.
2. Generate a `runId = crypto.randomUUID()` and attach it to every record
   via a child logger field.
3. Log a `cli.invoke` record at info level on entry with fields
   `{ argv, version, platform, nodeVersion }` (no env, no cwd).
4. Log a `cli.exit` record at info level on exit with `{ exitCode,
   durationMs }`.
5. On unhandled error, log `cli.error` with `{ err }` before re-throwing
   to oclif.
6. Replace `this.log` / `this.warn` / `this.error` call sites
   incrementally — they should remain the user-facing stdout/stderr
   path, but every meaningful event should also call the logger.

### Module logger naming (P0, S)

Adopt this naming scheme for child loggers:

| Module | Logger name |
| --- | --- |
| Per-command entry | `cli.<command-id>` (e.g. `cli.use`, `cli.update`) |
| Account service writes | `account-service.save`, `account-service.use`, `account-service.remove` |
| Registry IO | `registry.read`, `registry.write` |
| Sessions IO | `sessions.read`, `sessions.write` |
| Daemon | `daemon.start`, `daemon.tick`, `daemon.shutdown` |
| Provider HTTP | `provider.codex.fetch`, `provider.kiro.fetch` |
| Update check | `update.check`, `update.install` |
| Shell hook | `hook.install`, `hook.remove`, `hook.refresh` |
| Postinstall | `postinstall.detect`, `postinstall.prompt`, `postinstall.write` |

Names are stable identifiers — they appear in user log files and in
support reports. Treat a rename as a deprecation event (doc 12).

### Latency budget (P1, S)

Each command must honor a published latency budget:

| Command | p50 budget | p99 budget |
| --- | --- | --- |
| `authmux use <name>` | 30ms | 150ms |
| `authmux current` | 10ms | 50ms |
| `authmux list` (no `--details`) | 50ms | 250ms |
| `authmux list --details` | 200ms | 800ms |
| `authmux save <name>` | 50ms | 300ms |
| `authmux daemon --once` | 1s | 5s |

`cli.exit` records include `durationMs`, so a maintainer can aggregate
across a user-provided log file and confirm whether a slowness report is
real. If the daemon tick consistently exceeds 5s, that is an SLO breach
and warrants an issue (see § SLOs below).

### Migration

1. Land the logger, sinks, redactor, and rotator behind no
   user-visible behavior change. Default `info` level to the file sink;
   stderr sink stays off until a command opts in.
2. Wire `BaseCommand.cli.invoke` / `cli.exit` first. This produces useful
   data immediately without changing any user-visible output.
3. Migrate `daemon` next, because that is where the absence of logs
   hurts most.
4. Migrate provider HTTP calls third; they are the source of most
   intermittent failures.
5. Migrate the remaining commands opportunistically when they are
   touched for other reasons.

### Rollout

The logger is a strict addition. There is no migration risk for users.
The only behavior change is the appearance of files under
`~/.local/state/authmux/logs/`. Document the location in the README and
in `authmux diag` output.

## `authmux diag` (P0, M)

A new command for fast diagnostics. Output is plain text, copy-pasteable
into a GitHub issue. All sensitive fields are redacted.

### Output shape

```
authmux diag — 2026-05-17T14:32:18Z
─────────────────────────────────────
version          : 0.1.24
node             : v20.11.0
platform         : linux x64 (kernel 6.18.5)
shell            : /bin/zsh

paths
  codex dir      : /home/user/.codex
  accounts dir   : /home/user/.codex/accounts
  registry       : /home/user/.codex/accounts/registry.json
  sessions       : /home/user/.codex/accounts/sessions.json
  log dir        : /home/user/.local/state/authmux/logs
  update cache   : /home/user/.codex/accounts/update-check.json

accounts         : 3 saved, 1 active (***)
hook             : installed in /home/user/.zshrc
service          : active (systemd user, authmux-autoswitch.service)
auto-switch      : enabled, 5h=10% weekly=5%
usage source     : api
update channel   : latest
update cache age : 3h22m (latest=0.1.24, current=0.1.24, status=up-to-date)

env (relevant)
  CODEX_AUTH_SKIP_POSTINSTALL : unset
  CODEX_AUTH_SKIP_TTY_RESTORE : unset
  CODEX_AUTH_ACCOUNTS_DIR     : unset
  AUTHMUX_LOG_LEVEL           : unset
  AUTHMUX_LOG_FORMAT          : unset
  AUTHMUX_TELEMETRY           : unset

last 200 log lines (redacted) — /home/user/.local/state/authmux/logs/run-...
... <records> ...
```

### Rules

- Account names are masked to `***` unless `--show-names` is passed.
  Counts and active-account marker remain visible.
- Email addresses are *not* shown in `diag` output (unlike `authmux
  list`). Users who want them in the report can rerun with
  `--show-emails`.
- The "env (relevant)" section lists only the env vars that authmux
  consumes (5 from `src/lib/config/paths.ts`, plus
  `CODEX_AUTH_SKIP_POSTINSTALL`, `CODEX_AUTH_SKIP_TTY_RESTORE`,
  `CODEX_AUTH_SESSION_KEY`, `CODEX_AUTH_FORCE_EXTERNAL_SYNC`, and the
  `AUTHMUX_LOG_*` and `AUTHMUX_TELEMETRY` variables). Never dump
  `process.env` wholesale — it routinely contains tokens for unrelated
  tools.
- The log tail is the last 200 lines from the most recent `run-*.log`,
  passed through the same redactor used by the file sink. The redactor
  is run a second time on the rendered output as belt-and-suspenders.
- The command exits 0 if it can produce output, regardless of whether
  any component is in an error state. Errors *about* the diag command
  itself exit 1.

### Implementation pointer

`src/commands/diag.ts`, ~120 lines. Uses `getManagedServiceState()`
(`src/lib/accounts/service-manager.ts:214`), `accountService.list()`,
`fetchLatestNpmVersionCached` (`src/lib/update-check.ts:222`) with a
zero-timeout fetcher to read only the cached value.

## `authmux support-bundle` (P1, M)

A one-shot command that produces a single zip file the user can attach to
a bug report.

### Contents

```
authmux-support-<utc-iso-compact>.zip
├── diag.txt                  ← `authmux diag --show-emails` output, redacted
├── version.json              ← { version, node, platform, arch, kernel }
├── logs/
│   ├── run-<latest>.log      ← most recent 5 runs
│   ├── ...
│   └── daemon.log            ← current daemon log
├── registry.shape.json       ← structural shape of registry.json, no tokens
├── sessions.shape.json       ← shape of sessions.json, no PIDs > 1000
├── service/
│   ├── linux-unit.txt        ← contents of the systemd user unit, if any
│   ├── mac-plist.xml         ← contents of the LaunchAgent plist, if any
│   └── windows-task.txt      ← `schtasks /Query /TN ... /V /FO LIST` output
└── env.txt                   ← redacted env subset, same shape as `diag`
```

### `registry.shape.json` definition

For each account row in `registry.json`, emit:

```json
{
  "name": "***",
  "hasEmail": true,
  "hasAccountId": true,
  "hasUserId": true,
  "hasUsage": true,
  "lastUsedAt": "2026-05-17T14:00:00Z",
  "snapshotBytes": 4321
}
```

Never include the actual email, account id, user id, or any token-bearing
fields. The shape is enough to debug "I have 4 accounts and authmux only
shows 3" without exposing identity.

### CLI surface

```
authmux support-bundle [--out <path>] [--include-logs <n>] [--include-emails]
```

`--include-emails` is opt-in and warned about. `--include-logs` defaults
to 5; cap at 20 to keep bundle sizes manageable.

### Implementation pointer

Use `node:zlib` and `node:fs` only — no `archiver` dependency. Write a
minimal ZIP writer (~120 LOC) supporting STORE and DEFLATE methods. The
bundle is small enough that streaming is unnecessary.

## Opt-in telemetry (P2, L)

### Default

**Off.** No telemetry data leaves the user's machine unless the user
explicitly opts in.

### Opt-in flow

```sh
authmux config telemetry enable [--endpoint <url>]
authmux config telemetry disable
authmux config telemetry status
```

Stored in `<accountsDir>/telemetry.json`:

```json
{
  "version": 1,
  "policy": "enabled",
  "endpoint": "https://telemetry.authmux.dev/v1/events",
  "installId": "<uuid v4 generated once at enable time>",
  "enabledAt": "2026-05-17T14:32:18Z"
}
```

### Per-org disable

`AUTHMUX_TELEMETRY=off` (any of `0|false|no|off`) hard-disables telemetry
regardless of the on-disk policy. Organizations can ship this in
`/etc/environment` or in their CI base image. The disable wins; an admin
can never be silently overridden by a user re-enabling locally if the env
var is set.

### Event schema

Strictly versioned. Schema lives at `docs/telemetry/v1.json` and is
linked from this doc.

```json
{
  "schema": 1,
  "ts": "2026-05-17T14:32:18.123Z",
  "installId": "<uuid>",
  "sessionId": "<uuid per process>",
  "event": "cli.invoke" | "cli.exit" | "switch.success" |
           "switch.failure" | "daemon.tick" | "update.installed" |
           "update.declined" | "hook.installed" | "hook.removed",
  "version": "0.1.24",
  "platform": "linux" | "darwin" | "win32",
  "arch": "x64" | "arm64",
  "nodeMajor": 20,
  "fields": {
    "command": "use",
    "durationMs": 28,
    "exitCode": 0,
    "accountCount": 3,
    "serviceState": "active"
  }
}
```

### What is never in telemetry

- Account names
- Emails
- Account ids / user ids
- File system paths (any path on disk)
- Token values, even hashed
- Hostnames, IP addresses, MAC addresses
- Free-form error messages (only an `errorClass` taxonomy is sent —
  e.g. `RegistryReadError`, `ProviderHttpTimeout`)
- Anything from `process.env`

The redactor used for logs is run on every telemetry payload as a
defense-in-depth measure even though the schema explicitly forbids
secrets.

### Transport

POST JSON to `endpoint`, batch up to 32 events or 10s, whichever first.
Best-effort — failures are silently dropped after a single retry. No
queue persistence — telemetry that does not deliver is forgotten. The
user is paying for nothing.

### Self-host

The `--endpoint` flag accepts any HTTPS URL. Organizations that want
internal telemetry only can run a tiny receiver (a `tcollector`-style
sink, ~50 LOC) and point all their authmux installs at it.

### Migration

1. Land the config command and storage. Schema is on disk but the
   transmitter does nothing until v2 of this feature.
2. Land the transmitter behind a feature flag.
3. Document the schema in the repo and link from the README.
4. Enable transmission only after a full minor cycle with the feature
   flag, so the schema can change safely.

### Rollout

The first published telemetry-enabled release must include a
`releases/vX.Y.Z.md` `## Telemetry` section explicitly stating: what is
collected, what is not, how to opt out, how to self-host, how to delete
already-sent data (by `installId`).

## Metrics for power users (P2, M)

### Prometheus exposition

`authmux daemon --watch --metrics-addr 127.0.0.1:9119` opens an HTTP
listener exposing `/metrics` in Prometheus text format.

Bind defaults to localhost only. Refuse to bind to `0.0.0.0` without an
explicit `--metrics-bind-all` flag and a `AUTHMUX_ALLOW_UNAUTHED_METRICS=1`
env var, because there is no auth on the endpoint and an exposed
listener would leak account counts and switch frequencies to anyone on
the network.

### Metrics

| Name | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `authmux_build_info` | gauge | `version`, `node`, `platform` | Always 1, info-only |
| `authmux_accounts_total` | gauge | none | Number of saved accounts |
| `authmux_account_active` | gauge | `name` | 1 for active account, 0 for others. Names are hashed (sha256 truncated to 8 hex) unless `--metrics-show-names` |
| `authmux_daemon_tick_total` | counter | `result` (`ok`/`error`) | Daemon tick count |
| `authmux_daemon_tick_duration_seconds` | histogram | none | Tick latency |
| `authmux_switch_total` | counter | `reason` (`manual`/`auto`/`hook`/`session`) | Account switches |
| `authmux_provider_request_total` | counter | `provider`, `result` | Provider HTTP requests |
| `authmux_provider_request_duration_seconds` | histogram | `provider` | Provider latency |
| `authmux_log_records_total` | counter | `level`, `module` | Records written |
| `authmux_redaction_total` | counter | `kind` (`key`/`jwt`/`other`) | Redactions performed — a redaction count climbing rapidly is itself a signal |

### Implementation

`src/lib/metrics/registry.ts`, ~250 LOC, with a small Prometheus text
formatter. No `prom-client` dependency; the surface is small enough that
the formatter is two functions.

### Migration

The metrics endpoint is purely additive. Users who do not pass
`--metrics-addr` see no behavior change. Document it in the daemon
help text.

### Rollout

The first release with `/metrics` must include an example Grafana
dashboard JSON under `docs/observability/grafana-daemon.json`. The
README's "Managed background service" section gains a short subsection
linking to it.

## Tracing (P3, M)

### OpenTelemetry exporter

Behind `AUTHMUX_OTLP_ENDPOINT=<url>`. When set, the BaseCommand starts a
span around `runSafe`, the account service starts spans around `save`,
`use`, `remove`, the daemon tick is a span, and provider HTTP calls are
client spans.

### Why not on by default

OpenTelemetry SDK is large and adds startup cost. CLI invocations are
short-lived; the export flush has to happen before exit, which adds
shutdown latency. Make it strictly opt-in for advanced users
debugging production issues, not the default.

### Implementation

Use `@opentelemetry/api` (peer dep) + `@opentelemetry/sdk-node` (loaded
lazily only when the env var is set). Spans must redact attribute
values the same way log fields are redacted.

## SLOs

Track these SLOs as numbers in `docs/observability/slos.md`. Reproducing
them here so they live next to the metric definitions that prove them.

| SLO | Target | Window | Alert |
| --- | --- | --- | --- |
| `authmux use` p99 latency | < 150ms | 7d rolling | Page maintainers if > 250ms |
| `authmux list` p99 latency | < 250ms | 7d rolling | Issue if > 500ms |
| `daemon.tick` p99 latency | < 5s | 7d rolling | Issue if > 15s |
| Daemon uptime (managed service) | > 99% over 30d | 30d | Issue if < 95% |
| `provider.codex.fetch` success rate | > 98% | 7d | Issue if < 95% — could be upstream |
| `cli.error` rate | < 0.5% of invocations | 7d | Issue if > 2% |
| Log volume per CLI invocation | < 4 KiB at info level | n/a | PR review concern if any commit raises baseline |

SLOs are aspirational on day one — the project has no telemetry pipeline
to measure them. They become enforceable once metrics land and a
maintainer-operated test fleet runs them. The numbers are useful even as
guard rails for code review: a PR that obviously inflates the daemon
tick by 10x should be questioned without needing a dashboard.

## Open questions

1. Should the log dir live under `<accountsDir>` instead of XDG state?
   Argument for: discoverability — users already know the accounts dir.
   Argument against: logs and credentials should not share a parent so
   that "share my log file" is never accidentally "share my credentials
   file". Recommend XDG state.
2. Should we adopt `pino` instead of a custom logger? `pino` is fast and
   battle-tested but adds a dependency and ships its own opinionated
   transport story. The current proposal keeps zero deps and matches
   `authmux`'s minimal-dependency philosophy (see `package.json:50`–`58`:
   only `@oclif/core`, `prompts`, `tslib`, `typescript`). Decision:
   custom logger.
3. Should telemetry default change from off to opt-out after a year? No.
   Opt-in stays opt-in. The project's value proposition is local
   credential management; default telemetry would be a betrayal of that.
4. Should `support-bundle` redact account *counts*? No — counts are
   needed to debug "list shows 3 but I have 4". Bucket the count by
   power-of-two if telemetry-bound but ship exact counts in support
   bundles since those are user-shared, not auto-sent.
5. Should the daemon also expose `/healthz`? Yes, free with the metrics
   listener, returns 200 if last tick was within `2 * tickInterval`,
   else 503. Useful for systemd `WatchdogSec=` integration.

## Acceptance for this slice

- `src/lib/log/*` exists, has 95%+ test coverage on redaction,
  rotation, and level-filter hot paths.
- `BaseCommand` emits `cli.invoke` and `cli.exit` for every command.
- Daemon writes structured records to `daemon.log` on all three OSes.
- `authmux diag` exists and is referenced from `README.md` under a
  "Reporting bugs" subsection.
- `authmux support-bundle` exists, produces a zip ≤ 1 MiB for a typical
  user, and never includes raw tokens (verified by a unit test that
  inserts a synthetic token into a fixture log and asserts the bundle
  contains only `***`).
- Telemetry remains off by default. The schema is published.
- Prometheus `/metrics` is documented and exposes the metrics in the
  table above.
- SLOs are tracked in `docs/observability/slos.md` even before they are
  enforceable, and PR reviewers cite them when reviewing latency-
  affecting changes.
