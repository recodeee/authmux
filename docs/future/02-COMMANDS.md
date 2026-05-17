# 02 — Commands: `--json` schema reference

Status: in progress.

This file is the JSON-schema reference for every command that supports the
`--json` flag. The full command audit (one section per command, with human
output, flag table, exit-code behavior, examples) is out of scope for the
X4 roadmap item — that ships under a later doc-only PR. The X4 exit
criteria require this file to **list the JSON schema for each command**,
which is what this file does and nothing more.

All `--json` output follows the envelope shape defined in
`src/lib/cli/json-envelope.ts`:

```ts
type Envelope<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: ErrorCode;       // see src/lib/accounts/errors.ts
        severity: "fatal" | "warn" | "info";
        message: string;
        hint?: string;
        details?: Record<string, unknown>;
      };
    };
```

`ErrorCode` enumerates the §6.2 allowlist (see
`01-ARCHITECTURE.md`). Exit codes follow the §6.3 table — see
`exitCodeForErrorCode` in `json-envelope.ts`.

## Core read commands (Theme N3)

### `authmux list --json`

```ts
{
  ok: true;
  data: {
    accounts: Array<{
      name: string;
      active: boolean;
      email?: string;
      accountId?: string;
      userId?: string;
      planType?: string;
      lastUsageAt?: string;
      usageSource?: "api" | "local" | "cached" | "proxy";
      remaining5hPercent?: number;
      remainingWeeklyPercent?: number;
    }>;
    detailed: boolean;
  };
}
```

### `authmux current --json`

```ts
{ ok: true; data: { active: string | null } }
```

### `authmux status --json`

```ts
{
  ok: true;
  data: {
    autoSwitchEnabled: boolean;
    serviceState: "active" | "inactive" | "unknown";
    threshold5hPercent: number;
    thresholdWeeklyPercent: number;
    usageMode: "api" | "local";
  };
}
```

### `authmux use <account> --json`

```ts
{
  ok: true;
  data: {
    activated: string;
    kiro: {
      attempted: boolean;
      switched: boolean;
      active: string | null;
      reason: string | null;
    };
  };
}
```

Under `--json`, `authmux use` (no positional argument) does **not**
prompt; it returns `{ ok: false, error: { code: "E_PROMPT_CANCELLED", ... } }`
so the caller can supply the name explicitly.

### `authmux save [name] --json`

```ts
{
  ok: true;
  data: {
    saved: string;
    source: "explicit" | "active" | "existing" | "inferred";
    forced: boolean;
  };
}
```

## Theme X4 additions

The nine commands below ship `--json` parity in Theme X4. Each entry lists
the success-envelope `data` payload; error responses follow the standard
envelope shape above.

### `authmux config <auto|api> [action] --json`

```ts
{
  ok: true;
  data: {
    section: "auto" | "api";
    action: "enable" | "disable" | "thresholds";
    status: {
      autoSwitchEnabled: boolean;
      serviceState: "active" | "inactive" | "unknown";
      threshold5hPercent: number;
      thresholdWeeklyPercent: number;
      usageMode: "api" | "local";
    };
  };
}
```

Validation failures (missing action, mixing thresholds with enable/disable,
etc.) emit an `E_AUTOSWITCH_CONFIG` error envelope.

### `authmux daemon --once --json`

```ts
{
  ok: true;
  data: {
    switched: boolean;
    fromAccount?: string;
    toAccount?: string;
    reason: string;
  };
}
```

`daemon --watch` does not yet support `--json`; the long-running event
stream is tracked under roadmap Theme X3 (Observability v1). Passing
`--watch --json` returns an error envelope explaining the gap.

### `authmux forecast --json`

```ts
{
  ok: true;
  data: {
    accounts: Array<{
      name: string;
      score: number;
      circuitState: "closed" | "open" | "half-open";
      tokensAvailable: number;
      usable: boolean;
    }>;
  };
}
```

