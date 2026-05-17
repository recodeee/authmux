// Unit tests for src/lib/accounts/naming.ts (Theme N2).

import test from "node:test";
import assert from "node:assert/strict";

import {
  accountFilePath,
  isValidPercent,
  normalizeAccountName,
} from "../lib/accounts/naming";
import { InvalidAccountNameError } from "../lib/accounts/errors";

test("normalizeAccountName strips a trailing .json", () => {
  assert.equal(normalizeAccountName("alice.json"), "alice");
});

test("normalizeAccountName accepts emails, plus, dots, underscores", () => {
  assert.equal(normalizeAccountName("foo.bar+work@example.com"), "foo.bar+work@example.com");
});

test("normalizeAccountName rejects empty / whitespace", () => {
  assert.throws(() => normalizeAccountName(""), InvalidAccountNameError);
  assert.throws(() => normalizeAccountName("   "), InvalidAccountNameError);
});

test("normalizeAccountName rejects names starting with a special char", () => {
  assert.throws(() => normalizeAccountName(".hidden"), InvalidAccountNameError);
  assert.throws(() => normalizeAccountName("-leading-dash"), InvalidAccountNameError);
});

test("normalizeAccountName rejects non-string input", () => {
  assert.throws(
    () => normalizeAccountName(undefined as unknown as string),
    InvalidAccountNameError,
  );
});

test("accountFilePath joins the accounts dir with `<name>.json`", () => {
  const previous = process.env.CODEX_AUTH_ACCOUNTS_DIR;
  process.env.CODEX_AUTH_ACCOUNTS_DIR = "/tmp/authmux-test-accounts";
  try {
    assert.equal(accountFilePath("alice"), "/tmp/authmux-test-accounts/alice.json");
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_AUTH_ACCOUNTS_DIR;
    } else {
      process.env.CODEX_AUTH_ACCOUNTS_DIR = previous;
    }
  }
});

test("isValidPercent enforces 1..100 integer range", () => {
  assert.equal(isValidPercent(1), true);
  assert.equal(isValidPercent(100), true);
  assert.equal(isValidPercent(50), true);
  assert.equal(isValidPercent(0), false);
  assert.equal(isValidPercent(101), false);
  assert.equal(isValidPercent(1.5), false);
  assert.equal(isValidPercent(NaN), false);
});
