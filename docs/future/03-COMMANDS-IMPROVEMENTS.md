# 03 — Commands Improvements

Scope: every file under `src/commands/`. The companion files `01-ACCOUNTS-AND-CONFIG-IMPROVEMENTS.md` and `02-CORE-LIBRARY-IMPROVEMENTS.md` cover the library side; this file focuses on the CLI surface — what users actually type, what they see, what exit codes they get, and how the commands wire up to the libraries.

Per-command structure:

1. UX critique (with line refs).
2. Behaviour gaps and edge cases.
3. Proposed flag changes (with a deprecation table).
4. Output format proposal (human, `--json`, `--quiet`, exit codes).
5. Test plan referencing `src/tests/`.
6. Priority + effort.

Priority tags: `P0` (correctness), `P1` (next release), `P2` (this quarter), `P3` (nice to have). Effort: `S` (≤1 day), `M` (2–4 days), `L` (1–2 weeks), `XL` (>2 weeks).

The final section, **Cross-command concerns**, captures consistent flag handling, prompts, error mapping, config-dir override, and localisation-ready strings.

---

## Command surface inventory

| Command                   | File path                                   | Current responsibility                                                   | Flags                                            | Depends on (lib)                                                                 |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `authmux auto-switch`     | `src/commands/auto-switch.ts:6`             | Pick the "best" account by health and activate it.                       | none                                              | `account-service`, `account-health`, `account-savings`                            |
| `authmux check`           | `src/commands/check.ts:5`                   | Print pool-health summary plus per-account health.                       | none                                              | `account-service`, `account-health`                                               |
| `authmux clean`           | `src/commands/clean.ts:9`                   | Delete `.bak`/`.backup` files and broken symlinks under `~/.codex/accounts/` and `~/.codex/`. | none                                              | direct `node:fs`                                                                  |
| `authmux config`          | `src/commands/config.ts:4`                  | Manage auto-switch + usage API config.                                   | `--5h`, `--weekly`                                | `account-service`                                                                 |
| `authmux current`         | `src/commands/current.ts:3`                 | Print the active account name (or a friendly message).                   | none                                              | `account-service`                                                                 |
| `authmux daemon`          | `src/commands/daemon.ts:4`                  | Run the auto-switch loop once (`--once`) or continuously (`--watch`).    | `--watch`, `--once`                               | `account-service`                                                                 |
| `authmux export`          | `src/commands/export.ts:8`                  | Copy every `*.json` snapshot to a directory.                             | none (positional `dir`)                           | direct `node:fs`                                                                  |
| `authmux forecast`        | `src/commands/forecast.ts:5`                | Print best-first health ranking.                                         | none                                              | `account-service`, `account-health`                                               |
| `authmux hero`            | `src/commands/hero.ts:3`                    | ANSI-coloured marketing/tutorial card. `static hidden = true`.           | none                                              | none                                                                              |
| `authmux hook-install`    | `src/commands/hook-install.ts:5`            | Install or refresh the optional shell hook (sync/restore).               | `-f` shellRc                                      | `config/login-hook`                                                               |
| `authmux hook-remove`     | `src/commands/hook-remove.ts:5`             | Remove the shell hook.                                                   | `-f` shellRc                                      | `config/login-hook`                                                               |
| `authmux hook-status`     | `src/commands/hook-status.ts:5`             | Report whether the shell hook is installed.                              | `-f` shellRc                                      | `config/login-hook`                                                               |
| `authmux import`          | `src/commands/import.ts:8`                  | Import a single file / dir of files into `~/.codex/accounts/`; `--purge` rebuilds the registry. | `--alias`, `--purge`                              | direct `node:fs`                                                                  |
| `authmux kiro`            | `src/commands/kiro.ts:27`                   | Interactive / direct Kiro-CLI snapshot switcher.                         | `--new`                                           | direct `node:fs` (duplicates `lib/kiro-mirror.ts`)                                |
| `authmux kiro-login`      | `src/commands/kiro-login.ts:24`             | `kiro-cli login` then promote `data.sqlite3` to a named snapshot + symlink. | `-n` name                                         | direct `node:fs`, `execSync`                                                      |
| `authmux list`            | `src/commands/list.ts:15`                   | List accounts; show usage; offer self-update interactively.              | `-d` details                                       | `account-service`, `update-check`, `accounts/plan-display`                        |
| `authmux login`           | `src/commands/login.ts:8`                   | Run `codex login`, wait for snapshot, save it.                           | `--device-auth`, `-f` force                       | `account-service`, `accounts/auth-parser`, `config/paths`                         |
| `authmux parallel`        | `src/commands/parallel.ts:22`               | Manage `~/.claude-accounts/<name>` profiles + install shell aliases.     | `--add`, `--remove`, `--list`, `--aliases`, `--install` | direct `node:fs`                                                                  |
| `authmux remove`          | `src/commands/remove.ts:11`                 | Interactive multi-select / query / `--all` delete.                       | `-a` all                                          | `account-service`                                                                 |
| `authmux restore-session` | `src/commands/restore-session.ts:3`         | Internal helper: restore the session-pinned snapshot. `static hidden`.   | none                                              | `account-service`                                                                 |
| `authmux save`            | `src/commands/save.ts:4`                    | Save current `~/.codex/auth.json` as a named account (or infer the name). | `-f` force                                        | `account-service`                                                                 |
| `authmux savings`         | `src/commands/savings.ts:4`                 | Print switch counters and a cooldown-saved estimate.                     | none                                              | `account-savings`                                                                 |
| `authmux status`          | `src/commands/status.ts:3`                  | Print auto-switch + service + thresholds + usage mode.                   | none                                              | `account-service`                                                                 |
| `authmux switch`          | `src/commands/switch.ts:11`                 | Pick an account interactively or by query; mirror to Kiro + Hermes.     | `--live`, `--skip-api`, `--no-kiro`               | `account-service`, `account-health`, `account-savings`, `usage-refresh`, `kiro-mirror`, `hermes-mirror` |
| `authmux update`          | `src/commands/update.ts:15`                 | Check npm, optionally reinstall.                                         | `--check`, `-r` reinstall, `-y` yes               | `update-check`                                                                    |
| `authmux use`             | `src/commands/use.ts:9`                     | Switch active account; mirror to Kiro (only).                            | `--no-kiro`                                       | `account-service`, `account-health`, `account-savings`, `kiro-mirror`             |

A few cross-cutting observations from the inventory itself:

- Two commands switch accounts (`use`, `switch`). One mirrors to Kiro only, the other mirrors to both Kiro and Hermes. The split is historical, not principled — see the `switch` section.
- Two commands manage Kiro accounts (`kiro`, `kiro-login`) using direct `node:fs` calls that duplicate `src/lib/kiro-mirror.ts`. They predate the library.
- Ten commands (`auto-switch`, `check`, `clean`, `export`, `forecast`, `hero`, `import`, `kiro`, `kiro-login`, `parallel`, `savings`) extend `Command` directly instead of `BaseCommand`, so they skip the shared error normalisation and the `syncExternalAuthSnapshotIfNeeded` hook. Half of them touch account state, so the missing sync is a real bug, not just stylistic drift.
- No command has `--json`, `--quiet`, or `--config-dir`. Every command writes English-language strings inline.
- Most commands check for a TTY only implicitly (via `prompts` failing to read from a closed stdin). The two that check explicitly (`remove.ts:71`, `list.ts:75`) do it inconsistently.

These themes drive both the per-command sections and the **Cross-command concerns** at the bottom.

---

## authmux save

### UX critique

`src/commands/save.ts` is small (46 lines) and reads cleanly. A few rough edges:

- The success message at `src/commands/save.ts:43` always says "Saved current Codex auth tokens as ...". When `--force` overwrites an existing snapshot, the user gets no signal that they replaced something. They cannot tell after the fact whether the snapshot they just saved was new or a clobber.
- The suffix logic (`src/commands/save.ts:35-42`) cascades a three-level conditional that the reader has to parse to recognise the four sources (`explicit`, `active`, `existing`, inferred). This should be a table or a dedicated `describeNameSource(source): string` helper.
- The error from `accounts.saveAccount` when the existing snapshot belongs to a different email currently surfaces through `CodexAuthError`, but it doesn't tell the user the email it found vs the email it expected. Hard to debug a clobber refusal.
- No confirmation prompt before overwriting in non-`--force` mode for the "existing matching name" case. The asymmetry is fine, but the help text doesn't explain it.

### Behaviour gaps and edge cases

**Evidence + diagnosis:**

- Concurrent `authmux save foo` from two terminals: the second call races on the snapshot write. Today the registry write is the only atomic step; the snapshot file itself is overwritten without locking.
- If `auth.json` is itself a symlink (not normally the case, but it is when `restoreSessionSnapshotIfNeeded` runs without the post-action regular-file write), `saveAccount` will dereference and snapshot the target rather than the link. We need explicit symlink-handling rules.
- If the user runs `authmux save` while `auth.json` is mid-rotation by Codex, we may catch a partially-written file. There is no read-retry loop. Compare with `src/commands/login.ts:106-124`, which polls until `authMode !== "unknown"`.
- `--force` is a binary; there is no `--if-exists=replace|skip|fail` semantics. A scripted user wanting `skip` has no path.

### Proposed flag changes

| Action      | Flag                          | Notes                                                                                    |
| ----------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| Add         | `--if-exists=replace\|skip\|fail` | Default `fail`. `--force` becomes a sugar for `--if-exists=replace` (kept for one release). |
| Add         | `--note <text>`               | Attach a free-text note to the snapshot (stored in registry metadata).                   |
| Deprecate   | `--force` / `-f`              | Warn and map to `--if-exists=replace` for one release.                                   |

### Output format proposal

Human (default):

```
Saved "work" (overwrote previous snapshot; previous email: alice@a.com, new email: alice@b.com)
```

`--json`:

```json
{ "ok": true, "data": { "name": "work", "source": "inferred", "overwrote": true, "previousEmail": "alice@a.com", "email": "alice@b.com" } }
```

`--quiet`: prints `work` (the saved name only).

Exit-code map (see cross-command section): `0` ok, `2` no-auth-snapshot, `3` clobber-rejected-without-force, `4` invalid name.

### Test plan

- Existing: `src/tests/save-account-safety.test.ts` covers the clobber-refusal path. Extend with: same-email overwrite without `--force`, mismatched-email overwrite with `--force` (assert new field `previousEmail` is reported), invalid name characters.
- New file `src/tests/cmd-save.test.ts`: exercise CLI argv → output (via in-process invocation), covering `--json`, `--quiet`, `--if-exists=skip` paths.
- Concurrency: spawn two `save` processes against a temp `AUTHMUX_HOME`, assert final state contains both snapshot files and exactly one registry update.

**Priority:** P1. **Effort:** S.

---

## authmux login

### UX critique

`src/commands/login.ts` runs `codex login`, polls for a fresh `auth.json`, then delegates to `saveAccount`. Comments and structure are good; concrete UX issues:

