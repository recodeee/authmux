// Cluster-level smoke tests for the modules extracted in Theme N2.
// One suite per cluster: listing, session/pin, snapshot-vault, auto-switch
// config, auto-switch policy, usage adapter, write/use, write/remove,
// external-sync. Heavy save-account behavior is covered by
// `save-account-safety.test.ts`; list-side usage refresh by
// `account-list-usage-refresh.test.ts`. These add the per-cluster
// regression seam the protocol calls for.

import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

import { listAccountNames, loadReconciledRegistry } from "../lib/accounts/read/listing";
import {
  clearSessionAccountName,
  getActiveSessionAccountName,
  getSessionAccountName,
  resolveSessionScopeKey,
  setSessionAccountName,
} from "../lib/accounts/session/pin";
import {
  backupAllSnapshots,
  clearSnapshotBackupVault,
  restoreClobberedSnapshotsFromBackup,
} from "../lib/accounts/safety/snapshot-vault";
import {
  configureAutoSwitchThresholds,
  getStatus,
  setApiUsageEnabled,
} from "../lib/accounts/config/auto-switch-config";
import {
  runAutoSwitchOnce,
  selectBestCandidateFromRegistry,
} from "../lib/accounts/auto-switch/policy";
import {
  isUsageMissingForList,
  lookupProxyUsage,
} from "../lib/accounts/usage/adapter";
import { activateSnapshot } from "../lib/accounts/write/use";
import { removeAccounts } from "../lib/accounts/write/remove";
import { syncExternalAuthSnapshotIfNeeded } from "../lib/accounts/sync/external-sync";
import { AutoSwitchConfigError, AccountNotFoundError } from "../lib/accounts/errors";
import { resolveAuthPath, resolveSnapshotBackupDir } from "../lib/config/paths";
import { RegistryData, UsageSnapshot } from "../lib/accounts/types";

function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildAuthPayload(
  email: string,
  options?: { accountId?: string; userId?: string },
): string {
  const accountId = options?.accountId ?? "acct-1";
  const userId = options?.userId ?? "user-1";
  const idTokenPayload = {
    email,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
      chatgpt_plan_type: "team",
    },
  };
  const idToken = `${encodeBase64Url(JSON.stringify({ alg: "none" }))}.${encodeBase64Url(
    JSON.stringify(idTokenPayload),
  )}.sig`;
  return JSON.stringify(
    {
      tokens: {
        access_token: `token-${email}`,
        refresh_token: `refresh-${email}`,
        id_token: idToken,
        account_id: accountId,
      },
    },
    null,
    2,
  );
}

async function withIsolatedCodexDir(
  t: TestContext,
  fn: (paths: { codexDir: string; accountsDir: string; authPath: string }) => Promise<void>,
): Promise<void> {
  const codexDir = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-modules-"));
  const accountsDir = path.join(codexDir, "accounts");
  const authPath = path.join(codexDir, "auth.json");
  await fsp.mkdir(accountsDir, { recursive: true });

  const previousEnv = {
    CODEX_AUTH_CODEX_DIR: process.env.CODEX_AUTH_CODEX_DIR,
    CODEX_AUTH_ACCOUNTS_DIR: process.env.CODEX_AUTH_ACCOUNTS_DIR,
    CODEX_AUTH_JSON_PATH: process.env.CODEX_AUTH_JSON_PATH,
    CODEX_AUTH_CURRENT_PATH: process.env.CODEX_AUTH_CURRENT_PATH,
    CODEX_AUTH_SESSION_KEY: process.env.CODEX_AUTH_SESSION_KEY,
    CODEX_AUTH_SESSION_ACTIVE_OVERRIDE: process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE,
  };

  process.env.CODEX_AUTH_CODEX_DIR = codexDir;
  delete process.env.CODEX_AUTH_ACCOUNTS_DIR;
  delete process.env.CODEX_AUTH_JSON_PATH;
  delete process.env.CODEX_AUTH_CURRENT_PATH;
  process.env.CODEX_AUTH_SESSION_KEY = `test-${path.basename(codexDir)}`;
  process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "1";

  t.after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    await fsp.rm(codexDir, { recursive: true, force: true });
  });

  await fn({ codexDir, accountsDir, authPath });
}

