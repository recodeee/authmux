# 10 — Security and Secrets

This file inventories how `authmux` handles secret material today, draws a
concrete threat model, calls out every place the current implementation falls
short of the bar the project should hold itself to, and proposes a graded set
of hardening steps. It follows the Evidence / Diagnosis / Proposal / Migration
/ Rollout pattern defined in `00-OVERVIEW.md`.

The point of this document is not "authmux is insecure". The point is that
authmux multiplexes long-lived OAuth refresh tokens and bearer access tokens
that an attacker would happily steal, and any tool that touches those bytes
should be honest about its posture. Where today's posture is "plaintext file
under `~/.codex/`", we say so plainly so that downstream users can decide what
risk they are accepting and so that future contributors know which knob to
turn next.

## Scope

This file covers:

- Files written by authmux that contain or reference secret material
  (`~/.codex/auth.json`, `~/.codex/accounts/*.json`,
  `~/.codex/accounts/registry.json`,
  `~/.codex/accounts/.snapshot-backups/*.json`).
- Files written by authmux that influence which secret is loaded by the host
  process (`~/.codex/current`, `~/.codex/accounts/sessions.json`).
- Side-effect files outside `~/.codex/` (`~/.bashrc`, `~/.zshrc`,
  systemd/launchd unit files, Windows scheduled-task XML).
- Outbound network traffic from authmux
  (`src/lib/accounts/usage.ts:7`, `src/lib/accounts/usage.ts:8`,
  the `update-notifier` init hook).
- The npm publish + install pipeline, including the `postinstall` script at
  `scripts/postinstall-login-hook.cjs`.

Out of scope for this file:

- Secret handling inside the upstream CLIs themselves (`codex`, `claude`,
  `kiro`). We treat each as a black box with a known input file shape.
- Replacing authmux with a full-blown password manager. See
  `00-OVERVIEW.md` non-goal #2.
- Cloud sync, encrypted or otherwise. See `00-OVERVIEW.md` non-goal #5.

## Threat model

### Actors

| Actor                           | Capability                                                                                              | Likelihood       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| Local same-user malware         | Can read every file the user can read, write every file the user can write, observe env, scrape memory. | medium / rising  |
| Local other-user account        | Has its own UID; can only read files whose mode bits allow it.                                          | low (multi-user) |
| Local privileged user (root)    | Can read and write anything; only relevant on shared workstations.                                      | low              |
| Backup / sync agent             | iCloud, Dropbox, Time Machine, restic, btrbk — silently exfiltrates the home directory to remote store. | high             |
| Shoulder-surf / screen share    | Sees rendered output of `authmux list`, `current`, `status`.                                            | medium           |
| Malicious npm dependency        | Lives inside the install tree; executes arbitrary code during `postinstall`, lifecycle scripts, or use. | medium           |
| Compromised npm publisher token | Pushes a poisoned version of `authmux` to the registry under the same name.                             | low / catastrophic |
| Network attacker (passive)      | Observes traffic to `chatgpt.com` or the local dashboard proxy.                                         | low (TLS)        |
| Network attacker (active MITM)  | Presents a forged TLS certificate to authmux on egress.                                                 | very low         |
| Social-engineered user          | Pastes a malicious command containing `authmux save attacker` or sets a hostile `CODEX_AUTH_*` env var. | medium           |
| Repository contributor          | Submits a PR that quietly weakens permissions or adds telemetry.                                        | low / silent     |

### Assets

| Asset                                | Location today                                                  | Sensitivity  |
| ------------------------------------ | --------------------------------------------------------------- | ------------ |
| OAuth refresh tokens                 | `~/.codex/auth.json`, `~/.codex/accounts/<name>.json`           | critical     |
| OAuth access tokens (Bearer)         | same                                                            | high (short TTL) |
| OpenAI API keys (`OPENAI_API_KEY`)   | inside `auth.json` for `apikey` mode snapshots                  | critical     |
| `id_token` JWT claims                | inside `auth.json` `tokens.id_token`                            | medium (PII) |
| User identity (email, account_id)    | `~/.codex/accounts/registry.json`, snapshot files               | medium (PII) |
| Plan / quota state                   | `registry.json` `lastUsage`                                     | low          |
| Active-account pointer               | `~/.codex/current`                                              | low          |
| Per-shell session pin map            | `~/.codex/accounts/sessions.json`                               | low          |
| Dashboard proxy credentials          | `CODEX_LB_DASHBOARD_PASSWORD`, `CODEX_LB_DASHBOARD_TOTP_*` env  | high         |
| Shell rc-file integrity              | `~/.bashrc`, `~/.zshrc`                                         | medium       |

### Trust boundaries

```
+--------------------+   shell exec   +-----------------+   filesystem
|  user's shell      | -------------> |  authmux CLI    | <----------------> ~/.codex/
+--------------------+                +-----------------+                       |
        ^                                    |                                  |
        | source rc/zshrc                    | reads + writes                   |
        |                                    v                                  |
+--------------------+                +-----------------+                       |
|  login-hook block  | <------------- |  postinstall    |                       |
+--------------------+                +-----------------+                       |
        ^                                    |                                  |
        | npm install                        | spawns tsc                       |
        |                                    v                                  |
+--------------------+   tarball      +-----------------+    HTTPS              |
|  npm registry      | -------------> | install tree    | <----+                |
+--------------------+                +-----------------+      |                |
                                                               |                |
                                       +-----------------------+                |
                                       |                                        |
                                       v                                        |
                             chatgpt.com/backend-api    127.0.0.1:2455 (proxy)  |
                             registry.npmjs.org/authmux                         |
                                       ^                                        |
                                       |  update-notifier init hook             |
                                       +----------------------------------------+
```

The boundaries that matter for the rest of this document are:

1. **Filesystem boundary** between the authmux process and the on-disk
   credential snapshots. Everything inside `~/.codex/` is currently trusted
   to be authentic — there is no signature or HMAC.
2. **Process boundary** between the user's shell and the authmux process.
   The login hook injects a shell function that wraps `codex`, so the shell
   becomes a transitive caller of authmux on every `codex` invocation.
3. **Network boundary** between authmux and `chatgpt.com` (or the local
   proxy at `127.0.0.1:2455`). TLS verification is implicit in `fetch()`.