- The "auto-switch disabled before login" branch at `src/commands/login.ts:41-44` mutates global state but never restores it on failure. If `codex login` fails after we disable auto-switch, the user is left with auto-switch off and no warning that this happened. We should restore the previous value in a `finally`.
- `runCodexLogin` (`src/commands/login.ts:69-104`) inherits stdio, which is correct for interactive login but disastrous in CI / non-TTY. When stdin is closed, `codex` typically waits for input forever. There is no pre-flight TTY check.
- The 5-second polling deadline (`src/commands/login.ts:108`) is on top of however long the user takes inside `codex login`. The clock starts at `Date.now() + 5000` immediately after `codex login` exits, which is fine — but error message "Timed out waiting for refreshed Codex auth snapshot after login" doesn't help the user. They don't know whether to retry `authmux login` or whether `codex login` itself failed silently.
- The post-login suffix logic (`src/commands/login.ts:57-65`) duplicates `save`'s suffix logic. Extract to a shared helper.
- The `--device-auth` flag passes through to `codex login --device-auth`. There is no validation that `codex` supports it; older codex CLIs that don't will fail with a confusing error.

### Behaviour gaps and edge cases

- `codex` not in PATH: handled (`src/commands/login.ts:79-87`) with a clear error. Good.
- `codex` killed by signal: handled (`src/commands/login.ts:100-102`). Surfaces signal name. Good.
- `codex` exits 0 but no fresh `auth.json`: handled by the polling timeout. The error doesn't suggest `authmux current` to check whether the previous snapshot is still there.
- If two `authmux login` calls run concurrently (e.g. user double-clicks an alias), both will spawn `codex login`. Codex itself does not guard against concurrent logins; the second one wins and the first one silently saves with the second one's tokens. We need a process lock at the `~/.codex/auth.json` level.
- `--force` only forwards through `saveAccount.force`. It does not interact with the `setAutoSwitchEnabled(false)` decision; a `--force`-loaded login still disables auto-switch.
- `resolveLoginAccountNameFromCurrentAuth` produces a `source` of `active`/`existing`/`inferred`. The translation table is inlined again at `src/commands/login.ts:57-64`. Same duplication as `save.ts`.

### Proposed flag changes

| Action    | Flag              | Notes                                                                                  |
| --------- | ----------------- | -------------------------------------------------------------------------------------- |
| Add       | `--keep-auto-switch` | Do not disable auto-switch before login. For users who script the login flow.        |
| Add       | `--timeout=<ms>`  | Configure the post-login snapshot-poll deadline (default 5000).                        |
| Add       | `--if-exists=…`   | Inherit from `save`; deprecate `--force`.                                              |
| Add       | `--non-interactive` | Refuse to run if stdin is not a TTY (default behaviour); `--non-interactive` bypasses by failing fast rather than hanging. |

### Output format proposal

Human (default): a two-line transcript — the line from `runCodexLogin` (handled by Codex itself), then `Saved "alice@a.com" (inferred from auth email).`

`--json`:

```json
{ "ok": true, "data": { "name": "alice@a.com", "source": "inferred", "deviceAuth": false, "autoSwitchPreviousState": "off", "autoSwitchRestored": true } }
```

`--quiet`: prints the saved name only.

Exit codes: `0` ok, `2` codex-not-found, `3` codex-failed, `4` snapshot-timeout, `5` clobber-rejected.

### Test plan

- Existing: `src/tests/login-hook.test.ts` covers the shell-hook side. Add `src/tests/cmd-login.test.ts` that fakes the `codex` binary via a temp PATH and asserts: success path saves the snapshot, failure path restores auto-switch state, timeout path emits the right error code.
- Add a regression test for the auto-switch restore: enable auto-switch, run login with a fake `codex` that exits 1, assert auto-switch is back on.
- TTY check: spawn the command with stdin closed and assert the exit is fast (≤200 ms) with `non-interactive` error code, not a hang.

**Priority:** P0 (the auto-switch-leak bug is real, the concurrent-login race risks data loss). **Effort:** M.

---

## authmux use

### UX critique

`src/commands/use.ts` is the main "switch active account" command. The interactive picker is wired via `prompts` with a sensible initial selection (`src/commands/use.ts:64-65`).

- The picker label `${name}${mark}${kiroStr}` (`src/commands/use.ts:71-75`) hard-codes the `[kiro]` suffix. When future providers (Hermes, Claude Code) are added, the label will grow ad-hoc. Move to a label-builder that takes a list of provider tags.
- The kiro-mirror result is logged as warning (`src/commands/use.ts:51-52`) only when `attempted=true && switched=false`. For `attempted=false` (kiro not installed) we print nothing — which is correct for the common case but means users who *thought* they had Kiro mirroring set up have no debug signal. Add `--verbose` to surface `attempted=false` reasons.
- The `--no-kiro` flag is a single-provider opt-out; it does not generalise.
- On failure, `recordFailure(account)` (`src/commands/use.ts:42`) is called with the raw user input, not the resolved canonical name. If the user typed an alias, we record health failures against the alias, not the underlying account.
- The success message uses `"`-quoted name without indication of the previous account. Compare to `switch.ts` which says `Switched to: <name>`. Inconsistent.

### Behaviour gaps and edge cases

- Concurrent `authmux use` from two terminals racing on `~/.codex/auth.json`: `useAccount` writes a regular file atomically, but Kiro mirroring is not atomic (see `02-CORE-LIBRARY-IMPROVEMENTS.md` → `kiro-mirror.ts`).
- Auto-switch daemon and a manual `use` running at the same moment: the daemon may evaluate before our snapshot write completes and switch back. Needs a coordination signal (a lock file or a "manual override" timestamp the daemon respects for N minutes).
- Removing the active account from another terminal between `listAccountNames` and `useAccount` would leave us with an `AccountNotFoundError`. Currently surfaced as a generic error; should be a recognised exit code.
- `args.account = ""` (empty string after `=`) is allowed by oclif and triggers `useAccount("")`. We should reject empty strings before delegating.

### Proposed flag changes

| Action    | Flag                       | Notes                                                                                          |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| Add       | `--skip-provider <ids>`    | Comma-separated provider IDs to skip (e.g. `kiro,hermes`). Generalises `--no-kiro`.            |
| Add       | `--verbose`                | Surfaces `attempted=false` mirror reasons.                                                     |
| Deprecate | `--no-kiro`                | Map to `--skip-provider=kiro` with a warning for one release.                                  |
| Add       | `--lock-out <duration>`    | Tell the daemon to leave this manual choice alone for `<duration>` (e.g. `30m`).               |

### Output format proposal

Human (default for `use`):

```
Switched Codex auth: work → personal
Mirrored Kiro to: personal
```

`--json`:

```json
{
  "ok": true,
  "data": {
    "activated": "personal",
    "previous": "work",
    "mirrors": [
      { "id": "kiro", "switched": true },
      { "id": "hermes", "switched": false, "reason": "not-installed" }
    ]
  }
}
```

`--quiet`: prints `personal`.

Exit codes: `0` ok, `2` account-not-found, `4` clobber/permission, `130` prompt-cancelled.

### Test plan

- Add `src/tests/cmd-use.test.ts` with: argv with name → switches; no argv + non-TTY → fails with `prompt-required`; concurrent calls on same temp `AUTHMUX_HOME` → both succeed without corruption.
- Mock provider registry to assert all providers run, even if one throws.

**Priority:** P1. **Effort:** M.

---

## authmux switch

### UX critique

`src/commands/switch.ts` is a parallel implementation of `use` with a richer picker (numbered choices, optional live usage refresh) and additional Hermes mirroring. Some smell:

- Duplicated semantics vs `use`. We have two "switch active account" commands. Users will not know which to use. The Hermes mirror is the only behavioural difference; that should be moved into the provider framework so a single `switch` command suffices.
- `flags.live && !flags["skip-api"]` (`src/commands/switch.ts:50`) is a strange double-negative: `--live --skip-api` silently turns into a no-op. Replace with `--live=fresh|cached|off` (default `cached`).
- The usage refresh loop (`src/commands/switch.ts:51-57`) is serial. For 10 accounts at 5 s timeout each, the picker can take 50 s to render. Should be `Promise.all` with a per-account timeout already covered by `fetchUsage`.
- The query resolver (`src/commands/switch.ts:77-94`) tries row number → exact → fragment. There is no priority for active account, no priority for an existing exact email match. Ambiguous fragments silently return `undefined` instead of presenting a multi-match picker.
- The post-switch Hermes mirror is unconditional even with `--no-kiro`. The flag name suggests "skip all mirrors", but it only skips Kiro. Misleading.
- Numbered choices in the picker (`src/commands/switch.ts:64`) include the row number in the label *and* the user can type a row number as `args.query`. The two paths to "row 3" are inconsistent if accounts are added/removed between renders.

### Behaviour gaps and edge cases

- The `live` mode does not respect the `usageMode` setting (`config api enable|disable`). It will call the API even if the user disabled it. Should refuse with a hint to flip the mode.
- The `Map<string,string>` for usage labels (`src/commands/switch.ts:49`) is recreated even when `--live` is not set; it's then read at `src/commands/switch.ts:61` and the missing-key path is fine, but logically the map should not exist when live is off.
- Fragment match returning more than one result currently surfaces as "no account matching" because `matches.length === 1` is the only success path (`src/commands/switch.ts:91`). Two matches → fall through to `undefined`. The error message claims "No account matching" even though there were several.
- The `recordFailure` call uses `name`, which may be the resolved name (good) but could also be the original `args.query` (depending on which path was taken). Not consistent with `use.ts:42`.

### Proposed flag changes

| Action    | Flag                       | Notes                                                                                          |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| Replace   | `--live` + `--skip-api`    | with `--usage=fresh\|cached\|off`. Default `cached`.                                           |
| Replace   | `--no-kiro`                | with `--skip-provider <ids>`.                                                                  |
| Add       | `--ambiguous=fail\|pick`   | Default `pick` (interactive multi-match picker); `fail` for scripts.                           |

### Output format proposal

Merge `switch` and `use` into a single command exposing both interactive and query modes. `use` becomes a thin alias kept for one release that maps to `switch`.

Human output identical to `use`.

`--json` identical to `use`, with `mirrors` carrying all providers run.

Exit codes: same map as `use`, plus `6` ambiguous-query (only with `--ambiguous=fail`).

### Test plan

- Existing tests: none directly. Add `src/tests/cmd-switch.test.ts` covering: query as row number, exact name, single-fragment match, ambiguous fragment with `--ambiguous=fail` vs `pick`.
- Add `src/tests/cmd-switch-providers.test.ts`: fake provider registry, assert order of mirror calls, assert `--skip-provider` filtering.

**Priority:** P1 (after the cross-command flag refactor lands). **Effort:** M.

---

## authmux list

### UX critique

`src/commands/list.ts` is the most user-facing "everything at a glance" command. It also embeds a self-update prompt.

