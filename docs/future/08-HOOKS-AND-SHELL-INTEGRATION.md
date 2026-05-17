# 08 — Hooks and Shell Integration

This slice covers the optional shell hook that `authmux` writes into
`~/.bashrc` / `~/.zshrc` during postinstall and via the explicit
`authmux hook-install` command. The hook wraps the `codex` binary as a shell
function so that:

1. Before each `codex` run, `authmux restore-session` repins the active
   `~/.codex/auth.json` to whatever snapshot is bound to the current
   terminal session.
2. After each `codex` run, `authmux status` is invoked with
   `CODEX_AUTH_FORCE_EXTERNAL_SYNC=1` so that a freshly refreshed access /
   refresh token written by official `codex login` is immediately captured
   back into the appropriate snapshot file.
3. After `codex` exits, a `__codex_auth_restore_tty` helper writes a long
   sequence of escape codes to `/dev/tty` to undo terminal mode bits that
   the TUI sometimes leaves enabled (mouse reporting, alternate screen,
   bracketed paste, cursor hide, etc).

In addition, parallel Claude Code accounts are wired through the shell rc
file as `alias claude-<profile>="CLAUDE_CONFIG_DIR=... command claude"`,
managed by `src/commands/parallel.ts` and `scripts/claude-parallel-setup.sh`.

This document audits the end-to-end shell integration story and proposes a
more portable, less invasive design.

## Current model

### Postinstall flow

The npm postinstall step lives at
`/home/user/authmux/scripts/postinstall-login-hook.cjs:104-148`. The
material control flow is:

1. Skip unless `npm_config_global === "true"`
   (`scripts/postinstall-login-hook.cjs:105`). Local installs never touch
   the rc file.
2. Skip if `CODEX_AUTH_SKIP_POSTINSTALL` is truthy
   (`scripts/postinstall-login-hook.cjs:106`).
3. Skip if `CI` is truthy
   (`scripts/postinstall-login-hook.cjs:107`).
4. Detect TTY via `process.stdin.isTTY && process.stdout.isTTY`
   (`scripts/postinstall-login-hook.cjs:108`).
5. Compute target rc file by sniffing `process.env.SHELL`
   (`scripts/postinstall-login-hook.cjs:17-21`): if it contains `zsh`,
   target `~/.zshrc`; otherwise `~/.bashrc`. There is no third branch.
6. If the existing rc already contains the hook block markers, refresh
   it in place using `hookBlockRegex()` and exit silently when content
   would be byte-identical
   (`scripts/postinstall-login-hook.cjs:120-127`).
7. Otherwise, prompt
   `Install optional codex login auto-snapshot hook in <path>? [y/N]`
   (`scripts/postinstall-login-hook.cjs:138`). Default answer is `N`.
8. On `y` / `yes`, append the block and inform the user
   (`scripts/postinstall-login-hook.cjs:145-147`).

The same logic, minus the prompt, is exposed as a library function in
`src/lib/config/login-hook.ts:68-94` and called by the
`authmux hook-install` command (`src/commands/hook-install.ts:18-32`).
Status and removal helpers are in
`src/lib/config/login-hook.ts:96-138`, surfaced as
`src/commands/hook-remove.ts` and `src/commands/hook-status.ts`.

### The hook block

The block written between
`# >>> authmux-login-auto-snapshot >>>` and
`# <<< authmux-login-auto-snapshot <<<` is defined in two places that must
be kept byte-identical:

* `scripts/postinstall-login-hook.cjs:23-50` (`renderHookBlock`)
* `src/lib/config/login-hook.ts:39-66` (`renderLoginHookBlock`)

The block defines two bash functions:

```sh
__codex_auth_restore_tty() {
  [[ -t 1 ]] || return 0
  local __tty_target=/dev/tty
  [[ -w "$__tty_target" ]] || __tty_target=/dev/stdout
  printf '<long escape sequence>' >"$__tty_target" 2>/dev/null || true
}
codex() {
  if command -v authmux >/dev/null 2>&1; then
    command authmux restore-session >/dev/null 2>&1 || true
  fi
  command codex "$@"
  local __codex_exit=$?
  if command -v authmux >/dev/null 2>&1; then
    CODEX_AUTH_FORCE_EXTERNAL_SYNC=1 command authmux status >/dev/null 2>&1 || true
  fi
  if [[ -z "${CODEX_AUTH_SKIP_TTY_RESTORE:-}" ]]; then
    __codex_auth_restore_tty
  fi
  return $__codex_exit
}
```

The escape sequence sent by `__codex_auth_restore_tty` clears modes:
`\033[>4m` (modifyOtherKeys reset), `\033[<u` (kitty keyboard pop),
`\033[?2026l` (synchronized output off), `\033[?1004l` (focus reporting off),
`\033[?1l` (cursor key application mode off),
`\033[?2004l` (bracketed paste off), `\033[?1000l` / `\033[?1002l` /
`\033[?1003l` / `\033[?1006l` / `\033[?1015l` (mouse reporting off),
`\033[?1049l` (leave alternate screen), `\033[0m` (SGR reset),
`\033[?25h` (cursor visible), `\033[H` (cursor home), `\033>` (keypad
numeric).

### Restore-session command

`src/commands/restore-session.ts` is a hidden internal command that simply
calls `this.accounts.restoreSessionSnapshotIfNeeded()`. The heavy lifting
is in `src/lib/accounts/account-service.ts:206` and the session-scope
resolution at `src/lib/accounts/account-service.ts:1384-1396`:

```ts
private resolveSessionScopeKey(): string | null {
  const explicit = process.env[SESSION_KEY_ENV]?.trim();
  if (explicit) {
    const sanitized = explicit.replace(/\s+/g, " ").slice(0, 160);
    return `session:${sanitized}`;
  }
  if (typeof process.ppid === "number" && process.ppid > 1) {
    return `ppid:${process.ppid}`;
  }
  return null;
}
```

`SESSION_KEY_ENV` is `CODEX_AUTH_SESSION_KEY`
(`src/lib/accounts/account-service.ts:55`). When unset, the session is
keyed by the PPID of the `authmux` process — which, because the shell
function calls `command authmux`, is the shell PID itself. That works for
a single terminal tab but breaks across tmux/screen reattachment, across
`exec bash`, and inside subshell pipelines.

### Liveness check

`isSessionPinnedToActiveCodex` at
`src/lib/accounts/account-service.ts:1537-1571` decides whether a stored
session pin should still apply. The rules:

* If `SESSION_ACTIVE_OVERRIDE_ENV` is set to a known truthy/falsy value,
  honor it.
* If the session key has prefix `session:` (explicit env), trust it
  unconditionally (`account-service.ts:1547-1549`).
* On non-Linux platforms, trust the PPID key unconditionally
  (`account-service.ts:1551-1553`).
* On Linux, walk `/proc/<ppid>/task/<ppid>/children` and check whether any
  child is `codex` (`account-service.ts:1555-1570`). Only then is the
  PPID-keyed session considered live.

### Parallel Claude Code aliases

A different rc-block grammar is used for Claude Code parallel profiles
(`src/commands/parallel.ts:114-143`):

* Markers: `# >>> agent-auth parallel >>>` /
  `# <<< agent-auth parallel <<<`.
* Body: one `alias claude-<name>="CLAUDE_CONFIG_DIR=<dir> command claude"`
  per profile directory under `~/.claude-accounts/`.

`scripts/claude-parallel-setup.sh:1-74` is a standalone bash duplicate of
that logic with its own marker grammar
(`# >>> codex-auth claude-parallel >>>`,
`# <<< codex-auth claude-parallel <<<`) — three distinct marker conventions
coexist in the repo today.

## Issues

### I-1 Postinstall TTY prompt risks in non-interactive npm installs

