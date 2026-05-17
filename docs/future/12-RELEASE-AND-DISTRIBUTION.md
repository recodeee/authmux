# 12 — Release and Distribution

This file documents how `authmux` is currently shipped, the gaps in that
process, and the target release/distribution architecture. It is written for
maintainers cutting releases, contributors who need to understand the
versioning contract before changing user-visible behavior, and AI agents that
must avoid silently breaking the upgrade path.

Cross-references: postinstall safety is treated in depth in
`docs/future/10-POSTINSTALL-AND-SHELL-HOOK-SAFETY.md`; observability of the
update flow is in `docs/future/13-OBSERVABILITY-AND-LOGGING.md`; cross-platform
implications of bin scripts and managed services are in
`docs/future/14-CROSS-PLATFORM.md`.

## Current

### Package metadata

`package.json` declares `authmux` at version `0.1.24` with two bins
(`authmux` and `agent-auth` both pointing at `dist/index.js`),
`preferGlobal: true`, an `engines.node` floor of `>=18`, and a `files`
allowlist of `dist`, `scripts/postinstall-login-hook.cjs`, `README.md`,
`LICENSE`. The build pipeline is one `tsc` invocation; `prepublishOnly` runs
`npm run build`; there is no separate bundling, no minification, no source-map
strip, no `.npmignore`. See `package.json:1`–`66`.

### Publish flow

There is no `release` or `publish` workflow under `.github/workflows/`. The
only workflow present is `cr.yml`, an AI code-review action that runs on PRs
(`.github/workflows/cr.yml:1`). Releases are therefore cut manually on a
maintainer workstation following the checklist embedded in each
`releases/vX.Y.Z.md` file. As an example, `releases/v0.1.21.md` ends with:

```
1. Review package metadata and release notes.
2. `npm test`
3. `npm pack --dry-run`
4. `npm publish --access public`
5. Create GitHub release `v0.1.21` from `releases/v0.1.21.md`
```

There is no CI gate on `main`, no provenance attestation, no signed publish,
no smoke-install test, no tag protection.

### Update check

`src/lib/update-check.ts` shells out to `npm view authmux version --json` with
a 2.5s timeout (`DEFAULT_UPDATE_CHECK_TIMEOUT_MS`, line 7), caches the result
in `<accountsDir>/update-check.json` (`resolveUpdateCheckCachePath`, line 38),
and applies a 6-hour TTL when an update is pending, dropping to 60s when the
user is already up to date (lines 8–9, 232–237). The cached fetcher is used
by both `src/commands/update.ts` and `src/hooks/init/update-notifier.ts`.

### Update install

Both `update.ts` and the init hook invoke `runGlobalNpmInstall` from
`update-check.ts:268`, which is a thin wrapper around `spawn("npm", ["i",
"-g", <spec>])` with `stdio: "inherit"`. The hook will install the new
version inline when the user accepts the `[Y/n]` prompt during a bare
`authmux` invocation (`update-notifier.ts:38`–`55`) and then `process.exit(0)`
without falling through to the `hero` tutorial. The implementation assumes
`npm` is on `PATH`, that the user has permission to install globally, and
that `npm install -g authmux` is in fact the correct command for the install
method that was used to obtain `authmux` in the first place.

### Postinstall

`scripts/postinstall-login-hook.cjs:104`–`148` runs only when
`npm_config_global === "true"`. It refreshes the shell hook block if marker
lines are present, otherwise it prompts on TTY install. Non-TTY installs are
silently no-op. There is no signature verification of the package, no
checksum file shipped, no SBOM, and no provenance assertion.

### What lives in `releases/`

`releases/` contains hand-written changelogs as plain markdown:
`v0.1.6.md`, `v0.1.16.md`, `v0.1.17.md`, `v0.1.18.md`, `v0.1.19.md`,
`v0.1.20.md`, `v0.1.21.md`. There is no top-level `CHANGELOG.md`; the
release notes are not consolidated, the gaps between `v0.1.6` and `v0.1.16`
are not explained, and nothing currently links these markdown files to a
git tag or a GitHub Release object.

## Versioning

### Policy

`authmux` will commit to semver, with the following explicit rules layered
on top because the project has multiple independently-changing surfaces:

| Surface | Where defined | Bump rule |
| --- | --- | --- |
| User-facing CLI flag set | `src/commands/*.ts` | Removing or renaming a flag is **major**; adding a flag is **minor**; default change that alters output for an existing flag is **minor** with a deprecation log line |
| Subcommand names | `src/commands/*.ts` | Removing a command is **major**; renaming is **major** unless the old name remains as a hidden alias for one minor cycle |
| Stdout shape of `list`, `current`, `status` | `src/commands/list.ts:35`–`60`, `src/commands/current.ts`, `src/commands/status.ts` | When `--json` is added (see doc 04), the JSON contract becomes the stability surface; pretty output is best-effort |
| Exit codes | `src/lib/base-command.ts:21` and per-command `this.error` calls | Adding new non-zero exit codes is **minor**; remapping an existing exit code is **major** |
| Registry on-disk format | `<accountsDir>/registry.json` (`src/lib/config/paths.ts:45`) | Forward-compatible additions (new optional fields) are **minor**; format breaks require a **major** bump and a one-shot migration (see doc 02 + 05) |
| Snapshot file contents | `<accountsDir>/<name>.json` | Treated as opaque Codex/Claude/Kiro vendor data, not authmux’s API; vendor-breaking changes here are not authmux semver events |
| Sessions map | `<accountsDir>/sessions.json` (`paths.ts:49`) | Same as registry: forward-compat fields minor, breaks major |
| Provider adapter SDK (planned, see doc 03) | `src/lib/providers/*` (future) | **Independent semver lane** published under a sub-namespace, e.g. `@authmux/provider-sdk`. The CLI may pin a major range; adapter authors track that range explicitly |
| Environment-variable contract (`CODEX_AUTH_*`) | `src/lib/config/paths.ts` (5 vars today) | Adding new envs is **minor**; renaming or removing is **major** |
| Shell hook block contents | `renderLoginHookBlock` in `src/lib/config/login-hook.ts:39`–`66` | Functional change to what is written into rc files is **minor**; breaking change to the marker comments is **major** because in-place upgrade depends on them |
| Managed service unit contents | `linuxUnitContents`, `macPlistContents` in `service-manager.ts` | Changing the unit file is **minor**; re-keying the service label or task name is **major** because uninstall by old label will silently miss it |

### `0.x` interpretation

While the project is in `0.x`, the maintainers treat minor-version bumps
(`0.X.0`) as the analog of major bumps in `1.x`. Patch bumps (`0.x.Y`) are
strictly additive or fix-only. This rule is mechanical: anything that flips
a row above from "minor" to "major" instead flips from "patch" to "minor"
while the major is `0`. The project should explicitly transition to `1.0.0`
once the registry format and the provider adapter SDK have stabilized for
two consecutive minor cycles without breaking changes.

### Pre-1.0 deprecation

Even in `0.x`, deprecations must run one full minor cycle. If a flag will
be removed in `0.6.0`, it must emit a `warn`-level deprecation in `0.5.0`
that includes the replacement and the removal version. The
`docs/future/13-OBSERVABILITY-AND-LOGGING.md` proposal for a structured
logger reserves the `deprecation` event tag for this purpose.

### Config schema bump

When the registry file shape changes incompatibly:

1. Bump `package.json:version` to the next minor (in `0.x`) or major.
2. Bump `registry.schemaVersion` (a field that does not exist yet; see doc
   02 — register it before the next schema-breaking change ships).
3. Write a one-shot migration in `src/lib/accounts/registry.ts` that reads
   the previous shape, writes the new shape atomically, and records a
   `migration.applied` event into the structured log file.
4. Document the migration in the corresponding `releases/vX.Y.Z.md` under a
   mandatory `## Migration` section.
5. Keep the reverse migration documented even when not implemented, so
   users can roll back by hand if a regression slips through.

### Wire-format of provider adapters

When the adapter SDK exists (doc 03), changing the contract that
adapters consume — e.g. renaming `Snapshot.identity` or changing the
arguments to `adapter.parse()` — must bump the adapter-SDK major and the
CLI minor in lockstep, because the CLI depends on a specific adapter
range. The CLI must refuse to load adapters built against a different
major and surface a clear error rather than crashing.

## Release workflow

### Evidence