When no accounts are saved, `accounts` is `[]`.

### `authmux savings --json`

```ts
{
  ok: true;
  data: {
    totalSwitches: number;
    autoSwitches: number;
    rateLimitsAvoided: number;
    estimatedMinutesSaved: number;
    lastUpdated: string;       // ISO-8601
    autoSwitchRatePercent: number; // 0 when totalSwitches === 0
  };
}
```

### `authmux hero --json`

```ts
{
  ok: true;
  data: {
    sections: Array<{
      title: string;
      items: Array<{ command: string; description: string }>;
    }>;
  };
}
```

`hero` is the tutorial command; the JSON form is intended for documentation
generators that want the example list without scraping ANSI.

### `authmux export [dir] --json`

```ts
{
  ok: true;
  data: {
    exported: number;
    targetDir: string;
    files: string[];
  };
}
```

Failure modes: `E_NO_ACCOUNTS` when `~/.codex/accounts/` is missing or
empty.

### `authmux import <path> [--alias <name>] [--purge] --json`

Single-file import:

```ts
{
  ok: true;
  data: {
    mode: "file";
    imported: Array<{
      name: string;
      action: "imported" | "updated" | "skipped";
      source: string;
      reason?: string;
    }>;
  };
}
```

Directory import:

```ts
{
  ok: true;
  data: {
    mode: "directory";
    imported: Array<ImportedRecord>; // same shape as above
    dir: string;
    total: number;       // number of *.json files seen
    succeeded: number;   // total - skipped
  };
}
```

Purge mode (`--purge`):

```ts
{
  ok: true;
  data: {
    mode: "purge";
    dir: string;
    scanned: number;
    rebuilt: number;
    includedAuthJson: boolean;
  };
}
```

### `authmux parallel --json`

The `parallel` command bypasses `BaseCommand` (see `01-ARCHITECTURE.md`
§1.3) because it does not touch the Codex registry. The envelope shape is
identical, written manually via `writeJsonEnvelope`.

```ts
// --add <name>
{ ok: true; data: { action: "add"; profile: string; dir: string; created: boolean } }

// --remove <name>
{ ok: true; data: { action: "remove"; profile: string; dir: string } }

// --list (or no flag)
{
  ok: true;
  data: {
    action: "list";
    profiles: Array<{ name: string; configDir: string }>;
  };
}

// --aliases
{ ok: true; data: { action: "aliases"; profiles: string[]; aliases: string } }

// --install
{ ok: true; data: { action: "install"; rc: string; profiles: string[] } }
```

### `authmux kiro --json`

Like `parallel`, `kiro` is provider-specific and bypasses `BaseCommand`.

```ts
// No args → list
{
  ok: true;
  data: {
    action: "list";
    accounts: Array<{ name: string; active: boolean }>;
    active: string | null;
    dataDir: string;
  };
}

// Positional name → switch
{ ok: true; data: { action: "switch"; active: string; target: string } }

// --new
{
  ok: true;
  data: {
    action: "prep-new";
    removed: boolean;
    reason?: "no-data-file";
  };
}
```

## Notes on `--json` semantics

- **stdout is exactly one JSON document.** No banner, no color codes, no
  progress chrome. The `src/tests/json-parity.test.ts` snapshot test
  enforces this for every command listed above.
- **Prompts are suppressed.** Commands that would normally drop into an
  interactive picker (`use`, `kiro`) return `E_PROMPT_CANCELLED` (or the
  equivalent) under `--json` instead of hanging.
- **Human-mode output is unchanged.** Existing scripts that grep
  human-readable output keep working; the JSON layer is purely additive.
- **Error envelopes are uniform.** Any `AuthmuxError` thrown from a
  `--json` command is rendered by `BaseCommand.handleError` (or, for the
  two bypass commands, by an explicit `writeJsonEnvelope` call) using the
  shape at the top of this document.