4. **Supply-chain boundary** between the npm tarball and the install
   target machine, mediated by `scripts/postinstall-login-hook.cjs`.

### Attacker capability matrix

| Attacker                           | Read snapshots | Write snapshots | Read registry | Hijack hook | MITM usage API | Replace authmux binary |
| ---------------------------------- | -------------- | --------------- | ------------- | ----------- | -------------- | ---------------------- |
| Same-user malware                  | yes            | yes             | yes           | yes         | partial (DNS)  | yes                    |
| Other-user account (perms wide)    | yes (today)    | yes (today)     | yes (today)   | no          | no             | no                     |
| Other-user account (perms 700/600) | no             | no              | no            | no          | no             | no                     |
| Backup agent                       | yes            | no              | yes           | no          | no             | no                     |
| Compromised npm publisher          | next install   | next install    | next install  | next install| next install   | next install           |
| Postinstall-only attacker          | postinstall    | postinstall     | postinstall   | postinstall | postinstall    | yes                    |
| Network MITM                       | no             | no              | no            | no          | maybe          | no                     |

The headline takeaway: with the current default mode bits, **any other local
user on the same machine can read every saved authmux snapshot** simply by
walking `~/.codex/accounts/`. That is the single most important finding in
this document.

## Current posture review

The table below enumerates every artifact authmux writes that touches a
trust boundary, the permissions the code actually sets, the permissions the
artifact deserves, and whether the file content is encrypted at rest.

| Artifact                                                              | Written by                                                       | Code-set mode | Should be       | Parent dir mode today | Parent dir should be | Encrypted at rest |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | --------------- | --------------------- | -------------------- | ----------------- |
| `~/.codex/auth.json` (active snapshot)                                | `account-service.ts:408` (`fsp.copyFile`), `:998`, `:1307`        | umask default | `0600`          | umask default         | `0700`               | no                |
| `~/.codex/accounts/<name>.json` (saved snapshot)                      | `account-service.ts:408`, `:887`, `:925`, `:942` (`copyFile`)     | umask default | `0600`          | umask default         | `0700`               | no                |
| `~/.codex/accounts/registry.json`                                     | `registry.ts:151` (`fsp.writeFile`)                              | umask default | `0600`          | umask default         | `0700`               | no                |
| `~/.codex/current`                                                    | `account-service.ts:1046` (`fsp.writeFile`)                      | umask default | `0644` is fine  | umask default         | `0700`               | n/a               |
| `~/.codex/accounts/sessions.json`                                     | `account-service.ts:1513` (`fsp.writeFile`)                      | umask default | `0600`          | umask default         | `0700`               | no                |
| `~/.codex/accounts/.snapshot-backups/<name>.json`                     | `account-service.ts:887`, `:925`, `:942` (`copyFile` from auth)  | umask default | `0600`          | umask default         | `0700`               | no                |
| `~/.bashrc` / `~/.zshrc` (hook block append)                          | `login-hook.ts:87,92,114`; `postinstall-login-hook.cjs:123,146`  | unchanged     | unchanged       | n/a                   | n/a                  | n/a               |
| systemd `--user` unit (`~/.config/systemd/user/authmux.service`)      | `service-manager.ts` (out of scope for this doc, but noted)      | umask default | `0644` is fine  | umask default         | `0700` recommended   | n/a               |
| Windows scheduled-task XML                                            | `service-manager.ts`                                              | umask default | ACL: user only  | n/a                   | ACL: user only       | n/a               |

### Evidence (line-by-line)

- `src/lib/accounts/account-service.ts:986-988` — `ensureDir` is a one-line
  `fsp.mkdir(dirPath, { recursive: true })`. No `mode` argument, so the
  directory is created with `0777 & ~umask`, which on a typical user shell
  is `0755`. This is the parent directory of every snapshot.

  ```ts
  private async ensureDir(dirPath: string): Promise<void> {
    await fsp.mkdir(dirPath, { recursive: true });
  }
  ```

- `src/lib/accounts/account-service.ts:408` — `await fsp.copyFile(authPath, destination);`
  The snapshot is copied from the active `auth.json` to its named
  destination with no explicit `mode`. The copy inherits the source file's
  mode if and only if the destination did not exist; on overwrite of an
  existing file, the existing mode is preserved. Either way, no `fchmod`
  is performed.

- `src/lib/accounts/account-service.ts:996-998` — when materializing the
  symlink, authmux reads the file's bytes into a `Buffer`, unlinks the
  symlink, then writes the bytes back as a real file:

  ```ts
  const snapshotData = await fsp.readFile(authPath);
  await this.removeIfExists(authPath);
  await fsp.writeFile(authPath, snapshotData);
  ```

  The `writeFile` call uses no `mode` option, so the result is
  `0666 & ~umask` (typically `0644`).

- `src/lib/accounts/account-service.ts:1046` — `await fsp.writeFile(currentNamePath, ...)`.
  Same story: no mode, no `flag`, no atomic rename. A partial write here
  is recoverable (next run rebuilds), but the lack of `fsync` is still a
  durability gap.

- `src/lib/accounts/account-service.ts:1513` — `await fsp.writeFile(sessionMapPath, ...)`.
  Same pattern. Session map is lower sensitivity but still leaks the
  account name a given shell PID was using.

- `src/lib/accounts/registry.ts:148-152` — registry write is the same
  shape: ensure parent dir (no mode), `JSON.stringify` + `writeFile` (no
  mode):

  ```ts
  export async function saveRegistry(registry: RegistryData): Promise<void> {
    const registryPath = resolveRegistryPath();
    await fsp.mkdir(path.dirname(registryPath), { recursive: true });
    await fsp.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }
  ```

- `src/lib/config/login-hook.ts:69-92` — rc-file mutation. The function
  ensures the parent dir exists (with default mode), reads the existing
  rc file, then `writeFile`s the modified contents. There is no backup
  copy on disk before the write and no `dry-run` flag.

- `scripts/postinstall-login-hook.cjs:104-148` — same logic at install
  time, with the additional risk that `ensureBuiltDist` (lines 67-102)
  will spawn `tsc` or `npm exec --yes typescript@5.6.3` if `dist/index.js`
  is missing. That fallback path can pull a fresh transitive dep tree at
  install time from a non-pinned version, which expands the supply-chain
  blast radius.

