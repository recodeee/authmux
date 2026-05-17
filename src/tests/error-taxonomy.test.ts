// Enforces the §6.2 error-code allowlist and the §6.3 severity table.
// If you add a new AuthmuxError subclass, append it here too.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AccountNameInferenceError,
  AccountNotFoundError,
  AmbiguousAccountQueryError,
  AuthFileMissingError,
  AuthmuxError,
  AutoSwitchConfigError,
  CodexAuthError,
  InvalidAccountNameError,
  InvalidRemoveSelectionError,
  NoAccountsSavedError,
  PromptCancelledError,
  SnapshotEmailMismatchError,
} from "../lib/accounts";
import type { ErrorCode, ErrorSeverity } from "../lib/accounts";
import { exitCodeForErrorCode } from "../lib/cli/json-envelope";

const ALLOWED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "E_AUTH_MISSING",
  "E_AUTH_INVALID",
  "E_ACCOUNT_NOT_FOUND",
  "E_NO_ACCOUNTS",
  "E_NAME_INVALID",
  "E_NAME_INFERENCE_FAILED",
  "E_SNAPSHOT_EMAIL_MISMATCH",
  "E_PROMPT_CANCELLED",
  "E_REMOVE_EMPTY_SELECTION",
  "E_QUERY_AMBIGUOUS",
  "E_AUTOSWITCH_CONFIG",
  "E_REGISTRY_LOCKED",
  "E_REGISTRY_CORRUPT",
  "E_SNAPSHOT_CLOBBERED",
  "E_DAEMON_UNSUPPORTED_OS",
  "E_PROVIDER_NOT_INSTALLED",
  "E_USAGE_FETCH_FAILED",
]);

interface Expectation {
  className: string;
  instance: AuthmuxError;
  expectedCode: ErrorCode;
  expectedSeverity: ErrorSeverity;
}

const expectations: Expectation[] = [
  {
    className: "AuthFileMissingError",
    instance: new AuthFileMissingError("/tmp/auth.json"),
    expectedCode: "E_AUTH_MISSING",
    expectedSeverity: "fatal",
  },
  {
    className: "AccountNotFoundError",
    instance: new AccountNotFoundError("alice"),
    expectedCode: "E_ACCOUNT_NOT_FOUND",
    expectedSeverity: "fatal",
  },
  {
    className: "NoAccountsSavedError",
    instance: new NoAccountsSavedError(),
    expectedCode: "E_NO_ACCOUNTS",
    expectedSeverity: "fatal",
  },
  {
    className: "InvalidAccountNameError",
    instance: new InvalidAccountNameError(),
    expectedCode: "E_NAME_INVALID",
    expectedSeverity: "fatal",
  },
  {
    className: "AccountNameInferenceError",
    instance: new AccountNameInferenceError(),
    expectedCode: "E_NAME_INFERENCE_FAILED",
    expectedSeverity: "fatal",
  },
  {
    className: "SnapshotEmailMismatchError",
    instance: new SnapshotEmailMismatchError("alice", "a@x.com", "b@x.com"),
    expectedCode: "E_SNAPSHOT_EMAIL_MISMATCH",
    expectedSeverity: "fatal",
  },
  {
    className: "PromptCancelledError",
    instance: new PromptCancelledError(),
    expectedCode: "E_PROMPT_CANCELLED",
    expectedSeverity: "info",
  },
  {
    className: "InvalidRemoveSelectionError",
    instance: new InvalidRemoveSelectionError(),
    expectedCode: "E_REMOVE_EMPTY_SELECTION",
    expectedSeverity: "warn",
  },
  {
    className: "AmbiguousAccountQueryError",
    instance: new AmbiguousAccountQueryError("ali"),
    expectedCode: "E_QUERY_AMBIGUOUS",
    expectedSeverity: "fatal",
  },
  {
    className: "AutoSwitchConfigError",
    instance: new AutoSwitchConfigError("bad config"),
    expectedCode: "E_AUTOSWITCH_CONFIG",
    expectedSeverity: "fatal",
  },
];

test("every error class extends AuthmuxError and has an allowlisted code", () => {
  for (const exp of expectations) {
    assert.ok(
      exp.instance instanceof AuthmuxError,
      `${exp.className} must extend AuthmuxError`,
    );
    assert.equal(exp.instance.code, exp.expectedCode, `${exp.className} code`);
    assert.equal(
      exp.instance.severity,
      exp.expectedSeverity,
      `${exp.className} severity`,
    );
    assert.ok(
      ALLOWED_CODES.has(exp.instance.code),
      `${exp.className} code ${exp.instance.code} is not in §6.2 allowlist`,
    );
  }
});

test("CodexAuthError remains a back-compat subclass of AuthmuxError", () => {
  const err = new CodexAuthError("legacy");
  assert.ok(err instanceof AuthmuxError);
  assert.ok(err instanceof CodexAuthError);
  // Every concrete subclass must also satisfy `instanceof CodexAuthError`
  // because legacy code (and BaseCommand pre-N3) caught that class.
  for (const exp of expectations) {
    assert.ok(
      exp.instance instanceof CodexAuthError,
      `${exp.className} should still be a CodexAuthError for back-compat`,
    );
  }
});

test("toJSON envelope has the §6.3 shape", () => {
  const err = new AccountNotFoundError("alice");
  const env = err.toJSON();
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_ACCOUNT_NOT_FOUND");
  assert.equal(env.error.severity, "fatal");
  assert.equal(typeof env.error.message, "string");
  assert.deepEqual(env.error.details, { name: "alice" });
});

test("exit-code table matches §6.3", () => {
  assert.equal(exitCodeForErrorCode("E_AUTH_MISSING"), 3);
  assert.equal(exitCodeForErrorCode("E_ACCOUNT_NOT_FOUND"), 4);
  assert.equal(exitCodeForErrorCode("E_SNAPSHOT_EMAIL_MISMATCH"), 5);
  assert.equal(exitCodeForErrorCode("E_REGISTRY_LOCKED"), 6);
  assert.equal(exitCodeForErrorCode("E_REGISTRY_CORRUPT"), 7);
  assert.equal(exitCodeForErrorCode("E_PROVIDER_NOT_INSTALLED"), 8);
  assert.equal(exitCodeForErrorCode("E_PROMPT_CANCELLED"), 64);
  // Generic fallback for unmapped codes.
  assert.equal(exitCodeForErrorCode("E_USAGE_FETCH_FAILED"), 1);
});