- Embedding the update prompt inside `list` (`src/commands/list.ts:74-112`) means every `list` invocation may show interactive UI, even when piped or scripted. The TTY check (`process.stdin.isTTY && process.stdout.isTTY`, `src/commands/list.ts:75`) helps, but does not cover the case where the user redirects stdout but keeps stdin a TTY. In that case the prompt appears between data lines — output corruption.
- The update prompt fires *before* the list (`src/commands/list.ts:30`), so a user who answers `y` and updates loses the original `list` output they wanted. Move it to *after* the list, or disable in `--json`/`--quiet`.
- The plain output uses 2-space separators between columns; with long account names the columns drift. There is no minimum-width formatting. Compare to `column` / `tabular` output — even a simple `padEnd` would help.
- The two-branch render in `run()` (`src/commands/list.ts:32-63`) duplicates "no accounts" handling. Extract.
- `formatRemaining` returns "-" for missing values and "N%" otherwise (`src/commands/list.ts:67-72`). It does not warn when the value is stale; usage refresh is `"missing"` mode (`src/commands/list.ts:33, 48`), so we silently render cached values without showing the freshness.
- The details mode prints `email/account/user` on one line, `type/plan/usage/5h/weekly/lastUsageAt` on another. Order is inconsistent with the bare mode (which leads with `type=` then `5h=` then `weekly=`).

### Behaviour gaps and edge cases

- A registry that lists an account whose snapshot file no longer exists: `listAccountMappings` should filter or flag, but `list` does not surface the gap.
- `--details` ignores `--refresh=fresh|cached|off` because there is no such flag; refresh is always `"missing"`. A user who wants up-to-date numbers right now has no path other than triggering the daemon.
- The active-row mark is a leading `*` with a fixed two-character prefix `*` or ` `. Screen-readers and copy-paste users may not realise the `*` is meaningful.

### Proposed flag changes

| Action  | Flag                          | Notes                                                                              |
| ------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| Add     | `--refresh=fresh\|cached\|off` | Override the default `missing`. `off` skips usage entirely.                       |
| Add     | `--sort=name\|email\|5h\|weekly\|active` | Default `name`. With `--sort=active`, the active row comes first.       |
| Add     | `--filter <glob>`             | Filter accounts by name glob.                                                      |
| Add     | `--columns <list>`            | Comma-separated column whitelist. Implicitly enables `--details`.                  |
| Add     | `--no-update-prompt`          | Suppress the embedded self-update offer.                                           |

### Output format proposal

Default human output: aligned columns via `padEnd`, header line in dim text.

`--json`:

```json
{
  "ok": true,
  "data": {
    "active": "personal",
    "accounts": [
      {
        "name": "work",
        "active": false,
        "email": "alice@a.com",
        "planType": "Business",
        "remaining": { "5h": 12, "weekly": 44 },
        "usageSource": "api",
        "lastUsageAt": "2026-05-17T12:34:56Z"
      }
    ],
    "updateAvailable": false
  }
}
```

`--quiet`: one account name per line, active prefixed with `*`.

Exit codes: `0` ok, `2` no-accounts.

### Test plan

- Existing: `src/tests/account-list-usage-refresh.test.ts` (lib-level). Add `src/tests/cmd-list.test.ts` with snapshot tests for default, `--details`, `--json`, `--quiet`, empty registry.
- Add a TTY-corruption test: invoke with stdout piped, stdin TTY → the update prompt must not fire.

**Priority:** P1. **Effort:** M.

---

## authmux remove

### UX critique

`src/commands/remove.ts` handles three modes (query, `--all`, interactive multi-select) and refuses combinations (`src/commands/remove.ts:37`).

- The labels (`buildChoiceLabel`, `src/commands/remove.ts:113-122`) include `(active)` but the picker default is "nothing selected" (`selected: false`). A user who hits Enter without toggling gets the `InvalidRemoveSelectionError` — confusing for a multi-select default. Consider preselecting based on a `--default-select` flag.
- "Removed N account(s): a, b, c" (`src/commands/remove.ts:54`) prints the entire list. For `--all` against a 50-account user this is a wall of text. Truncate with a count for >5 items.
- The fallback activation message ("Activated fallback account: X", `src/commands/remove.ts:56`) does not say which account it replaces. Should be "Activated fallback account: X (was previously: Y)".
- A query that matches one account silently picks it without confirmation (`src/commands/remove.ts:67-69`). Destructive default. Add a confirmation in TTY mode unless `--yes` is passed.
- Non-interactive multi-match (`src/commands/remove.ts:71-74`) error message is good but the exit code is generic.

### Behaviour gaps and edge cases

- Removing the active account: the service activates a fallback, but if no other account is usable (per `account-health`), the fallback may still be "least bad" — see `02-CORE-LIBRARY-IMPROVEMENTS.md` → `account-health.ts` selectBest issue. The user should be warned that the activated fallback is degraded.
- `removeAccounts` is presumably transactional in the service; the command does not surface partial-failure information. Add an `errors[]` field to the JSON output.
- Multi-select with zero ticked + Enter currently throws `InvalidRemoveSelectionError`. Friendlier: print "Nothing selected. Exit (Ctrl+C) to cancel, or pick at least one with Space."
- A query that matches zero results throws `AccountNotFoundError(query)`. Exit code currently maps via the error class; ensure it lands at `2`.

### Proposed flag changes

| Action  | Flag                | Notes                                                                                 |
| ------- | ------------------- | ------------------------------------------------------------------------------------- |
| Add     | `--yes` / `-y`      | Skip the new TTY confirmation for query-mode single-match.                            |
| Add     | `--keep-active`     | Refuse to remove the active account (useful in scripts).                              |
| Add     | `--dry-run`         | Print which accounts would be removed without removing them.                          |

### Output format proposal (remove)

Human (default):

```
Removed 3 accounts: alice, bob, charlie
Activated fallback account: dave (was previously: alice)
```

For >5 removals, summarise as `Removed 12 accounts (use --json for the list).`

`--json`:

```json
{
  "ok": true,
  "data": {
    "removed": ["alice", "bob"],
    "previousActive": "alice",
    "newActive": "dave",
    "fallbackHealth": { "score": 42, "usable": false }
  }
}
```

`--quiet`: prints removed names, one per line.

Exit codes: `0` ok, `2` no-accounts/account-not-found, `3` invalid-selection, `130` prompt-cancelled.

### Test plan

- Existing: none direct for `remove`. Add `src/tests/cmd-remove.test.ts`: query-single-match without `--yes` → confirmation appears; query-single-match with `--yes` → no confirmation; `--all` removes all; active-removal triggers fallback; `--keep-active` refuses to remove active.
- Property test: after removal, the registry never references missing snapshot files.

**Priority:** P1. **Effort:** S.

---

## authmux current

### UX critique

`src/commands/current.ts` is 12 lines. It prints the active account name or `"No Codex account is active yet."` (`src/commands/current.ts:9`).

- The friendly message is mixed with the data on the same stream. A script parsing `authmux current` cannot tell "no account" from a real account named "No Codex account is active yet." (unlikely but possible). Friendly text belongs on stderr; data on stdout.
- No exit-code difference between "no active account" and "active account exists". Scripts can't `if authmux current >/dev/null; then ... fi`.
- No `--json` or `--quiet`. `--quiet` would print just the name (or nothing) and rely on exit code.

### Behaviour gaps and edge cases

- The active name comes from `getCurrentAccountName`. If the registry's active points to a snapshot file that no longer exists, we still print the name — misleading.
- No coupling with the session-pinned snapshot. A user inside a session-pinned terminal will see the registry's active, not their effective session pin. Should optionally report the session-pinned value with `--session`.

### Proposed flag changes

| Action  | Flag                  | Notes                                                                                            |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| Add     | `--json`              | Inherited from base, included here because of the discriminator below.                           |
| Add     | `--quiet` / `-q`      | Print name only, no friendly message. Exit `0` if present, `2` if not.                           |
| Add     | `--session`           | Show the effective session-pinned snapshot in addition to the registry's active.                 |
| Add     | `--verify`            | Confirm the snapshot file exists and is readable; fail with `4` if it does not.                  |

### Output format proposal

Default human: `personal` (single line, no trailing message); if none: `(no active account)` on stderr + exit `2`.

`--json`:

```json
{ "ok": true, "data": { "active": "personal", "snapshotExists": true, "sessionPinned": "work" } }
```

Exit codes: `0` active account, `2` no active, `4` active points to missing snapshot.

### Test plan

- Add `src/tests/cmd-current.test.ts` with all four exit-code paths against temp `AUTHMUX_HOME`.

**Priority:** P2. **Effort:** S.

---

## authmux status

### UX critique

`src/commands/status.ts` is 15 lines and reports four facts (`src/commands/status.ts:9-12`).

- Four lines of `key: value`. Not bad, but the thresholds line `thresholds: 5h<10%, weekly<5%` is non-obvious for new users. Add a "what does this mean" hint behind `--help`.
- `serviceState` rendered as-is. The set of possible values isn't documented inline. Add a legend or move to a table.
- No surfacing of the daemon's last run time, last switch event, or current pool-health summary. `status` is the natural place for "what is authmux doing right now".

### Behaviour gaps and edge cases

- If the managed service is registered but stopped, `serviceState` reports... what? Probably `stopped` or `unknown`, but the command does not differentiate "not installed" from "stopped". Surfaces both with the same string.
- No exit-code differentiation. Should differ between "auto-switch on + service healthy" (0) and "auto-switch on + service stopped" (3).
- `usageMode` is a single string; the command does not show the threshold that the daemon would compare against, nor when the next evaluation will run.

### Proposed flag changes

| Action  | Flag             | Notes                                                                                             |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| Add     | `--watch`        | Refresh status every 5 s until interrupted.                                                       |
| Add     | `--detail`       | Add last-run, last-switch, pool-health summary, and a one-line "next evaluation in N seconds".   |
| Add     | `--strict`       | Exit non-zero if any inconsistency is detected (auto-switch on but service stopped, etc.).        |

### Output format proposal

Human (default):

```
auto-switch:     ON
service:         active (systemd: codex-auth.service)
thresholds:      5h<10%   weekly<5%
usage mode:      api
```

`--json`:

```json
{
  "ok": true,
  "data": {
    "autoSwitch": true,
    "service": { "kind": "systemd", "state": "active", "unit": "codex-auth.service" },
    "thresholds": { "5h": 10, "weekly": 5 },
    "usageMode": "api",
    "lastRunAt": "2026-05-17T15:00:00Z",
    "nextRunInSeconds": 23
  }
}
```

Exit codes: `0` ok, `3` inconsistent under `--strict`.

### Test plan

- Add `src/tests/cmd-status.test.ts` against a fake `services.accounts.getStatus()` returning each combination of `autoSwitch` × `serviceState`.

**Priority:** P2. **Effort:** S.

---

## authmux daemon

### UX critique

`src/commands/daemon.ts` requires exactly one of `--watch` / `--once` (`src/commands/daemon.ts:24-26`). It logs `switched: X -> Y` or `no switch: <reason>` in `--once` mode (`src/commands/daemon.ts:30-34`); `--watch` mode delegates to `accounts.runDaemon("watch")` and never logs.