- `src/lib/accounts/usage.ts:7-8` — outbound endpoints are hard-coded:
  `https://chatgpt.com/backend-api/wham/usage` and
  `http://127.0.0.1:2455`. The proxy URL is HTTP, not HTTPS — acceptable
  because it is loopback-only, but it should be locked to loopback by
  the client.

- `src/lib/accounts/usage.ts:540-550` — `fetchUsageFromApi` uses the
  built-in `fetch()` with a 5-second `AbortController` timeout, sends
  `Authorization: Bearer <accessToken>` and `ChatGPT-Account-Id`
  headers, and identifies itself with `User-Agent: authmux`. There is no
  certificate pinning (which is fine for a public endpoint) and no proxy
  hygiene — `HTTP_PROXY` / `HTTPS_PROXY` env vars would route credentials
  through whatever proxy the user has configured, with no warning.

### Diagnosis of the current posture

1. **Wrong umask assumption.** All file writes assume the user has a
   restrictive umask (`0077`). Most distros default to `0022`, which means
   every snapshot is world-readable. On a multi-user box this is a direct
   read of refresh tokens.
2. **No directory hardening.** Even if every file were `0600`, an attacker
   with directory listing on `~/.codex/accounts/` learns every account
   name, which leaks the user's organization layout. We need `0700` on
   `~/.codex/`, `~/.codex/accounts/`, and `.snapshot-backups/`.
3. **No tamper detection.** A snapshot is loaded into the live `auth.json`
   purely on the basis of "the bytes parse as JSON". Any process that can
   write the snapshot file can swap the refresh token for one the attacker
   controls.
4. **No memory hygiene.** Snapshot bytes are read into a `Buffer`
   (`account-service.ts:996`), JSON-parsed elsewhere, and left to GC. We
   accept that V8 makes true zeroization impossible without native code,
   but we currently make no attempt to scope or shorten lifetime.
5. **rc-file edits are destructive.** `installLoginHook` and
   `removeLoginHook` rewrite the rc file in place with no `.bak` copy,
   no dry-run, and no detection of concurrent edits by other tools.
6. **`postinstall` is high-risk.** It runs unconditionally on every
   install, can spawn a fresh `tsc` from `npm exec --yes typescript@5.6.3`,
   prompts on stdin, and writes to the user's rc file. That set of
   behaviors during `npm install` of a globally installed package is
   the single biggest hardening target in the repo.
7. **No declared CA pinning, no proxy guard.** Any HTTP proxy in env
   silently MITMs the usage call.
8. **No SECURITY.md.** There is currently no documented disclosure path,
   so a finder has to triage between `Issues` and `Discussions` and may
   simply post a CVE-worthy bug to a public issue.

## Recommendations

Each recommendation below is tagged with the priority / effort scheme from
`00-OVERVIEW.md` and structured as Evidence → Diagnosis → Proposal →
Migration → Rollout.

### R1. Enforce `0700` on `~/.codex/` and `0600` on every snapshot — `P0 / M / high`

- **Evidence.** `src/lib/accounts/account-service.ts:986-988` and
  `src/lib/accounts/registry.ts:148-152` both create directories and files
  without an explicit `mode`, so the result depends on the user's umask.
  On Ubuntu and macOS defaults this means snapshots land at `0644` and
  the accounts directory at `0755`.
- **Diagnosis.** Refresh tokens that grant `chatgpt.com/backend-api/*`
  access have a long TTL and are valuable to any attacker who can read
  them. World-readable mode bits on a multi-user host (CI runner, shared
  workstation, jump box) hand them over.
- **Proposal.**
  - Add a `writeFileSecure(filePath, data)` helper in
    `src/lib/config/paths.ts` (or a new `src/lib/config/secure-fs.ts`).
    It performs:
    1. `fsp.mkdir(parent, { recursive: true, mode: 0o700 })`.
    2. `fsp.chmod(parent, 0o700)` after `mkdir` (the `mode` option is
       masked by umask; the explicit `chmod` defeats umask).
    3. `fsp.writeFile(tmpPath, data, { mode: 0o600, flag: "wx" })`
       with `tmpPath = filePath + ".tmp-<pid>-<random>"`.
    4. `fsp.fsync(fd)` via `fsp.open` + `handle.sync()`.
    5. `fsp.rename(tmpPath, filePath)`.
    6. `fsp.chmod(filePath, 0o600)` as belt-and-braces.
  - Add a parallel `copyFileSecure(src, dst)` helper that does
    `readFile` + `writeFileSecure` instead of `copyFile`. (`copyFile`
    does not give us a way to force the destination mode.)
  - Wire `account-service.ts` to call `copyFileSecure` for every
    snapshot copy and to call `writeFileSecure` for `current` and
    `sessions.json`.
  - Wire `registry.ts:saveRegistry` to call `writeFileSecure`.
  - On Windows, the helper falls back to using `icacls`-equivalent via a
    native module or simply skips the chmod step; the
    NTFS default ACL inherits from the user profile, which is already
    user-only on standard installs.
- **Migration.**
  - Add the helpers under a feature flag
    (`CODEX_AUTH_SECURE_FS_DISABLE=1`) for one minor release so any
    hostile environment can be diagnosed quickly.
  - On daemon start and on first command after upgrade, run
    `repairSecretPerms()` that walks `~/.codex/accounts/` and chmods
    everything down to `0600` / `0700`. Print a one-line note when it
    fires.
  - Document the change in release notes under "Behaviour change".
- **Rollout.** Tied to a minor bump (e.g. `0.2.0`). Document the env-var
  escape hatch. After two minors, drop the escape hatch.

### R2. Refuse to operate when perms are wider than expected — `P1 / S / med`

- **Evidence.** Even with R1, an external process could chmod the file
  after authmux wrote it. Today there is no detection.
- **Diagnosis.** Defense in depth: detect drift, refuse to proceed,
  shout loudly.
- **Proposal.** Add `assertSecretFileMode(filePath)` that `stat`s the
  file and throws a new `InsecureSecretPermissionsError` if
  `mode & 0o077 !== 0` on Unix. Call it from `loadAccountSnapshot`,
  `loadRegistry`, and `readSessionMap`.
