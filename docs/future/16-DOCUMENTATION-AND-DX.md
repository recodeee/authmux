# 16 — Documentation and Developer Experience

## Current docs surface

The project today has three documentation surfaces, plus the protocol you
are reading.

| Surface                          | Path                              | Audience                              |
| -------------------------------- | --------------------------------- | ------------------------------------- |
| User-facing README               | `/README.md`                       | First-time users on npm landing page  |
| Agent / Guardex contract         | `/AGENTS.md`                       | AI agents operating the repo          |
| OpenSpec change tracker          | `/openspec/changes/`               | In-flight change proposals            |
| Improvement protocol (this set)  | `/docs/future/*.md`                | Maintainers + future contributors     |

This is functional but thin. Specifically missing:

- No per-command markdown pages. Users discover flags only by typing
  `authmux <cmd> --help` and parsing oclif's text output.
- No troubleshooting guide. Every "auth.json got clobbered" question is
  resolved in chat or GitHub issues with no canonical writeup.
- No contribution guide separate from `AGENTS.md` (which is dense and
  written for AI agents, not humans).
- No FAQ. Questions like "does authmux send my credentials anywhere?" are
  answered ad-hoc.
- No examples directory. A user wanting to wire `authmux use` into their
  shell prompt has to read source.
- No architecture diagram visible from the README. `docs/future/01-ARCHITECTURE.md`
  exists in the protocol but is not surfaced anywhere a casual visitor lands.

## Gaps

### G1 — Per-command reference

`authmux <cmd> --help` text is the only reference. There is no scrollable,
searchable, link-anchorable list of all 26 commands.

### G2 — Troubleshooting

The project has shipped at least the following classes of bugs (see
`releases/v0.1.*.md` summarized in `00-OVERVIEW.md`):

- `auth.json` clobbered via stale symlink (recovered via snapshot-backup
  vault).
- External `codex login` writing an unrecognized snapshot that authmux then
  needs to reconcile.
- Daemon failing to re-evaluate after a transient network blip on the
  usage endpoint.

Each of those has a known resolution. None of them is written down outside
of release notes.

### G3 — Contribution guide

`AGENTS.md` covers Guardex flow, OMX caveman style, branch claiming. A
human contributor opening their first PR needs: how to clone, how to
install, how to run tests, how to add a command, how to add a provider
adapter, what the commit-message convention is. None of that exists today
as a CONTRIBUTING.md.

### G4 — FAQ

A two-page FAQ would cover roughly 80% of GitHub Discussions in the
project's likely first year. Topics:

- "Does authmux upload my Codex credentials?"
- "Why does my shell still drop me into the wrong account after `authmux
  use`?"
- "How do I migrate from `codex` login flow to `authmux save`?"
- "What does `--no-kiro` actually skip?"
- "Why does `authmux daemon --watch` keep restarting?"

### G5 — Examples directory

No `examples/` tree. A user wanting recipes such as:

- "Switch account based on git remote"
- "Pin terminal to account for the lifetime of a tmux pane"
- "Wire authmux into starship prompt"

...has nothing to copy-paste.

### G6 — Architecture diagram

`docs/future/01-ARCHITECTURE.md` already exists in the protocol. It is not
linked from the README. A README-level ASCII or Mermaid diagram that
orients the reader in the first scroll-page would close the gap for casual
visitors and PR reviewers.

## Proposed docs site layout

Use a static site generator (Docusaurus, Astro Starlight, or `vitepress` —
choose whichever requires the fewest dev-deps; Starlight is recommended
because its Markdown-first model maps 1:1 onto the existing `docs/future/`
files). Map URLs to source files explicitly so that "where does this page
live in git" is unambiguous.

| URL path                    | Source                                              |
| --------------------------- | --------------------------------------------------- |
| `/`                         | `docs/site/index.md` (quickstart, distilled README) |
| `/cli/<command>`            | Auto-generated from oclif metadata (see Auto-gen)   |
| `/guides/codex`             | `docs/site/guides/codex.md`                         |
| `/guides/claude-code`       | `docs/site/guides/claude-code.md`                   |
| `/guides/kiro`              | `docs/site/guides/kiro.md`                          |
| `/concepts/snapshots`       | `docs/site/concepts/snapshots.md`                   |
| `/concepts/pinning`         | `docs/site/concepts/pinning.md`                     |
| `/concepts/auto-switch`     | `docs/site/concepts/auto-switch.md`                 |
| `/troubleshooting`          | `docs/site/troubleshooting.md`                      |
| `/internals/architecture`   | `docs/future/01-ARCHITECTURE.md` (published as-is)  |
| `/internals/performance`    | `docs/future/15-PERFORMANCE-AND-SCALABILITY.md`     |
| `/internals/glossary`       | `docs/future/18-GLOSSARY-AND-APPENDICES.md`         |
| `/contributing`             | `/CONTRIBUTING.md` (new top-level file)             |
| `/security`                 | `/SECURITY.md` (new top-level file)                 |

The point of the explicit mapping is that **no page on the published site
exists without a single source file in git**. That kills the "the website
says X but the code says Y" failure mode.

## Auto-generation

oclif ships a `oclif readme` command that updates a README's
`<!-- commands -->` block with auto-generated command reference. Use it
twice:

### In-repo

Keep `README.md` as the public-facing landing page. Insert the block:

```
<!-- commands -->
... auto-generated by `oclif readme` ...
<!-- commandsstop -->
```

Run `npx oclif readme --multi` in a pre-commit hook so the block stays
synchronized with command metadata. Reject commits that mutate the block
manually.

### On the docs site

For each command, generate one Markdown page at `/cli/<command>` by
walking `oclif.config.commands` and rendering:

- Description
- Usage line
- Flags table
- Args table
- Examples (pulled from `static examples = [...]` on the command class —
  enforce this in a CI check)

The pre-commit hook running `oclif readme --multi` writes to
`docs/site/cli/`, with one file per command. CI fails if the generated
content differs from what is committed.

## Contributor experience

### One-command bootstrap

Today: `npm install && npm run build && npm test`. Acceptable but
discoverable only if the reader knows oclif/Node conventions. Replace with:

```sh
make bootstrap   # or: npm run bootstrap
```

That single target should:

1. Verify Node ≥ 18.
2. Install dependencies.
3. Build the TypeScript.
4. Run the test suite.
5. Print "Next steps:" with a few sample commands (`authmux current`,
   `authmux list`, etc.).

The target lives in a `Makefile` (or `scripts/bootstrap.sh`) at the repo
root. Both paths invoke the same npm script under the hood.

### Devcontainer / Codespaces

Add `.devcontainer/devcontainer.json` with a pinned Node 18 image, the
extensions list (TypeScript, ESLint, Prettier), and a `postCreateCommand`
that runs the bootstrap target. This lets a brand-new contributor go from
"click 'Open in Codespaces'" to "tests pass" without local Node install.

### Lint + format

`package.json:56-58` lists only `@types/prompts` as a dev dependency. There
is no ESLint, no Prettier. Add:

- `eslint` with `@typescript-eslint/parser` and a minimal config covering
  no-floating-promises, no-unused-vars, prefer-const.
- `prettier` with the project's existing implicit style (2-space indent,
  trailing commas, semicolons — derived from reading
  `src/lib/accounts/registry.ts` and `src/lib/accounts/usage.ts`).
- Wire both into a `lint-staged` pre-commit hook.
- Wire CI to fail on lint or format drift.

The introduction PR for ESLint/Prettier should reformat the entire `src/`
tree in one commit and add `.git-blame-ignore-revs` so blame stays
useful. Reformat once, never again.

### Conventional Commits + changesets

Adopt Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, ...) and
the `changesets` tooling for release notes. Today release notes are
hand-written under `releases/v0.1.*.md`; the proposal in `14-RELEASE-AND-
DISTRIBUTION.md` (planned) covers automating those.

Concretely:
- Add `.changeset/` with an empty config.
- Add a `changeset` script to `package.json` that opens the prompt.
- Require a changeset entry on PRs that touch `src/` (CI check).

### PR + issue templates

Today there is no `.github/pull_request_template.md` and no issue
templates. Add:

- `pull_request_template.md` with sections: Summary, Linked OpenSpec change
  (if any), Test plan, Risk tag, Release-note line.
- `ISSUE_TEMPLATE/bug.yml` capturing: authmux version, Node version, OS,
  command run, expected vs actual.
- `ISSUE_TEMPLATE/feature.yml` capturing: user story, why-now, related
  protocol section.
- `ISSUE_TEMPLATE/config.yml` to point users to GitHub Discussions for
  open-ended questions.

### CODEOWNERS

Add `.github/CODEOWNERS` mapping `src/lib/accounts/`, `src/commands/`,
`scripts/`, `docs/future/` to the right reviewers. With Guardex active,
this also helps lock claims align with code ownership.

## Demo and onboarding

### Animated terminal demo

Use `vhs` (Charm's terminal-to-gif tool) to record a 60-second demo of:

1. `authmux save personal`
2. `authmux save work`
3. `authmux list`
4. `authmux use work`
5. `codex` (showing it picked up the work account)

Check the `.tape` source and the rendered `.gif` into `docs/demos/`.
Reference the gif from the README's first scroll-page so visitors see
authmux in action without watching a separate video.

### 60-second video script

A written script (under `docs/demos/script.md`) that anyone with a screen
recorder can re-shoot when the UI changes:

```
0:00  "authmux multiplexes your Codex / Claude / Kiro credentials."
0:05  Open empty ~/.codex/accounts/, run `authmux save personal`,
      authenticate via the device-code flow.
0:20  Run `authmux save work`, authenticate again with a second
      account.
0:35  Run `authmux list`. Highlight the active marker.
0:42  Run `authmux use personal`. Show the active pointer move.
0:50  Open a new shell, run `codex`, observe it uses the personal
      account.