- The XOR check at `src/commands/daemon.ts:24` is correct but the message is generic. Help text should explain why both modes exist: `--once` for cron-driven scheduling, `--watch` for managed-service mode.
- `--watch` produces no progress output. A user running `authmux daemon --watch` by hand has no signal that anything is happening — not even a heartbeat. Service managers see no log line per evaluation.
- `--watch` has no clean shutdown. SIGINT must propagate cleanly into `runDaemon`; today there is no signal-handling here, so behaviour depends on the service implementation.
- The `--once` failure path logs `no switch: <reason>` with exit `0`. From a cron job's perspective, "no switch needed" and "service errored" both succeed. Differentiate.
- No backoff / reconnect logic visible at this layer (the `--watch` loop in `runDaemon` is opaque to the command). Document or surface it via `--detail`.

### Behaviour gaps and edge cases

- `runAutoSwitchOnce` can in principle return `switched: false` for many reasons (no usable account, usage refresh failed, thresholds not crossed, daemon disabled). The current binary log loses the distinction.
- `runDaemon("watch")` blocks forever in-process. If the parent service manager sends `SIGTERM`, the command should run cleanup, flush state, and exit.
- Two daemon instances on the same host: registry + state-file writes will race. The daemon should acquire a PID/lock file and refuse to start if another is running.
- Network failure in `usage-refresh` should retry with backoff (covered by `02-CORE-LIBRARY-IMPROVEMENTS.md` → `usage-refresh.ts`), and the daemon should surface a consecutive-failure count.

### Proposed flag changes

| Action  | Flag                  | Notes                                                                                          |
| ------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Add     | `--interval=<ms>`     | Override the watch interval (default 30000).                                                   |
| Add     | `--max-iterations=<n>` | For testability; exit after N evaluations (debug only).                                       |
| Add     | `--log-level=<level>` | Forward to the shared logger.                                                                  |
| Add     | `--lock-file=<path>`  | Override the default `~/.config/authmux/daemon.lock`.                                          |
| Add     | `--probe`             | Like `--once` but never modifies state — only computes the proposed switch.                    |

### Output format proposal (daemon)

`--once` human (success path):

```
switched: work → personal  (reason: 5h-remaining=7% < threshold=10%)
```

`--once` human (no-switch path):

```
no switch: thresholds not crossed (5h=42%, weekly=18%)
```

`--once` `--json`:

```json
{
  "ok": true,
  "data": {
    "switched": true,
    "from": "work",
    "to": "personal",
    "reason": "5h-remaining=7% < threshold=10%",
    "evaluatedAt": "..."
  }
}
```

`--watch` human: one log line per iteration (`iteration=N evaluatedAt=… switched=… reason=…`).

Exit codes: `0` ok, `2` no-usable-account, `3` lock-held-by-other-instance, `4` config-invalid, `130` SIGINT.

### Test plan

- Existing: none. Add `src/tests/cmd-daemon.test.ts`: `--once` against fake service returning each outcome; `--watch --max-iterations=3` runs three loops and exits 0; lock-file already present → exit 3.
- Add a graceful-shutdown test: launch `--watch`, send SIGTERM, assert exit ≤2 s and `flush()` is called.

**Priority:** P0 (lock file + signal handling are correctness). **Effort:** M.

---

## authmux config

### UX critique

`src/commands/config.ts` overloads positional `section` and `action` to model `auto enable|disable`, `auto --5h N --weekly M`, `api enable|disable` (`src/commands/config.ts:7-30`). Error messages are reasonable.

- The XOR between "action" and "threshold flags" is enforced manually (`src/commands/config.ts:54-56, 65-67`). The two paths could become four with the addition of one flag. Replace with explicit subcommands: `config auto enable`, `config auto disable`, `config auto thresholds`, `config api enable`, `config api disable`.
- No way to view current config without running another command (`status`). Add `config show` or `config get`.
- Threshold flags are integer-only (`Flags.integer`). Negative numbers, 0, and >100 are not validated until the service rejects them. Validate at the flag layer with `parse:` and emit clear errors.
- The `usageMode === "api" ? "api" : "local-only"` rendering (`src/commands/config.ts:60`) doesn't match the rest of the codebase (`status.ts` uses just the raw mode). Inconsistent.

### Behaviour gaps and edge cases

- `config auto enable` without managed-service installation succeeds but the service won't actually run. We should detect this and either install the service (with a confirmation) or surface the gap.
- Concurrent `config auto --5h 12` and `config auto enable`: which wins is order-dependent. The XOR guard prevents a single command from doing both, but two commands racing can produce a half-configured state.
- `config api enable` requires that the user already has accounts with valid tokens. Today we set the mode unconditionally; on next refresh, every account fails. Pre-flight with a token-presence check.

### Proposed flag changes

| Action     | Flag/subcommand                | Notes                                                                                  |
| ---------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| Add        | `config show`                  | Print all config in human or JSON form.                                                |
| Add        | `config get <key>`             | Print a single value by dotted key.                                                    |
| Add        | `config set <key> <value>`     | Generic setter; supersedes the action-flag tangle.                                     |
| Deprecate  | `config auto enable\|disable`  | Map to `config set autoSwitch.enabled true\|false` for one release.                    |
| Deprecate  | `--5h`, `--weekly`             | Map to `config set autoSwitch.thresholds.5h N`.                                        |

### Output format proposal

Human (current behaviour) preserved for the deprecated forms with a one-line `(deprecated, use ...)` notice.

`config show --json`:

```json
{
  "ok": true,
  "data": {
    "autoSwitch": { "enabled": true, "thresholds": { "5h": 10, "weekly": 5 } },
    "usage": { "mode": "api" }
  }
}
```

Exit codes: `0` ok, `2` invalid key, `4` invalid value.

### Test plan

- Existing: none. Add `src/tests/cmd-config.test.ts`: enable/disable round-trip; threshold validation rejects 0, 101, NaN; deprecated form prints warning; `config show` matches `status` in the relevant fields.

**Priority:** P1. **Effort:** S.

---

## authmux update

### UX critique

`src/commands/update.ts` consults `update-check`, displays a summary card, optionally reinstalls.

- `static description = "Check for updates and upgrade agent-auth globally"` (`src/commands/update.ts:16`) — references the legacy binary name `agent-auth`. Same bug in the message text at `src/commands/update.ts:53, 60`. Confusing for users on the `authmux` binary.
- `runGlobalNpmInstall` hardcodes npm (covered by lib improvements). For a user installed via `pnpm add -g authmux`, the update silently installs a second copy via npm.
- The "Update cancelled." message is fine. The case where `latestVersion` is null (`src/commands/update.ts:41-44`) is a warning but exit code is 0; should be non-zero so scripts can detect.
- `--check` doesn't add a `--quiet` short form for scripted polling.
- The confirmation prompt always asks "now?" (`src/commands/update.ts:74`) — assumes user is in a hurry. Default-yes via Enter is fine; for `--check`, no prompt fires.
- The `--reinstall` flag reinstalls even when up to date (`src/commands/update.ts:58`). Good. The message uses `↺` (`src/commands/update.ts:67`) — same TTY/color concern as elsewhere.

### Behaviour gaps and edge cases

- Update runs as the current user. On systems where the global npm prefix is root-owned, install fails. We surface `exit code N` but not the cause. See lib improvements for the package-manager detection.
- A user running `authmux update` while another process holds the npm cache may see ECONFLICT. No retry.
- `--check --json` would be the natural way for a status panel to poll us, but no `--json` exists.
- The TTY check for `--yes` does not fire if stdin is closed; `prompts` will return `{}` and the command will think the user cancelled. Should pre-flight: non-TTY without `--yes` → fail fast.

### Proposed flag changes

| Action    | Flag                | Notes                                                                                  |
| --------- | ------------------- | -------------------------------------------------------------------------------------- |
| Add       | `--json`            | Emit machine-readable result for both `--check` and the install path.                  |
| Add       | `--package-manager` | `npm\|pnpm\|yarn\|bun\|auto` (default `auto`).                                         |
| Add       | `--registry <url>`  | Override the npm registry for `--check`.                                               |
| Add       | `--prefix <path>`   | Pass through to the package manager for non-root installs.                             |
| Add       | `--allow-prerelease` | Permit prereleases when comparing.                                                    |

### Output format proposal

Human card (preserved, but rendered colour-aware): box-drawing only when stdout is a TTY; ASCII fallback otherwise.

`--json --check`:

```json
{
  "ok": true,
  "data": {
    "currentVersion": "1.2.3",
    "latestVersion": "1.2.4",
    "state": "update-available",
    "fetchedFrom": "registry"
  }
}
```

`--json` (install path):

```json
{
  "ok": true,
  "data": { "installed": "1.2.4", "manager": "npm", "previousVersion": "1.2.3", "exitCode": 0 }
}
```

Exit codes: `0` ok / up-to-date, `2` registry-unreachable, `3` install-failed, `4` permission-denied (with explicit suggested workaround).

### Test plan

- Existing: `src/tests/update-check.test.ts` covers the lib. Add `src/tests/cmd-update.test.ts`: `--check` happy path, registry-unreachable, `--reinstall` flow, `--yes` skips prompt, non-TTY without `--yes` fails fast.

**Priority:** P0 for the binary-name typos and non-TTY hang; P1 for the package-manager work. **Effort:** M.

---

## authmux auto-switch

### UX critique

`src/commands/auto-switch.ts` extends `Command` (not `BaseCommand`), constructs a fresh `AccountService` (`src/commands/auto-switch.ts:10`), and picks the best account via `selectBestAccount`.

- Constructing a new `AccountService` per command (`src/commands/auto-switch.ts:10`) bypasses the singleton used by `BaseCommand`. Two services means two registry caches in the same process. Lucky we don't currently run two commands in one process — but the pattern is wrong.
- No error normalisation: a thrown error surfaces as oclif's default "Error: …" with stack. Contrast with `BaseCommand`-derived commands.
- `this.error(\`Failed to switch to ${best}: ${err}\`)` (`src/commands/auto-switch.ts:29`) string-templates an `unknown`. If `err` is a `CodexAuthError` the message is wrapped twice and the stack is lost.
- `selectBestAccount` returns the highest-scoring even when unusable (see `02-CORE-LIBRARY-IMPROVEMENTS.md`). This command then activates an unusable account. The user has no warning.
- Overlaps semantically with `daemon --once`: both compute "best account" and switch. Why two commands?
- Missing post-switch provider mirroring (Kiro / Hermes). Inconsistent with `use` / `switch`.

### Behaviour gaps and edge cases

- No `--dry-run`. A user wanting to "tell me what would happen" has no path.
- No respect for the manual-override lock file proposed for `use`.
- No `recordAutoSwitch` on the failure path; the savings ledger only updates on success.

### Proposed flag changes

