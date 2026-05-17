// Unit tests for src/lib/accounts/identity/equality.ts (Theme N2).
// Pure functions, no I/O — exercise each branch.

import test from "node:test";
import assert from "node:assert/strict";

import {
  registryEntrySharesEmail,
  registryEntrySharesIdentity,
  renderSnapshotIdentity,
  snapshotsShareEmail,
  snapshotsShareIdentity,
} from "../lib/accounts/identity/equality";
import { AccountRegistryEntry, ParsedAuthSnapshot } from "../lib/accounts/types";

function snap(partial: Partial<ParsedAuthSnapshot>): ParsedAuthSnapshot {
  return { authMode: "chatgpt", ...partial };
}

test("snapshotsShareIdentity matches on accountId+userId", () => {
  assert.equal(
    snapshotsShareIdentity(
      snap({ accountId: "a", userId: "u" }),
      snap({ accountId: "a", userId: "u" }),
    ),
    true,
  );
  assert.equal(
    snapshotsShareIdentity(
      snap({ accountId: "a", userId: "u1" }),
      snap({ accountId: "a", userId: "u2" }),
    ),
    false,
  );
});

test("snapshotsShareIdentity falls back to accountId alone", () => {
  assert.equal(
    snapshotsShareIdentity(snap({ accountId: "a" }), snap({ accountId: "a" })),
    true,
  );
});

test("snapshotsShareIdentity falls back to userId alone", () => {
  assert.equal(
    snapshotsShareIdentity(snap({ userId: "u" }), snap({ userId: "u" })),
    true,
  );
});

test("snapshotsShareIdentity falls back to lower-cased email when all else missing", () => {
  assert.equal(
    snapshotsShareIdentity(snap({ email: "FOO@bar.com" }), snap({ email: "foo@BAR.com" })),
    true,
  );
});

test("snapshotsShareIdentity refuses non-chatgpt modes", () => {
  assert.equal(
    snapshotsShareIdentity(
      { authMode: "apikey", email: "a@b" },
      { authMode: "chatgpt", email: "a@b" },
    ),
    false,
  );
});

test("snapshotsShareEmail is true only when both emails set & match", () => {
  assert.equal(snapshotsShareEmail(snap({ email: "a@b" }), snap({ email: "a@b" })), true);
  assert.equal(snapshotsShareEmail(snap({ email: "a@b" }), snap({ email: "x@y" })), false);
  assert.equal(snapshotsShareEmail(snap({}), snap({ email: "a@b" })), false);
});

test("registryEntrySharesIdentity / Email round-trip", () => {
  const entry: AccountRegistryEntry = {
    name: "n",
    createdAt: "now",
    email: "user@example.com",
    accountId: "acct",
    userId: "uid",
  };
  assert.equal(
    registryEntrySharesIdentity(entry, snap({ accountId: "acct", userId: "uid" })),
    true,
  );
  assert.equal(
    registryEntrySharesIdentity(entry, snap({ accountId: "OTHER", userId: "OTHER" })),
    false,
  );
  assert.equal(
    registryEntrySharesEmail(entry, snap({ email: "user@example.com" })),
    true,
  );
});

test("renderSnapshotIdentity joins email + account + user", () => {
  const out = renderSnapshotIdentity(
    snap({ accountId: "acct", userId: "uid" }),
    "user@example.com",
  );
  assert.equal(out, "user@example.com | account:acct | user:uid");
});