Nothing in `.github/workflows/` automates a release.
`releases/vX.Y.Z.md` includes a manual checklist. `npm test` (per
`package.json:16`) only runs the unit tests under `dist/tests/**/*.test.js`
after `npm run build` — there is no integration test, no smoke install, no
matrix.

### Diagnosis

A purely manual release flow is fragile in three specific ways for
`authmux`:

1. **Postinstall hook risk.** Every global install runs a shell-mutating
   script (`scripts/postinstall-login-hook.cjs`). A bad publish can damage
   end-user shells. The current process has no smoke install in a clean
   container before publish.
2. **Update notifier coupling.** A bad publish does not just fail to
   install — because `src/hooks/init/update-notifier.ts` *auto-prompts on
   every bare `authmux` run* and defaults to yes, an installable but broken
   release will be picked up by a large fraction of users within hours of
   publish. Rollback is not free.
3. **Supply-chain.** Without provenance, downstream consumers cannot verify
   that the tarball on npm corresponds to the git tag.

### Proposal — `release.yml` GitHub workflow (P0, M)

Add `.github/workflows/release.yml` that triggers on push of a tag matching
`v[0-9]+.[0-9]+.[0-9]+` and on `workflow_dispatch`. Stages:

1. **Verify.** Checkout at the tag. Read `package.json:version`. Fail if
   it does not equal the tag without the leading `v`.
2. **Install.** `npm ci` on Node 18, 20, 22 LTS lines in matrix.
3. **Typecheck + build.** `npm run build`.
4. **Unit.** `npm test`.
5. **Pack.** `npm pack`. Upload the resulting `authmux-X.Y.Z.tgz` as a
   workflow artifact.
6. **Smoke install.** In a fresh Linux container, `npm i -g
   ./authmux-X.Y.Z.tgz` with `CODEX_AUTH_SKIP_POSTINSTALL=1` set, then
   `authmux --help`, `authmux --version`, `authmux list` against an empty
   accounts dir, and `authmux update --check`. All must exit zero.
7. **Smoke install — macOS.** Same on `macos-latest` runner.
8. **Smoke install — Windows.** Same on `windows-latest` runner with
   `npm i -g authmux-X.Y.Z.tgz`.
9. **Publish.** `npm publish --provenance --access public` using a
   short-lived OIDC token. Token must scope to `authmux` package only. No
   long-lived `NPM_TOKEN` secret in the repo.
10. **GitHub Release.** Use the matching `releases/vX.Y.Z.md` file as the
    release body. Attach the `.tgz` from step 5 and a `SHA256SUMS` text
    file generated in step 6.
11. **Verify.** After 30s, fetch the published tarball back from
    `registry.npmjs.org` and assert that its `sha256` matches the artifact
    from step 5. This guards against tampering between pack and publish.

### Proposal — Changesets or release-please (P1, M)

The current model of hand-writing `releases/vX.Y.Z.md` is brittle and
encourages bumping the version before the notes exist (see `v0.1.21`,
which states the bump was to "proceed with the next manual publish"). Adopt
one of:

- **Changesets** (`@changesets/cli`). PRs include a `.changeset/*.md`
  describing the change and its semver impact. A release PR is opened
  automatically and accumulates changesets until merged, at which point the
  tag is cut.
- **release-please** (Google). Inferred from conventional-commit messages
  on `main`. Simpler if the team commits to conventional commits.

Either tool must continue to write a file under `releases/vX.Y.Z.md`
because the repository already treats those as the canonical record. The
adoption should not delete the manual files; it should produce them.

### Proposal — Pre-release channels (P1, S)

npm dist-tags:

| Tag | Purpose | Triggered by |
| --- | --- | --- |
| `latest` | Default install target | Tag `vX.Y.Z` on `main` |
| `next` | Release-candidate for the next minor | Tag `vX.Y.Z-rc.N` |
| `canary` | Per-commit on `main` for advanced testers | Push to `main`, version derived from commit short SHA |

Update `src/lib/update-check.ts` to read a `channel` from
`<accountsDir>/update-channel` (default `latest`). The npm view call must
include `--tag <channel>` for non-`latest`. The init notifier must label the
channel in the prompt (e.g. `Install authmux X.Y.Z (next) now? [Y/n]`) so a
user on `next` is never surprised.

### Proposal — Reproducible builds (P2, M)

`tsc` output is already deterministic given the same input, but the
`postinstall` step re-runs `tsc` on git installs, so the user's
`dist/index.js` can differ from the published one in trivial ways. Two
fixes:

1. Always ship a built `dist/` in the npm tarball (already the case via
   `files`).
2. Add a CI job that re-runs `tsc` from a clean clone of the tag and
   asserts byte-equality with the tarball's `dist/`. Any drift is a
   release blocker.

### Migration

1. Land `release.yml` behind `workflow_dispatch` only.
2. Cut the next two releases with the workflow in dry-run (no `npm
   publish`) and a manual publish afterwards. Compare artifacts.
3. Enable the publish step.
4. Adopt Changesets or release-please in a follow-up PR.

### Rollout

Coordinate with the postinstall safety doc (10): the smoke-install gate in
step 6 must verify that `CODEX_AUTH_SKIP_POSTINSTALL=1` actually suppresses
the prompt, because that is the escape hatch any downstream automation
needs. If that contract breaks, the release should fail loudly.

## Update UX

### Evidence

- `src/commands/update.ts:18`–`33` exposes `--check`, `--reinstall`, `-y`.
- `src/hooks/init/update-notifier.ts:38`–`55` *auto-installs* on a bare
  `authmux` invocation when the user accepts the prompt. Default is yes
  (`shouldProceedWithYesDefault` returns true on empty input,
  `update-check.ts:162`).
- `runGlobalNpmInstall` hardcodes `npm i -g <pkg>@<version>`
  (`update-check.ts:268`–`285`).
- Update spec is normalized through `formatGlobalInstallSpec`
  (`update-check.ts:139`–`149`).

### Diagnosis

Hardcoding `npm i -g` breaks for users who installed authmux via:

- `pnpm add -g authmux` — `pnpm` users do not want their global store
  bypassed.
- `yarn global add authmux` — classic Yarn places the bin in a different
  prefix; an `npm i -g` would silently install a parallel copy.
- `bun add -g authmux` — same.
- `brew install authmux` (proposed below) — `npm i -g` would shadow the
  Homebrew-managed binary.
- `volta install authmux` — Volta pins per-project versions and resents
  ambient `npm i -g`.
- `npx authmux@latest` users (ephemeral) — should never auto-update,
  there's nothing to update.

In nvm-managed environments, `npm i -g` works without `sudo`. On a system
Node install on Linux, it usually needs `sudo`, and the spawned `npm` will
inherit the unprivileged TTY, fail with `EACCES`, and emit a wall of text
that the user cannot interpret in context.

### Proposal — Install method detection (P0, M)

Add `src/lib/install-method.ts` that returns one of:

```
type InstallMethod =
  | { kind: "npm-global"; prefix: string; needsSudo: boolean }
  | { kind: "pnpm-global"; root: string }
  | { kind: "yarn-classic"; prefix: string }
  | { kind: "bun-global"; root: string }
  | { kind: "brew"; cellar: string }
  | { kind: "volta"; root: string }
  | { kind: "npx-ephemeral" }
  | { kind: "git-local"; checkoutPath: string }
  | { kind: "unknown" };
```

Detection heuristics:

1. Inspect `process.argv[1]` — the launcher script path. If it lives under
   `/opt/homebrew/Cellar`, `/usr/local/Cellar` → `brew`. If under
   `/.volta/tools/image/packages` → `volta`. If under `~/.bun/install/global`
   → `bun-global`. If under `<pnpm-store>/v3/.pnpm-global` or
   `~/.pnpm-global` → `pnpm-global`. If under `<yarn-config-prefix>/lib` →
   `yarn-classic`. Otherwise `npm-global`.
2. For `npm-global`, run `npm prefix -g` to determine the prefix and
   `stat()` it to see if the current user can write it; if not,
   `needsSudo: true`.
3. For `npx-ephemeral`, the path will live under a temp directory
   (`/tmp/.npm/_npx/*` or platform equivalent) — match `_npx` in the path.
4. For `git-local`, the bin path resolves into the working tree's `dist`.

### Proposal — Per-method update command (P0, S)

Once the method is known, `runGlobalUpdate` selects:

| Method | Command |
| --- | --- |
| `npm-global` (no sudo) | `npm i -g authmux@<v>` |
| `npm-global` (sudo) | Print the suggested `sudo npm i -g authmux@<v>` and `exit 0` rather than auto-elevating |
| `pnpm-global` | `pnpm add -g authmux@<v>` |
| `yarn-classic` | `yarn global add authmux@<v>` |
| `bun-global` | `bun add -g authmux@<v>` |
| `brew` | Print `brew upgrade authmux` and `exit 0` |
| `volta` | Print `volta install authmux@<v>` and `exit 0` |
| `npx-ephemeral` | Print "Update skipped — running via npx; rerun with `@latest`" and `exit 0` |
| `git-local` | Print `git pull && npm run build` and `exit 0` |
| `unknown` | Print the npm command as a best guess and `exit 0` |

The "print and exit" cases are deliberate. The user must keep control of
their package manager. Only the `npm-global` no-sudo case should auto-spawn
without confirmation (and only when `-y` is set or when the init hook gets
explicit consent).

### Proposal — `--auto-update` opt-in (P1, S)

Today the init hook *defaults* to installing on a bare invocation. This is
implicitly opt-out, which violates the principle stated for the postinstall
script in doc 10. Replace with:

1. A persistent setting `<accountsDir>/update-policy.json` with shape
   `{ "version": 1, "policy": "ask" | "auto" | "off", "channel":
   "latest" | "next" | "canary" }`. Default `policy: "ask"`.
2. A command `authmux config update --policy <ask|auto|off> [--channel
   <latest|next|canary>]`.
3. The init hook reads the policy; if `off`, no prompt; if `ask`, the
   current `[Y/n]` UX; if `auto`, install without asking, but only when
   the detected install method does not require sudo.
4. Cap the auto-install to once per launch and once per 6h to avoid
   loops if an install partially fails.

### Proposal — Backup tarball channel (P2, L)

When `npm view` is unreachable (offline, proxy, registry outage), the
update flow currently fails silently. Add a fallback:

1. The CI release workflow uploads the tarball as an asset on the GitHub
   Release.
2. `update-check.ts` accepts an `AUTHMUX_UPDATE_TARBALL_BASE` env var.
   When npm is unreachable, fetch the tarball directly with `fetch()`,
   verify its sha256 against `SHA256SUMS` from the release, and run
   `npm i -g ./local.tgz` against it.
