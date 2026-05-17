# 09 — Multi-CLI Support

`authmux` started as a Codex auth multiplexer. The codebase has since
grown three additional integrations:

* **Claude Code parallel profiles** via `src/commands/parallel.ts`,
  switched at shell level by `CLAUDE_CONFIG_DIR`.
* **Kiro CLI** via `src/commands/kiro.ts`, `src/commands/kiro-login.ts`,
  and `src/lib/kiro-mirror.ts`, switched by symlinking
  `~/.local/share/kiro-cli/data.sqlite3` to a named `.sqlite3`.
* **Hermes agent** via `src/lib/hermes-mirror.ts`, which invokes a Python
  helper inside `~/Documents/hermes-agent/venv` to mirror Codex tokens.

Each integration was added with its own conventions, its own file layout,
its own command class hierarchy (`BaseCommand` vs raw `Command`), and its
own session-key model. This document captures today's state, proposes a
unified `ProviderAdapter` abstraction, and sketches the migration path
to fold the existing logic underneath it.

## Today

### Codex (primary)

* Source of truth: `src/lib/accounts/account-service.ts` (1663 LOC).
* Auth artifact: `~/.codex/auth.json` (single file).
* Snapshots: `~/.codex/accounts/<name>.json`.
* Switch mechanism: write a regular file copy of the snapshot to
  `auth.json`. No symlinks (see file 01 for the regular-file rationale
  on Windows).
* Identity inference: parses the `tokens.idToken` JWT payload for an
  `email` field (`src/commands/import.ts:117-129`).
* Capabilities: device auth, refresh tokens, usage probe via API mode,
  local-rollout usage fallback, session-pinning, auto-switch on quota.
* Surface: `authmux save / login / use / list / current / remove /
  status / config / daemon / hook-install / hook-status / hook-remove /
  switch / parallel / kiro / kiro-login / import / export / restore-
  session / update / forecast / hero / clean / auto-switch / check /
  savings`.

### Claude Code (parallel profiles)

* Source of truth: `src/commands/parallel.ts` (145 LOC).
* Auth artifact: `~/.claude/` directory (when no `CLAUDE_CONFIG_DIR`),
  or `<CLAUDE_CONFIG_DIR>/` (per profile).
* Snapshots: one *directory* per profile at
  `~/.claude-accounts/<name>/` (`parallel.ts:6`). Each directory is its
  own complete Claude Code config, populated by the user via the first
  `claude-<name>` invocation.
* Switch mechanism: environment-variable-only. Aliases of the form
  `alias claude-<name>="CLAUDE_CONFIG_DIR=... command claude"`
  (`parallel.ts:99`).
* Identity inference: **none.** `authmux` has no knowledge of which
  Anthropic email is logged into which profile directory.
* Capabilities: parallel (yes, each terminal can run a different
  profile simultaneously), device auth (n/a — Claude Code handles its
  own auth), usage probe (no), refresh tokens (handled internally by
  Claude Code).
* Surface: `authmux parallel --add / --remove / --list / --aliases /
  --install` only.

### Kiro CLI

* Source of truth: `src/commands/kiro.ts` (108 LOC),
  `src/commands/kiro-login.ts` (77 LOC), `src/lib/kiro-mirror.ts` (109 LOC).
* Auth artifact: `~/.local/share/kiro-cli/data.sqlite3` (single
  SQLite database).
* Snapshots: `~/.local/share/kiro-cli/<name>.sqlite3` (sibling files,
  named so).
* Switch mechanism: symlink `data.sqlite3 -> <name>.sqlite3`
  (`kiro.ts:85`, `kiro-mirror.ts:91`). Stores active-name marker at
  `$XDG_DATA_HOME/kiro-account-switcher/active`.
* Identity inference: **none.** Profile names are user-chosen during
  `kiro-login --name` (`kiro-login.ts:61`).
* Capabilities: parallel (no — one symlink at a time), device auth
  (n/a — handled by `kiro-cli login`), refresh tokens (opaque, stored
  in the sqlite blob), usage probe (no), session pinning (no).
* Surface: `authmux kiro [name|--new]`, `authmux kiro-login [--name]`,
  plus the mirror call inside `switch.ts:117`.

### Hermes mirror

* Source of truth: `src/lib/hermes-mirror.ts` (52 LOC).
* What it actually does: when `~/Documents/hermes-agent/venv/bin/python3`
  and `~/Documents/hermes-agent/hermes_cli` both exist, the active
  Codex `auth.json` is parsed by invoking a small Python program in the
  Hermes venv:

  ```py
  from hermes_cli.auth import _save_codex_tokens
  p = json.load(open("~/.codex/auth.json"))
  t = p.get("tokens")
  _save_codex_tokens(t, p.get("last_refresh"))
  ```

  i.e. Hermes is **downstream** of Codex auth, not an independent
  provider. It does not own a snapshot collection; it only consumes
  whatever Codex tokens authmux happens to have just activated.

* Capabilities: passive consumer, no surface area beyond automatic
  call from `switch.ts:108`.
* Failure modes: silent unless the user looks at the `HermesMirrorResult`
  return value, which is not printed unless `attempted && !switched`.

### Cross-cutting observations