| Action   | Flag           | Notes                                                                                              |
| -------- | -------------- | -------------------------------------------------------------------------------------------------- |
| Replace  | the command    | Fold into `daemon --once` (with `--reason=manual-auto-switch`). Keep the command as a deprecated alias for one release. |
| Add (if kept) | `--dry-run` | Print the proposed switch without executing.                                                    |
| Add (if kept) | `--skip-provider` | Same generalisation as `use` / `switch`.                                                   |

### Output format proposal (auto-switch)

Same as `daemon --once`.

### Test plan

- Add `src/tests/cmd-auto-switch.test.ts`: best-account is usable → switch happens, savings recorded; best-account is unusable → command refuses with `2`; service throws → error normalised.

**Priority:** P2 (deprecate, not invest). **Effort:** S.

---

## authmux check

### UX critique

`src/commands/check.ts` prints pool health and per-account health.

- Extends `Command` directly; same DI and error-normalisation gaps as `auto-switch`.
- Pool-health status uses string literals `HEALTHY` / `DEGRADED` / `UNHEALTHY` (`src/commands/check.ts:20`). Not bad, but not configurable, no colour, no machine-readable mode.
- The `flags` array (`circuit-${state}`, `rate-limited`) is built ad hoc (`src/commands/check.ts:24-26`). Move to a typed `HealthFlag` enum so additions don't drift.
- The score is `Math.round(h.score)` — same precision loss issue as `usage-refresh`.
- No correlation with the savings ledger. A user asking "is my pool healthy" probably also wants "how many switches lately?".

### Behaviour gaps and edge cases

- Calls `loadState()` (`src/commands/check.ts:17`) directly, despite `forecastAccounts` already doing that internally (`src/lib/account-health.ts:225`). Redundant work.
- Empty account list logs "No saved accounts found." with exit 0. A script asking "is my pool healthy" should get a non-zero exit to fail loudly.
- Per-account `flags.length ? ' [...]' : ''` produces inconsistent spacing for accounts with and without flags (alignment drifts).
- No way to filter to "only show unhealthy".

### Proposed flag changes

| Action   | Flag                  | Notes                                                                                          |
| -------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Add      | `--only=unhealthy`    | Filter the list.                                                                               |
| Add      | `--exit-on-degraded`  | Exit `3` when pool is DEGRADED, `4` when UNHEALTHY.                                            |
| Add      | `--include-savings`   | Append a one-line summary from the savings ledger.                                             |

### Output format proposal

Human (default) aligned columns; coloured status (red/yellow/green) when TTY.

`--json`:

```json
{
  "ok": true,
  "data": {
    "pool": { "status": "DEGRADED", "usable": 1, "total": 3 },
    "accounts": [
      { "name": "work", "score": 76, "circuit": "closed", "tokensAvailable": 50, "usable": true, "flags": [] },
      { "name": "personal", "score": 11, "circuit": "open", "tokensAvailable": 0, "usable": false, "flags": ["circuit-open", "rate-limited"] }
    ]
  }
}
```

Exit codes: `0` always (unless `--exit-on-degraded`), `2` empty pool, `3` degraded, `4` unhealthy.

### Test plan

- Add `src/tests/cmd-check.test.ts`: pool with mixed health renders correctly; `--exit-on-degraded` produces the right code; empty pool exits non-zero.

**Priority:** P2. **Effort:** S.

---

## authmux forecast

### UX critique

`src/commands/forecast.ts` prints best-first ranking with score / circuit / tokens.

- Identical structural critique as `check` (extends `Command`, calls `forecastAccounts`, uses ad-hoc strings).
- The two commands overlap: `forecast` is a sorted version of `check`'s per-account list, minus the pool summary. Consolidate.
- Uses Unicode check / cross (`✓` / `✗`, `src/commands/forecast.ts:21`) — same TTY-aware concern.
- Numbered prefix (`[N]`, `src/commands/forecast.ts:22`) duplicates the row-number affordance from `switch`, but `forecast` does not feed back into `switch`. Either let users `authmux use $(authmux forecast --best)` or remove the numbers.

### Behaviour gaps and edge cases

- Empty pool: prints "No saved accounts found." with exit 0; same gap as `check`.
- No `--best` shortcut to print just the top candidate name (useful for scripting).
- No filtering by minimum score.

### Proposed flag changes

| Action  | Flag                  | Notes                                                                                          |
| ------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Add     | `--best`              | Print just the top candidate name; exit `2` if none usable.                                    |
| Add     | `--min-score=<n>`     | Hide entries below the threshold.                                                              |
| Add     | `--limit=<n>`         | Show only the top N.                                                                           |
| Replace | the command           | Fold into `check --sort=score --details`. Keep `forecast` as a deprecated alias for one release. |

### Output format proposal

`--json` identical to `check`'s `accounts` slice, sorted by score desc.

`--best` produces a single line on stdout (the account name), no JSON unless `--json` is added.

Exit codes: same as `check`, plus `2` for `--best` with no usable account.

### Test plan

- Add `src/tests/cmd-forecast.test.ts`: `--best` returns top usable, refuses if none usable.

**Priority:** P3. **Effort:** S.

---

## authmux savings

### UX critique

`src/commands/savings.ts` reads the legacy counter file and prints four counters + a percentage.

- Presents `~${s.estimatedMinutesSaved} minutes` (`src/commands/savings.ts:14`) as a precise number despite the underlying `+5 per event` heuristic (see `02-CORE-LIBRARY-IMPROVEMENTS.md` → `account-savings.ts`). Misleading.
- Extends `Command`, not `BaseCommand`.
- No date-range filter, no per-account breakdown, no machine-readable mode.
- `Auto-switch rate` is computed inline (`src/commands/savings.ts:17-20`); should live in `buildSavingsReport`.

### Behaviour gaps and edge cases

- A pristine install with zero events prints all zeros and `lastUpdated: <now>`, because the lib seeds `lastUpdated` on the empty default. Misleading freshness signal.
- No `--reset` or `--compact` to manage the ledger.
- The percentages and minutes are presented but never explained — a user does not know the methodology.

### Proposed flag changes

| Action  | Flag                  | Notes                                                                                          |
| ------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Add     | `--window=<duration>` | Restrict to events in the last `<duration>` (default `all`).                                   |
| Add     | `--per-account`       | Add per-account counters.                                                                      |
| Add     | `--compact`           | Run lazy compaction on the JSONL log.                                                          |
| Add     | `--reset`             | Wipe the log after confirmation.                                                               |
| Add     | `--methodology`       | Print a paragraph explaining how cooldown-saved minutes are estimated.                         |

### Output format proposal

Human (default):

```
Account Rotation Savings (window: all):

  Total switches:      120
  Auto-switches:       96 (80%)
  Rate limits avoided: 14
  Estimated cooldown saved: 60–90 minutes  (low–high range, see --methodology)
  Last event at:       2026-05-17T14:21:33Z
```

`--json`:

```json
{
  "ok": true,
  "data": {
    "windowDays": null,
    "totalSwitches": 120,
    "autoSwitches": 96,
    "autoSwitchRate": 0.8,
    "rateLimitsAvoided": 14,
    "estimatedCooldownMinutesAvoided": { "low": 60, "high": 90 },
    "lastEventAt": "2026-05-17T14:21:33Z"
  }
}
```

Exit codes: `0` ok, `2` ledger-corrupt-not-readable, `3` empty (only with a future `--require-data` flag).

### Test plan

- Add `src/tests/cmd-savings.test.ts`: empty ledger; windowed report; `--per-account`.

**Priority:** P2. **Effort:** S.

---

## authmux clean

### UX critique

`src/commands/clean.ts` deletes `.bak` / `.backup` files and broken symlinks under `~/.codex/accounts/` and `~/.codex/auth.json.bak`.

- Hardcoded paths (`src/commands/clean.ts:6-7`). No `--config-dir` override; no `AUTHMUX_HOME`.
- No dry-run.
- No confirmation for destructive operation; runs immediately.
- Three independent sync `readdirSync` walks (`src/commands/clean.ts:17, 36`); the third re-reads the directory after the first walk already iterated it. One pass would suffice.
- "Nothing to clean." message on exit `0`; "Cleaned N file(s)." also on `0`. Same exit code, no scripted distinction.
- No coverage for other stale artefacts: orphan `accounts/<name>.json` whose registry entry is missing; registry entries whose snapshot file is missing; stale `update-check.json` cache.

### Behaviour gaps and edge cases

- A symlink in `accounts/` pointing at a non-existent path returns `false` for `fs.existsSync` but the `lstatSync` itself can throw on Windows under EBUSY. No error handling.
- Removing a `.bak` next to an active snapshot can confuse downstream tooling that looked for `auth.json.bak` as a manual rollback. Should warn before deleting (or move to a quarantine dir).
- No interaction with the savings or health state files.

### Proposed flag changes

| Action  | Flag                | Notes                                                                                          |
| ------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| Add     | `--dry-run`         | Print would-delete list without deleting.                                                      |
| Add     | `--yes` / `-y`      | Skip confirmation (default in non-TTY).                                                        |
| Add     | `--include=<set>`   | Comma-separated: `bak,broken-symlinks,orphan-snapshots,orphan-registry,update-cache`.          |
| Add     | `--quarantine`      | Move files to `~/.cache/authmux/quarantine/` instead of deleting.                              |

### Output format proposal

Human (default) preserved; add a `summary:` line at the end.

`--json`:

```json
{
  "ok": true,
  "data": {
    "removed": ["accounts/foo.bak", "auth.json.bak"],
    "skipped": [],
    "summary": { "removed": 2, "quarantined": 0 }
  }
}
```

Exit codes: `0` ok, `2` nothing-to-clean (only with `--require-action`), `4` permission-denied.

### Test plan

