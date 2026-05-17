// JSON envelope shape for --json output (Theme N3).
// Success: { "ok": true, "data": <command-specific payload> }
// Error:   { "ok": false, "error": { code, severity, message, hint?, details? } }
// One object per invocation, written to stdout via console.log. Human prose
// goes to stderr (or is suppressed) so stdout stays parseable.

import type { AuthmuxErrorJSON, ErrorCode } from "../accounts/errors";
import { AuthmuxError } from "../accounts/errors";

export interface JsonSuccess<T = unknown> {
  ok: true;
  data: T;
}

export type JsonEnvelope<T = unknown> = JsonSuccess<T> | AuthmuxErrorJSON;

export function jsonSuccess<T>(data: T): JsonSuccess<T> {
  return { ok: true, data };
}

export function jsonError(err: AuthmuxError): AuthmuxErrorJSON {
  return err.toJSON();
}

// Exit-code table per docs/future/01-ARCHITECTURE.md §6.3.
// 0  Success
// 1  Generic failure
// 2  Usage error (oclif default)
// 3  E_AUTH_MISSING
// 4  E_ACCOUNT_NOT_FOUND
// 5  E_SNAPSHOT_EMAIL_MISMATCH
// 6  E_REGISTRY_LOCKED
// 7  E_REGISTRY_CORRUPT
// 8  E_PROVIDER_NOT_INSTALLED
// 64 E_PROMPT_CANCELLED
export function exitCodeForErrorCode(code: ErrorCode): number {
  switch (code) {
    case "E_AUTH_MISSING":
      return 3;
    case "E_ACCOUNT_NOT_FOUND":
      return 4;
    case "E_SNAPSHOT_EMAIL_MISMATCH":
      return 5;
    case "E_REGISTRY_LOCKED":
      return 6;
    case "E_REGISTRY_CORRUPT":
      return 7;
    case "E_PROVIDER_NOT_INSTALLED":
      return 8;
    case "E_PROMPT_CANCELLED":
      return 64;
    default:
      return 1;
  }
}

export function writeJsonEnvelope(envelope: JsonEnvelope): void {
  // Single-line JSON on stdout; nothing else.
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
