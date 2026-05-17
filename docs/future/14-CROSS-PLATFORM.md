# 14 — Cross-Platform Parity

This file inventories what `authmux` does on each supported platform
today, identifies the parity gaps, and proposes concrete remediations.
The target is honest GA on Linux, macOS, and Windows; first-class
support for WSL; and a defined fallback story for non-systemd Linux and
containerized usage.

Cross-references: release/distribution channel implications for each
platform are in `docs/future/12-RELEASE-AND-DISTRIBUTION.md`; logging
paths per platform are in `docs/future/13-OBSERVABILITY-AND-LOGGING.md`;
postinstall shell hook behavior across shells is in
`docs/future/10-POSTINSTALL-AND-SHELL-HOOK-SAFETY.md`.

## Current

`authmux` runs on `node>=18` (`package.json:18`–`20`) and claims
"Works on macOS/Linux/Windows" in `README.md:261`. The reality is more
nuanced. Source evidence:

- Platform branches in production code live in two files only:
  `src/lib/accounts/service-manager.ts` (lines 183, 187, 191, 200, 204,
  208, 215, 216, 217) and `src/lib/accounts/account-service.ts:1551`.
- The postinstall script (`scripts/postinstall-login-hook.cjs`) hard-
  codes bash/zsh rc files (`targetShellRc`, lines 17–21). It does not
  emit anything for PowerShell, cmd, fish, or any other shell.
- The login hook block written by `src/lib/config/login-hook.ts:39`–`66`
  is bash/zsh syntax. It cannot be sourced from any other shell.
- `src/lib/config/paths.ts` resolves all four data directories under
  `os.homedir()` with hard-coded subpaths (`.codex`, `accounts`,
  `auth.json`, `current`). There is no XDG honoring, no
  `%LOCALAPPDATA%`, no `Library/Application Support`.
- The managed service uses three different mechanisms with three
  different uninstall semantics (systemd unit, LaunchAgent plist,
  Scheduled Task). Each path is independently implemented; there is no
  shared abstraction.

## Parity matrix

Status legend: **GA** — works as designed, no known caveats. **partial**
— works but with platform-specific gaps the user must know about.
**broken** — does not work as the README implies. **not started** —
explicitly unsupported today. **n/a** — not applicable to this
platform.

