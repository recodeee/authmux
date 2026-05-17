// AuthmuxError taxonomy (see docs/future/01-ARCHITECTURE.md §6.2).
// Stable machine codes survive across releases; human-readable `message`
// strings are kept identical to pre-N3 wording so existing scripts that
// grep stdout continue to work. New code should consume `code`/`severity`/
// `details` rather than parsing `message`.

export type ErrorCode =
  | "E_AUTH_MISSING"
  | "E_AUTH_INVALID"
  | "E_ACCOUNT_NOT_FOUND"
  | "E_NO_ACCOUNTS"
  | "E_NAME_INVALID"
  | "E_NAME_INFERENCE_FAILED"
  | "E_SNAPSHOT_EMAIL_MISMATCH"
  | "E_PROMPT_CANCELLED"
  | "E_REMOVE_EMPTY_SELECTION"
  | "E_QUERY_AMBIGUOUS"
  | "E_AUTOSWITCH_CONFIG"
  | "E_REGISTRY_LOCKED"
  | "E_REGISTRY_CORRUPT"
  | "E_SNAPSHOT_CLOBBERED"
  | "E_DAEMON_UNSUPPORTED_OS"
  | "E_PROVIDER_NOT_INSTALLED"
  | "E_USAGE_FETCH_FAILED";

export type ErrorSeverity = "fatal" | "warn" | "info";

export interface AuthmuxErrorJSON {
  ok: false;
  error: {
    code: ErrorCode;
    severity: ErrorSeverity;
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
  };
}

export class AuthmuxError extends Error {
  public readonly code: ErrorCode;
  public readonly severity: ErrorSeverity;
  public readonly hint?: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    severity: ErrorSeverity,
    message: string,
    hint?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.severity = severity;
    this.hint = hint;
    this.details = details;
  }

  toJSON(): AuthmuxErrorJSON {
    return {
      ok: false,
      error: {
        code: this.code,
        severity: this.severity,
        message: this.message,
        ...(this.hint !== undefined ? { hint: this.hint } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

// Back-compat alias. Pre-N3 code (and external consumers) imported
// `CodexAuthError` as the catch-all base. Keeping it as a subclass of
// `AuthmuxError` lets `instanceof CodexAuthError` checks keep working.
export class CodexAuthError extends AuthmuxError {
  constructor(
    message: string,
    code: ErrorCode = "E_AUTH_INVALID",
    severity: ErrorSeverity = "fatal",
    hint?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, severity, message, hint, details);
    this.name = new.target.name;
  }
}

export class AuthFileMissingError extends CodexAuthError {
  constructor(targetPath: string) {
    super(
      `No Codex auth file found at ${targetPath}. ` +
        `Log into Codex first so ~/.codex/auth.json exists.`,
      "E_AUTH_MISSING",
      "fatal",
      `Run \`codex login\` (or the matching provider login) so ${targetPath} exists.`,
      { path: targetPath },
    );
  }
}

export class AccountNotFoundError extends CodexAuthError {
  constructor(accountName: string) {
    super(
      `No saved Codex account named "${accountName}" was found.`,
      "E_ACCOUNT_NOT_FOUND",
      "fatal",
      `Run "authmux list" to see available names.`,
      { name: accountName },
    );
  }
}

export class NoAccountsSavedError extends CodexAuthError {
  constructor() {
    super(
      `No saved Codex accounts yet. Run "authmux save <name>" first.`,
      "E_NO_ACCOUNTS",
      "fatal",
      `Run "authmux save <name>" after logging into a provider.`,
    );
  }
}

export class InvalidAccountNameError extends CodexAuthError {
  constructor() {
    super(
      "Account names must include at least one non-space character and " +
        "may contain letters, numbers, dashes, underscores, dots, and @.",
      "E_NAME_INVALID",
      "fatal",
      `Pick a name matching /^[A-Za-z0-9._@-]+$/.`,
    );
  }
}

export class AccountNameInferenceError extends CodexAuthError {
  constructor() {
    super(
      "Could not infer account name from auth email. Pass one explicitly: authmux save <name>.",
      "E_NAME_INFERENCE_FAILED",
      "fatal",
      `Pass an explicit name: "authmux save <name>".`,
    );
  }
}

export class SnapshotEmailMismatchError extends CodexAuthError {
  constructor(accountName: string, existingEmail: string, incomingEmail: string) {
    super(
      `Refusing to overwrite snapshot "${accountName}" because it belongs to ` +
        `${existingEmail}, but current auth is ${incomingEmail}. ` +
        `Use a different name, run "authmux remove ${accountName}" first, or re-run with --force.`,
      "E_SNAPSHOT_EMAIL_MISMATCH",
      "fatal",
      `Use a different name, "authmux remove ${accountName}", or pass --force.`,
      { accountName, existingEmail, incomingEmail },
    );
  }
}

export class PromptCancelledError extends CodexAuthError {
  constructor() {
    super(
      "No account selected. The operation was cancelled.",
      "E_PROMPT_CANCELLED",
      "info",
      `Re-run and pick an account, or pass it explicitly as an argument.`,
    );
  }
}

export class InvalidRemoveSelectionError extends CodexAuthError {
  constructor() {
    super(
      "No accounts were selected for removal.",
      "E_REMOVE_EMPTY_SELECTION",
      "warn",
      `Pick at least one account, or pass names as arguments.`,
    );
  }
}

export class AmbiguousAccountQueryError extends CodexAuthError {
  constructor(query: string) {
    super(
      `Query "${query}" matched multiple accounts. Refine the query or use interactive mode.`,
      "E_QUERY_AMBIGUOUS",
      "fatal",
      `Refine the query or omit it to pick interactively.`,
      { query },
    );
  }
}

export class AutoSwitchConfigError extends CodexAuthError {
  constructor(message: string) {
    super(message, "E_AUTOSWITCH_CONFIG", "fatal");
  }
}
