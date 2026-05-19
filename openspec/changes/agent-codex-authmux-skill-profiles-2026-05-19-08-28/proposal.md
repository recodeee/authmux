## Why

- Codex startup context is inflated by exposing all Soul skills to every session.
- The user needs authmux to launch Codex and Claude Code with small, role-specific skill sets so new sessions do not burn context on unrelated skills.

## What Changes

- Add authmux account metadata for `skillProfile`.
- Add `authmux skills` commands to list, inspect, save, and activate Soul skill profiles.
- Activate the current skill profile from the Codex shell hook before `command codex`.
- Extend Claude parallel profiles so generated aliases activate a per-profile skills directory before launching Claude Code.

## Impact

- Affects authmux registry shape, `save`, `login`, `use`, `list`, `parallel`, and generated shell hooks.
- Defaults to the `base` profile when no account-specific profile is configured.
- If Soul is not installed, profile activation is skipped with a warning for explicit commands and silently ignored by shell hooks.