3. The sha256 list itself must come from a hard-coded set of trusted
   GPG/sigstore signers (see doc 10's signed-release proposal).

This path is intentionally narrow — it is for users behind enterprise
proxies where npm is mirrored or unavailable, not for routine updates.

### Migration

1. Implement install-method detection. Use it only for *display* first
   (log a debug line) for one minor cycle, while still running `npm i -g`.
2. Add the per-method command map. Switch the init-hook flow first because
   it has the most user impact when wrong.
3. Switch the `update` command last; users invoking it explicitly are more
   tolerant of method-specific behavior.
4. Land the policy file.

### Rollout

Coordinate with doc 13: every update attempt — successful, declined,
failed, skipped — must produce a structured log event so support reports
can trace whether the user's install method was correctly detected.

## Alternative distribution

The npm channel is necessary but not sufficient. Below are concrete
proposals for additional channels.

### Homebrew tap (P1, M)

Create `recodeee/homebrew-tap` with the formula:

```ruby
class Authmux < Formula
  desc "Multi-account auth multiplexer for AI CLI agents"
  homepage "https://github.com/recodeee/authmux"
  url "https://registry.npmjs.org/authmux/-/authmux-X.Y.Z.tgz"
  sha256 "<sha256>"
  license "MIT"

  depends_on "node@20"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
    # Suppress shell-hook prompt during brew install — brew is non-interactive
    ENV["CODEX_AUTH_SKIP_POSTINSTALL"] = "1"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/authmux --version")
  end
end
```

Release workflow extension: after a successful `npm publish`, open a PR
against the tap repo bumping `url` and `sha256`. Auto-merge gated on the
tap's own CI (`brew install --build-from-source ./authmux.rb`).

User flow:

```sh
brew tap recodeee/tap
brew install authmux
```

The brew-installed binary lives in `/opt/homebrew/bin/authmux`
(Apple Silicon) or `/usr/local/bin/authmux` (Intel). Install-method
detection (above) must classify these correctly so `authmux update`
defers to `brew upgrade`.

### Scoop bucket — Windows (P1, M)

Create `recodeee/scoop-bucket` with:

```json
{
  "version": "X.Y.Z",
  "description": "Multi-account auth multiplexer",
  "homepage": "https://github.com/recodeee/authmux",
  "license": "MIT",
  "depends": "nodejs-lts",
  "url": "https://registry.npmjs.org/authmux/-/authmux-X.Y.Z.tgz",
  "hash": "sha256:...",
  "extract_dir": "package",
  "bin": "bin\\authmux.cmd",
  "installer": {
    "script": [
      "$env:CODEX_AUTH_SKIP_POSTINSTALL = '1'",
      "npm install -g --prefix \"$dir\" \"$dir\""
    ]
  }
}
```

User flow:

```powershell
scoop bucket add authmux https://github.com/recodeee/scoop-bucket
scoop install authmux
```

This is the cleanest path for Windows users today and avoids the
ambiguity around `npm i -g` on Windows where the bin shim is a `.cmd`
under `%AppData%\npm` that PowerShell often does not pick up.

### Standalone binary (P2, L)

Two options:

- **`bun build --compile`** — bundles Node into a single executable per
  target triple. Pros: very fast startup; no Node prerequisite. Cons:
  embeds a runtime, ~50MB binary; signing/notarization needed on macOS
  and Windows; postinstall script cannot run as a Node script anymore.
- **`pkg`** — older, archived but still functional. Same trade-offs;
  smaller user community now.

The standalone binary is attractive for the daemon use case (long-running
service, no PATH/Node concerns) and for users who do not have Node
installed. It is unattractive for the CLI use case because all three
target AI CLIs (Codex, Claude Code, Kiro) already require Node-adjacent
toolchains, so adding Node is rarely an extra burden.

Recommendation: ship standalone binaries for the daemon only, distributed
via GitHub Releases as `authmux-daemon-<os>-<arch>`. Keep the CLI on npm.

### Docker image (P2, M)

Use case: self-hosted AI worker fleets where many agents run in parallel
under different accounts. A `recodeee/authmux:X.Y.Z` image:

```Dockerfile
FROM node:20-bookworm-slim
RUN npm i -g authmux@X.Y.Z && \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*
ENV CODEX_AUTH_SKIP_POSTINSTALL=1 \
    CODEX_AUTH_ACCOUNTS_DIR=/data/accounts \
    CODEX_AUTH_CODEX_DIR=/data/.codex
VOLUME /data
ENTRYPOINT ["authmux"]
CMD ["daemon", "--watch"]
```

The image must default to `--watch` because container orchestrators expect
a long-lived foreground process. The `CODEX_AUTH_SKIP_POSTINSTALL=1` env is
essential because no shell rc file exists inside a typical container and
the prompt would dangle.

A second `recodeee/authmux:X.Y.Z-cli` tag without `ENTRYPOINT` is useful
for one-shot `docker run --rm` invocations.

### Nix flake (P3, S)

```nix
{
  description = "authmux";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }: let
    pkgs = nixpkgs.legacyPackages.x86_64-linux;
  in {
    packages.x86_64-linux.default = pkgs.buildNpmPackage {
      pname = "authmux";
      version = "X.Y.Z";
      src = pkgs.fetchurl {
        url = "https://registry.npmjs.org/authmux/-/authmux-X.Y.Z.tgz";
        sha256 = "...";
      };
      npmDepsHash = "...";
      # Disable postinstall; Nix builds are sandboxed and cannot mutate
      # the user's shell rc.
      npmFlags = [ "--ignore-scripts" ];
      dontNpmBuild = true;
    };
  };
}
```

Nix users routinely set `--ignore-scripts`. Document the trade-off (the
shell hook will not auto-install; users must run `authmux hook-install`
manually) in the flake's README.

### AUR — Arch Linux (P3, S)

PKGBUILD that wraps `npm install -g --prefix=/usr authmux`. Same
postinstall suppression. Owned by a maintainer who agrees to update on
release.

## Postinstall safety

The full discussion lives in `docs/future/10-POSTINSTALL-AND-SHELL-HOOK-
SAFETY.md`. Summary of the release-relevant rules:

1. Every release workflow must smoke-install with
   `CODEX_AUTH_SKIP_POSTINSTALL=1` and assert success.
2. Every release workflow must *also* smoke-install without the env var,
   inside a container with a controlled rc file, and verify that the rc
   file ends with exactly one hook block bracketed by
   `LOGIN_HOOK_MARK_START` / `LOGIN_HOOK_MARK_END` (`src/lib/config/login-
   hook.ts:5`–`6`). This catches accidental duplication or
   regex-corruption regressions before publish.
3. Provenance attestation (`npm publish --provenance`) is mandatory once
   `release.yml` lands. Postinstall scripts that mutate user environments
   without provenance are a known supply-chain attack vector.
4. The published tarball must not exceed an agreed size budget (suggest
   2 MB) — if it grows beyond that, investigate before publish. Today the
   build output is small enough that any sudden jump is suspicious.

## Deprecation policy

### Surface

Anything in the versioning table above marked as having a major-bump
impact is part of the deprecation surface.

### Process

1. **Announce** in the `releases/vX.Y.Z.md` for the release that
   introduces the replacement, under a mandatory `## Deprecations`
   section.
2. **Warn** at runtime via the structured logger (see doc 13) with
   level `warn` and a stable event tag `deprecation.<surface>`. The
   warning must include: the deprecated thing, the replacement, and the
   removal version.
3. **Soak** for at least one minor release cycle.
4. **Remove** in the next minor (or major). The removal release's notes
   must include a `## Removed` section that lists every removed deprecation
   with a link back to its announcement release.

### Worked example — renaming `agent-auth` bin

`package.json:6`–`9` declares both `authmux` and `agent-auth` as bins.
The `agent-auth` name predates the rename and is currently referenced in
`src/commands/update.ts:53` (`Run \`agent-auth self-update\``) — that line
should be updated to `authmux update`, see doc 04. Concrete deprecation:

- `0.2.0`: `agent-auth` continues to work but prints a warn-level
  deprecation on each invocation (`authmux.deprecation.bin.agent-auth`).
- `0.3.0`: `agent-auth` is removed from `bin`. Release notes link back to
  `0.2.0`.

### Worked example — env var rename `CODEX_AUTH_*` → `AUTHMUX_*`

The env vars in `src/lib/config/paths.ts` (`CODEX_AUTH_CODEX_DIR`,
`CODEX_AUTH_ACCOUNTS_DIR`, `CODEX_AUTH_JSON_PATH`,
`CODEX_AUTH_CURRENT_PATH`, `CODEX_AUTH_SESSION_MAP_PATH`) all carry the
old project name. Renaming them is a major event. The migration:

- `0.4.0`: introduce `AUTHMUX_*` aliases. The resolver reads the new name
  first, then falls back to the old name with a warn-level log per process
  invocation (`authmux.deprecation.env.codex-auth-prefix`).
- `0.5.0`: remove the old names.

The deprecation warning must be emitted exactly once per process. The
logger proposal in doc 13 requires a `dedupe` helper for this; without it,
busy daemons would spam the log file.

### Documentation

Each deprecation gets one row in a top-level `CHANGELOG.md`
`## Deprecations` table and a paragraph in the migration guide for the
removal release. The release workflow must fail if the `## Deprecations`
section is added without the corresponding removal-version cross-link.

## Open questions

1. Should `authmux` adopt conventional-commits? Required for
   release-please but not for changesets. Maintainer preference TBD.
2. Should the GitHub Release body be authoritative, or
   `releases/vX.Y.Z.md`? Recommendation: the markdown file in the repo is
   the source of truth, and the GitHub Release body is generated from it.
3. What is the support window for old minors? Recommend: each minor is
   supported for security backports for 90 days after the next minor
   ships, and the current minor always receives bug fixes.
4. Should we publish to GitHub Packages in addition to npm? Useful for
   air-gapped CI; low priority until a real user asks.

## Acceptance for this slice

- `release.yml` exists, is documented, passes a dry-run on the next two
  releases before being enabled for publish.
- `update-check.ts` is install-method-aware and refuses to spawn `npm i
  -g` when the detected method is `brew`, `volta`, `pnpm`, `bun`,
  `yarn-classic`, or `npx`.
- A top-level `CHANGELOG.md` exists and is generated, not hand-edited.
- `releases/vX.Y.Z.md` continues to exist for every release.
- Deprecation warnings flow through the structured logger from doc 13.
- The Homebrew tap and Scoop bucket repositories exist and are bumped
  automatically on each `latest` publish.