Evidence: `scripts/postinstall-login-hook.cjs:108` only skips the prompt
when both `stdin` and `stdout` are TTYs. The CI check at line 107 covers
`process.env.CI`, but many non-interactive contexts (Dockerfile `RUN npm
i -g`, Nix `npm-package-helpers`, `pnpm setup`, npm's own `--ignore-
scripts=false` jobs run under a wrapper, ssh exec with a pseudo-tty) do
*not* set `CI=true`. The `canPrompt` check guards the prompt but the
postinstall still executes `ensureBuiltDist()` at line 151, which can
spawn `tsc` or `npm exec` in a place where neither is available.

Diagnosis: Two problems are conflated here:

1. The build-from-source fallback
   (`scripts/postinstall-login-hook.cjs:67-102`) is a *separate* concern
   from the hook installation. It should not run for tarball installs at
   all, only for git installs that ship without `dist/`.
2. The TTY detection is necessary but not sufficient: a piped-into stdin
   on `npm i` (e.g. `yes | npm i -g authmux`) will report `isTTY = false`
   but the user's true intent may have been to opt out, not to skip
   silently.

Severity: P1, S.

### I-2 Bash + zsh only

Evidence: `targetShellRc` in
`scripts/postinstall-login-hook.cjs:17-21` and
`resolveDefaultShellRcPath` in
`src/lib/config/login-hook.ts:30-37` hard-code two shells. The hook block
itself uses bash-isms — `local`, `[[ ... ]]`, `${VAR:-}` — that fish,
nushell, and `cmd.exe` cannot evaluate. Even pure-POSIX `sh` users will
silently get a working block because bash and dash both accept the
`function-style codex() { ... }` syntax, but the `[[ -t 1 ]]` test will
fail under dash.

Diagnosis: There is no shell adapter layer. Every shell is treated as if
it were bash. Fish in particular requires `function codex; ...; end` and
`if test -t 1` and would currently see a block that prints syntax errors
on every shell start.

Severity: P1, M.

### I-3 Idempotent block management still has a TOCTOU window

Evidence: `installLoginHook` at `src/lib/config/login-hook.ts:68-94`
reads the rc file, decides between "refresh" and "append" based on
substring presence of the markers, then writes the file. There is no
locking. If two concurrent `npm i -g authmux` invocations (or
`hook-install` + a manual editor save) both reach the read step before
either writes, the second write can clobber the first or, more subtly,
produce a file with two adjacent blocks if the markers differ slightly
(e.g. trailing whitespace) and the regex misses one.

Diagnosis: `hookBlockRegex` at
`src/lib/config/login-hook.ts:19-23` is anchored only by the literal
marker strings. If a previous version had different marker text — or if
a user accidentally moved one of the markers — both blocks survive.

Severity: P2, S.

### I-4 Wrapping `codex` as a function breaks tooling

Evidence: `codex() { ... }` is defined unconditionally
(`src/lib/config/login-hook.ts:50-63`). Tools that do
`which codex`, `command -v codex`, IDE integrations that exec the binary
by absolute path, and any wrapper that does
`/usr/local/bin/codex --version` directly will all bypass the function
entirely. Worse, `type -a codex` inside the user's shell now reports the
function first — users debugging `codex` issues often have no idea their
shell has redefined the binary, and reach for `command codex` only after
extensive head-scratching.

Diagnosis: The shell-function wrapping pattern is the most invasive
possible integration. It claims a globally-visible identifier in every
new shell session and is hard to inspect (`declare -f codex` is
non-obvious).

Severity: P1, M.

### I-5 PPID-keyed sessions fail under tmux/screen attach/detach

Evidence: `resolveSessionScopeKey` at
`src/lib/accounts/account-service.ts:1384-1396` falls back to
`ppid:${process.ppid}` when `CODEX_AUTH_SESSION_KEY` is unset. The PPID
is the shell that ran the function — but if the user detaches a tmux
session, the shell continues with the same PID. Reattaching from a
different terminal makes that PID conceptually a different "session" even
though the key is unchanged. Inside subshells (`bash -c '...'`, command
substitution), the PPID changes and the session pin is silently lost.

The Linux liveness check at `account-service.ts:1555-1570` walks `/proc`
for the PPID's children and checks for `codex`. That works when
`restore-session` runs *before* `codex`, but the check is fired again
later (e.g. when `authmux status` is invoked by the post-hook) at which
point `codex` has exited and the session may be incorrectly marked
inactive.

Diagnosis: PPID is a brittle proxy for "what the user thinks of as their
terminal." There is no use of `$TERM_SESSION_ID` (macOS Terminal.app),
`$ITERM_SESSION_ID` (iTerm2), `$WT_SESSION` (Windows Terminal),
`$KITTY_PID` / `$KITTY_WINDOW_ID` (kitty), `$TMUX_PANE` (tmux),
`$STY` (GNU Screen), or any other terminal-emulator-provided stable
identifier.

Severity: P0, M.

### I-6 `stty sane` / escape-restore can mask real codex failures

Evidence: The post-hook unconditionally writes a long escape sequence
(`src/lib/config/login-hook.ts:48`) and re-enables the cursor. If `codex`
itself crashed with output mid-write (a half-rendered TUI frame, an error
message that contains its own CSI sequences), the restore sequence
overwrites or smears the error. Users see a clean prompt and assume
`codex` succeeded.

Diagnosis: The hook treats every exit as "TUI exit needs cleanup." It
should treat non-zero exits as "TUI exit but preserve scrollback intent"
— possibly by suppressing the alternate-screen leave (`?1049l`) when the
exit code is non-zero, or by writing the sequence *before* the exit code
is captured and then re-emitting a brief diagnostic.

Severity: P2, S.

### I-7 No diagnostic surface for "why didn't auto-snapshot fire"

Evidence: `authmux hook-status` (`src/commands/hook-status.ts:18-27`)
reports only `installed | not-installed` and the rc-file path. There is
no record of:

* The last time the hook actually fired.
* The last `CODEX_AUTH_FORCE_EXTERNAL_SYNC=1 authmux status` exit code.
* Whether `command -v authmux` resolved successfully inside the hook.
* Whether the user's shell is one the hook even supports.
* The current resolved session key (PPID vs. explicit env).

Users have no way to answer "I just logged in but my new account wasn't
captured — what went wrong?" without instrumenting the shell themselves.

Severity: P1, M.

### I-8 Three distinct marker grammars in the tree

Evidence:

* `# >>> authmux-login-auto-snapshot >>>` in
  `src/lib/config/login-hook.ts:5`.
* `# >>> agent-auth parallel >>>` in
  `src/commands/parallel.ts:121`.
* `# >>> codex-auth claude-parallel >>>` in
  `scripts/claude-parallel-setup.sh:9`.

Diagnosis: Each of these three blocks treats rc-file mutation as a
one-off. There is no shared library for "manage a marked block in a
config file." Removing one tool's block does not remove the others. A
user who migrated from the old `codex-auth` / `agent-auth` naming may
have stale blocks the current `authmux` never knows about.

Severity: P2, S.

### I-9 Markers are unversioned

Evidence: The markers do not include a schema version. The only signal
that a block is outdated is byte-for-byte comparison after re-rendering.
If a future release ships a block with new behavior (e.g. a new env var,
a new TTY restore sequence), users who already opted in will silently
get the new block on every postinstall — even when they explicitly opted
out of automation upgrades.

Diagnosis: Marker text like `# >>> authmux:hook v=1 >>>` would let the
tool detect "your installed block is v=1, current template is v=2" and
prompt before upgrading. It also enables forward-compatible removal: a
v=3 client can still find and remove a v=1 block left by an ancient
install.

Severity: P2, S.

### I-10 Postinstall and library duplicate the hook template

Evidence: The exact same block text is rendered in two places
(`scripts/postinstall-login-hook.cjs:23-50` and
`src/lib/config/login-hook.ts:39-66`). They must stay in sync manually.
A future maintainer editing only one is plausible.

Diagnosis: The postinstall script is `.cjs` and runs before `dist/` is
guaranteed to exist (it triggers the TypeScript build itself at line
68-102), so it can't import the library. The fix is either to compile
the template to a static `.txt` shipped in `scripts/` and read by both,
or to require `dist/` first and have postinstall delegate to a built
helper.

Severity: P2, S.

### I-11 Hermes mirror is hidden from the user

Evidence: `mirrorHermesCodexAuth`
(`src/lib/hermes-mirror.ts:20-52`) is called from `src/commands/switch.ts`
but never disclosed in any rc-file block, status command, or
`hook-status` output. A user with `~/Documents/hermes-agent` installed
gets implicit, undocumented sync behavior.

Diagnosis: Although Hermes is out of scope for this slice (covered in
the multi-CLI doc), the hook story is incomplete because the postinstall
prompt does not mention that opting in also activates Hermes mirroring
on every `switch`.

Severity: P3, S.

## Proposals

Each proposal follows the Evidence / Diagnosis / Proposal / Migration /
Rollout shape and carries a priority tag (`P0`-`P3`) and a size tag
(`S`/`M`/`L`/`XL`).

### P-1 PATH-shim instead of shell function

Priority: P0. Size: M.

Evidence: I-4 above.

Diagnosis: The function-wrap pattern intercepts the `codex` identifier
at shell level only. A PATH shim — a tiny executable placed earlier in
PATH than the real `codex` binary — intercepts every caller, including
non-shell ones, while remaining invisible to `which` once the user looks
at the link target.

Proposal: Ship two artifacts.

**Posix shim (`~/.local/bin/codex`):**

```sh
#!/usr/bin/env sh
# authmux:shim v=1
authmux_bin="$(command -v authmux 2>/dev/null || true)"
if [ -n "$authmux_bin" ]; then
  "$authmux_bin" restore-session >/dev/null 2>&1 || true
fi

real_codex="$(authmux resolve-binary codex 2>/dev/null || command -v -p codex || true)"
if [ -z "$real_codex" ] || [ "$real_codex" = "$0" ]; then
  echo "authmux shim: cannot locate real codex binary" >&2
  exit 127
fi

"$real_codex" "$@"
exit_code=$?

if [ -n "$authmux_bin" ]; then
  CODEX_AUTH_FORCE_EXTERNAL_SYNC=1 "$authmux_bin" status >/dev/null 2>&1 || true
fi

if [ -z "${CODEX_AUTH_SKIP_TTY_RESTORE:-}" ] && [ -t 1 ]; then
  "$authmux_bin" tty restore >/dev/null 2>&1 || true
fi

exit $exit_code
```

**Windows shim (`%LOCALAPPDATA%\authmux\bin\codex.cmd`):**

```bat
@echo off
setlocal
where authmux >NUL 2>&1
if %ERRORLEVEL% EQU 0 authmux restore-session >NUL 2>&1
for /f "delims=" %%i in ('authmux resolve-binary codex 2^>NUL') do set REAL_CODEX=%%i
if "%REAL_CODEX%"=="" goto :no_codex
"%REAL_CODEX%" %*
set CODEX_EXIT=%ERRORLEVEL%
set CODEX_AUTH_FORCE_EXTERNAL_SYNC=1
authmux status >NUL 2>&1
exit /b %CODEX_EXIT%
:no_codex
echo authmux shim: cannot locate real codex binary 1>&2
exit /b 127
endlocal
```

The shim depends on a new internal command `authmux resolve-binary <name>`
that walks `PATH` and skips any entry equal to its own resolved location,
returning the next match. This eliminates the recursion risk that plain
`command -v codex` would re-resolve back to the shim.

Migration: Ship `P-1` alongside the existing function-based hook
behind an opt-in flag `--shim` on `authmux hook-install`. Document a
manual cutover. In a later release, flip the default and emit a
deprecation notice when the function-based block is detected.

Rollout: Feature-flagged in v0.X. Default in v0.(X+2). Function-based
block removable via `authmux hook-remove` for the next two minor
versions; thereafter `authmux hook-remove` only removes the legacy form
if it detects it (block markers carry version tags per P-7 below).

### P-2 First-class shell adapters

Priority: P1. Size: M.

Evidence: I-2 above.

Diagnosis: Add a `ShellAdapter` abstraction that owns
(a) the rc-file location, (b) the syntax for defining the hook, and
(c) the syntax for setting env-prefixed aliases (used by the parallel
Claude Code feature).

Proposal: Define five adapters with concrete templates.

```ts
// src/lib/shell/types.ts
export interface ShellAdapter {
  readonly id: "bash" | "zsh" | "fish" | "nushell" | "pwsh";
  readonly displayName: string;
  rcFilePath(): string;
  renderHookBlock(opts: HookBlockOptions): string;
  renderAlias(name: string, command: string, env: Record<string, string>): string;
  markerStart(version: number): string;
  markerEnd(version: number): string;
  blockRegex(): RegExp;
}
```

Per-shell template snippets:

```fish
# fish: ~/.config/fish/config.fish
# >>> authmux:hook v=2 >>>
function __authmux_restore_tty
    isatty stdout; or return 0
    set -l tty /dev/tty
    test -w $tty; or set tty /dev/stdout
    printf '<escape sequence>' >$tty 2>/dev/null
end

function codex
    if type -q authmux
        command authmux restore-session >/dev/null 2>&1
    end
    command codex $argv
    set -l __codex_exit $status
    if type -q authmux
        set -lx CODEX_AUTH_FORCE_EXTERNAL_SYNC 1
        command authmux status >/dev/null 2>&1
    end
    if test -z "$CODEX_AUTH_SKIP_TTY_RESTORE"
        __authmux_restore_tty
    end
    return $__codex_exit
end
# <<< authmux:hook v=2 <<<
```

```nu
# nushell: $nu.config-path or `~/.config/nushell/config.nu`
# >>> authmux:hook v=2 >>>
def codex [...args] {
  if (which authmux | is-not-empty) {
    do { authmux restore-session } | complete | ignore
  }
  let __codex_exit = (do { ^codex ...$args } | complete)
  if (which authmux | is-not-empty) {
    with-env [CODEX_AUTH_FORCE_EXTERNAL_SYNC 1] {
      do { authmux status } | complete | ignore
    }
  }
  exit $__codex_exit.exit_code
}
# <<< authmux:hook v=2 <<<
```

```ps1
# pwsh: $PROFILE
# >>> authmux:hook v=2 >>>
function codex {
    if (Get-Command authmux -ErrorAction SilentlyContinue) {
        & authmux restore-session | Out-Null
    }
    & "$($env:CODEX_REAL_BIN ?? (Get-Command -CommandType Application codex | Select-Object -First 1 -ExpandProperty Source))" @args
    $exit = $LASTEXITCODE
    if (Get-Command authmux -ErrorAction SilentlyContinue) {
        $env:CODEX_AUTH_FORCE_EXTERNAL_SYNC = "1"
        & authmux status | Out-Null
        Remove-Item Env:\CODEX_AUTH_FORCE_EXTERNAL_SYNC -ErrorAction SilentlyContinue
    }
    exit $exit
}
# <<< authmux:hook v=2 <<<
```

Detection logic (in priority order):

1. `--shell <id>` explicit flag on `hook-install`.
2. Env var `AUTHMUX_SHELL`.
3. `SHELL` basename match (`fish` / `zsh` / `bash`).
4. PowerShell: `$PSVersionTable` presence or
   `process.env.PSModulePath` heuristic.
5. nushell: presence of `nu` in PATH and absence of any of the above
   strong signals (last resort).
6. Default: bash.

Migration: Detect installed-block grammars and refuse to install a
second block in a different shell rc. A user with both bash and fish
gets two blocks only if they explicitly request both via
`authmux hook-install --shell bash --shell fish`.

Rollout: Phase 1 — add fish and pwsh templates behind explicit
`--shell` flag. Phase 2 — auto-detect at install time. Phase 3 — auto-
detect at every `authmux update` and refresh the matching block.

### P-3 Stable session-key strategy

Priority: P0. Size: M.

Evidence: I-5 above.

Diagnosis: A session key must (a) survive subshells, (b) survive tmux
detach/reattach, (c) differ across tabs of the same emulator, (d) be
cheap to read on every command. No single env var meets all of these on
all platforms.

Proposal: Implement a layered resolver in
`src/lib/accounts/account-service.ts`:

```ts
private resolveSessionScopeKey(): string | null {
  const explicit = process.env.CODEX_AUTH_SESSION_KEY?.trim();
  if (explicit) return `session:${sanitize(explicit)}`;

  // Layer 1: well-known emulator-provided identifiers (most stable).
  const known = [
    ["term", process.env.TERM_SESSION_ID],     // Terminal.app
    ["iterm", process.env.ITERM_SESSION_ID],   // iTerm2
    ["wt", process.env.WT_SESSION],            // Windows Terminal
    ["kitty", process.env.KITTY_WINDOW_ID],    // kitty
    ["wezterm", process.env.WEZTERM_PANE],     // wezterm
    ["tmux", process.env.TMUX_PANE],           // tmux
    ["screen", process.env.STY],               // GNU screen
  ] as const;
  for (const [tag, value] of known) {
    if (value && value.trim()) return `${tag}:${sanitize(value)}`;
  }

  // Layer 2: TTY-file-keyed persistent UUID.
  const ttyId = this.tryReadTtyId();   // see helper below
  if (ttyId) return `tty:${ttyId}`;

  // Layer 3: PPID (legacy fallback).
  if (typeof process.ppid === "number" && process.ppid > 1) {
    return `ppid:${process.ppid}`;
  }
  return null;
}
```

The `tryReadTtyId` helper writes a UUID to
`$XDG_RUNTIME_DIR/authmux/tty/<basename of $(tty)>` on first call and
reads it on subsequent calls. When the TTY is closed and reused, the
kernel reassigns the same device path and we want a fresh UUID — so the
file is touched at every read and a cleanup pass evicts entries older
than 24h.

Add a public debug command:

```text
authmux session id
  resolved: tmux:%1
  layer: tmux ($TMUX_PANE)
  ppid: 4129
  tty: /dev/pts/3
  cached pins: 12 (oldest 6h ago)
```

Migration: Existing `ppid:` keys in the session map at
`resolveSessionMapPath()` will not match new keys. Add a one-time
migration that rewrites the active session's `ppid:` entry to the
freshly-resolved layered key on first run after upgrade.

Rollout: Ship as additive behavior; do not delete the PPID branch. New
sessions get layered keys; old `ppid:N` entries time out via existing
liveness checks.

### P-4 `authmux hook diag` diagnostic command

Priority: P1. Size: S.

Evidence: I-7 above.

Diagnosis: Users need a single command that prints everything relevant
to "did the hook fire and did it succeed."

Proposal: Add `src/commands/hook-diag.ts` that prints:

```text
authmux hook diag
  shell.detected: zsh (from $SHELL)
  shell.rc: /home/user/.zshrc (exists, 12.4 KB)
  hook.installed: yes
  hook.version: v=2
  hook.checksum.local: sha256:abc123… (matches latest template)
  shim.installed: yes
  shim.path: /home/user/.local/bin/codex
  shim.precedes-real: yes (/home/user/.local/bin first in PATH)
  session.key: tmux:%3
  session.layer: tmux ($TMUX_PANE)
  session.last-fire: 2026-05-17T09:18:33Z (4m ago)
  session.last-exit: 0
  external-sync.last-fire: 2026-05-17T09:18:35Z
  external-sync.last-exit: 0
  external-sync.last-error: (none)
  warnings: []
```

The "last-fire" timestamps come from a per-session ring buffer at
`$XDG_STATE_HOME/authmux/hook-log.jsonl`, populated by `restore-session`
and `status` whenever `CODEX_AUTH_FORCE_EXTERNAL_SYNC=1` is set.

Migration: New JSONL file is created lazily; absence renders as
`(no records)` instead of an error.

Rollout: Ship with `--quiet` and `--json` modes to keep parseable by
CI / Guardex skill checks.

### P-5 Default to *not* writing hook in non-TTY contexts

Priority: P1. Size: S.

Evidence: I-1 above.

Diagnosis: The current postinstall already skips on non-TTY, but does
not communicate *that* it skipped. Users who scripted `npm i -g authmux`
into a Dockerfile see no instruction telling them how to wire the hook
later.

Proposal: When `canPrompt` is false and the hook is not installed,
print exactly one line to stderr:

```text
authmux: shell hook not installed (non-interactive). Run `authmux hook-install` to enable login auto-snapshot.
```

When `canPrompt` is true but the user declines, write a marker file at
`$XDG_STATE_HOME/authmux/postinstall-skip` so subsequent installs do not
re-prompt; document `--reinstall-hook` to opt back in.

Migration: None — additive.

Rollout: Behavior change is a single stderr line and a marker file; no
breaking surface.

### P-6 Block content carries a checksum

Priority: P2. Size: S.

Evidence: I-9 above plus the file-mutation safety concern raised in
later "Security" section.

Diagnosis: A user who manually edits the hook block today gets their
edits silently clobbered on the next `npm i -g authmux` because the
refresh path at `src/lib/config/login-hook.ts:79-88` overwrites without
comparison. Embedding a `# checksum: sha256:…` line lets the installer
detect "this block was hand-edited" and refuse to refresh without
`--force`.

Proposal: Append a final line inside the block:

```sh
# >>> authmux:hook v=2 >>>
# checksum: sha256:6f3c9...
<body>
# <<< authmux:hook v=2 <<<
```

On install/refresh:

1. Read the block.
2. Strip the `# checksum:` line.
3. Compute `sha256(remaining body)`.
4. If declared and computed differ, the block was hand-edited.
5. Without `--force`, print a diff and abort.

Migration: Old v=1 blocks have no checksum; treat absent checksum as
"please upgrade me" rather than "hand-edited."

Rollout: Single release. Document the `--force` flag and the
`hook-diag` field that shows the checksum status.

### P-7 Versioned hook block markers

Priority: P2. Size: S.

Evidence: I-9 above.

Diagnosis: Migrating between marker conventions is currently free-form;
detection happens via substring search which is order-dependent.

Proposal: Adopt `# >>> authmux:hook v=N >>>` /
`# <<< authmux:hook v=N <<<` where `N` is an integer. The installer
recognises all known historical versions and can remove/refresh any of
them, but only writes the latest version. The marker regex becomes:

```ts
const HOOK_MARKER_RE = /# >>> authmux:hook v=(\d+) >>>[\s\S]*?# <<< authmux:hook v=\1 <<</g;
```

Map of historical markers to migrate:

| Historical marker                                  | Treated as | Action on upgrade        |
| -------------------------------------------------- | ---------- | ------------------------ |
| `# >>> authmux-login-auto-snapshot >>>`            | v=1        | Remove, replace with vN. |
| `# >>> codex-auth claude-parallel >>>`             | parallel-v1 | Remove, replace with parallel-v2. |
| `# >>> agent-auth parallel >>>`                    | parallel-v1 | Remove, replace with parallel-v2. |

Migration: Implement an `authmux hook migrate` command that walks the
detected rc file, dedupes any duplicates, and rewrites all known
historical markers to the latest grammar. Idempotent.

Rollout: Add to `authmux update` as an opt-in step; print "Run
`authmux hook migrate` to upgrade your rc-file block(s)."

### P-8 Centralize rc-file block management

Priority: P2. Size: M.

Evidence: I-8 above.

Diagnosis: Three rc-file manipulators exist
(`scripts/postinstall-login-hook.cjs`, `src/lib/config/login-hook.ts`,
`src/commands/parallel.ts`) plus a shell duplicate
(`scripts/claude-parallel-setup.sh`).

Proposal: Extract a single `src/lib/shell/rc-block-manager.ts` that
exposes:

```ts
export interface RcBlock {
  ownerId: string;          // e.g. "hook" | "parallel-claude" | "parallel-codex"
  version: number;
  body: string;
}
export interface RcBlockManager {
  list(rcPath: string): Promise<RcBlock[]>;
  upsert(rcPath: string, block: RcBlock): Promise<"installed" | "updated" | "unchanged">;
  remove(rcPath: string, ownerId: string): Promise<"removed" | "not-found">;
  removeAll(rcPath: string): Promise<number>;   // count removed
}
```

The marker grammar becomes:
`# >>> authmux:<ownerId> v=<version> >>>` /
`# <<< authmux:<ownerId> v=<version> <<<`.

Migration: Rewrite the three existing manipulators against this API.
Drop `scripts/claude-parallel-setup.sh` from the install path; keep it
only as an emergency offline tool with a deprecation header.

Rollout: New library shipped first as internal; commands ported in
sequence. No user-visible behavior change.

### P-9 Hermes / Kiro inclusion in hook diagnostics

Priority: P3. Size: S.

Evidence: I-11 above.

Diagnosis: Hook integration is currently invisible for adjacent
providers. Once the multi-CLI provider story (file 09) lands, the hook
fires extra logic per provider; the diagnostic should reflect that.

Proposal: Extend `authmux hook diag` to list per-provider sync status:

```text
  providers:
    codex:    sync=ok       last-fire=4m ago
    kiro:     sync=skipped  reason="kiro-cli not installed"
    hermes:   sync=ok       last-fire=4m ago
    claude:   sync=n/a      (no hook integration; uses parallel aliases)
```

Migration: Trivial once the provider-adapter list is queryable.

Rollout: Block until provider adapter abstraction (file 09) is at
least Phase 1.

## Cross-platform install matrix

Each row describes the *current* behavior on the left and the *target*
behavior under proposals P-1 through P-5 on the right. Rows in italics
are not currently functional and would be new capabilities.

| OS / shell                       | Today (postinstall)                          | Today (hook-install)                          | Target                                                                 |
| -------------------------------- | -------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| macOS / zsh                      | Prompts; writes `~/.zshrc`                   | Writes `~/.zshrc`                             | PATH-shim + optional zsh block (v=2)                                   |
| macOS / bash                     | Prompts; writes `~/.bashrc`                  | Writes `~/.bashrc`                            | PATH-shim + optional bash block (v=2)                                  |
| *macOS / fish*                   | *Misdetects as bash, writes `~/.bashrc`*     | *Misdetects as bash*                          | Detect via `$SHELL=*fish*`; write `~/.config/fish/config.fish`         |
| Linux / bash                     | Prompts; writes `~/.bashrc`                  | Writes `~/.bashrc`                            | PATH-shim + bash block                                                 |
| Linux / zsh                      | Prompts; writes `~/.zshrc`                   | Writes `~/.zshrc`                             | PATH-shim + zsh block                                                  |
| *Linux / fish*                   | *Misdetects as bash*                         | *Misdetects as bash*                          | Detect via `$SHELL=*fish*`; write fish config                          |
| *Linux / nushell*                | *Misdetects as bash*                         | *Misdetects as bash*                          | Detect via `nu` in PATH; write `$nu.config-path`                       |
| Windows / pwsh                   | Skips (no `npm_config_global` TTY assumed)   | Misdetects rc as `~/.bashrc`                  | Write `%LOCALAPPDATA%\authmux\bin\codex.cmd` shim; optional `$PROFILE` |
| *Windows / git-bash*             | *May write `~/.bashrc` inside MinGW HOME*    | *Same*                                        | PATH-shim under `$HOME/bin/codex`; bash block honored                  |
| *Windows / cmd.exe*              | *No hook at all*                             | *No hook*                                     | PATH-shim only (`codex.cmd` in `%LOCALAPPDATA%\authmux\bin`)           |
| CI (CI=true)                     | Skip prompt; print follow-up?                | Operator-driven; works                        | Skip prompt; print follow-up; honor `--shim`                           |
| Docker `RUN npm i -g`            | Skip prompt; *silent*                        | Operator-driven; works                        | Print follow-up; recommend shim install in same RUN                    |
| `npm i -g` with stdin redirected | Skip prompt; *silent*                        | Operator-driven; works                        | Print follow-up                                                        |

## Testing

The shell-integration surface is hard to test because it spans rc-file
mutation, real `bash`/`zsh`/`fish` parsing, real `codex` invocation,
and PPID semantics. A layered test plan:

### Unit tests

* **rc-block manager** (`P-8`): given a fixture rc file, `upsert`
  produces the expected normalized output, removes any older-grammar
  blocks for the same owner, leaves user content unchanged.
* **hook-block regex** (`src/lib/config/login-hook.ts:19-23` and its
  versioned successor): does not match partial markers; does not eat
  surrounding user content; is idempotent under repeated `upsert`.
* **session-key resolver** (P-3): table-driven test over a matrix of
  env-var combinations producing the expected key layer.
* **checksum** (P-6): a hand-edited body fails verification; pristine
  body passes; checksum line stripping is order-independent.

### Snapshot tests

* For each (`shell × hook-version`) pair, render the block to a string
  and snapshot it. The snapshots live in
  `tests/golden/hook-blocks/<shell>-v<version>.txt`. Any change to the
  block requires updating the snapshot, which surfaces in code review.

### Integration tests

* Spawn a real `bash --noprofile --norc -c 'source <fixture-rc>; type codex'`
  and assert the function is defined.
* Spawn `bash -c 'source <fixture-rc>; codex --help'` against a
  stub `codex` binary on `PATH`; assert that the stub was called and
  that the post-hook attempted to run `authmux status` with
  `CODEX_AUTH_FORCE_EXTERNAL_SYNC=1`.
* Repeat for `zsh` and `fish` using a Docker-based matrix
  (existing CI infrastructure permitting).

### End-to-end tests

* Bring up a tmux session, attach from two different terminals, run
  `codex` in each, assert each terminal retains its own session pin.
* Detach and reattach the tmux session; assert the pin survives.
* Open a subshell (`bash -c 'codex --help'`) inside an already-pinned
  shell; assert the subshell inherits the pin via the layered session
  key.

### Lint / chaos tests

* "Idempotent install" lint: run `authmux hook-install` ten times
  against a fresh rc file; assert the file contains exactly one block
  and exactly one trailing newline.
* "Partial corruption" chaos: delete the end marker mid-block from the
  rc file; assert the next install refuses to write and prompts for
  `--force`.
* "Concurrent install" chaos: launch two `hook-install` processes
  simultaneously; assert no duplicate block ends up in the file.

### Fixtures

* `tests/fixtures/rc/empty.bashrc`
* `tests/fixtures/rc/pristine-v1.bashrc`
* `tests/fixtures/rc/pristine-v2.bashrc`
* `tests/fixtures/rc/mixed-v1-and-parallel.bashrc`
* `tests/fixtures/rc/hand-edited-checksum-fail.bashrc`
* `tests/fixtures/rc/duplicate-blocks.bashrc`
* `tests/fixtures/rc/dos-line-endings.bashrc`

## Security

The shell-integration surface touches files outside `~/.codex` and
executes code on every new shell session. The threat model includes
both accidental damage (silent overwrite of user content) and active
attack (malicious npm package replacing the hook body).

### S-1 Refuse to mutate rc files outside `$HOME`

Evidence: `installLoginHook` accepts an arbitrary `rcPath` argument
(`src/lib/config/login-hook.ts:68`). The `hook-install` command exposes
`--shellRc` (`src/commands/hook-install.ts:11-15`) with no path
validation. A misconfigured invocation could write to `/etc/profile` or
any other writable path.

Proposal: Validate that `path.resolve(rcPath)` starts with
`os.homedir()` unless `--allow-outside-home` is also passed and the
caller is a TTY operator. Reject paths under `/etc`, `/usr`, `/var`,
`/opt`, and all of `C:\Windows`, `C:\ProgramData`, `C:\Program Files`,
`C:\Program Files (x86)` on Windows.

### S-2 Refuse to overwrite non-managed blocks

Evidence: Per P-6, the current refresh path silently rewrites the
block, losing user edits. A malicious npm package could trivially
inject a different hook body that runs on every new shell.

Proposal: Combine P-6's checksum with strict ownership detection:

1. Block must contain `# >>> authmux:<ownerId> v=<n> >>>` markers.
2. Block must contain `# checksum: sha256:<hex>`.
3. Body must hash to the declared checksum, OR the new block being
   installed is byte-identical to the existing body.
4. Otherwise, abort with a diff and require `--force`.

### S-3 Signed-block opt-in

Proposal (P3): A `# authmux-key: <fingerprint>` line inside the block
references a public key that signed the block body. The signature is
written as `# signature: <base64>`. On refresh, the installer verifies
the signature using a key bundled with the npm package; if verification
fails, the block is treated as foreign and the refresh refuses.

Trade-off: This protects against a third-party `postinstall` script
attempting to impersonate authmux, but requires shipping a public key
in the package and rotating it on every signing-key change. Defer
until the broader signed-release story is in place.

### S-4 Shim must not introduce path-traversal

Evidence (proposed P-1): The shim resolves the real `codex` binary via
`authmux resolve-binary codex`. That command must explicitly exclude
its own resolved location to prevent loops, and must reject any path
not on `PATH` (no `..` traversal, no relative resolution against `cwd`).

Proposal: `resolve-binary` walks `process.env.PATH` segments in order,
calls `fs.realpath` on each candidate, and rejects any whose realpath
equals the shim's own realpath. Returns the first surviving match.
Exits 1 if none. Refuses to follow any path that contains `..`
post-resolution.

### S-5 Restore-sequence safety

Evidence: The TTY restore writes to `/dev/tty` directly. On Linux that
device is always owned by the controlling terminal user, so injection
is not a concern, but on shared systems (multi-user servers, jump
boxes) a misconfigured `/dev/tty` permission could mean the bytes
land somewhere unexpected.

Proposal: Wrap the restore in `if [[ -w /dev/tty && -O /dev/tty ]];
then …; fi` to require the user to own the TTY device. Document
`CODEX_AUTH_SKIP_TTY_RESTORE=1` as the canonical opt-out.

### S-6 Postinstall must not exec arbitrary npm during install

Evidence: `ensureBuiltDist` at
`scripts/postinstall-login-hook.cjs:67-102` may shell out to
`npm exec --yes --package typescript@5.6.3 -- tsc`. This downloads and
executes a TypeScript compiler at install time, defeating offline
installs and surprising security scanners.

Proposal: Confine the fallback build to git installs only. Detect git
install via the absence of `dist/index.js` AND the presence of
`.git/` (i.e. install from source rather than from tarball). Tarball
installs that lack `dist/` should hard-fail with a clear "your tarball
is broken; reinstall from npm" message rather than invoke `npm exec`.

## Compatibility and rollout sequence

The proposals interact. A workable rollout order is:

1. **P-8** (rc-block manager) and **P-7** (versioned markers) land
   together. No user-visible change beyond a new internal API.
2. **P-6** (checksum) layered on top. Existing blocks treated as v=1
   and untouched until a user runs `hook-install --upgrade`.
3. **P-4** (`hook diag`) shipped as a read-only diagnostic. Safe.
4. **P-3** (layered session keys) shipped behind a feature flag
   `AUTHMUX_SESSION_KEY_STRATEGY=layered`. Default remains PPID for one
   release.
5. **P-5** (non-TTY behavior) and **P-2** (fish/pwsh/nushell adapters)
   ship in parallel; both are additive.
6. **P-1** (PATH shim) ships as opt-in via
   `authmux hook-install --shim`. After two releases of soak, the
   default for new installs flips to shim. The shell-function block is
   retained for two more releases for users who explicitly prefer it.
7. **P-9** (provider sync rows in `hook diag`) blocked on file 09.

Throughout: keep `authmux hook-remove` capable of removing **every**
historical marker grammar (`authmux-login-auto-snapshot`,
`authmux:hook v=1`, `authmux:hook v=2`, `agent-auth parallel`,
`codex-auth claude-parallel`). The removal command is the user's only
escape hatch and must remain comprehensive.

## Open questions

* Should the shim install location be configurable, or always
  `~/.local/bin` on Posix? Some distros (Arch) prepend `~/.local/bin`
  by default; others (Debian, some macOS setups) do not. A naive
  install may not actually intercept `codex` calls if the directory is
  not on PATH. The diag command must detect this and warn loudly.
* Should `authmux` install a `~/.local/bin/claude` shim equivalent for
  parallel Claude Code accounts, sourcing the active profile from a
  state file rather than from a per-alias env? That would eliminate
  the `claude-work` / `claude-personal` alias proliferation and let
  users keep typing `claude` while authmux multiplexes. Defer to file
  09 for the broader provider-shim discussion.
* For PowerShell users, is `$PROFILE` always the right target, or
  should we target `$PROFILE.CurrentUserAllHosts` to cover both ISE
  and Core? Empirically, most modern users only have Core; ISE is
  effectively deprecated. Recommendation: target
  `$PROFILE.CurrentUserCurrentHost` and document the override.
* Does the function-wrap pattern actually fail in any IDE we care
  about? VS Code's integrated terminal runs the user's shell, so the
  function survives. JetBrains terminals also work. The case that
  fails is "external launcher spawns `codex` directly" — e.g. an MCP
  client, a CI runner, a third-party wrapper. Confirm with a survey of
  the top ten downstream callers before committing to P-1's default
  flip.