- **Migration.** Behind `CODEX_AUTH_STRICT_PERMS=1` for one minor,
  default-on after.
- **Rollout.** Surface the error with a remediation hint
  (`chmod 600 ~/.codex/accounts/*.json && chmod 700 ~/.codex/accounts/`).

### R3. Optional OS keychain backend — `P1 / L / med`

- **Evidence.** All snapshot bytes are plaintext on disk. Even with
  `0600` perms, the bytes survive `tar` backups, IDE indexers, antivirus
  quarantines, and any process running as the same UID.
- **Diagnosis.** A keychain stores the bytes encrypted under a key
  controlled by the OS user-session keyring. The disk artifact becomes a
  short envelope referencing a keychain item, drastically shrinking the
  blast radius of a stolen home-dir backup.
- **Proposal.** Introduce a `SnapshotStore` interface:

  ```ts
  interface SnapshotStore {
    kind: "file" | "keychain";
    readSnapshot(name: string): Promise<Buffer>;
    writeSnapshot(name: string, bytes: Buffer): Promise<void>;
    listSnapshots(): Promise<string[]>;
    deleteSnapshot(name: string): Promise<void>;
  }
  ```

  Provide two implementations:
  - `FileSnapshotStore` — current behaviour, plus R1 perms.
  - `KeychainSnapshotStore` — backed by:
    - macOS Keychain via the `security` CLI (no native deps) or via
      the `keytar` package if/when a native dep is acceptable.
    - libsecret / gnome-keyring via the `secret-tool` CLI on Linux.
    - Windows Credential Manager via `cmdkey` / `wincred`.
  - The store choice is configurable via
    `~/.codex/accounts/registry.json:secrets.store = "file" | "keychain"`
    and via `authmux config secrets.store keychain`.
- **Migration.** New install defaults to `file` (backwards compatible).
  A `authmux secrets migrate keychain` command copies every snapshot
  into the keychain, leaves the file as a tombstone, and updates the
  registry. The inverse `migrate file` is also offered.
- **Rollout.** Ship behind a documented `keychain` opt-in for at least
  two minors before considering it default for new installs. Never
  silently migrate.

### R4. Memory hygiene for token buffers — `P2 / S / low`

- **Evidence.** `account-service.ts:996` reads the snapshot into a
  `Buffer` and lets it go to GC. JWT id-tokens and refresh tokens stay
  resident until V8 happens to collect.
- **Diagnosis.** Node cannot guarantee scrubbing of `Buffer` contents
  because V8 may have already copied the bytes into a string for JSON
  parsing. But we can avoid making the problem worse and we can scrub
  the bytes we directly own.
- **Proposal.**
  - Prefer `Buffer.allocUnsafe(n).fill(0)` semantics: call `buf.fill(0)`
    on every snapshot buffer once the snapshot has been written to its
    final destination.
  - Never log `accessToken`, `refresh_token`, `id_token`, or
    `OPENAI_API_KEY`. Add a structured logger with a key-allowlist; any
    key not in the allowlist is redacted to `"[redacted]"`.
  - Convert the snapshot parser to take a `Buffer` and avoid the
    intermediate `string` round-trip where feasible, or accept that
    JSON.parse owns its own copy and document the residual leak.
  - Reject snapshot writes whose JSON contains a key matching
    `secret|password|cookie|session` outside the documented allow-list
    of fields (`tokens`, `OPENAI_API_KEY`, `last_refresh`, `email`,
    `account_id`, `chatgpt_account_id`). This is also R6.
- **Migration.** Internal change only. No user-visible flag.
- **Rollout.** Mention briefly in release notes.

### R5. HTTP client hardening — `P1 / M / med`

- **Evidence.** `src/lib/accounts/usage.ts:543` calls
  `fetch(USAGE_ENDPOINT, { ... })` with no explicit TLS config and no
  proxy guard. The built-in `fetch` in Node 18+ honours `HTTPS_PROXY`,
  `NO_PROXY`, and `NODE_TLS_REJECT_UNAUTHORIZED` from the environment.
- **Diagnosis.** If a user runs authmux on a corporate workstation with
  a transparent proxy, the bearer access token is sent through the
  proxy. If they have ever exported `NODE_TLS_REJECT_UNAUTHORIZED=0`
  (a depressingly common quick-fix), authmux silently inherits it.
- **Proposal.**
  - At process start, if `NODE_TLS_REJECT_UNAUTHORIZED === "0"`,
    print a single warning line to stderr and refuse to make outbound
    requests unless `CODEX_AUTH_ALLOW_INSECURE_TLS=1` is also set.
  - Surface the resolved proxy (`HTTPS_PROXY` value) in
    `authmux config` output so users can audit it.
  - For the local proxy at `127.0.0.1:2455`, hard-enforce
    `url.hostname === "127.0.0.1"` or `"localhost"` and refuse any
    other override of `CODEX_LB_DASHBOARD_URL`. (Today the code at
    `usage.ts:431` already restricts to `http:` / `https:`; we extend
    that check.)
  - Set explicit `headers: { "User-Agent": "authmux/<version>",
    "Accept": "application/json" }` and an explicit
    `cache: "no-store"`.
- **Migration.** Pure additive checks; no breakage expected.
- **Rollout.** Document the env-var escape hatch.

### R6. Schema-check auth artifacts before write and before activation — `P0 / M / high`

- **Evidence.** `assertSafeSnapshotOverwrite` at
  `account-service.ts:1001-1030` checks the email identity but does not
  schema-validate the snapshot. A malformed snapshot with extra keys
  (`__proto__`, `constructor`, attacker-controlled fields) is happily
  written and later activated.
- **Diagnosis.** authmux is the gatekeeper for `~/.codex/auth.json`.
  Refusing to write or activate an unrecognized shape is cheap insurance
  against accidental clobbering and against malicious snapshot files
  planted by another process.