| Concern                  | Codex             | Claude Code   | Kiro            | Hermes           |
| ------------------------ | ----------------- | ------------- | --------------- | ---------------- |
| Snapshot dir layout      | `~/.codex/accounts/*.json` | `~/.claude-accounts/<name>/` (dir) | `~/.local/share/kiro-cli/<name>.sqlite3` | n/a (consumer)  |
| Switch primitive         | File copy         | Env var       | Symlink         | Process exec     |
| Identity inference       | JWT email         | None          | User-named      | Inherited        |
| Per-terminal session pin | Yes               | No (env var)  | No              | No               |
| Usage / quota probe      | API + local       | None          | None            | None             |
| Parallel-friendly        | No (single file)  | Yes           | No (symlink)    | n/a              |
| Refresh-token aware      | Yes               | Opaque        | Opaque          | Mirrored from Codex |
| Command extends          | `BaseCommand`     | raw `Command` | raw `Command`   | n/a              |

The "Command extends" row is the cleanest tell: Codex commands inherit
from `BaseCommand` (with its `runSafe`, `accounts`, telemetry, and
external-sync wiring), while Claude Code and Kiro commands skip the
shared base entirely and reach for `node:fs` directly. Any refactor
that introduces a provider abstraction has to bring Claude Code and
Kiro into the same lifecycle so that lookups like "what is the active
account for provider X" answer consistently across all four.

## Provider abstraction proposal

Priority: P0. Size: L.

### Goals

* One conceptual model — "provider" — that the rest of the codebase
  can program against without knowing whether the underlying CLI is
  Codex, Claude Code, Kiro, or something added next year.
* Adapter authors implement an interface and ship a small module.
  Built-in adapters live in `src/lib/providers/*`. Third-party
  adapters can be loaded from `~/.config/authmux/adapters/*.js` or
  `npm install -g authmux-adapter-<name>`.
* The account registry becomes provider-scoped: an `Account` belongs
  to exactly one provider, and `authmux list` shows all of them by
  default with a `--provider <id>` filter.
* Per-provider capability flags determine which commands are
  applicable. `authmux daemon --watch` only auto-switches accounts
  whose provider declares `supportsUsageApi`.

### Non-goals

* This abstraction does *not* require every provider to support every
  authmux feature. Capability flags make missing features
  unsurprising.
* It does *not* attempt to unify auth artifact storage. Each provider
  keeps its native layout; adapters expose snapshot operations as
  opaque blobs (file, directory, or sqlite database) plus an identity
  tuple.
* It does not subsume the shell-hook story (file 08). Hook integration
  is one capability flag, not the whole interface.

### TypeScript sketch

```ts
// src/lib/providers/types.ts

export type ProviderId = "codex" | "claude-code" | "kiro" | "hermes" | string;

export interface Identity {
  email?: string;
  accountId?: string;
  userId?: string;
  displayName?: string;
  workspace?: string;     // ChatGPT business workspace / team
  plan?: string;          // "pro" | "business" | "usage-based" | ...
  /** Raw provider-specific blob for debugging. Never shown to user. */
  raw?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  warnings?: string[];
}

export interface UsageResult {
  fiveHourRemaining?: number;       // 0..1
  weeklyRemaining?: number;         // 0..1
  source: "api" | "local" | "estimate";
  fetchedAt: string;                // ISO 8601
  raw?: unknown;
}

export interface EnvOverrides {
  /** Env vars the caller should set before exec'ing the provider binary. */
  set?: Record<string, string>;
  /** Env vars the caller should unset. */
  unset?: string[];
}

export interface HookFragment {
  shell: "bash" | "zsh" | "fish" | "nushell" | "pwsh";
  body: string;
}

export interface SnapshotPath {
  /** Single-file snapshot (Codex JSON, Kiro sqlite). */
  file?: string;
  /** Directory snapshot (Claude Code config dir). */
  directory?: string;
}

export interface ProviderCapabilities {
  supportsParallel: boolean;
  supportsUsageApi: boolean;
  supportsDeviceAuth: boolean;
  supportsSnapshot: boolean;        // false for passive consumers like Hermes
  supportsSessionPin: boolean;
  supportsRefreshTokenSync: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly binaryName: string;
  readonly defaultConfigDir: string;
  /** Files relative to `defaultConfigDir` that constitute the auth artifact. */
  readonly authArtifactRelativePaths: readonly string[];
  readonly capabilities: ProviderCapabilities;

  /** True when this provider is detected as installed on the host. */
  isInstalled(): Promise<boolean>;

  /** Parse provider-native auth files into an Identity. */
  inferIdentity(artifacts: SnapshotPath): Promise<Identity | null>;

  /** Confirm an artifact is structurally valid. */
  validateAuthArtifacts(artifacts: SnapshotPath): Promise<ValidationResult>;

  /** Atomically activate a snapshot (file copy, dir copy, or symlink). */
  singleSwitch(opts: { snapshot: SnapshotPath; activeAuthRoot: string }): Promise<void>;

  /** Produce the env overrides needed to run a specific profile in parallel. */
  parallelSwitch?(opts: { profileName: string; snapshot: SnapshotPath }): EnvOverrides;

  /** Query usage / quota. Required iff capabilities.supportsUsageApi. */
  usageProbe?(opts: { snapshot: SnapshotPath; identity: Identity }): Promise<UsageResult>;

  /** Provide a shell-hook fragment for the given shell. */
  installShellHook?(shell: HookFragment["shell"]): HookFragment;

  /** Refresh tokens in-place if the provider supports it. Called by daemon. */
  refreshTokens?(snapshot: SnapshotPath): Promise<{ refreshed: boolean; reason?: string }>;

  /**
   * Mirror to a downstream consumer (e.g. Hermes). Adapters that are
   * passive consumers themselves do nothing here. Called after every
   * successful singleSwitch.
   */
  postSwitch?(opts: { snapshot: SnapshotPath; identity: Identity }): Promise<void>;
}
```