// -- read/listing.ts ---------------------------------------------------------

test("listAccountNames returns sorted .json names and ignores registry.json", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir }) => {
    await fsp.writeFile(path.join(accountsDir, "bob.json"), "{}", "utf8");
    await fsp.writeFile(path.join(accountsDir, "alice.json"), "{}", "utf8");
    await fsp.writeFile(path.join(accountsDir, "registry.json"), "{}", "utf8");
    await fsp.writeFile(path.join(accountsDir, "ignored.txt"), "x", "utf8");
    const names = await listAccountNames();
    assert.deepEqual(names, ["alice", "bob"]);
  });
});

test("loadReconciledRegistry creates entries for snapshots without a row", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir }) => {
    await fsp.writeFile(path.join(accountsDir, "alice.json"), "{}", "utf8");
    const reg = await loadReconciledRegistry();
    assert.ok(reg.accounts["alice"]);
    assert.equal(reg.accounts["alice"].name, "alice");
  });
});

// -- session/pin.ts ----------------------------------------------------------

test("session/pin round-trips an account name through the session map", async (t) => {
  await withIsolatedCodexDir(t, async () => {
    const key = resolveSessionScopeKey();
    assert.ok(key && key.startsWith("session:"));
    await setSessionAccountName("alice");
    assert.equal(await getSessionAccountName(), "alice");
    assert.equal(await getActiveSessionAccountName(), "alice");
    await clearSessionAccountName();
    assert.equal(await getSessionAccountName(), null);
  });
});

// -- safety/snapshot-vault.ts -----------------------------------------------

test("backup vault copies snapshots and restores after clobber", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir }) => {
    const aliceFile = path.join(accountsDir, "alice.json");
    const original = buildAuthPayload("alice@example.com", { accountId: "orig" });
    await fsp.writeFile(aliceFile, original, "utf8");

    await backupAllSnapshots(listAccountNames);
    const vault = path.join(resolveSnapshotBackupDir(), "alice.json");
    const backed = await fsp.readFile(vault, "utf8");
    assert.equal(backed, original);

    // Simulate codex clobbering alice.json with a different identity.
    await fsp.writeFile(
      aliceFile,
      buildAuthPayload("alice@example.com", { accountId: "clobbered" }),
      "utf8",
    );
    await restoreClobberedSnapshotsFromBackup();
    const restored = await fsp.readFile(aliceFile, "utf8");
    assert.equal(restored, original);

    await clearSnapshotBackupVault();
    assert.equal(
      await fsp
        .access(resolveSnapshotBackupDir())
        .then(() => true)
        .catch(() => false),
      false,
    );
  });
});

// -- config/auto-switch-config.ts -------------------------------------------

test("getStatus returns defaults on a fresh dir, and setApiUsageEnabled toggles", async (t) => {
  await withIsolatedCodexDir(t, async () => {
    const before = await getStatus();
    assert.equal(before.autoSwitchEnabled, false);
    assert.equal(before.usageMode, "api");

    await setApiUsageEnabled(false);
    const after = await getStatus();
    assert.equal(after.usageMode, "local");
  });
});

test("configureAutoSwitchThresholds rejects out-of-range values", async (t) => {
  await withIsolatedCodexDir(t, async () => {
    await assert.rejects(
      () => configureAutoSwitchThresholds({ threshold5hPercent: 0 }),
      AutoSwitchConfigError,
    );
    await assert.rejects(
      () => configureAutoSwitchThresholds({ thresholdWeeklyPercent: 101 }),
      AutoSwitchConfigError,
    );
    const ok = await configureAutoSwitchThresholds({ threshold5hPercent: 15 });
    assert.equal(ok.threshold5hPercent, 15);
  });
});

// -- auto-switch/policy.ts --------------------------------------------------