- **Proposal.**
  - Define a `AuthSnapshotSchema` (a hand-rolled validator, no new
    runtime dep) that accepts exactly:
    - top-level keys: `OPENAI_API_KEY?`, `tokens?`, `last_refresh?`.
    - `tokens` keys: `id_token`, `access_token`, `refresh_token`,
      `account_id`.
  - On write, call `validateAuthSnapshot(bytes)` and throw
    `InvalidAuthSnapshotError(path, reason)` on failure.
  - On activation (every `use`, every daemon switch), re-validate the
    bytes we are about to drop into `~/.codex/auth.json`.
  - Allow opting out via `CODEX_AUTH_SCHEMA_RELAXED=1` for users on
    bleeding-edge upstream `codex` releases that may add fields.
- **Migration.** Strict mode behind the env var for one minor; default
  strict afterward.
- **Rollout.** Document the env var, link to issue tracker for any new
  field upstream adds.

### R7. `--dry-run` for every mutation outside `~/.codex/` — `P1 / S / med`

- **Evidence.** `installLoginHook` (`login-hook.ts:68-94`),
  `removeLoginHook` (`:96-116`), and the `service-manager` rc-file /
  unit-file writes all mutate user-owned files outside `~/.codex/` with
  no preview.
- **Diagnosis.** Modifying `~/.bashrc` or installing a launch agent are
  exactly the operations a security-conscious user wants to vet first.
- **Proposal.**
  - Add `--dry-run` to `hook-install`, `hook-remove`, and the
    `service-manager install` / `service-manager remove` flows. In
    dry-run, print the unified diff that would be applied and exit 0
    without writing.
  - Add `--print` mode that emits the would-be file contents to stdout
    for piping into `tee` or review.
- **Migration.** Pure additive flag.
- **Rollout.** Mention in release notes; reference in the README hook
  section.

### R8. Snapshot integrity HMAC — `P2 / L / high`

- **Evidence.** Today an attacker who can write to
  `~/.codex/accounts/<name>.json` between the time a user runs
  `authmux save` and the time they run `authmux use <name>` can swap in
  any auth blob. Email-identity check (`account-service.ts:1019`)
  catches mismatched emails but not a same-email attacker (e.g. a
  reused refresh token from a captured backup).
- **Diagnosis.** A keyed MAC over the snapshot bytes, with the key
  stored only in the OS keychain, provides tamper detection that
  survives backup/restore and survives an attacker without keychain
  access.
- **Proposal.**
  - On first run, generate a 32-byte random key, store it in the
    keychain under `authmux/integrity-key`. If keychain is unavailable,
    store under `~/.codex/accounts/.integrity-key` with mode `0600`
    (degraded mode, log a warning).
  - On every snapshot write, append a sidecar `<name>.json.mac`
    containing the hex of `HMAC-SHA256(key, snapshot_bytes)`.
  - On every snapshot activation, verify the MAC. On mismatch, refuse
    activation and emit `IntegrityMismatchError(name, expected,
    actual)`.
  - Also MAC the registry file.
- **Migration.** Behind `--integrity` flag for one minor; auto-MAC on
  next write afterward. Existing snapshots without a `.mac` are read
  with a one-time warning.
- **Rollout.** Document the failure mode and how to recover (delete
  the MAC sidecar if you trust the file).

### R9. Lock down the `postinstall` script — `P0 / M / high`

- **Evidence.** `scripts/postinstall-login-hook.cjs:67-102` will
  bootstrap a TypeScript install via
  `npm exec --yes --package typescript@5.6.3 -- tsc -p tsconfig.json`
  if `dist/index.js` is missing. `--yes` accepts any prompt; the
  version is pinned but the transitive tree is not.
- **Diagnosis.** The package on npm should ship `dist/`. The git-install
  bootstrap path should never be reachable from a registry install. If
  it is, that itself is a bug worth refusing.
- **Proposal.**
  - In `postinstall-login-hook.cjs`, detect "install from registry" vs
    "install from git" by checking for the presence of `tsconfig.json`
    relative to the package root. Registry installs do not ship
    `tsconfig.json`. If `tsconfig.json` is absent and `dist/` is
    absent, fail loudly with a clear error — do not bootstrap.
  - For git installs, require an explicit
    `CODEX_AUTH_ALLOW_POSTINSTALL_BUILD=1` env var before invoking
    `npm exec` or `tsc`. Otherwise print instructions and exit 0.
  - Default the `maybeInstallHook` branch to `no-op` unless the user
    is `--global` *and* interactive *and* not `CI`. This is already
    the behaviour (`postinstall-login-hook.cjs:104-108`), but make it
    impossible to skip the CI guard.
  - Strip the script down to the minimum and unit-test it against a
    matrix of (global, interactive, CI, hook-already-installed, git
    install).
  - Verify with `npm pack --dry-run` that the published tarball
    contains exactly: `dist/`, `scripts/postinstall-login-hook.cjs`,
    `README.md`, `LICENSE`, `package.json`. Today the `files` array
    at `package.json:21-26` declares this; add a CI step that pins it.
- **Migration.** Single PR; no flag.
- **Rollout.** Release-notes line under "Security".

### R10. Reproducible builds and npm provenance — `P1 / M / med`

- **Evidence.** Published tarballs today are built on a maintainer
  workstation via `npm run build` (`package.json:13`) and pushed via
  `npm publish` (implicit through `prepublishOnly`).
- **Diagnosis.** Provenance turns "trust the maintainer" into "trust
  the maintainer + GitHub OIDC + the published attestation". It is
  cheap to enable and dramatically narrows the supply-chain story.
- **Proposal.**
  - Add `.github/workflows/release.yml` that builds, tests, and
    publishes via OIDC with `permissions.id-token: write`. Use
    `npm publish --provenance --access public`.
  - Pin every action by SHA, the way `cr.yml:21` already does.
  - Verify reproducibility: build twice in the workflow and `diff -r`
    `dist/`. Fail the build on diff.
  - Sign git tags (`git tag -s vX.Y.Z`) and document the maintainer
    GPG fingerprint in `SECURITY.md`.
- **Migration.** Net-new workflow file. Local `npm publish` is still
  possible but maintainers should not use it for releases.
- **Rollout.** Document in `RELEASING.md` (when that file is created
  by `14-RELEASE-AND-DISTRIBUTION.md`).

### R11. Pin and audit dependency surface — `P1 / S / low`