- Add `src/tests/cmd-clean.test.ts` against a temp `AUTHMUX_HOME` populated with the artefact types; assert idempotency (running twice doesn't re-report removals).

**Priority:** P2. **Effort:** S.

---

## authmux export

### UX critique

`src/commands/export.ts` copies every `*.json` snapshot to a directory (default `./agent-auth-export`).

- The default directory name `agent-auth-export` (`src/commands/export.ts:17`) carries the legacy binary name. Should be `authmux-export`.
- Extends `Command` directly.
- No filter (export specific accounts only).
- No anonymisation. Exported files include access tokens — a user running `authmux export` then attaching the directory to a bug report leaks credentials.
- No compression / archive form.
- Hardcoded `ACCOUNTS_DIR`.

### Behaviour gaps and edge cases

- `mkdirSync(targetDir, { recursive: true })` is called *before* checking that the source has anything to copy (`src/commands/export.ts:24-30`). Already handled (the empty check runs first) — but the order is fragile.
- Overwriting an existing export directory silently merges with whatever was there. Should refuse unless `--force` or `--overwrite`.
- The success message reports `Exported ${files.length} accounts to ${targetDir}` — but the registry mapping (active account, metadata) is not exported. A subsequent `authmux import` re-creates the snapshots but loses the active state.

### Proposed flag changes

| Action    | Flag                  | Notes                                                                                          |
| --------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Rename    | default dir           | `authmux-export` (deprecate the legacy name; warn for one release).                            |
| Add       | `--filter=<glob>`     | Export only matching accounts.                                                                 |
| Add       | `--redact`            | Strip tokens; leave metadata for portability/inspection.                                       |
| Add       | `--archive=tar\|zip`  | Produce a single archive file rather than a directory.                                         |
| Add       | `--include-registry`  | Bundle a copy of the registry to support exact restore.                                        |
| Add       | `--force`             | Allow overwriting an existing target.                                                          |

### Output format proposal

Human (default): one line per file copied (truncate to N for large exports), then a summary.

`--json`:

```json
{
  "ok": true,
  "data": { "target": "./authmux-export", "exported": ["alice.json", "bob.json"], "redacted": false, "registryIncluded": false }
}
```

Exit codes: `0` ok, `2` no-accounts-to-export, `3` target-exists-without-force, `4` permission-denied.

### Test plan

- Add `src/tests/cmd-export.test.ts`: round-trip with `import` against a temp source/target; `--redact` produces files without `accessToken` fields; `--archive=tar` produces a readable archive.

**Priority:** P2. **Effort:** S.

---

## authmux import

### UX critique

`src/commands/import.ts` accepts a file or directory, with `--alias` to rename a single file and `--purge` to rebuild the registry from the on-disk snapshots.

- Three modes (file, directory, `--purge`) overloaded onto one positional + one flag. The combinations multiply quickly and the help text gets confusing. Split into `import file <path>`, `import dir <path>`, `import rebuild [--from <dir>]`.
- The single-file `Updated` vs `Imported` message (`src/commands/import.ts:60-65`) only distinguishes existence, not whether content changed. A re-import of an identical file says "Updated" — misleading.
- `importDirectory` (`src/commands/import.ts:68-84`) wraps each per-file import in try/catch but the try wraps `this.importFile`, which itself calls `this.error()`. `this.error()` throws an `ExitError`, which the catch then swallows — meaning a single bad file in a directory import is silently skipped and we continue. The user has no signal that we skipped that file beyond a one-line `Skipped` warn.
- `extractName` (`src/commands/import.ts:117-129`) decodes JWT id-tokens to extract email. JWT decoding has no signature validation (we don't trust the payload, but the comment doesn't say that, and the function would crash on a non-string `split(".")` result if `idToken` is `null` after our `typeof === "string"` guard, which is safe — but the `Buffer.from(... , "base64url")` is Node 16+ and we claim Node 18+, so fine).
- `--purge` is destructive and behind a flag, but the help text doesn't say "this will copy every file in the scan path on top of the registry". Users will run it expecting a registry-only rebuild and discover their snapshots got rewritten.

### Behaviour gaps and edge cases

- Importing a snapshot whose email is empty (no JWT, no `email` claim) falls back to `path.basename(filePath, ".json")` — fine, but the filename may contain characters the registry rejects. We should validate.
- `--purge` writes `current.json` for an existing `auth.json` (`src/commands/import.ts:108-112`). The chosen name `current` shadows a hypothetical user-named `current`. Use a unique sentinel.
- Concurrent imports: no locking. Two processes writing the same `${name}.json` race.
- After an import, the registry is *not* updated to reflect new accounts. The next `list` invocation needs to reconcile. The command should call `reconcileRegistryWithAccounts` itself.
- `--purge` does not validate that the scanned files are real auth snapshots; an arbitrary JSON file would be copied into `accounts/` and break downstream parsing.

### Proposed flag changes

| Action     | Flag/subcommand               | Notes                                                                                  |
| ---------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| Split      | `import file`, `import dir`, `import rebuild` | Replace the overloaded positional + `--purge`.                            |
| Add        | `--reconcile`                 | Default true. Run registry reconciliation after the import.                            |
| Add        | `--validate`                  | Parse and validate each file as a Codex auth snapshot before writing.                  |
| Add        | `--on-conflict=skip\|replace\|fail` | Replaces the implicit "always overwrite".                                       |
| Add        | `--dry-run`                   | Print would-import list without writing.                                               |

### Output format proposal

Human (default) — preserve the per-file lines but add a final summary.

`--json`:

```json
{
  "ok": true,
  "data": {
    "imported": [{ "name": "alice", "source": "/path/to/file.json", "previousExisted": false }],
    "skipped": [{ "source": "/path/to/bad.json", "reason": "invalid-auth-snapshot" }],
    "reconciled": true
  }
}
```

Exit codes: `0` ok, `2` source-missing, `3` validation-failed (any file), `4` conflict-without-flag.

### Test plan

- Add `src/tests/cmd-import.test.ts`: file with alias; directory with one bad file; `--purge` with `--validate` rejects an invalid file; concurrent imports of the same source produce a deterministic result.

**Priority:** P1 (the silent-skip and overload-confusion are real). **Effort:** M.

---

## authmux hook-install / hook-status / hook-remove

These three commands share the same shape (one `-f` flag, one async call into `lib/config/login-hook`), so they're covered together.

### UX critique

- `hook-install.ts:24-30` distinguishes three outcomes (`already-installed`, `updated`, others). Good. The "others" path doesn't list the literal value, so the user doesn't know whether the install path was `installed` or something we forgot.
- `hook-status.ts:24-25` prints two lines (`login-hook: installed`, `rc-file: /path`). No `--json`.
- `hook-remove.ts:24-29` distinguishes `not-installed` from removal. Good.
- All three reference the implementation in `src/lib/config/login-hook` — out of scope for this file (covered in `01-…`), but the command-side gaps remain.
- None of the three accept `--shell=bash|zsh|fish` to write to a non-default rc file.
- None of the three validate the rc file is writable before doing anything.
- No way to preview the block that will be written (`hook-install --print`).

### Behaviour gaps and edge cases

- Concurrent `hook-install` from two terminals: writes race on the rc file.
- An rc file containing the block but with manual edits inside it will be overwritten on `updated`. The user has no warning.
- `hook-remove` against an rc file that was edited manually around the block could leave stray markers.

### Proposed flag changes

| Action  | Flag                  | Notes                                                                                          |
| ------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Add     | `--shell=auto\|bash\|zsh\|fish` | Override rc-file detection.                                                          |
| Add     | `--print`             | Print the block instead of writing.                                                            |
| Add     | `--backup`            | Save a timestamped backup of the rc file before writing.                                       |
| Add     | `--diff`              | Print the diff that would be applied.                                                          |

### Output format proposal

Human (default) preserved.

`--json`:

```json
{ "ok": true, "data": { "rcPath": "/home/u/.bashrc", "outcome": "updated", "backupPath": "/home/u/.bashrc.bak-2026-05-17" } }
```

Exit codes: `0` ok, `2` rc-not-writable, `3` parse-failure (existing block malformed).

### Test plan

- Existing: `src/tests/login-hook.test.ts` covers the lib. Add `src/tests/cmd-hook.test.ts`: install → status → remove round-trip; `--print`; `--shell=zsh` writes to `.zshrc`; concurrent install simulation.

**Priority:** P2. **Effort:** S.

---

## authmux restore-session

`src/commands/restore-session.ts` is a 14-line hidden command that delegates to `accounts.restoreSessionSnapshotIfNeeded()`.

### UX critique

- Hidden, no output, no flags. Fine as an internal helper.
- Not idempotent in observable behaviour: the user has no way to ask "what would you restore?". Add `--dry-run` and `--verbose`.
- No exit-code differentiation between "restored" and "nothing to restore".

### Proposed changes

| Action  | Flag                | Notes                                                                                          |
| ------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| Add     | `--dry-run`         | Print would-restore name.                                                                      |
| Add     | `--verbose`         | Log the resolved session key and the resolved snapshot name.                                   |

Exit codes: `0` restored, `2` nothing-to-restore, `3` snapshot-missing-but-pinned.

### Test plan

- Add `src/tests/cmd-restore-session.test.ts`: pinned + snapshot present → restores; pinned + snapshot missing → exit 3; no pin → exit 2.

**Priority:** P3. **Effort:** S.

---

## authmux kiro

### UX critique

`src/commands/kiro.ts` is an interactive switcher for Kiro snapshots, with `--new` to remove the symlink so a fresh `kiro-cli login` can begin.

- Extends `Command`. Reimplements all path logic that lives in `src/lib/kiro-mirror.ts`. Should go through the library.
- Uses Node's `readline` for prompts (`src/commands/kiro.ts:20-25`); the rest of the codebase uses `prompts`. Inconsistent.
- `lstatSync` after `existsSync` (`src/commands/kiro.ts:81`) — order is wrong: if `existsSync` returns false but it's a broken symlink, `lstatSync` still works. The current expression `fs.existsSync(DATA_FILE) || fs.lstatSync(DATA_FILE).isSymbolicLink()` will throw `ENOENT` on the lstat when the file truly does not exist. Bug.
- `getAccounts` (`src/commands/kiro.ts:12-18`) duplicates `listKiroSnapshots` from the library.
- No JSON output.
- Direct-switch by argv (`src/commands/kiro.ts:46-50`) silently runs `switchTo`, which then calls `this.error()` on bad input; that throws `ExitError` synchronously, fine.

### Behaviour gaps and edge cases

- `--new` on an unmanaged regular `data.sqlite3` errors with "regular file. Run: agent-auth kiro-login --name <name>" (`src/commands/kiro.ts:101`) — references the legacy binary name.
- Switching when `data.sqlite3` is a directory (unusual but possible): `lstatSync` says it's not a symlink → we `unlinkSync` → fails on directories. Not handled.
- No `--no-mirror` / mirror integration (Kiro switch does not update Codex registry — and the inverse is `use`/`switch` mirroring *to* Kiro, but `authmux kiro` is the Kiro-first path; should optionally mirror back to Codex if a matching account name exists).

### Proposed flag changes

| Action     | Flag                  | Notes                                                                                          |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Replace    | implementation        | Delegate to `KiroMirror` (lib).                                                                |
| Add        | `--mirror-codex`      | If a matching Codex snapshot exists, also `useAccount` to keep them aligned.                   |
| Add        | `--list`              | List Kiro snapshots (current behaviour without the picker).                                    |
| Replace    | `--new`               | Rename to `--prep-new` or move to `kiro-login --prep`.                                         |

### Output format proposal

Human preserved.

`--json`:

```json
{ "ok": true, "data": { "active": "personal", "available": ["personal", "work"] } }
```

Exit codes: `0` ok, `2` no-snapshots, `3` invalid-choice, `4` unmanaged-state.

### Test plan

- Existing: `src/tests/test_kiro_account_switcher.py` is the Python integration test. Add `src/tests/cmd-kiro.test.ts` that mocks the lib.

**Priority:** P1. **Effort:** S after `KiroMirror` lands.

---

## authmux kiro-login

### UX critique

`src/commands/kiro-login.ts` runs `kiro-cli login`, then either reports the active snapshot (if `data.sqlite3` is already a symlink) or prompts for a name and renames the regular file into a snapshot.

- `execSync("kiro-cli login", { stdio: "inherit" })` (`src/commands/kiro-login.ts:37`) blocks the event loop. For an inherited-stdio TTY-bound command that's tolerable, but use `runCommand` (proposed in `02-…`) for consistent timeout / error capture.
- The empty `try { execSync... } catch { this.error("kiro-cli login failed.") }` (`src/commands/kiro-login.ts:36-40`) loses the original error. We don't know whether `kiro-cli` is missing, the login was cancelled, or the network failed.
- Uses `readline` instead of `prompts` (`src/commands/kiro-login.ts:17-22`). Inconsistent.
- Validates name with a 7-character regex (`src/commands/kiro-login.ts:13-15`) and the validation is duplicated from `kiro-mirror.ts`'s implicit assumptions. Move both call sites to `isValidProviderName` from the lib.
- The post-login path assumes the user wants the existing file converted, but if `--name` collides with an existing snapshot the command errors out (`src/commands/kiro-login.ts:67-69`). At that point the original regular `data.sqlite3` is intact but unmanaged — the user has to manually clean up. Add `--if-exists=replace|fail|incremented-suffix`.

### Behaviour gaps and edge cases

- If `kiro-cli login` succeeds but leaves `data.sqlite3` as a symlink (the user was already logged in), we report it as a refresh — correct, but the snapshot file the symlink points at may now have new tokens. We should report that "tokens refreshed".
- The `rename` + `symlinkSync` sequence (`src/commands/kiro-login.ts:71-73`) is not atomic. Crash between the two leaves a snapshot but no live `data.sqlite3`.
- No coordination with `authmux save` / `authmux use`. A user who runs `authmux kiro-login --name work` would expect a follow-up `authmux use work` to mirror into Kiro — which it does (if a matching Codex snapshot exists). The interplay deserves a help-text note.
- Hardcoded paths; same path-policy issue.

### Proposed flag changes

| Action     | Flag                  | Notes                                                                                          |
| ---------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Add        | `--if-exists=replace\|fail\|suffix` | Default `fail`; `suffix` appends `-1`, `-2`, ... to find a free name.                |
| Add        | `--non-interactive`   | Refuse to prompt; require `--name`.                                                            |
| Add        | `--skip-kiro-login`   | For testing: skip the `kiro-cli login` call and just process whatever is on disk.              |
| Replace    | implementation        | Delegate to `KiroMirror.adoptFromCurrentLogin(name)` once the lib supports it.                 |

### Output format proposal

Human preserved with a tokens-refreshed note.

`--json`:

```json
{
  "ok": true,
  "data": { "active": "work", "outcome": "adopted\|refreshed", "previousFile": "regular\|symlink" }
}
```

Exit codes: `0` ok, `2` kiro-cli-missing, `3` login-failed, `4` name-conflict.

### Test plan

- Add `src/tests/cmd-kiro-login.test.ts`: fake `kiro-cli` via a temp PATH script that touches `data.sqlite3`; assert adopt / refresh paths.

**Priority:** P1. **Effort:** M.

---

## authmux parallel

### UX critique

`src/commands/parallel.ts` manages `~/.claude-accounts/<name>` profile dirs and writes shell aliases.

- Extends `Command`. Reasonable.
- The flag set is one verb per flag (`--add`, `--remove`, `--list`, `--aliases`, `--install`). Two flags simultaneously are not validated — `--add work --remove personal` silently runs `addProfile("work")` and skips `--remove` because of the if-chain at `src/commands/parallel.ts:44-54`. The chain falls through to `listProfiles` for the no-flag case, which is fine, but combinations are undefined.
- Replace flags with subcommands: `parallel add`, `parallel remove`, `parallel list`, `parallel aliases`, `parallel install`.
- `--install` always writes to the current user's rc file (`shellRcPath`, `src/commands/parallel.ts:16-20`) with a hardcoded fish-incompatible alias syntax (`alias claude-foo="..."`). Fish users get a broken rc file.
- `--install` is idempotent (the marker-block replacement at `src/commands/parallel.ts:125-133`) but the parser is fragile: if the user manually edited the markers, the slice math leaves stray characters. The slice at `endIdx + endMarker.length + 1` (`src/commands/parallel.ts:131`) assumes a trailing newline after the end marker; without one, we lose the first byte of the next block.
- `--install` uses `command claude` in the alias (`src/commands/parallel.ts:99`) to bypass alias recursion. For users whose `claude` is a function rather than a binary, `command` doesn't help.
- `--remove` deletes the directory recursively without confirmation — destroys the user's saved Claude credentials. Add `--yes` and confirm in TTY.
- `--add` allows any string as the profile name; no validation. `parallel --add ' '` would create a directory named with a space.
- The directory `CLAUDE_PARALLEL_DIR` (`src/commands/parallel.ts:6`) is hardcoded; no `--config-dir`-style override.

### Behaviour gaps and edge cases

- Two `parallel --install` calls race on the rc file (covered also by `hook-install`).
- Windows is not supported (`shellRcPath` only knows bash/zsh). The README mentions PowerShell as a manual workaround; the command should detect Windows and print a friendlier error.
- The aliases reference `CLAUDE_CONFIG_DIR=...`. If the directory is removed via `--remove` without updating the aliases, `claude-<name>` still launches with the missing dir.
- Idempotency: `--add` against an existing profile prints "already exists" and exits 0. Should arguably exit 0 with a warning, or exit non-zero behind a flag.

### Proposed flag changes

| Action    | Flag/subcommand              | Notes                                                                                       |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| Replace   | `--add`/`--remove`/etc       | Subcommands `parallel add\|remove\|list\|aliases\|install`. Keep flags as aliases for one release. |
| Add       | `--shell=auto\|bash\|zsh\|fish\|powershell` | Generate appropriate alias syntax.                                                   |
| Add       | `--yes`                      | Skip confirmation on `remove`.                                                              |
| Add       | `--dry-run`                  | For `install`, print the diff.                                                              |
| Add       | `--profile-dir <path>`       | Override `~/.claude-accounts`.                                                              |

### Output format proposal

Human preserved with confirmation prompts added to `remove`.

`--json` (for `list`):

```json
{
  "ok": true,
  "data": {
    "profiles": [
      { "name": "work", "dir": "/home/u/.claude-accounts/work" }
    ]
  }
}
```

Exit codes: `0` ok, `2` profile-not-found, `3` invalid-name, `4` rc-not-writable, `5` unsupported-shell.

### Test plan

- Add `src/tests/cmd-parallel.test.ts`: round-trip add/list/install/remove against temp HOME; install with `--shell=fish` writes fish syntax; concurrent install simulation.

**Priority:** P1. **Effort:** M.

---

## authmux hero

### UX critique

`src/commands/hero.ts` is a hidden marketing/tutorial card with hardcoded ANSI escapes (`src/commands/hero.ts:8-43`).

- References the legacy `agent-auth` binary throughout. Update to `authmux`.
- ANSI escapes are inlined as `\x1b[...m`. Use a small colour helper (`src/lib/ui/colour.ts`) so we can centralise the TTY check and `--no-color` handling.
- No `--plain` flag for environments without colour support.
- Hidden, so only discoverable via README. Consider unhiding and replacing the auto-generated oclif help screen for the bare `authmux` invocation.

### Proposed changes

- Rename the binary in the text.
- Move the layout into a template under `src/lib/ui/hero.ts` and expose a `--no-color` flag.
- Unhide and wire to the bare `authmux` (no args) flow.

### Test plan

- Snapshot test of the produced output (with colour stripped) in `src/tests/cmd-hero.test.ts`.

**Priority:** P3. **Effort:** S.

---

## Cross-command concerns

The per-command sections above repeatedly surface the same shared problems. This section consolidates them into single fixes that span every command file.

### 1. Shared flag parsing (`@oclif/core` v3 patterns)

**Evidence.** Today each command declares `static flags = { ... } as const` independently. Common flags like `--json` and `--quiet` are not inherited because there is no shared base flag set. oclif v3 supports `static baseFlags` for exactly this; we don't use it.

**Diagnosis.** Every new command duplicates the same handful of declarations and forgets at least one. The lack of `baseFlags` also means new global flags require touching every command file.

**Proposal.** In the new `BaseCommand` (see `02-…`):

```ts
static baseFlags = {
  json: Flags.boolean({ description: "Emit machine-readable JSON" }),
  quiet: Flags.boolean({ char: "q", description: "Suppress non-error output" }),
  "config-dir": Flags.string({
    description: "Override the config directory (default: ~/.config/authmux)",
    helpGroup: "GLOBAL",
  }),
  "no-color": Flags.boolean({ description: "Disable ANSI colour output" }),
  verbose: Flags.boolean({ description: "Verbose diagnostic logging" }),
};
```

Subclasses merge their own flags via:

```ts
static flags = { ...super.baseFlags, ...mySpecificFlags };
```

oclif v3 picks the `baseFlags` automatically when `static baseFlags` is declared on the base, so subclasses don't need the explicit spread; but spreading documents intent.

**Migration.** Each command's `static flags` definition becomes a subset that excludes the base flags. The exit handler in `BaseCommand.run` consults `flags.json` / `flags.quiet` / `flags["no-color"]` for output formatting.

**Rollout.** Land `baseFlags`, then migrate commands one at a time. Order: high-traffic commands (`list`, `use`, `switch`, `status`, `current`) first.

**Priority:** P0. **Effort:** M (one PR per command, mostly mechanical).

### 2. Shared prompts wrapper (TTY-safe)

**Evidence.** `prompts` is called directly from `use.ts:66`, `remove.ts:85`, `update.ts:71`, `list.ts:91`. Two more commands (`kiro.ts:66`, `kiro-login.ts:60`) use `readline`. None of them check for `process.stdin.isTTY` before invoking; `prompts` returns `{}` on Ctrl-C and on closed-stdin, which the call sites handle inconsistently — sometimes throwing `PromptCancelledError`, sometimes silently treating as "no".

**Diagnosis.** Closed-stdin behaviour is the main pain. In Docker/CI the commands hang or silently take a default. There is also no `--non-interactive` global flag.

**Proposal.** A single wrapper:

```ts
// src/lib/ui/prompt.ts
export interface PromptOptions {
  nonInteractive?: boolean;          // from global --non-interactive or auto-detected
  fallback?: "fail" | "default";
}

export async function prompt<T>(
  config: PromptObject,
  opts?: PromptOptions,
): Promise<T>;

export async function confirm(
  message: string,
  opts?: { default?: boolean; nonInteractive?: boolean },
): Promise<boolean>;

export async function selectOne<T>(
  message: string,
  choices: { title: string; value: T }[],
  opts?: PromptOptions,
): Promise<T>;

export async function selectMany<T>(
  message: string,
  choices: { title: string; value: T; selected?: boolean }[],
  opts?: PromptOptions,
): Promise<T[]>;
```

Behaviour:

- If `nonInteractive` is true or stdin is not a TTY, return `opts.fallback === "default" ? defaults[choice] : throw PromptRequiredError`.
- On Ctrl-C / closed-stdin while prompting, throw `PromptCancelledError`.
- Standardise the error mapping so `BaseCommand` produces exit `130` for cancellation and a distinct code for "non-interactive without --yes".

**Migration.** Each prompt call site becomes a one-line `await confirm(...)` / `await selectOne(...)`. Drop the per-command `onCancel` boilerplate.

**Priority:** P0. **Effort:** S.

### 3. Shared error-to-exit-code mapping

**Evidence.** Today `BaseCommand.handleError` only recognises `CodexAuthError`. Other custom errors throw and oclif prints `Error: ...` with stack. There is no canonical exit-code table.

**Diagnosis.** Scripts cannot reliably differentiate "no accounts saved" from "permission denied" from "internal bug". This is the single biggest blocker for using authmux in automation.

**Proposal.** A table in `src/lib/error-codes.ts`:

```ts
export const EXIT_CODE: Record<ErrorCode, number> = {
  "internal":              1,
  "no-accounts-saved":     2,
  "account-not-found":     2,
  "auth-snapshot-missing": 2,
  "config-key-missing":    2,
  "invalid-remove-selection": 3,
  "config-invalid":        3,
  "clobber-rejected":      3,
  "pool-degraded":         3,
  "permission-denied":     4,
  "auth-snapshot-invalid": 4,
  "external-tool-missing": 5,
  "ambiguous-query":       6,
  "network-unavailable":   7,
  "lock-held":             8,
  "prompt-cancelled":      130,
  "prompt-required":       131,
};

export function exitCodeFor(code: ErrorCode): number;
```

Each custom error in `src/lib/accounts/errors.ts` (and any new ones in `02-…`) carries an `errorCode: ErrorCode`. `BaseCommand.normaliseError` reads it.

**Migration.** Add `errorCode` to every error class. Update `BaseCommand.run` to consult the table. Document the table in `README.md` (or a new `docs/exit-codes.md`).

**Priority:** P0. **Effort:** S.

### 4. Shared `--config-dir` for testability

**Evidence.** Path resolution is scattered. `account-savings.ts:12` hardcodes `~/.codex/multi-auth`; `usage-refresh.ts:12` hardcodes `~/.codex/accounts`; `clean.ts:6-7` hardcodes `~/.codex`; `export.ts:6`, `import.ts:6`, `kiro.ts:7-10` all do their own thing. Tests rely on `os.homedir()` and have to monkey-patch the environment.

**Diagnosis.** Tests are flaky in shared environments (CI shares HOME between jobs). Users with custom Codex setups cannot point authmux at a different directory.

**Proposal.** A single `AuthmuxPaths` resolver (`02-…` Section 6) that consults:

1. `--config-dir <path>` flag (if present).
2. `AUTHMUX_HOME` env var.
3. `XDG_CONFIG_HOME/authmux` if set.
4. `~/.codex` for backward-compat (current default).

Every command receives a `services.paths` object instead of importing `node:path` + `node:os` directly.

**Migration.** Replace the hardcoded constants with `services.paths.*`. Update tests to set `AUTHMUX_HOME` to a temp dir; remove `os.homedir` monkey-patches.

**Priority:** P0. **Effort:** M.

### 5. Localisation-ready strings

**Evidence.** Strings are inlined as English literals throughout the command files: `"No saved Codex accounts yet. Run \`authmux save <name>\`."` (`list.ts:35`), `"\`codex\` CLI was not found in PATH..."` (`login.ts:81`), and dozens more.

**Diagnosis.** Translating today would require touching every command. More importantly, the strings drift — three commands say "no accounts found" three different ways.

**Proposal.** Add `src/lib/strings.ts` as a single message catalog:

```ts
export const MSG = {
  noAccounts: () => "No saved Codex accounts yet. Run `authmux save <name>`.",
  codexNotFound: () => "`codex` CLI was not found in PATH. Install Codex CLI first, then retry.",
  switchedTo: (from: string | undefined, to: string) =>
    from ? `Switched Codex auth: ${from} → ${to}` : `Switched Codex auth to "${to}".`,
  // …
} as const;
```

Wrap with a tiny i18n helper later if/when needed. The immediate win is consistency.

**Migration.** Mechanical: each inline string becomes `MSG.foo(...)`. Tests assert against `MSG.foo` outputs.

**Priority:** P2. **Effort:** M (low-risk, high-volume change).

### 6. Consistent `--help` examples

**Evidence.** Only `parallel.ts:33-39` declares `static examples`. Every other command relies on the description + flag descriptions alone. New users running `authmux save --help` see no examples.

**Proposal.** Each command gains a `static examples` array of 2–4 lines. Adopt a convention: first example is the canonical happy-path, then variants.

**Priority:** P2. **Effort:** S.

### 7. Consistent command logging

**Evidence.** Each command uses `this.log` (stdout) and `this.warn` (stderr); some commands shoehorn diagnostics into `this.log` (e.g. `list.ts:99` `Skipped update`). The split between human output and diagnostics is unprincipled.

**Proposal.** Adopt the convention:

- `this.log` (stdout): data only.
- Logger (stderr): diagnostics, warnings, progress.
- Prompts: stderr.
- `this.warn` is kept as a thin wrapper around `logger.warn`.

This makes piping safe (`authmux list | jq ...` works; the update prompt does not appear in the data stream).

**Priority:** P1. **Effort:** M (depends on logger from `02-…`).

### 8. Consistent import style

**Evidence.** Half the command files import with `.js` extensions (`switch.ts:3`, `auto-switch.ts:3`); half do not (`use.ts:3`, `login.ts:3`). The TypeScript build settings tolerate both, but consistency aids grep-ability and prevents accidental breakage when the build target changes.

**Proposal.** Pick one style (ESM-compatible `.js` extensions on relative imports, which is the safer long-term choice) and enforce with ESLint.

**Priority:** P3. **Effort:** S.

### 9. Binary-name hygiene

**Evidence.** Multiple commands still reference the legacy `agent-auth` binary name in description text or output strings: `update.ts:16, 53, 60`, `hero.ts` throughout, `kiro.ts:55, 99`, `kiro-login.ts` (implicit), `export.ts:17` (default dir name).

**Proposal.** Search-and-replace `agent-auth` → `authmux` across `src/commands/` in one PR; add an ESLint rule banning the literal `agent-auth` in source.

**Priority:** P1 (user-facing typos). **Effort:** S.

### 10. Consolidate `use` and `switch`

**Evidence.** Two commands switch the active account. `use` is older (no Hermes mirror, no live usage); `switch` is newer (Hermes mirror, optional live usage, numbered query).

**Proposal.** Promote `switch` to the canonical command. Make `use` a deprecated alias for one release that maps to `switch` with `--usage=off`. Document the deprecation in the changelog.

**Priority:** P1. **Effort:** S.

### 11. Consolidate `check` and `forecast`

**Evidence.** Same observation as `use`/`switch`. `forecast` is essentially `check --sort=score --details --no-pool`.

**Proposal.** Promote `check` to canonical with `--sort=score|name` and `--best`. Keep `forecast` as a deprecated alias mapping to `check --sort=score --details`.

**Priority:** P3. **Effort:** S.

### 12. Consolidate `auto-switch` into `daemon`

**Evidence.** `auto-switch` shares its semantics entirely with `daemon --once`. The only difference is missing mirror integration and missing error normalisation.

**Proposal.** Make `daemon --once` the canonical path. Keep `auto-switch` as a deprecated alias for one release.

**Priority:** P2. **Effort:** S.

### 13. Cross-command testing harness

**Evidence.** Tests live under `src/tests/` and target library functions. None of them exercise the actual oclif command pipeline — argv → flag parse → run → output. The closest is `save-account-safety.test.ts`, which tests the service.

**Proposal.** Add `src/tests/cmd-runner.ts`:

```ts
export async function runCmd(argv: string[], opts?: { home?: string; stdin?: string }): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  json?: unknown;
}>;
```

Spawns the CLI in-process against a temp `AUTHMUX_HOME`, captures stdout/stderr, parses `--json` output when present. Every per-command test plan in this document uses it.

**Priority:** P0 (unblocks all the new command tests). **Effort:** M.

### 14. Cross-command sequencing summary

End-state command list, with deprecated aliases removed after one release:

| Canonical command | Current command(s) folded in | Notes                                       |
| ----------------- | ---------------------------- | ------------------------------------------- |
| `switch`          | `use`, `switch`              | One canonical command for account switching. |
| `check`           | `check`, `forecast`          | One canonical command for health reporting. |
| `daemon`          | `daemon`, `auto-switch`      | One canonical command for auto-switch.      |
| `config`          | `config` (refactored)        | Subcommands replace overloaded action arg.  |
| `import`          | `import` (refactored)        | Subcommands replace overloaded positional.  |
| `parallel`        | `parallel` (refactored)      | Subcommands replace verb flags.             |
| `hook`            | `hook-install`, `hook-status`, `hook-remove` | Single noun with `install`/`status`/`remove` subcommands. |
| `provider`        | `kiro`, `kiro-login`         | Generalises to `provider <id> switch|login|prep`.  |
| `update`          | `update`                     | Package-manager-aware.                      |
| `save`            | `save`                       |                                             |
| `login`           | `login`                      |                                             |
| `list`            | `list`                       |                                             |
| `remove`          | `remove`                     |                                             |
| `current`         | `current`                    |                                             |
| `status`          | `status`                     |                                             |
| `savings`         | `savings`                    |                                             |
| `clean`           | `clean`                      |                                             |
| `export`          | `export`                     |                                             |
| `restore-session` | `restore-session`            | Stays hidden.                               |
| `hero`            | `hero`                       | Either drop or unhide.                      |

### 15. Roll-out order

Recommended sequencing for the command-side improvements:

1. **Foundation (P0):** shared exit-code table, base flags (`--json`, `--quiet`, `--config-dir`, `--no-color`, `--verbose`), prompts wrapper, in-process CLI test harness, error-class `errorCode` field. One PR per concern; no behaviour change for existing commands until they opt in.
2. **High-traffic command migration (P0/P1):** `list`, `use`/`switch`, `status`, `current`, `update`, `daemon`. Each migration adds `--json` + non-TTY safety + exit-code mapping.
3. **Provider-mirror generalisation (P1):** introduces `--skip-provider`; deprecates `--no-kiro`. Touches `use`, `switch`, `kiro`, `kiro-login`.
4. **Config / import / parallel subcommand refactors (P1/P2):** clean up overloaded positionals/flags.
5. **Deprecation removals (next major):** drop `use`, `forecast`, `auto-switch`, `hook-install`/`hook-status`/`hook-remove`, in favour of canonical commands.
6. **Localisation catalogue (P2):** mechanical string consolidation, no behaviour change.

Each step is independently shippable. Steps 1 and 2 give the largest user-visible improvement (every command becomes scriptable). Step 3 generalises the integration surface for future providers (Claude Code parallel accounts are the obvious next candidate). Step 4 is internal polish. Step 5 is a major-version bump.