### Provider registry

```ts
// src/lib/providers/registry.ts
export class ProviderRegistry {
  private adapters = new Map<ProviderId, ProviderAdapter>();
  register(adapter: ProviderAdapter): void;
  get(id: ProviderId): ProviderAdapter | undefined;
  listInstalled(): Promise<ProviderAdapter[]>;
  /** Load `~/.config/authmux/adapters/*.js` if user opts in. */
  loadUserAdapters(allow: "all" | readonly ProviderId[]): Promise<void>;
}
```

### Account scoping

The `Account` type (currently anonymous-ish — really just a snapshot
name plus parsed metadata) gains an explicit `providerId`:

```ts
export interface Account {
  providerId: ProviderId;
  name: string;                   // user-chosen snapshot name
  identity: Identity;
  snapshot: SnapshotPath;
  capturedAt: string;
  lastActivatedAt?: string;
  usage?: UsageResult;
}
```

The registry file at `~/.codex/accounts/registry.json` evolves to
include `providerId` per row (defaulting to `"codex"` for legacy
entries). The `accounts/` directory grows a per-provider subdirectory:

```
~/.codex/accounts/
  registry.json
  codex/
    work.json
    personal.json
  claude-code/
    work/   (directory snapshot)
    personal/
  kiro/
    work.sqlite3
    personal.sqlite3