- **Evidence.** `package.json:50-55` lists four runtime deps with caret
  ranges. `package-lock.json` is committed (good). No audit job runs in
  CI (`.github/workflows/cr.yml` is the only workflow and it is an LLM
  code-review bot).
- **Diagnosis.** The caret ranges are fine because the lockfile pins
  the resolved tree. What is missing is an automated `npm audit` (and
  `npm audit signatures`) check on every PR.
- **Proposal.**
  - Add a `ci.yml` workflow that runs:
    - `npm ci` (uses the lockfile only).
    - `npm audit --omit=dev --audit-level=high`.
    - `npm audit signatures` (verifies registry signatures on
      every installed tarball).
    - `npm run build` and `npm test`.
  - Document the bar: PRs do not merge if `audit --audit-level=high`
    is failing, with a clear escape hatch for false positives.
- **Migration.** Pure CI additive change.
- **Rollout.** Add a status badge to the README.

### R12. Configurable strict mode and self-audit command — `P2 / S / low`

- **Evidence.** Users today have no easy way to check whether their
  authmux install is in a good security posture.
- **Diagnosis.** A dedicated `authmux doctor` (or extension to
  `authmux check`) that prints a checklist removes the guesswork.
- **Proposal.** Add an `authmux check --security` flag that walks:
  - perms on `~/.codex/`, `~/.codex/accounts/`, every snapshot,
    `registry.json`, `sessions.json`;
  - presence and validity of the integrity key (R8);
  - presence of `SECURITY.md` link;
  - resolved proxy and `NODE_TLS_REJECT_UNAUTHORIZED` (R5);
  - whether the keychain backend is available (R3);
  - whether the login hook is installed and matches the expected
    template (`login-hook.ts:39-66`).
  Each item prints `ok` / `warn` / `fail`. Exit code 1 on any `fail`.
- **Migration.** New command.
- **Rollout.** Document in README and link from the postinstall
  prompt.

## Supply chain

### Dependency surface today

`package.json:50-58` declares:

```
"dependencies": {
  "@oclif/core": "^3.0.0",
  "prompts": "^2.4.2",
  "tslib": "^2.8.1",
  "typescript": "^5.6.3"
},
"devDependencies": {
  "@types/prompts": "^2.4.9"
}
```

`typescript` is in `dependencies`, not `devDependencies`. That is
intentional because `postinstall-login-hook.cjs:74-83` will try to spawn
`tsc` for git installs. This decision is worth revisiting under R9 — if
git-install bootstrapping requires opt-in, `typescript` can move to
`devDependencies` and the production install tree shrinks dramatically.

### Publish-time hygiene

The `files` field in `package.json:21-26` already restricts the
published tarball to:

- `dist/`
- `scripts/postinstall-login-hook.cjs`
- `README.md`
- `LICENSE`

This is correct, but it is not enforced by anything other than the npm
client. R9 proposes a CI step that runs `npm pack --dry-run` and asserts
the contents byte-for-byte.

### Postinstall threat surface

The `postinstall` script is the most dangerous code in the repository
because it runs unconditionally on every install of authmux — and on
every `npm install` of any package that depends on authmux (today none,
but the policy should hold). The script does the following, in order:

1. Resolve project root and check for `dist/index.js`
   (`postinstall-login-hook.cjs:68-70`).
2. If `dist/index.js` is missing, locate `node_modules/typescript/bin/tsc`
   (`:72-82`) and spawn it. If `tsc` is missing, spawn
   `npm exec --yes --package typescript@5.6.3 -- tsc -p tsconfig.json`
   (`:84-97`).
3. Then call `maybeInstallHook` which, if global, interactive, non-CI,
   reads/writes the user's rc file (`:104-148`).

Hardening (from R9, summarized here for the supply-chain section):

- Refuse the bootstrap unless `tsconfig.json` exists, which it never
  does in a registry install.
- Require an opt-in env var for the bootstrap.
- Move `typescript` to `devDependencies` if and only if R9 lands.
- Never `--yes` to a fresh `npm exec`; if a bootstrap is truly needed,
  fail and ask the user to install TypeScript explicitly.

### Lockfile and audit policy

- `package-lock.json` is checked in. Keep it that way; renovate/dependabot
  PRs must include the lockfile change.
- CI must run `npm ci`, not `npm install`, to enforce the lockfile.
- CI runs `npm audit --audit-level=high --omit=dev` on every PR and on
  cron weekly.
- CI runs `npm audit signatures` to verify registry signatures.
- Renovate (or Dependabot) is configured to:
  - Group all `@types/*` updates.
  - Open PRs for `@oclif/core`, `prompts`, `tslib`, `typescript`
    individually, with `automerge: false`.
  - Skip alpha / beta / rc tags by default.

### Reproducible builds

- `tsc` output is deterministic by default for a fixed set of inputs.
  CI runs the build twice in a job and asserts `diff -r dist/`
  produces no output.
- The published tarball is generated only by CI; maintainer-machine
  publishes are explicitly forbidden by `RELEASING.md` (to be written).

### npm provenance

- Use `npm publish --provenance --access public` from a workflow with
  `id-token: write` and `contents: write`.
- The resulting attestation links the tarball to the GitHub Actions
  workflow run that produced it. Consumers can verify with
  `npm view authmux@latest --json | jq .dist`.

### Signed tags

- All release tags (`vX.Y.Z`) are signed with the maintainer's GPG
  key. The fingerprint is published in `SECURITY.md`.
- A CI step verifies the tag signature before running `npm publish`.

## Disclosure

### SECURITY.md template

Create `SECURITY.md` at repo root with the following structure:

```
# Security policy

## Supported versions

The latest published minor version is supported. Older versions receive
security fixes only when the same patch can ship to current.

## Reporting a vulnerability

Please report security issues privately to <security@example.com> or via
GitHub's "Report a vulnerability" private advisory flow:
https://github.com/recodeee/authmux/security/advisories/new

Please do not file a public issue for any of the following:

- A way to read another local user's authmux snapshots.
- A way to make authmux activate a different account than the one the
  user asked for.
- A way to MITM the usage API call.
- A way to elevate from `npm install authmux` to arbitrary code
  execution.

For non-security bugs, public issues are welcome.

## What to expect

- We acknowledge reports within 3 business days.
- We aim for a fix candidate within 14 days for `high` / `critical`
  severities and 30 days for `medium`.
- We coordinate disclosure with the reporter and credit them in the
  release notes unless they ask to remain anonymous.

## Maintainer GPG fingerprint

`<fingerprint>` — used to sign release tags. Verify with
`git tag -v vX.Y.Z`.
```

