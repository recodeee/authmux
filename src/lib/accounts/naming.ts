// Name/path utilities extracted from AccountService (Theme N2).
// Pure helpers for account-name validation + the `accounts/<name>.json`
// path mapping. Behavior is byte-identical to the pre-N2 inline versions.

import path from "node:path";
import { resolveAccountsDir } from "../config/paths";
import { InvalidAccountNameError } from "./errors";

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._@+-]*$/;

export function normalizeAccountName(rawName: string | undefined): string {
  if (typeof rawName !== "string") {
    throw new InvalidAccountNameError();
  }

  const trimmed = rawName.trim();
  if (!trimmed.length) {
    throw new InvalidAccountNameError();
  }

  const withoutExtension = trimmed.replace(/\.json$/i, "");
  if (!ACCOUNT_NAME_PATTERN.test(withoutExtension)) {
    throw new InvalidAccountNameError();
  }

  return withoutExtension;
}

export function accountFilePath(name: string): string {
  return path.join(resolveAccountsDir(), `${name}.json`);
}

export function isValidPercent(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 100
  );
}