| Feature | Linux | macOS | Windows (PowerShell) | Windows (cmd) | Windows (Git Bash) | WSL2 | NixOS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Snapshot save (`authmux save`) | GA | GA | GA | GA | GA | GA | partial — postinstall blocked by `--ignore-scripts` |
| Snapshot use (`authmux use`) | GA | GA | GA | GA | GA | GA | GA |
| Registry IO | GA | GA | GA | GA | GA | GA | GA |
| Sessions map IO | GA | GA | GA | GA | GA | GA | GA |
| Per-terminal session pinning | GA | GA | partial — PPID semantics differ | partial | partial | GA | GA |
| Postinstall hook prompt | GA | GA | broken — bash/zsh rc only | broken | partial — writes to `~/.bashrc` (Git Bash's home) | GA | not started — sandbox blocks |
| Login hook wrapper around `codex` | GA | GA | broken — bash function in PowerShell profile is a no-op | broken | partial — wraps via `~/.bashrc` only inside Git Bash | GA | partial — user must run `hook-install` manually |
| `authmux hook-install --file <path>` | GA | GA | partial — writes bash syntax to whatever file is named | partial | partial | GA | GA |
| Parallel Claude profiles (`authmux parallel --install`) | GA | GA | not started — README §"Notes" says "use PowerShell functions with `$env:CLAUDE_CONFIG_DIR`" but provides no installer | not started | partial — same as bash | GA | GA |
| Managed service install | GA — systemd user | GA — LaunchAgent | partial — schtasks ONLOGON, no failure recovery | partial | n/a — uses Windows-side schtasks regardless | partial — requires `loginctl enable-linger` for headless | partial — needs custom NixOS module |
| Managed service uninstall | GA | GA | partial — leaves task even after authmux is uninstalled | partial | n/a | GA | partial |
| Service status reporting (`authmux status`) | GA | GA | partial — only "active" / "inactive" with no LastTaskResult | partial | n/a | GA | GA |
| Daemon stdio capture | GA — journald | broken — plist has no `StandardOutPath` | broken — task has no redirection | broken | n/a | GA | GA |
| Self-update `npm i -g` | partial — sudo gating | GA | partial — bin shim placement varies | broken — `npm i -g` rarely on PATH | partial — Git Bash inherits Windows npm | GA | broken — flake users must update via Nix |
| Update notifier prompt on bare `authmux` | GA | GA | GA | GA | GA | GA | GA |
| File permissions on `auth.json` | GA — chmod 600 | GA | partial — Windows NTFS ACLs not set | partial | partial | GA | GA |
| Atomic rename of registry | GA | GA | partial — Windows rename races with open handles | partial | partial | GA | GA |
| Terminal restore (`__codex_auth_restore_tty`) | GA | GA | broken — bash function | broken | partial — only inside Git Bash | GA | GA |
| `authmux update` for non-npm install methods | partial — `pnpm` etc. wrong cmd | partial — also breaks `brew` | partial — also `scoop` (proposed) | partial | partial | partial | broken — must use `nix flake update` |
| XDG state/config dir honoring | broken — uses `~/.codex/...` even when `XDG_*` set | n/a — macOS does not use XDG | n/a | n/a | n/a | broken | partial — Nix users routinely set `XDG_*` |
| Long-path support (>260 chars) | n/a | n/a | broken — needs `LongPathsEnabled` registry tweak | broken | broken | n/a | n/a |
| Credential storage (system keyring) | not started | not started — could use Keychain | not started — could use Credential Manager | not started | not started | not started — could use WSL keyring or pass-through | not started |

The cells marked "partial" or "broken" each have a corresponding
proposal below.

## Linux

### Evidence

- Managed service uses `systemctl --user`
  (`src/lib/accounts/service-manager.ts:50`–`82`). The unit file is
  written to `~/.config/systemd/user/authmux-autoswitch.service`
  (`linuxUnitPath`, line 30).
- The `enableLinuxService` path requires four `spawnSync` calls to
  succeed: `daemon-reload`, `enable`, `start`, and the file write. Each
  failure throws but the partial state is not cleaned up.
- `account-service.ts:1551` has a Linux-only fast path that uses
  `/proc/<pid>/task/<pid>/children` and `/proc/<pid>/cmdline` to detect
  whether a parent shell has a live `codex` child. macOS and Windows
  short-circuit to `true` at line 1552, which is intentional but means
  they trust the session-pin map blindly.
- Path resolution uses `os.homedir()`; `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME` are ignored
  (`src/lib/config/paths.ts:1`–`67`).

### Diagnosis — non-systemd distros

The service install assumes systemd. Users on distros that do not ship
systemd by default — Alpine, Void (runit), Gentoo with OpenRC, Devuan
(sysvinit) — get a bare error from `systemctl --user daemon-reload`
that does not explain the cause. The CLI does not detect the init
system before attempting the install.

### Diagnosis — XDG

Putting credentials under `~/.codex/accounts` is fine because Codex
itself owns `~/.codex/auth.json` and the locality is helpful. But the
*derived* files (registry, sessions, update cache, future logs) do not
belong there — they are authmux state, not Codex data, and they
should live under `$XDG_STATE_HOME/authmux` or
`$XDG_DATA_HOME/authmux`. Doc 06 (security) wants this split for a
separate reason: a `chmod` audit on the credential directory should not
have to ignore non-credential files.

### Diagnosis — Snap/Flatpak

Snap-packaged Node and Flatpak'd terminals run with restricted
filesystem views. A Snap'd `codex` (hypothetical) writing into its own
confined home would not be visible to a non-Snap authmux running outside
the sandbox. The README's promise of "instant switching" assumes a
shared filesystem view.

### Proposal — Init system detection (P1, M)

Add `src/lib/service/init-system.ts`:

```ts
export type InitSystem =
  | { kind: "systemd"; userInstance: boolean }
  | { kind: "runit" }
  | { kind: "openrc" }
  | { kind: "sysvinit" }
  | { kind: "none" }
  | { kind: "unknown" };

export async function detectInitSystem(): Promise<InitSystem>;
```

Detection:

1. If `/run/systemd/system` exists → systemd.
   - Check `XDG_RUNTIME_DIR` and `systemctl --user --no-pager show
     --property=Result` to confirm the user instance is available.
2. If `/etc/runit/runsvdir` exists → runit.
3. If `/sbin/openrc-run` exists or `/etc/init.d/openrc-init` →
   openrc.
4. If `/etc/init.d/` exists with classic SysV scripts → sysvinit.
5. Otherwise unknown.

`enableManagedService()` (`service-manager.ts:182`) gates on the
detected system:

| Init system | Action |
| --- | --- |
| systemd (user available) | Current path |
| systemd (no user instance) | Suggest `loginctl enable-linger` and refuse to install |
| runit | Print runit-style supervise instructions and refuse to auto-install (runit `sv` files belong to the system admin) |
| openrc | Same — print instructions, no auto-install |
| sysvinit | Same |
| none / unknown | Suggest running `authmux daemon --watch` under `nohup` and refuse |

The "refuse and instruct" cases are deliberate: authmux must not write
system service files. The user can copy-paste the suggested
configuration; authmux only takes responsibility for the systemd user
case where the unit is per-user and self-contained.

### Proposal — XDG honoring (P0, M)

Extend `src/lib/config/paths.ts`:

```ts
function xdgState(): string {
  return process.env.XDG_STATE_HOME?.trim() ||
         path.join(os.homedir(), ".local", "state");
}

function xdgData(): string {
  return process.env.XDG_DATA_HOME?.trim() ||
         path.join(os.homedir(), ".local", "share");
}

function xdgConfig(): string {
  return process.env.XDG_CONFIG_HOME?.trim() ||
         path.join(os.homedir(), ".config");
}

export function resolveLogDir(): string {
  return path.join(xdgState(), "authmux", "logs");
}

export function resolveAuthmuxConfigDir(): string {
  return path.join(xdgConfig(), "authmux");
}
```

Existing `resolveAccountsDir()` keeps the current default
(`~/.codex/accounts`) because that path holds credentials that should
stay alongside Codex's own `auth.json`. But the *update cache*,
*log files*, and *future telemetry config* move to XDG. The migration
copies any pre-existing `update-check.json` from the old location on
first run and then ignores the old file.

### Proposal — Snap/Flatpak documentation (P3, S)

Add `docs/platforms/linux-sandbox.md` covering:

- Why authmux running outside a sandbox cannot manage Codex inside a
  Snap.
- The recommended pattern: install both authmux and the AI CLI as
  classic packages, not as sandboxed packages.
- A note on Flatpak permission flags (`--filesystem=home`) that
  partially work but lose `chmod` integrity.

### Migration

1. Land init-system detection in display-only mode (just log the result
   on `authmux status`) for one minor cycle.
2. Switch the service install to gate on the detection.
3. Land XDG honoring with a one-shot migration of `update-check.json`.

### Rollout

The XDG change is user-visible: `update-check.json` moves. Document in
the release notes, and have the diag command (doc 13) show both the
old and new locations until the next minor cycle.

## macOS

### Evidence

- Managed service is a LaunchAgent plist at
  `~/Library/LaunchAgents/com.codex.auth.autoswitch.plist`
  (`service-manager.ts:91`, `99`).
- The plist label is `com.codex.auth.autoswitch` — a legacy
  artifact from before the rename to `authmux` (see doc 12 deprecation
  table).
- The plist has `RunAtLoad`/`KeepAlive` but no `StandardOutPath`,
  `StandardErrorPath`, `WorkingDirectory`, or `EnvironmentVariables`.
- Install uses `launchctl load`; `launchctl unload` is called first to
  handle the upgrade-in-place case (`service-manager.ts:124`).
- File permissions for `auth.json` use the standard POSIX chmod path
  (per doc 05/06 — this works on macOS HFS+/APFS).

### Diagnosis — LaunchAgent vs LaunchDaemon

`authmux` correctly chose LaunchAgent (per-user, runs in the user's
context with access to the user's keychain and home directory).
LaunchDaemon would be wrong because it runs as root and would fight
file ownership on `~/.codex/auth.json`. Document this choice so a
well-intentioned PR does not "promote" the plist to a LaunchDaemon.

### Diagnosis — Service label

`com.codex.auth.autoswitch` does not match the project name. Renaming
it requires the deprecation flow in doc 12 because existing installs
must be cleaned up by old label before the new one is registered. The
risk of leaving orphan plists otherwise is real — they keep loading
on boot until the user manually `rm`s them.

### Diagnosis — Notarization

If authmux ships a standalone binary (doc 12 proposal), macOS
Gatekeeper will quarantine an unsigned binary. The first launch
prompts the user with "cannot be opened because the developer cannot
be verified" and tells them to right-click → Open. This is a one-time
friction but it tanks new-user adoption. Either notarize or do not
ship a macOS standalone.

### Diagnosis — Keychain

Tokens currently live in plaintext JSON on disk
(`<accountsDir>/<name>.json`). On macOS, `security`-backed Keychain
storage would be a significant security upgrade. Doc 06 covers the
full proposal; the cross-platform piece is: a Keychain backend is
useful on macOS, a Credential Manager backend is useful on Windows,
and `libsecret`/`pass` is useful on Linux. The CLI surface should be
identical across the three.

### Diagnosis — SIP

System Integrity Protection blocks writes to `/System` and some
protected directories. authmux does not write there today, but if a
future feature wants to install a Spotlight metadata importer or a
Quick Action, SIP will block it. Document the constraint so future PRs
know not to try.

### Diagnosis — Terminal session IDs

The PPID-based session pin
(`account-service.ts:1544`–`1570`) walks `/proc/<pid>/children`,
which does not exist on macOS. The macOS code path bails to `true`
(line 1552), which means the session pin trusts whatever the sessions
map says. That is mostly fine because iTerm2 and Terminal.app maintain
stable PPID semantics across panes within a session — but tmux panes
inside iTerm2 confuse this further. A doc note is sufficient for now;
a real fix would use the `TERM_SESSION_ID` (iTerm2) or
`Apple_Terminal_*` env vars to scope.

### Proposal — Rename service label (P1, S)

Coordinate with doc 12:

- `0.4.0`: Add new label `dev.authmux.autoswitch`. On install, write
  the new plist and *also* check for the old one
  (`com.codex.auth.autoswitch`) and unload + delete it. On status,
  report based on the new label only.
- Emit a `deprecation.service.mac-label` log line during the migration
  for one cycle.
- `0.5.0`: Remove the cleanup code; old installs that skipped `0.4.x`
  must run `launchctl unload ~/Library/LaunchAgents/com.codex.auth.autoswitch.plist; rm` manually.

### Proposal — Capture daemon stdio (P0, S)

Extend `macPlistContents()` (`service-manager.ts:95`) with:

```xml
<key>StandardOutPath</key>
<string>$HOME/Library/Logs/authmux/daemon-stdio.log</string>
<key>StandardErrorPath</key>
<string>$HOME/Library/Logs/authmux/daemon-stdio.log</string>
<key>WorkingDirectory</key>
<string>$HOME</string>
```

`launchctl` resolves `$HOME` at load time. Create
`~/Library/Logs/authmux/` during `enableMacService()` with `mkdir -p`.

The stdio file is separate from the structured `daemon.log` from doc
13; it captures pre-logger output, native crashes, and any process the
daemon spawns that does not honor the logger.

### Proposal — Notarization (P2, L)

Only relevant if the standalone-binary proposal from doc 12 lands.
Procedure:

1. Sign with `codesign --options runtime --timestamp` using an Apple
   Developer ID.
2. Submit to notary service via `notarytool submit`.
3. Staple with `stapler staple`.
4. Distribute via the Homebrew tap, which Gatekeeper trusts.

### Proposal — Keychain backend (P2, L)

Doc 06 carries the full design. Cross-platform pointer: define
`CredentialBackend` interface; macOS implementation uses
`security add-generic-password`/`find-generic-password` via spawn (no
native deps). Per-snapshot, store `{accountId, refreshToken,
accessToken}` separately and keep the JSON envelope on disk for
metadata only. Migration is a one-shot per snapshot, gated by
`authmux config keychain enable`.

### Migration

1. Land stdio capture first — pure addition, zero risk.
2. Land service-label rename behind a deprecation cycle.
3. Land notarization when (and only when) standalone binaries ship.
4. Land Keychain backend last, behind explicit opt-in.

### Rollout

`authmux diag` (doc 13) on macOS must include the stdio log path so
support reports can locate it. The deprecation cycle for the label
rename gets explicit `releases/vX.Y.Z.md` callouts in `## Deprecations`.

## Windows

### Evidence

- Managed service is a Scheduled Task created via `schtasks /Create`
  (`service-manager.ts:147`–`163`) with `/SC ONLOGON` and
  `/TR "cmd /c authmux daemon --watch"`.
- Uninstall: `schtasks /Delete /TN authmux-autoswitch /F`
  (`service-manager.ts:165`).
- Status: query + verbose parse looking for the substring "running"
  (`service-manager.ts:169`–`180`).
- Postinstall script targets `~/.zshrc` or `~/.bashrc` only. On
  Windows the env var `SHELL` is usually unset, so it falls through to
  `.bashrc` (`postinstall-login-hook.cjs:17`–`21`). For native Windows
  users this writes a file that nothing reads. For Git Bash users
  this writes into `C:\Users\<user>\.bashrc`, which Git Bash *does*
  source.
- No Windows-side filesystem ACL setting; `auth.json` is written with
  default inheritance from the parent directory.

### Diagnosis — Scheduled Task vs Windows Service

Scheduled Task with `ONLOGON` works but has three known limitations:

1. The task does not restart if it crashes. There is no equivalent of
   systemd `Restart=always`. A daemon crash means the user goes
   without auto-switch until next logon.
2. The task does not have any structured logging interface beyond the
   Task Scheduler's own history (which is rarely enabled by default —
   `wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`).
3. The task runs as the logged-in user, which is correct, but on
   shared workstations a fast user switch can leave the previous user's
   daemon running while the new user logs in. Schtasks does not
   serialize.

A Windows Service is the correct long-term answer for #1 and #2. Options:

- **`node-windows`** — wraps `nssm` (Non-Sucking Service Manager) to
  install a Node process as a Windows Service. Adds a sizable native
  dependency.
- **Rust shim** — a tiny `authmux-svc.exe` Rust binary that uses the
  Windows Service Control Manager API and shells out to
  `authmux daemon --watch`. Tighter, no native node deps, but adds a
  Rust toolchain to release.
- **Stay on schtasks with restart logic** — wrap the `--watch` invocation
  in a retry loop inside the daemon itself, and use schtasks's
  `/RL HIGHEST` plus repetition triggers to backstop crashes.

Recommended: stay on schtasks for `0.x`, switch to a Rust shim for
`1.0`. The shim ships as a separate `authmux-windows-service` package
to keep the main npm tarball cross-platform.

### Diagnosis — Shell support

The login hook is bash syntax. On Windows there is no equivalent
PowerShell function that ships today. Users who run `codex` from
PowerShell, cmd, or Windows Terminal's default profile do not benefit
from the per-terminal session pin, the auto-snapshot after login, or
the TTY restore.

### Diagnosis — Path separators and line endings

Paths use Node's `path.join`, which on Windows produces `\` separators
— that is fine for filesystem APIs. But a few places assemble
filesystem paths into shell commands (e.g. the suggested-command logic
in `update-check.ts:151`'s `npm i -g <spec>`) which is shell-agnostic
and therefore safe. Line endings in rc files: the postinstall script
writes `\n` literals (`postinstall-login-hook.cjs:23`–`49`). On Git
Bash this is fine; if the user has `core.autocrlf=true` and the rc
file already has `\r\n`, the merged file becomes mixed. Low impact
because bash tolerates mixed endings, but worth normalizing.

### Diagnosis — File ACLs

`auth.json` containing tokens is written with default ACLs on Windows,
which usually means inheriting from `%USERPROFILE%\.codex\` — which
itself inherits from `%USERPROFILE%` — which is per-user by default.
This is acceptable but fragile. A user who relaxed permissions on
`%USERPROFILE%` (rare but happens on shared dev boxes) has authmux
silently inheriting that relaxation. Doc 06 wants explicit ACL
tightening: SID-based DACL granting only the current user `Read | Write`.

### Diagnosis — Credential Manager

Same shape as macOS Keychain (above). Windows Credential Manager
provides per-user encrypted storage via `cmdkey` (cmdline) or
`CredRead`/`CredWrite` (Win32 API). Tokens belong here if a
credential backend lands.

### Diagnosis — Long-path enablement

Some npm install prefixes on Windows live deep:
`C:\Users\<user>\AppData\Roaming\npm\node_modules\authmux\dist\hooks\init\update-notifier.js`
can exceed 260 characters with a long username. Windows 10 1607+
supports long paths but requires
`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled=1`
and a manifest opt-in. Node has had long-path support since v18 but
some bundled tools (older `npm` scripts) still break.

### Proposal — PowerShell profile install (P0, M)

Add `src/lib/shell/powershell-hook.ts`. The hook is a PowerShell
advanced function that wraps `codex`, mirroring the bash function in
`renderLoginHookBlock()`:

```powershell
# >>> authmux-login-auto-snapshot >>>
function global:codex {
  param([Parameter(ValueFromRemainingArguments=$true)]$Args)
  if (Get-Command authmux -ErrorAction SilentlyContinue) {
    & authmux restore-session 2>$null | Out-Null
  }
  & codex.exe @Args
  $exit = $LASTEXITCODE
  if (Get-Command authmux -ErrorAction SilentlyContinue) {
    $env:CODEX_AUTH_FORCE_EXTERNAL_SYNC = "1"
    & authmux status 2>$null | Out-Null
    Remove-Item env:CODEX_AUTH_FORCE_EXTERNAL_SYNC -ErrorAction SilentlyContinue
  }
  exit $exit
}
# <<< authmux-login-auto-snapshot <<<
```

Install target: `$PROFILE.CurrentUserAllHosts`
(`Documents\PowerShell\profile.ps1` on PS 7,
`Documents\WindowsPowerShell\profile.ps1` on Windows PowerShell 5).

Postinstall script extension:

- Detect platform (`process.platform === "win32"`).
- Detect available shells: PowerShell 7 (`pwsh.exe`), Windows
  PowerShell 5 (`powershell.exe`), Git Bash (`bash.exe` under
  `C:\Program Files\Git\bin`), WSL (presence of `wsl.exe`).
- Prompt the user with a list, default to "all of the above that exist".
- Write the appropriate hook block to each selected shell's profile.

The PowerShell hook does not perform TTY restore — PowerShell handles
its own VT mode reset on prompt return. This is a real platform
difference, not a regression.

### Proposal — Windows Terminal session id (P1, S)

Windows Terminal sets `WT_SESSION` to a per-tab UUID. Use this as the
session-pin scope key when available, replacing the PPID-derived key
(`account-service.ts:1547`'s `session:`/`ppid:` prefixes). The
`CODEX_AUTH_SESSION_KEY` env documented in `README.md:81` already
provides the override; the WT_SESSION fallback should kick in only on
Windows when the override is not set.

### Proposal — File ACL hardening (P0, S)

When writing `auth.json` or snapshot files on Windows, follow the
write with a PowerShell-based ACL fix:

```powershell
icacls "<path>" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
```

Or use the `node-acl` package — but again, no native deps preferred,
so prefer `icacls` shelled out via `spawnSync` after the write
completes. Failures are warnings, not errors — the user may have
already locked the file via Group Policy and the chmod-equivalent
should not regress that.

### Proposal — Windows Service via Rust shim (P2, L)

Out of scope for `0.x`. Documented here so a future PR does not
"naturally" reach for `node-windows` without considering the trade-off.

### Proposal — Long-path detection (P2, S)

On Windows, before postinstall writes any file under
`%AppData%\npm\node_modules\authmux\...`, check the resulting full
path length. If > 240 chars and `LongPathsEnabled` is not set, abort
postinstall with a clear error message linking to the Microsoft
documentation. Better to fail early than to half-install.

### Migration

1. Land PowerShell hook installation and Git Bash detection. This is
   purely additive — users who only use cmd see no change.
2. Land Windows Terminal session id detection.
3. Land ACL hardening behind a feature flag for one cycle, then enable.
4. Defer Windows Service shim to `1.0`.

### Rollout

Update `README.md`'s "Notes" section (lines 261–264) to describe the
per-shell support explicitly:

```
- PowerShell 5/7: login hook installs into $PROFILE
- cmd: no login hook (use `authmux save`/`authmux use` manually)
- Git Bash: same hook as macOS/Linux bash
- WSL: see WSL section below
```

## WSL

### Evidence

WSL2 presents a full Linux userland with its own home directory. From
inside WSL, `authmux` runs as a Linux build, reads `~/.codex/auth.json`
inside the WSL filesystem, and is *invisible* to a copy of authmux
installed on the Windows side.

A user who installs authmux on Windows (npm under Windows Node) and a
second copy inside WSL gets two completely independent registries
under two completely independent `~/.codex/` paths. This is the safe
default behavior but is undocumented.

### Diagnosis

The most common WSL confusion is "I logged in to Codex on Windows but
authmux on WSL does not see the account." That is correct — they are
separate environments — but it surprises new users.

### Proposal — Document isolation as default (P0, S)

Add a `## WSL` section to README explaining:

- WSL and Windows are separate auth domains by default.
- This is intentional and safe — credentials should not cross the
  boundary without consent.
- To use the same account in both, either log in twice (recommended)
  or use the `authmux bridge` command (below) to mirror.

### Proposal — `authmux bridge` (P2, M)

A one-shot copy command between the two environments. Two modes:

```sh
# From inside WSL, copy the active Windows snapshot into WSL's registry:
authmux bridge from-windows --account work

# From Windows, copy active WSL snapshot into Windows's registry:
authmux bridge from-wsl --account work
```

Implementation:

- Detect WSL via `/proc/sys/fs/binfmt_misc/WSLInterop` existence.
- The bridge reads the *other* side's accounts dir via the cross-fs
  bridge: WSL can see `/mnt/c/Users/<user>/.codex/`; Windows can
  reach the WSL distro via `\\wsl.localhost\<distro>\home\<user>\.codex\`.
- Snapshot files are copied with a new name suffix
  (`<account>-from-windows` or `<account>-from-wsl`) to make the
  cross-domain provenance explicit.
- The bridge never deletes; it only copies.
- The bridge requires an explicit account name; bulk copy is refused
  to prevent accidental token spread.

### Proposal — WSL service install (P1, S)

Inside WSL, `systemd --user` works on WSL2 with the systemd opt-in
(`wsl --update` to a recent build and `systemd=true` in
`/etc/wsl.conf`). Without it, `authmux config auto enable` should
detect WSL, detect the absence of systemd, and emit the same "init
system unsupported" error from the Linux init-system detection
proposal.

For a daemon that keeps running after the user logs out of WSL, the
user must run `loginctl enable-linger`. Document this prominently.

### Migration

1. README WSL section first.
2. WSL detection in the existing init-system probe.
3. `authmux bridge` as a separate feature gated on user demand.

### Rollout

`authmux diag` (doc 13) explicitly reports `wsl: true` and the bridge
URL it would use, so support reports from WSL users are
unambiguous.

## Containerized usage

### Use case

Self-hosted CI runners or AI worker fleets that spawn many Codex /
Claude Code processes from one image, each needing distinct accounts
to spread quota.

### Proposal — Reference Dockerfile (P1, M)

Ship `docs/platforms/Dockerfile.example`:

```Dockerfile
FROM node:20-bookworm-slim
ARG AUTHMUX_VERSION=0.1.24
ENV CODEX_AUTH_SKIP_POSTINSTALL=1 \
    CODEX_AUTH_ACCOUNTS_DIR=/data/accounts \
    CODEX_AUTH_CODEX_DIR=/data/.codex \
    XDG_STATE_HOME=/data/state \
    AUTHMUX_LOG_FORMAT=json \
    AUTHMUX_LOG_LEVEL=info
RUN npm i -g authmux@${AUTHMUX_VERSION}
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:9119/healthz || exit 1
ENTRYPOINT ["authmux"]
CMD ["daemon", "--watch", "--metrics-addr", "127.0.0.1:9119"]
```

Key choices:

- `CODEX_AUTH_SKIP_POSTINSTALL=1` is mandatory — non-TTY containers
  cannot prompt anyway, but the env makes the intent explicit.
- All state goes to `/data`, mountable as a volume for persistence
  across container restarts.
- The healthcheck uses the `/healthz` endpoint from doc 13.
- Default to `daemon --watch` because containers expect a long-lived
  foreground process.

### Proposal — Container best practices doc (P2, S)

Document:

- Mounting individual snapshots as Docker secrets vs putting them in
  the image (do not put them in the image).
- Per-tenant containers vs shared container with per-call account
  switching — recommend per-tenant for isolation.
- Resource limits — the daemon idles at near-zero CPU; the dominant
  cost is provider HTTP calls when API mode is enabled.

### Proposal — Avoid rootful containers (P3, S)

The container should run as a non-root user (`USER node` in the
example). authmux does not need root, and rootful containers are an
unnecessary risk. Document this.

### Rollout

Add `docs/platforms/containers.md` describing the above. Cross-link from
the README. Optional: publish the example image to GHCR (see doc 12).

## Testing matrix

### What CI must run

| Job | Runner | Coverage |
| --- | --- | --- |
| `lint` | ubuntu-latest | Typecheck only — `tsc --noEmit` |
| `unit-linux` | ubuntu-latest | `npm test` |
| `unit-macos` | macos-latest | `npm test` |
| `unit-windows` | windows-latest | `npm test` (PowerShell shell) |
| `smoke-linux-tarball` | ubuntu-latest container | `npm pack` + `npm i -g ./tgz` + run 5 commands |
| `smoke-macos-tarball` | macos-latest | same |
| `smoke-windows-tarball` | windows-latest | same, PowerShell |
| `smoke-windows-gitbash` | windows-latest | same, run inside Git Bash |
| `smoke-alpine` | alpine container | catches non-systemd Linux + musl differences |
| `smoke-wsl` | windows-latest with WSL action | install authmux inside WSL Ubuntu, exercise the bridge command |
| `smoke-node18` `smoke-node20` `smoke-node22` | matrix | engine floor verification |
| `postinstall-rc-noop` | ubuntu-latest | Verify `CODEX_AUTH_SKIP_POSTINSTALL=1` results in zero rc file mutations (asserted via file-diff before/after install) |
| `postinstall-rc-install` | ubuntu-latest | Verify with a controlled `~/.bashrc`, exactly one hook block exists after install |
| `service-install-linux` | ubuntu-latest with systemd | Enable, verify `is-active`, disable, verify removed |
| `service-install-macos` | macos-latest | Enable, verify `launchctl list`, disable, verify removed |
| `service-install-windows` | windows-latest | Enable, verify `schtasks /Query`, disable, verify removed |
| `concurrent-switch` | ubuntu-latest | Spawn 20 `authmux use` in parallel against the same registry; assert no torn writes |
| `xdg-honor` | ubuntu-latest | With `XDG_STATE_HOME=/tmp/xdg`, assert log dir is `/tmp/xdg/authmux/logs` |
| `long-path-windows` | windows-latest | Create a deep prefix, verify install succeeds with `LongPathsEnabled=1` and fails clearly without it |

### What CI does today

One workflow (`cr.yml`) that runs an AI code review on PRs. None of
the above is automated. Doc 12 specifies that the testing matrix lands
alongside `release.yml`. This doc adds the cross-platform expansion
beyond a basic `unit-*` job: smoke tarball installs and per-shell
postinstall verification.

### Test fixtures

A `tests/fixtures/platforms/` directory with:

- `bashrc.empty`, `bashrc.preinstalled`, `bashrc.broken-hook`
- `zshrc.empty`, `zshrc.preinstalled`
- `profile.ps1.empty`, `profile.ps1.preinstalled`
- `systemd-unit.golden`, `launchagent.plist.golden`, `schtasks-task.golden`

The unit tests assert the rendered hook block matches the golden file
byte-for-byte. Any cosmetic change to the hook (whitespace, marker
comments) becomes an explicit test update, which is the correct level
of friction.

## Migration plan

The cross-platform parity work is broken into four phases, each gated
on the previous.

### Phase 1 — Observability baseline (P0, prerequisite)

- XDG path honoring on Linux.
- Daemon stdio capture on macOS.
- File sink for the structured logger from doc 13 on all platforms.

Why first: every platform-specific fix that follows is easier to
verify when log evidence is available. Phase 1 is a no-op for the
user (no UX change), just plumbing.

### Phase 2 — Windows first-class (P0)

- PowerShell login hook installer.
- Git Bash detection in postinstall.
- Windows Terminal session-id support.
- File ACL hardening.

Why second: Windows is the most-broken platform per the matrix. The
parity gap is the largest, and the fixes are localized.

### Phase 3 — Linux non-systemd (P1)

- Init system detection.
- Refuse-and-instruct flow for runit/openrc/sysvinit.
- Snap/Flatpak documentation.

Why third: smaller user base than Windows but a clear correctness
problem (silent install failures). The work is mostly defensive
gating.

### Phase 4 — WSL bridge and macOS Keychain (P2)

- `authmux bridge` command.
- Keychain/Credential Manager/libsecret credential backend behind
  explicit opt-in.
- Notarization of standalone binary (if/when standalone ships per
  doc 12).

Why last: each is a non-trivial new feature, not a bug fix. Land them
on a stable foundation.

### Phase tracking

Each phase corresponds to one minor release in the `0.x` line. The
deprecation policy from doc 12 applies to anything renamed: the macOS
service label, the env-var prefix, the `agent-auth` bin.

## Acceptance for this slice

- The parity matrix above is reproduced in the README under a
  "Platform support" section, with cells linking to the corresponding
  proposals here.
- `service-manager.ts` has a single platform-agnostic API
  (`ManagedServiceProvider` interface) with one implementation per
  platform, all sharing the same install/uninstall/status contract.
- Postinstall script supports bash, zsh, PowerShell 5/7, Git Bash, and
  WSL detection, with per-shell rc file selection.
- XDG state honoring is on by default on Linux.
- File sink logs land in `~/Library/Logs/authmux` on macOS and
  `%LOCALAPPDATA%\authmux\logs` on Windows.
- `authmux diag` prints platform-correct paths.
- The testing matrix above is enforced by CI on every PR to `main`.
- README's "Notes" section is rewritten to be specific per shell, not
  vague "Works on macOS/Linux/Windows".