### Disclosure timeline

| Day  | Action                                                                                |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | Report received via private channel; ack within 3 business days.                      |
| +3   | Triage decision: confirmed / needs-info / not-a-vuln.                                 |
| +7   | Fix branch open; reporter looped in on the PR diff (private).                         |
| +14  | Fix candidate cut for `high` / `critical`; rolling release for `medium`.              |
| +21  | CVE requested via GitHub's advisory flow.                                             |
| +30  | Public release + advisory + release notes section "Security".                         |
| +60  | Postmortem note added to `docs/future/10-SECURITY-AND-SECRETS.md` under "History".    |

### CVE handling

- Use GitHub Security Advisories to request CVEs through the GHSA
  pipeline. Do not request CVEs through MITRE directly unless GH-SA
  is unavailable.
- Include `CWE-` references in every advisory (e.g. `CWE-276`
  Incorrect Default Permissions for R1, `CWE-22` Path Traversal for
  any path-handling bug, `CWE-829` Inclusion of Functionality from
  Untrusted Source for postinstall bootstrap bugs).

## Compliance

authmux is a local tool. It does not:

- Store secrets in any backend other than the local filesystem (and,
  with R3, the local OS keychain).
- Send telemetry. There is no analytics endpoint, no error reporting
  endpoint, no remote logging.
- Auto-update itself. The `update-notifier` init hook only displays a
  message; the user must run `npm i -g authmux` to actually upgrade.
- Read or modify any file outside `~/.codex/` and `~/.bashrc` /
  `~/.zshrc` (and OS-specific service files when the daemon is
  installed). All such paths are documented in this file.

### Data residency

- All authmux state lives on the user's machine. There is no cloud
  backend. There is no data-residency requirement to meet because the
  data never leaves the host.

### Telemetry consent

- Today there is no telemetry. If telemetry is ever added (see
  `09-OBSERVABILITY.md`), it must be:
  - opt-in;
  - off by default;
  - documented in `SECURITY.md` and `README.md`;
  - implemented with a single endpoint over HTTPS;
  - subject to a clear retention policy (≤ 30 days, aggregated).

### Retention

- Snapshot files and the registry are retained until the user runs
  `authmux remove <name>` or deletes the files directly.
- The backup vault under `~/.codex/accounts/.snapshot-backups/` is
  transient and should be cleared at the end of every successful
  sync. Confirm that policy with an integration test.
- Log files (when structured logging lands) rotate at ≤ 7 days.

### Regulated environments

For users in regulated orgs (HIPAA, PCI, SOX, FedRAMP):

- authmux can be deployed inside the regulated boundary because all
  data stays local.
- The keychain backend (R3) is recommended for FedRAMP-style
  deployments where DAR (data at rest) encryption is mandatory.
- Disable the optional `update-notifier` egress with
  `CODEX_AUTH_DISABLE_UPDATE_NOTIFIER=1` (to be added) in
  air-gapped environments.

## Hardening checklist (per release)

Run through this list before tagging a release. The list is
maintainer-facing; copy it into the release-prep issue template.

```
[ ] R1 helpers in use everywhere — grep for `writeFile|copyFile` in
    src/ shows only the secure helpers
[ ] R2 strict-perms check is on by default
[ ] R3 keychain backend tests pass on macOS, Linux, Windows
[ ] R4 logger redaction tests pass; grep for `console.log` in src/
    finds no secret-shaped string
[ ] R5 TLS-insecure warning fires under env-var test
[ ] R6 schema validator rejects known bad fixtures
[ ] R7 dry-run flag prints diff and exits 0
[ ] R8 integrity MAC verified on activation, attacker fixture rejected
[ ] R9 postinstall refuses bootstrap on registry install; CI asserts
    tarball contents
[ ] R10 release workflow built, tested, and signed via OIDC; tag
    signature verified
[ ] R11 npm audit --audit-level=high passes; npm audit signatures
    passes
[ ] R12 authmux check --security exits 0 on a freshly installed box
[ ] SECURITY.md present and up to date
[ ] CHANGELOG / release notes have a "Security" section if any of the
    above changed
```

## Open questions

These do not block any P0 above but should be tracked.

1. **Where do we store the integrity key on Linux without a keyring?**
   GNOME Keyring requires a graphical session. Headless servers may
   have neither libsecret nor a TTY-friendly fallback. Proposal: fall
   back to a `0600` file under `~/.codex/accounts/.integrity-key` and
   warn loudly. Acceptable?
2. **Should we offer a "panic" command?** `authmux panic` would shred
   every snapshot, the registry, and the active `auth.json` in one go.
   Useful for laptop-loss scenarios where the user wants to nuke
   everything before remote-wipe completes. Risk: same command becomes
   a destructive footgun.
3. **Should we sign snapshot files with an asymmetric key?** Public-key
   verification would let CI / fleet tools verify snapshots without
   holding the signing key. Probably overkill for v1; revisit at v2.
4. **Should we support hardware-backed keys (YubiKey, TPM)?**
   Out of scope until R3 and R8 are both shipped and adopted.
5. **What is the threat model for the daemon (`authmux daemon
   --watch`)?** Covered by `05-AUTO-SWITCH-DAEMON.md`, but specifically
   the long-running process needs its own audit: privilege drop,
   socket perms, signal handling.

## History

This section is appended to as security-relevant changes ship. Each
entry is dated and links to the PR / release.

- _no entries yet_

## Appendix A — File-permission cheat sheet

| Octal | Symbolic     | Meaning                                                       |
| ----- | ------------ | ------------------------------------------------------------- |
| `0700`| `drwx------` | Owner can list / read / write; no one else can even see names. |
| `0600`| `-rw-------` | Owner can read / write; nothing else.                          |
| `0644`| `-rw-r--r--` | Owner write, world read. **Wrong for secrets.**                |
| `0755`| `drwxr-xr-x` | Owner write, world execute (i.e. world can `cd` and list).     |
| `0777`| `drwxrwxrwx` | Anyone can do anything. Never used by authmux.                 |