0:58  "That's authmux. MIT licensed. Not affiliated with OpenAI or
      Anthropic."
```

### Onboarding checklist for new contributors

A `docs/site/contributing/onboarding.md` that walks a brand-new
contributor through:

1. Read the README.
2. Read `AGENTS.md` (skim — Guardex is for AI agents but you should know
   it exists).
3. Pick a "good first issue" labeled item.
4. Run `npm run bootstrap`.
5. Read `01-ARCHITECTURE.md` for the area you'll touch.
6. Open a draft PR early; the maintainers will help.

## I18n readiness

The project is single-language (English) today. There is no plan to ship
translations soon, but the *readiness* work is cheap and pays off when
demand appears.

### Single string module

Move all user-facing log strings out of command bodies into a single
module `src/lib/i18n/strings.ts` exporting a typed object:

```ts
export const strings = {
  use: {
    switched: (name: string) => `Switched Codex auth to "${name}".`,
    kiroMirrored: (name: string) => `Mirrored Kiro CLI to "${name}".`,
    noKiroSnapshot: (reason: string) => `Kiro mirror skipped: ${reason}.`,
  },
  list: {
    empty: 'No saved Codex accounts yet. Run `authmux save <name>`.',
    // ...
  },
} as const;
```

Command bodies import from this module instead of inlining strings. This
buys two things:
- Translators have one file to translate.
- A typo in a log message is caught in one place.

### Do not block on translation

The proposal is structural-only. Actual translations should land only when
a maintainer or contributor commits to maintaining a locale long-term.
"Half-translated" is worse than "English only".

### Right-to-left

Deferred. Terminal RTL support is fragmented across emulators and there
is no near-term demand. Acknowledge the gap; do not solve it.

## Error message guide

Every user-facing error today is a `this.error(...)` or `this.warn(...)`
call. The proposal in `10-ERROR-MODEL.md` (planned) covers stable error
codes; the *docs* angle is:

### Every error must say four things

1. **What happened.** "Could not read auth.json at `<path>`."
2. **Why.** "The file does not exist or is unreadable."
3. **How to fix.** "Run `authmux save <name>` to create the first
   account, or set `CODEX_AUTH_JSON_PATH` to point at an existing file."
4. **A stable URL anchor.** "See: https://authmux.dev/errors/E_AUTH_MISSING"

### Error catalogue page

`docs/site/errors/index.md` lists every error code with the four sections
above. Each error gets its own anchor (`/errors#E_AUTH_MISSING`) so
deep-links from CLI output are stable across docs-site refactors.

### Anchor stability rule

Once an error code ships in a public release, its anchor is permanent.
Renaming it requires:

1. Add the new anchor.
2. Add a 301-redirect from the old anchor.
3. Keep the redirect for at least one major version.

This is the docs equivalent of API-stability discipline.

## Summary of proposals

| ID      | Proposal                                | Priority | Effort |
| ------- | --------------------------------------- | -------- | ------ |
| P-16.1  | Static docs site with explicit URL map  | P1       | M      |
| P-16.2  | oclif readme auto-gen + pre-commit hook | P1       | S      |
| P-16.3  | `make bootstrap` / `npm run bootstrap`  | P2       | S      |
| P-16.4  | Devcontainer / Codespaces config        | P2       | S      |
| P-16.5  | ESLint + Prettier + lint-staged         | P1       | M      |
| P-16.6  | Conventional Commits + changesets       | P2       | M      |
| P-16.7  | PR + issue templates + CODEOWNERS       | P1       | S      |
| P-16.8  | `vhs` demo gif in README                | P2       | S      |
| P-16.9  | Single string module (i18n readiness)   | P3       | M      |
| P-16.10 | Error catalogue page + anchor stability | P1       | M      |
| P-16.11 | CONTRIBUTING.md (human-readable)        | P1       | S      |
| P-16.12 | SECURITY.md with disclosure policy      | P0       | S      |
| P-16.13 | FAQ page                                | P2       | S      |
| P-16.14 | Examples directory with recipes         | P2       | M      |
| P-16.15 | Troubleshooting guide                   | P1       | M      |

## Done criteria

- Site is live at a stable URL (recommended: `authmux.dev` or
  `recodeee.github.io/authmux`).
- Every command listed in `00-OVERVIEW.md`'s "Command catalogue" has a
  corresponding `/cli/<command>` page generated from oclif metadata.
- README's `<!-- commands -->` block is regenerated by CI on every push to
  `main`.
- A new contributor can go from `git clone` to `npm test passing` with one
  command, with no manual debugging.
- Every `this.error()` call in `src/commands/` and `src/lib/` either
  references a documented error code or carries a TODO with an issue link.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODEOWNERS`, and the PR/issue
  templates exist at the repo root.

Until all six of those are true, the project ships docs as a side-effect of
shipping code, which is a bad place to be.