test("selectBestCandidateFromRegistry prefers highest usageScore", () => {
  const lowUsage: UsageSnapshot = {
    primary: { usedPercent: 90 },
    secondary: { usedPercent: 95 },
    fetchedAt: new Date().toISOString(),
    source: "cached",
  };
  const highUsage: UsageSnapshot = {
    primary: { usedPercent: 10 },
    secondary: { usedPercent: 5 },
    fetchedAt: new Date().toISOString(),
    source: "cached",
  };
  const registry: RegistryData = {
    version: 1,
    autoSwitch: {
      enabled: true,
      threshold5hPercent: 10,
      thresholdWeeklyPercent: 5,
    },
    api: { usage: true },
    accounts: {
      tired: { name: "tired", createdAt: "now", lastUsage: lowUsage },
      fresh: { name: "fresh", createdAt: "now", lastUsage: highUsage },
    },
  };
  assert.equal(selectBestCandidateFromRegistry(["tired", "fresh"], registry), "fresh");
});

test("runAutoSwitchOnce no-ops when disabled", async (t) => {
  await withIsolatedCodexDir(t, async () => {
    const result = await runAutoSwitchOnce(async () => null);
    assert.equal(result.switched, false);
    assert.equal(result.reason, "auto-switch is disabled");
  });
});

// -- usage/adapter.ts -------------------------------------------------------

test("lookupProxyUsage normalizes case + trims", () => {
  const sample: UsageSnapshot = {
    primary: { usedPercent: 10 },
    fetchedAt: new Date().toISOString(),
    source: "proxy",
  };
  const map = new Map([["alice@example.com", sample]]);
  assert.equal(lookupProxyUsage(map, "  ALICE@example.com "), sample);
  assert.equal(lookupProxyUsage(map, ""), null);
  assert.equal(lookupProxyUsage(map, undefined), null);
});

test("isUsageMissingForList true when no usage at all", () => {
  assert.equal(isUsageMissingForList(undefined, 0), true);
});

// -- write/use.ts (activateSnapshot) ---------------------------------------

test("activateSnapshot copies snapshot to auth.json and writes current-name", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir }) => {
    const aliceSnap = buildAuthPayload("alice@example.com");
    await fsp.writeFile(path.join(accountsDir, "alice.json"), aliceSnap, "utf8");
    await activateSnapshot("alice");
    const authPath = resolveAuthPath();
    const written = await fsp.readFile(authPath, "utf8");
    assert.equal(written, aliceSnap);
    assert.equal(await getSessionAccountName(), "alice");
  });
});

test("activateSnapshot throws AccountNotFoundError for an unknown name", async (t) => {
  await withIsolatedCodexDir(t, async () => {
    await assert.rejects(() => activateSnapshot("ghost"), AccountNotFoundError);
  });
});

// -- write/remove.ts -------------------------------------------------------

test("removeAccounts deletes the snapshot file and prunes registry", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir }) => {
    await fsp.writeFile(path.join(accountsDir, "alice.json"), "{}", "utf8");
    await fsp.writeFile(path.join(accountsDir, "bob.json"), "{}", "utf8");

    const result = await removeAccounts(["alice"], async () => null);
    assert.deepEqual(result.removed, ["alice"]);
    const names = await listAccountNames();
    assert.deepEqual(names, ["bob"]);
  });
});

test("removeAccounts refuses a name that does not exist", async (t) => {
  await withIsolatedCodexDir(t, async () => {
    await assert.rejects(
      () => removeAccounts(["ghost"], async () => null),
      AccountNotFoundError,
    );
  });
});

// -- sync/external-sync.ts -------------------------------------------------

test("syncExternalAuthSnapshotIfNeeded returns no-op when no auth file", async (t) => {
  await withIsolatedCodexDir(t, async () => {
    const result = await syncExternalAuthSnapshotIfNeeded();
    assert.equal(result.synchronized, false);
    assert.equal(result.autoSwitchDisabled, false);
  });
});

test("syncExternalAuthSnapshotIfNeeded imports a fresh codex login", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    await fsp.writeFile(authPath, buildAuthPayload("alice@example.com"), "utf8");
    const result = await syncExternalAuthSnapshotIfNeeded();
    assert.equal(result.synchronized, true);
    assert.equal(result.savedName, "alice@example.com");
    const written = await fsp.readFile(
      path.join(accountsDir, "alice@example.com.json"),
      "utf8",
    );
    assert.ok(written.includes("alice@example.com"));
  });
});