```

A migration step moves existing `~/.codex/accounts/*.json` into
`~/.codex/accounts/codex/`, with backward-compatible fallback for one
release.

## Built-in adapters

### codex

```ts
// src/lib/providers/codex.ts
export const codexAdapter: ProviderAdapter = {
  id: "codex",
  displayName: "Codex (OpenAI)",
  binaryName: "codex",
  defaultConfigDir: path.join(os.homedir(), ".codex"),
  authArtifactRelativePaths: ["auth.json"],
  capabilities: {
    supportsParallel: false,
    supportsUsageApi: true,
    supportsDeviceAuth: true,
    supportsSnapshot: true,
    supportsSessionPin: true,
    supportsRefreshTokenSync: true,
  },
  // ...
};
```

* **File layout**: single JSON file `~/.codex/auth.json`. Snapshots are
  full-file copies. No directory state.
* **Identity quirks**: Workspace switching produces an `idToken` with
  a different `email` claim (workspace owner email) than the
  conversational email; `inferIdentity` must fall back to
  `tokens.accountId` plus `tokens.userId` to disambiguate workspaces
  that share an owner email. See
  `src/commands/import.ts:117-129` for the current heuristic, which
  only inspects email.
* **Auth artifact format**: top-level JSON with `tokens.access_token`,
  `tokens.refresh_token`, `tokens.id_token`, `last_refresh`, plus
  optional `tokens.account` / `tokens.user` metadata.
* **Refresh-token handling**: Codex updates `auth.json` in-place after
  each refresh. The hook (file 08) captures the refresh back into the
  active snapshot. The daemon may also call `refreshTokens` ahead of
  expiry.
* **Edge cases**:
  * Workspace switch mid-session — the JWT's `email` claim flips,
    `inferIdentity` returns a different identity, and the registry
    must not silently rename the snapshot. Solution: pin
    `(accountId, userId)` as identity key, treat `email` as
    display-only.
  * Device auth: `authmux login --device-auth` invokes
    `codex login --device-auth`. Capability flag exposed.
  * Manual `~/.codex/auth.json` edits — fingerprint check inside
    `account-service` detects drift and triggers external sync.

### claude-code

```ts
export const claudeCodeAdapter: ProviderAdapter = {
  id: "claude-code",
  displayName: "Claude Code (Anthropic)",
  binaryName: "claude",
  defaultConfigDir: path.join(os.homedir(), ".claude"),
  authArtifactRelativePaths: [
    "credentials.json",       // OAuth tokens (best-effort name)
    "settings.json",          // user prefs
    ".credentials.json",      // alternate filename
  ],
  capabilities: {
    supportsParallel: true,
    supportsUsageApi: false,
    supportsDeviceAuth: true,
    supportsSnapshot: true,
    supportsSessionPin: false,
    supportsRefreshTokenSync: false,
  },
  // ...
};
```

* **File layout**: A *directory* per profile. The adapter snapshots
  the entire `~/.claude/` tree minus volatile caches into
  `~/.codex/accounts/claude-code/<name>/`. For parallel-only operation,
  the directory at `~/.claude-accounts/<name>/` is the live config dir
  and snapshotting is a no-op (the live directory *is* the snapshot).
* **Identity quirks**: Claude Code stores OAuth credentials inside a
  file that authmux must not parse aggressively — the file format is
  not stable across Claude Code releases. `inferIdentity` returns
  `{ email: <best-effort> }` if the file contains a recognizable JWT
  or `{ displayName: profileName }` otherwise.
* **Auth artifact format**: opaque. Adapter treats it as bytes.
* **Refresh-token handling**: Claude Code refreshes its own tokens
  inside the running process. authmux must not touch the file while
  Claude is running. `refreshTokens` is therefore unimplemented;
  capability flag is false.
* **Parallel mechanism**: `parallelSwitch` returns
  `{ set: { CLAUDE_CONFIG_DIR: <profile dir> } }`. The shell-alias
  installer (today `parallel.ts:114`) is rewritten as a thin caller
  of this method.
* **Edge cases**:
  * Workspace switching inside Claude — handled internally by Claude
    Code; adapter does not see it.
  * MFA / device auth — handled by Claude Code's own flow; adapter
    declares `supportsDeviceAuth: true` only for surfacing in
    `authmux status`, not to implement it.
  * Cross-machine snapshot copy — feasible, but warn users that
    machine-bound device tokens may invalidate.

### kiro

```ts
export const kiroAdapter: ProviderAdapter = {
  id: "kiro",
  displayName: "Kiro CLI",
  binaryName: "kiro-cli",
  defaultConfigDir: path.join(os.homedir(), ".local/share/kiro-cli"),
  authArtifactRelativePaths: ["data.sqlite3"],
  capabilities: {
    supportsParallel: false,
    supportsUsageApi: false,
    supportsDeviceAuth: true,
    supportsSnapshot: true,
    supportsSessionPin: false,
    supportsRefreshTokenSync: false,
  },
  // ...
};
```

* **File layout**: snapshots stored as sibling sqlite files
  alongside the live `data.sqlite3`. Switch primitive is symlink
  (`src/lib/kiro-mirror.ts:91`).
* **Identity quirks**: kiro-cli stores no human-readable identity in
  the sqlite file. authmux's only identity is the user-chosen
  snapshot name (`kiro-login --name`,
  `src/commands/kiro-login.ts:61`). `inferIdentity` returns
  `{ displayName: name }`.
* **Auth artifact format**: opaque sqlite. Adapter treats as bytes.
  Reading sqlite tables would require shipping a sqlite client; the
  adapter does not.
* **Refresh-token handling**: unknown; assumed internal to kiro-cli.
  Capability flag false. The current implementation refuses to
  clobber an unmanaged `data.sqlite3` (`kiro-mirror.ts:69-78`),
  forcing the user to run `kiro-login` to convert it first. The
  adapter preserves this behavior in `singleSwitch`.
* **Edge cases**:
  * Pre-existing unmanaged sqlite from a prior kiro install — same
    handling as today, surfaced as `ValidationResult.warnings`.
  * Symlink not supported on the filesystem (rare; e.g. some
    Windows configurations) — adapter falls back to file copy and
    declares `supportsParallel: false` unconditionally regardless of
    platform.

### hermes

Hermes is a special case: it is a passive consumer of Codex auth, not
an independent provider with its own snapshots. Two options:

1. Model it as a `ProviderAdapter` with
   `supportsSnapshot: false` and the only meaningful method
   `postSwitch`, called by the registry whenever the codex adapter
   activates a snapshot.
2. Model it as a `Subscriber` outside the provider system entirely.

Recommendation: option 1. It keeps a single adapter list, makes
Hermes visible in `authmux providers list`, and centralizes the
"after every codex switch, mirror tokens downstream" rule that today
lives ad hoc in `src/commands/switch.ts:108`.

```ts
export const hermesAdapter: ProviderAdapter = {
  id: "hermes",
  displayName: "Hermes Agent (downstream consumer of Codex)",
  binaryName: "hermes",
  defaultConfigDir: path.join(os.homedir(), "Documents/hermes-agent"),
  authArtifactRelativePaths: [],
  capabilities: {
    supportsParallel: false,
    supportsUsageApi: false,
    supportsDeviceAuth: false,
    supportsSnapshot: false,
    supportsSessionPin: false,
    supportsRefreshTokenSync: false,
  },
  async isInstalled() {
    return fs.existsSync(path.join(this.defaultConfigDir, "venv/bin/python3"))
        && fs.existsSync(path.join(this.defaultConfigDir, "hermes_cli"));
  },
  // singleSwitch, inferIdentity, validateAuthArtifacts -> all reject
  async postSwitch({ snapshot, identity }) {
    if (snapshot.file !== path.join(os.homedir(), ".codex/auth.json")) return;
    // Equivalent of today's mirrorHermesCodexAuth()
  },
};
```

The registry wires `postSwitch` so that whenever the codex adapter
finishes `singleSwitch`, every installed adapter's `postSwitch` is
called with the new snapshot. Hermes is one consumer; future
consumers (e.g. a `cursor` adapter that wants to import Codex
sessions) plug in the same way.

## Adapter discovery

Priority: P1. Size: M.

### Built-ins

Built-in adapters ship inside the npm package at
`src/lib/providers/{codex,claude-code,kiro,hermes}.ts`. The registry
auto-registers all of them at startup. A built-in adapter is always
trusted; capability flags reflect what authmux can actually do, not
user policy.

### User adapters

Users may install third-party adapters at
`~/.config/authmux/adapters/*.js`. Each file must export a default
`ProviderAdapter` instance (CommonJS `module.exports = adapter` or
ESM `export default adapter`). Loading is opt-in via either:

* `authmux providers trust <id>` — adds `id` to an allowlist at
  `~/.config/authmux/adapters/allowlist.json`.
* `authmux providers trust --all` — trusts all currently-present
  files, recorded as `["*"]`.

On every authmux startup, the registry:

1. Lists files in `~/.config/authmux/adapters/`.
2. For each file, computes `sha256(file contents)`.
3. Looks up `(id, sha256)` in the allowlist. If present, loads.
4. Otherwise, skips and emits a warning at `authmux providers list`.

### npm-installed adapters

Adapters distributed as npm packages follow the naming convention
`authmux-adapter-<id>`. Globally installed packages are auto-discovered
via `npm root -g`. The trust model is identical: presence does not
imply trust; `authmux providers trust authmux-adapter-cursor`
explicitly enables loading.

### Capability allowlist

The trust model is coarse-grained (load or don't load). A finer model
is possible: per-capability allowlist (`supportsUsageApi` enabled but
`postSwitch` disabled, etc.). For the first cut, keep it coarse and
revisit if community adapters develop a track record of misuse.

### Adapter security model

* Adapters run in the authmux process. They have full Node.js access.
* The trust mechanism is human-in-the-loop only; there is no signed-
  adapter story in v1.
* `authmux providers list` shows checksum, trust status, file path,
  and a one-line description so users can audit before trusting.
* Defense in depth: adapters that touch files outside
  `defaultConfigDir` must go through a `FsScope` helper that blocks
  writes to `/etc`, `/usr`, `~/.ssh`, `~/.aws`, etc. by default.

## Future adapters

The following sections sketch what each candidate adapter would look
like under the proposed abstraction. They are deliberately shallow —
deeper investigation lives in future per-provider design notes.

### Cursor

* **Binary**: `cursor` (Electron launcher) plus `cursor-agent`
  (background process) on some platforms.
* **Config locations**:
  * macOS: `~/Library/Application Support/Cursor/User/`
  * Linux: `~/.config/Cursor/User/`
  * Windows: `%APPDATA%\Cursor\User\`
* **Auth artifact**: OAuth tokens inside the Electron keychain on
  macOS; sqlite + flat files on Linux/Windows.
* **Parallel feasibility**: Plausible via a portable
  `CURSOR_USER_DATA_DIR` equivalent (needs confirmation). If absent,
  parallel is achieved by sandboxed user-data dirs at launch time.
* **Identity story**: Cursor tracks login email and team; both are
  parseable from local config if exposed in plaintext.
* **Capabilities**: `supportsParallel` conditional; `supportsUsageApi`
  unknown; `supportsDeviceAuth` true; `supportsSnapshot` true.
* **Risks**: Electron config dirs contain large LevelDB blobs; naive
  snapshotting balloons disk usage. Adapter should snapshot only the
  identified credential files.

### Aider

* **Binary**: `aider` (Python CLI).
* **Config locations**: `~/.aider.conf.yml`, `~/.aider.env`,
  plus API keys read from environment.
* **Auth artifact**: API keys (OpenAI / Anthropic / etc.) sourced from
  environment or a `.env` file. No OAuth.
* **Parallel feasibility**: trivially parallel — set
  `OPENAI_API_KEY=...` per shell.
* **Identity story**: identity = API key fingerprint
  (`sha256(api_key)[0:8]`).
* **Capabilities**: `supportsParallel` true (env-based);
  `supportsUsageApi` true (per-provider billing endpoint);
  `supportsDeviceAuth` false; `supportsSnapshot` true (snapshot is
  the `.env` file).
* **Risks**: API keys in plaintext snapshots; encryption story
  becomes mandatory for this adapter (cross-link to file 12 on
  encryption).

### Cline / Roo

* **Binary**: VS Code extension; no standalone CLI.
* **Config locations**: VS Code global storage under
  `~/.config/Code/User/globalStorage/<publisher>.<extension>/`.
* **Auth artifact**: API keys stored via VS Code's `SecretStorage`
  API (keychain-backed).
* **Parallel feasibility**: parallel = different VS Code profiles.
* **Identity story**: same fingerprint-of-key approach as Aider, but
  reading from keychain requires a VS Code extension shim.
* **Capabilities**: `supportsParallel` true (VS Code profile);
  `supportsSnapshot` requires keychain access.
* **Risks**: cross-process keychain reads are user-prompted on macOS;
  user experience is poor for snapshotting.

### Sourcegraph Amp

* **Binary**: `amp` CLI plus VS Code extension.
* **Config locations**: `~/.config/amp/` on Linux; macOS equivalent.
* **Auth artifact**: API token via `amp login`.
* **Parallel feasibility**: requires `AMP_CONFIG_DIR`-like override
  (confirm with vendor).
* **Identity story**: account email returned by Amp's identity API.
* **Capabilities**: `supportsParallel` conditional; `supportsUsageApi`
  yes via Amp's quota endpoint; `supportsDeviceAuth` true;
  `supportsSnapshot` true.
* **Risks**: low; CLI is small and config layout is documented.

### Continue

* **Binary**: VS Code / JetBrains extension; CLI optional.
* **Config locations**: `~/.continue/config.json` and
  `~/.continue/sessions/`.
* **Auth artifact**: API keys in `config.json`; also model-provider
  OAuth in extension secret storage.
* **Parallel feasibility**: parallel by config-file path; native
  support exists via `CONTINUE_CONFIG_DIR` (verify).
* **Capabilities**: `supportsParallel` likely true; `supportsSnapshot`
  true; `supportsUsageApi` provider-dependent.

### OpenAI CLI

* **Binary**: `openai` (Python CLI).
* **Config locations**: `~/.config/openai/auth.json` or env-only.
* **Auth artifact**: API key.
* **Parallel feasibility**: env-based.
* **Identity story**: organization id + project id from `openai api
  organization.list`.
* **Capabilities**: superset of Aider; same encryption concerns.

### Gemini CLI

* **Binary**: `gemini` (Google's official CLI).
* **Config locations**: `~/.config/gemini/credentials.json` or
  ADC-style `~/.config/gcloud/application_default_credentials.json`.
* **Auth artifact**: OAuth tokens (`google-auth-library` format).
* **Parallel feasibility**: ADC honors `GOOGLE_APPLICATION_CREDENTIALS`
  env var pointing at a per-profile JSON file — natural parallel
  pattern.
* **Identity story**: account email is inside the OAuth payload.
* **Capabilities**: `supportsParallel` true (env-based);
  `supportsUsageApi` via GCP billing API (heavy; usually skipped);
  `supportsDeviceAuth` true.

### Grok CLI

* **Binary**: `grok` (xAI's CLI) where it exists.
* **Config locations**: TBD; likely `~/.config/grok/` or
  `~/.xai/`.
* **Auth artifact**: API key.
* **Parallel feasibility**: env-based.
* **Capabilities**: identical shape to Aider / OpenAI CLI adapters.

### Common pattern

Most candidate adapters fall into one of three buckets:

1. **File-based OAuth** (Codex, Claude Code, Kiro, Cursor, Amp,
   Gemini): a snapshot is a copy of a config file or directory; the
   adapter implements `singleSwitch` as a file/directory copy.
2. **Env-based API key** (Aider, OpenAI CLI, Grok CLI): a snapshot is
   a key-value map; `parallelSwitch` returns env overrides;
   `singleSwitch` writes an `.env` file or updates the live config.
3. **Secret-store backed** (Cline, Roo, parts of Cursor): a snapshot
   requires keychain access; the adapter declares a `requires:
   "keychain"` capability and the user accepts an additional prompt
   on each operation.

The adapter interface accommodates all three; differences live behind
capability flags.

## Adapter testing kit

Priority: P1. Size: M.

Every adapter — built-in or third-party — must pass a conformance
suite distributed as `@authmux/adapter-test-kit`. The suite covers:

### T-1 Identity round-trip

Given a known auth artifact fixture, `inferIdentity()` returns the
expected `Identity`. Re-saving the snapshot and re-inferring yields a
byte-identical identity. Tests at least three fixtures: minimal,
typical, and edge-case (e.g. workspace-switched Codex).

### T-2 Snapshot round-trip

`singleSwitch` from snapshot S1 followed by reading the live auth
artifact back into snapshot S2 produces `S1 === S2` (byte-identical
for file snapshots, recursive-diff-empty for directory snapshots,
sqlite-dump-identical for sqlite snapshots).

### T-3 Parallel env-override

If `capabilities.supportsParallel`, `parallelSwitch` returns env
overrides that, when applied to a spawned child process, cause the
child to see the expected config directory. The kit runs:

```ts
const env = adapter.parallelSwitch({ profileName: "test", snapshot });
const child = spawn(adapter.binaryName, ["--config-info"], { env: { ...process.env, ...env.set } });
// assert child output references the snapshot path
```

### T-4 Usage-probe contract

If `capabilities.supportsUsageApi`, `usageProbe` returns a
`UsageResult` with at least one of `fiveHourRemaining` /
`weeklyRemaining` populated, plus `source` and `fetchedAt`. The kit
asserts the values are in `[0, 1]` and `fetchedAt` is a valid ISO 8601
string.

### T-5 Validation rejects malformed artifacts

`validateAuthArtifacts` returns `ok: false` for an empty file, for
truncated JSON / sqlite, and for a file owned by another user (where
applicable). Each rejection includes a `reason` string.

### T-6 No-op idempotency

`singleSwitch` called twice in a row with the same snapshot does not
break: the second call is a no-op or, if it must rewrite, does so
atomically. The live auth artifact is never absent for more than a
single fs.rename call.

### T-7 Hook fragment validity

If `installShellHook` is implemented, the returned `HookFragment.body`
is parseable by the named shell (bash/zsh/fish/nushell/pwsh). The kit
spawns the shell with the body sourced from a temp file and asserts
no syntax errors.

### T-8 PostSwitch isolation

`postSwitch` is called only after a successful `singleSwitch`. If
`postSwitch` throws, the switch is still considered complete (the
adapter is downstream and may not block the user). The kit asserts
that a throwing `postSwitch` produces a warning in the result but
does not roll back the switch.

### Conformance harness

```ts
// @authmux/adapter-test-kit
export async function runConformance(adapter: ProviderAdapter, fixtures: AdapterFixtures): Promise<ConformanceReport> {
  return {
    identityRoundTrip: await testIdentityRoundTrip(adapter, fixtures),
    snapshotRoundTrip: await testSnapshotRoundTrip(adapter, fixtures),
    parallelEnvOverride: adapter.capabilities.supportsParallel
      ? await testParallelEnvOverride(adapter, fixtures)
      : { skipped: true, reason: "supportsParallel=false" },
    usageProbeContract: adapter.capabilities.supportsUsageApi
      ? await testUsageProbeContract(adapter, fixtures)
      : { skipped: true, reason: "supportsUsageApi=false" },
    validation: await testValidation(adapter, fixtures),
    idempotency: await testIdempotency(adapter, fixtures),
    hookFragment: adapter.installShellHook
      ? await testHookFragment(adapter, fixtures)
      : { skipped: true, reason: "no hook" },
    postSwitchIsolation: adapter.postSwitch
      ? await testPostSwitchIsolation(adapter, fixtures)
      : { skipped: true, reason: "no postSwitch" },
  };
}
```

Each built-in adapter ships its own fixtures under
`tests/adapters/<id>/fixtures/`. CI runs `runConformance` for every
built-in on every PR.

## Migration

Priority: P0. Size: XL.

Migrating today's `account-service`-centric code into the adapter
abstraction is large but well-bounded. The plan is staged so that no
single PR touches everything.

### Stage M-1 — Introduce types and registry, no behavior change

* Add `src/lib/providers/types.ts` (interface only, no
  implementations).
* Add `src/lib/providers/registry.ts` with empty registry.
* Add `ProviderRegistry` as a singleton on `BaseCommand`.
* No existing command behavior changes. The registry is unused.

Lines touched: ~300, all additive. Risk: minimal.

### Stage M-2 — Wrap existing Codex logic in a codex adapter

* Implement `src/lib/providers/codex.ts` as a thin façade over the
  current `AccountService` methods. The façade does not move logic;
  it only delegates.
* Register `codexAdapter` in the registry. Confirm
  `registry.get("codex")` returns it.
* Add `authmux providers list` command that prints registered
  adapters and their capabilities. Read-only.

Lines touched: ~500 added, 0 deleted. Risk: low.

### Stage M-3 — Port Kiro and Hermes to adapters

* Implement `src/lib/providers/kiro.ts` over today's
  `src/lib/kiro-mirror.ts` and the `kiro` / `kiro-login` commands.
* Implement `src/lib/providers/hermes.ts` over today's
  `src/lib/hermes-mirror.ts`.
* `src/commands/switch.ts:108-117` is rewritten to iterate
  `registry.listInstalled()` and call `postSwitch` on each rather
  than calling `mirrorHermesCodexAuth` and `switchKiroSnapshot`
  directly.
* `src/commands/kiro.ts` becomes a thin caller of `kiroAdapter`.
* `src/commands/kiro-login.ts` likewise.

Lines touched: ~800 changed, ~100 deleted. Risk: medium. Side effects:
behavior of `switch.ts` becomes data-driven; any adapter that crashes
in `postSwitch` must not break the switch (T-8 enforces this).

### Stage M-4 — Port Claude Code parallel to an adapter

* Implement `src/lib/providers/claude-code.ts` with
  `capabilities.supportsParallel = true`.
* Rewrite `src/commands/parallel.ts` as a caller of
  `claudeCodeAdapter.parallelSwitch` plus the rc-block manager from
  file 08 proposal P-8.
* `~/.claude-accounts/<name>/` continues to be the snapshot location
  (no on-disk migration), but the adapter now owns the read/write
  pathways.
* `scripts/claude-parallel-setup.sh` is removed from the install path
  and marked deprecated.

Lines touched: ~400 changed, ~150 deleted. Risk: low (Claude Code
parallel has limited surface area).

### Stage M-5 — Provider-scoped registry / snapshot layout

* Migrate `~/.codex/accounts/*.json` into
  `~/.codex/accounts/codex/*.json` with one-time migration on first
  v(X+5) run. Backward-compatible read path remains for one
  release.
* Add `providerId` to the registry JSON. Default to `"codex"` for
  legacy rows.
* `authmux list` grows `--provider <id>` and `--all-providers`
  (default).
* `authmux current` shows the active account per provider, not just
  Codex.

Lines touched: ~700 changed. Risk: medium. Migration script must be
idempotent and reversible.

### Stage M-6 — User-adapter discovery

* Implement `~/.config/authmux/adapters/` loader and trust list.
* Add `authmux providers trust <id>` and `authmux providers list
  --untrusted` commands.
* Add capability allowlist (deferred to v(X+7) per discovery
  proposal).

Lines touched: ~300 added. Risk: low; gated behind explicit trust.

### Stage M-7 — Refactor `account-service` into per-adapter modules

* The 1663-LOC `src/lib/accounts/account-service.ts` is split:
  * Adapter-agnostic concerns (registry, session map, sync state,
    locking) stay in `src/lib/accounts/`.
  * Codex-specific concerns (JWT parsing, auth.json fingerprinting,
    rollout-log usage probe) move into `src/lib/providers/codex/`.
* Public API at `src/lib/accounts/index.ts` re-exports the same
  surface for one release to give downstream callers (any external
  package importing authmux internals) time to migrate.

Lines touched: ~1500 moved. Risk: high; full test suite must pass
before and after. Should be the last stage of the migration.

### Stage M-8 — Daemon and auto-switch are provider-aware

* `src/commands/daemon.ts` and `src/commands/auto-switch.ts` iterate
  accounts and call `usageProbe` on those whose provider declares
  `supportsUsageApi`. Accounts without usage probes are excluded
  from auto-switch decisions.
* `authmux config auto` grows `--provider <id>` to scope rules.

Lines touched: ~400 changed. Risk: medium.

### Migration risks and mitigations

* **Risk**: breaking existing scripts that hard-code
  `~/.codex/accounts/<name>.json` paths.
  **Mitigation**: keep the file at the legacy path as a hardlink (or
  copy) for one release; emit deprecation warnings when
  `authmux save` is called without a per-provider subdirectory in the
  registry.

* **Risk**: third-party adapter crashes destabilize authmux core.
  **Mitigation**: every adapter call is wrapped in a try/catch with
  structured error output; conformance suite is mandatory before
  trust.

* **Risk**: Kiro's symlink-based switch loses snapshots if the user
  runs `kiro-cli` with `--init` or similar between authmux switches.
  **Mitigation**: adapter validates the symlink target on each
  `singleSwitch` and refuses to overwrite an unmanaged file (already
  the case in `src/lib/kiro-mirror.ts:69-78`).

* **Risk**: Claude Code's directory-snapshot adapter accidentally
  copies large caches.
  **Mitigation**: explicit allowlist of files to snapshot, not a
  recursive copy.

* **Risk**: Hermes adapter spawns Python on every switch; slow.
  **Mitigation**: spawn is already capped at 5s timeout
  (`src/lib/hermes-mirror.ts:41`); adapter inherits that timeout
  and exposes it as a capability-level config knob.

## Rollout summary

Combining the stages above with priorities from earlier sections:

| Release | Stage | Visible change                                        |
| ------- | ----- | ----------------------------------------------------- |
| v0.X    | M-1   | None (internal interface)                             |
| v0.X+1  | M-2   | `authmux providers list` command                      |
| v0.X+2  | M-3   | `switch.ts` is data-driven; behavior unchanged        |
| v0.X+3  | M-4   | `parallel` command refactored; legacy script deprecated |
| v0.X+4  | M-5   | Per-provider snapshot dirs; legacy fallback           |
| v0.X+5  | M-6   | User adapters loadable with explicit trust            |
| v0.X+6  | M-7   | `account-service` split; same public API              |
| v0.X+7  | M-8   | Daemon is provider-aware                              |

After v0.X+7, the codebase has a single conceptual model for
"providers," and adding a new CLI (Cursor, Aider, Amp, …) is an
adapter PR rather than a cross-cutting refactor.

## Open questions

* Should `Identity` be a discriminated union per provider (so that
  Codex callers get `tokens.accountId` type-safely) or a structurally-
  typed bag? The sketch above uses the latter for adapter
  ergonomics, but loses type safety in core code paths. Likely
  resolution: keep the bag at the interface boundary, declare
  per-provider narrowed types in adapter modules.

* Should adapters be allowed to define new commands (e.g.
  `authmux kiro-login`) or only methods on the interface? Letting
  adapters extend the CLI surface is powerful but requires a stable
  oclif plugin model. Recommendation: defer command-extension to a
  v2 of the adapter API; for v1, all CLI surface is owned by
  built-in commands that dispatch to adapters by id.

* Should the registry support a "default provider" per shell
  invocation? E.g. `authmux save work` defaults to codex today; in
  a multi-provider world, it must either require `--provider` or
  pick a default. Recommendation: auto-detect based on which
  provider's auth artifact has changed most recently
  (fingerprint-based), with explicit `--provider` always overriding.

* For passive consumers like Hermes, should `postSwitch` be best-
  effort (current proposal) or transactional (rollback on failure)?
  Transactional is hard for downstream consumers that write into
  third-party files. Best-effort is honest. Recommendation: keep
  best-effort, surface errors loudly in `authmux switch` output, and
  expose a `--strict-mirrors` flag for users who want failure to be
  blocking.

* Does the conformance kit live in the main package, in a separate
  `@authmux/adapter-test-kit` package, or both? Separate package is
  cleaner but adds another release surface. Recommendation: separate
  package with semver tied to the adapter API version; built-in
  adapters depend on it as a dev-dep.

* For provider adapters that need secret-store access (Cline, Roo,
  parts of Cursor), should authmux ship a generic keychain shim
  (e.g. `keytar`-based) or require adapters to bundle their own?
  Generic shim creates a binary dependency that complicates
  cross-platform builds. Recommendation: adapters bundle their own
  and declare it via a `requires` capability so authmux can warn at
  trust time about additional binary deps.