## Appendix B — Environment variables touched by authmux

This list is mirrored in `11-CONFIGURATION.md` for the configuration
audit. It is reproduced here so that security review of authmux can
proceed without bouncing between files.

| Variable                              | Effect                                                                       | Security-relevant? |
| ------------------------------------- | ---------------------------------------------------------------------------- | ------------------ |
| `CODEX_AUTH_CODEX_DIR`                | Override `~/.codex` (`paths.ts:10`).                                         | yes                |
| `CODEX_AUTH_ACCOUNTS_DIR`             | Override `~/.codex/accounts` (`paths.ts:19`).                                | yes                |
| `CODEX_AUTH_JSON_PATH`                | Override the active auth file (`paths.ts:28`).                               | yes                |
| `CODEX_AUTH_CURRENT_PATH`             | Override `current` pointer (`paths.ts:37`).                                  | low                |
| `CODEX_AUTH_SESSION_MAP_PATH`         | Override session map (`paths.ts:51`).                                        | low                |
| `CODEX_AUTH_SESSION_KEY`              | Override session pin scope.                                                  | yes (pin spoof)    |
| `CODEX_AUTH_FORCE_EXTERNAL_SYNC`      | Force re-sync on every command.                                              | low                |
| `CODEX_AUTH_SKIP_POSTINSTALL`         | Skip the postinstall prompt (`postinstall-login-hook.cjs:106`).              | yes                |
| `CODEX_AUTH_SKIP_TTY_RESTORE`         | Skip TTY restore inside the shell hook.                                      | low                |
| `CODEX_AUTH_ALLOW_INSECURE_TLS`       | (Proposed R5) Permit `NODE_TLS_REJECT_UNAUTHORIZED=0`.                       | yes                |
| `CODEX_AUTH_SCHEMA_RELAXED`           | (Proposed R6) Skip schema validation on activation.                          | yes                |
| `CODEX_AUTH_STRICT_PERMS`             | (Proposed R2) Refuse to operate when perms drift wider.                      | yes                |
| `CODEX_AUTH_DISABLE_UPDATE_NOTIFIER`  | (Proposed) Disable npm registry egress for update checks.                    | yes                |
| `CODEX_AUTH_ALLOW_POSTINSTALL_BUILD`  | (Proposed R9) Opt-in to git-install bootstrap.                               | yes                |
| `CODEX_LB_DASHBOARD_PASSWORD`         | Dashboard proxy password (`usage.ts:15`).                                    | yes                |
| `CODEX_LB_DASHBOARD_TOTP_CODE`        | Dashboard proxy TOTP (`usage.ts:16`).                                        | yes                |
| `CODEX_LB_DASHBOARD_TOTP_COMMAND`     | Command to compute TOTP (`usage.ts:17`).                                     | yes (exec)         |
| `NODE_TLS_REJECT_UNAUTHORIZED`        | Inherited from Node; disables TLS verification globally.                     | yes                |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Inherited from Node `fetch`; can route credentialled requests via a proxy. | yes                |
| `SHELL`                               | Read to choose `.bashrc` vs `.zshrc` (`login-hook.ts:31`).                   | low                |
| `CI`                                  | Skip postinstall prompt (`postinstall-login-hook.cjs:107`).                  | low                |

The "Security-relevant?" column drives which env vars must be
mentioned in `SECURITY.md` and which need an explicit warning in
`authmux check --security` output.

## Appendix C — Commands that mutate filesystem outside `~/.codex/`

Audited list, as of writing. If this list grows, update R7.

| Command                                  | Files it touches                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `authmux hook-install`                   | `~/.bashrc` or `~/.zshrc` (`login-hook.ts:68-94`).                              |
| `authmux hook-remove`                    | same (`login-hook.ts:96-116`).                                                  |
| `authmux service-manager install`        | Linux: `~/.config/systemd/user/authmux.service`. macOS: `~/Library/LaunchAgents/dev.authmux.plist`. Windows: scheduled task XML. |
| `authmux service-manager remove`         | same.                                                                           |
| `authmux parallel`                       | Per-account `CLAUDE_CONFIG_DIR` directories.                                    |
| `authmux kiro`                           | Kiro CLI's own config dir (via `kiro-mirror.ts`).                               |
| postinstall                              | `~/.bashrc` or `~/.zshrc` (`postinstall-login-hook.cjs:104-148`).               |

Every entry above is in scope for R7.

## Appendix D — Threat-model worked example

To make the abstract attacker capability matrix concrete, here is a
single worked example of the "Backup agent" actor exfiltrating
snapshots today and how each recommendation reduces the damage.

### Scenario

User Alice runs macOS with Time Machine writing to an attached drive.
Alice has 3 authmux snapshots:

- `alice-personal` (ChatGPT Plus)
- `alice-work` (ChatGPT Business via SSO)
- `alice-api` (OpenAI API key)

The Time Machine drive is later stolen.

### Today

The attacker mounts the Time Machine drive on their laptop, navigates
to `Users/alice/.codex/accounts/`, reads every `*.json` file. Refresh
tokens, the API key, account IDs, emails — all in plaintext, readable
by anyone with the disk. The attacker can replay the refresh tokens
against `auth.openai.com` until they are revoked.

### After R1 + R2

The Time Machine snapshot preserves the `0600` mode bits, but the
attacker mounting the drive on a different machine becomes root on
that machine and reads everything anyway. R1 does not protect against
disk theft.

### After R3 (keychain backend)

The snapshot files no longer exist on disk in plaintext. The keychain
items are encrypted under Alice's macOS login keychain, which is in
turn protected by Alice's account password. Time Machine backs up the
encrypted keychain; the attacker would need to crack Alice's password
to read the snapshots.

### After R8 (HMAC integrity)

Even if the attacker can read the snapshots, they cannot inject a new
snapshot back into a restored Time Machine on a recovered-from-theft
machine because the integrity key lives only in the keychain.

### After R10 (provenance)

Independent of the above, the attacker cannot ship a malicious update
of authmux to Alice through the npm registry without compromising the
GitHub OIDC pipeline.

This worked example is the kind of narrative we want in `SECURITY.md`
once it lands.
