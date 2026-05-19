## ADDED Requirements

### Requirement: Account Skill Profile Metadata
authmux SHALL allow a saved Codex account to store an optional Soul skill profile name.

#### Scenario: Saving an account profile
- **WHEN** a user runs `authmux save <name> --skill-profile frontend`
- **THEN** the registry entry for `<name>` stores `skillProfile=frontend`
- **AND** later account listings can expose that profile.

### Requirement: Current Skill Profile Resolution
authmux SHALL resolve the current skill profile from explicit environment override, active account metadata, then the `base` default.

#### Scenario: Activating current profile
- **WHEN** `authmux skills activate-current --agent codex` runs for an active account without metadata
- **THEN** authmux activates the `base` Soul profile.

### Requirement: Codex Launch Hook Profile Activation
The generated Codex shell hook SHALL activate the current skill profile before launching Codex.

#### Scenario: Starting Codex through the hook
- **WHEN** the shell function `codex` is invoked
- **THEN** it restores the authmux session
- **AND** runs `authmux skills activate-current --agent codex`
- **AND** then runs `command codex`.

### Requirement: Claude Parallel Profile Activation
authmux SHALL allow Claude parallel profiles to carry a Soul skill profile and SHALL activate that profile in generated aliases.

#### Scenario: Generating a Claude alias
- **WHEN** a Claude parallel profile has `skillProfile=frontend`
- **THEN** its generated alias activates the `frontend` profile into that Claude profile's skills directory before launching `claude`.
