import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

import { AccountService } from "../lib/accounts/account-service";
import { SnapshotEmailMismatchError } from "../lib/accounts/errors";
import { parseAuthSnapshotFile } from "../lib/accounts/auth-parser";

function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildAuthPayload(
  email: string,
  options?: { accountId?: string; userId?: string; tokenSeed?: string },
): string {
  const accountId = options?.accountId ?? "acct-1";
  const userId = options?.userId ?? "user-1";
  const tokenSeed = options?.tokenSeed ?? email;
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
        access_token: `token-${tokenSeed}`,
        refresh_token: `refresh-${tokenSeed}`,
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
  const codexDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-auth-save-"));
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

test("saveAccount blocks overwriting snapshot when existing and incoming emails differ", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const destinationPath = path.join(accountsDir, "codexina.json");

    await fsp.writeFile(destinationPath, buildAuthPayload("bia@edixai.com"), "utf8");
    await fsp.writeFile(authPath, buildAuthPayload("codexina@edixai.com"), "utf8");

    await assert.rejects(
      () => service.saveAccount("codexina"),
      (error: unknown) =>
        error instanceof SnapshotEmailMismatchError &&
        error.message.includes("bia@edixai.com") &&
        error.message.includes("codexina@edixai.com"),
    );

    const parsed = await parseAuthSnapshotFile(destinationPath);
    assert.equal(parsed.email, "bia@edixai.com");
  });
});

test("saveAccount allows force overwrite when emails differ", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const destinationPath = path.join(accountsDir, "codexina.json");

    await fsp.writeFile(destinationPath, buildAuthPayload("bia@edixai.com"), "utf8");
    await fsp.writeFile(authPath, buildAuthPayload("codexina@edixai.com"), "utf8");

    await service.saveAccount("codexina", { force: true });
    const parsed = await parseAuthSnapshotFile(destinationPath);
    assert.equal(parsed.email, "codexina@edixai.com");
  });
});

test("saveAccount still overwrites when existing snapshot belongs to same email", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const destinationPath = path.join(accountsDir, "codexina.json");

    await fsp.writeFile(destinationPath, buildAuthPayload("codexina@edixai.com"), "utf8");
    await fsp.writeFile(authPath, buildAuthPayload("codexina@edixai.com"), "utf8");

    await assert.doesNotReject(() => service.saveAccount("codexina"));
    const parsed = await parseAuthSnapshotFile(destinationPath);
    assert.equal(parsed.email, "codexina@edixai.com");
  });
});

test("saveAccount accepts an email-shaped snapshot name", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const accountName = "viktor@edia.com";
    const destinationPath = path.join(accountsDir, `${accountName}.json`);

    await fsp.writeFile(authPath, buildAuthPayload("viktor@edia.com"), "utf8");

    await assert.doesNotReject(() => service.saveAccount(accountName));
    const parsed = await parseAuthSnapshotFile(destinationPath);
    assert.equal(parsed.email, "viktor@edia.com");
  });
});

test("saveAccount accepts an email-shaped snapshot name containing plus aliases", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const accountName = "viktor+biz@edia.com";
    const destinationPath = path.join(accountsDir, `${accountName}.json`);

    await fsp.writeFile(authPath, buildAuthPayload("viktor+biz@edia.com"), "utf8");

    await assert.doesNotReject(() => service.saveAccount(accountName));
    const parsed = await parseAuthSnapshotFile(destinationPath);
    assert.equal(parsed.email, "viktor+biz@edia.com");
  });
});

test("saveAccount blocks overwrite when emails match but account identity differs", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const destinationPath = path.join(accountsDir, "work.json");

    await fsp.writeFile(
      destinationPath,
      buildAuthPayload("codexina@edixai.com", {
        accountId: "acct-a",
        userId: "user-a",
      }),
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload("codexina@edixai.com", {
        accountId: "acct-b",
        userId: "user-a",
      }),
      "utf8",
    );

    await assert.rejects(
      () => service.saveAccount("work"),
      (error: unknown) =>
        error instanceof SnapshotEmailMismatchError &&
        error.message.includes("account:acct-a") &&
        error.message.includes("account:acct-b"),
    );
  });
});

test("inferAccountNameFromCurrentAuth returns email-shaped duplicate suffix for same-email different account identities", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const firstSnapshotPath = path.join(accountsDir, "codexina@edixai.com.json");

    await fsp.writeFile(
      firstSnapshotPath,
      buildAuthPayload("codexina@edixai.com", {
        accountId: "acct-a",
        userId: "user-a",
      }),
      "utf8",
    );

    await fsp.writeFile(
      authPath,
      buildAuthPayload("codexina@edixai.com", {
        accountId: "acct-b",
        userId: "user-a",
      }),
      "utf8",
    );

    const inferred = await service.inferAccountNameFromCurrentAuth();
    assert.equal(inferred, "codexina@edixai.com--dup-2");
  });
});

test("resolveLoginAccountNameFromCurrentAuth refreshes the canonical email snapshot when only accountId differs", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const email = "csoves@edixai.com";

    await fsp.writeFile(
      path.join(accountsDir, `${email}.json`),
      buildAuthPayload(email, {
        accountId: "acct-a",
        userId: "user-a",
      }),
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload(email, {
        accountId: "acct-b",
        userId: "user-a",
      }),
      "utf8",
    );

    const resolved = await service.resolveLoginAccountNameFromCurrentAuth();
    assert.deepEqual(resolved, {
      name: email,
      source: "existing",
      forceOverwrite: true,
    });
  });
});

test("resolveLoginAccountNameFromCurrentAuth reuses active canonical email snapshot for same-email relogin", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const email = "admin@mite.hu";
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      path.join(accountsDir, `${email}.json`),
      buildAuthPayload(email, {
        accountId: "acct-old",
        userId: "user-admin",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${email}\n`, "utf8");
    await fsp.writeFile(
      authPath,
      buildAuthPayload(email, {
        accountId: "acct-new",
        userId: "user-admin",
      }),
      "utf8",
    );

    const resolved = await service.resolveLoginAccountNameFromCurrentAuth();
    assert.deepEqual(resolved, {
      name: email,
      source: "active",
      forceOverwrite: true,
    });
  });
});

test("resolveLoginAccountNameFromCurrentAuth reuses active alias for same-email relogin", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "team-primary";
    const email = "csoves@edixai.com";

    await fsp.writeFile(
      path.join(accountsDir, `${activeName}.json`),
      buildAuthPayload(email, {
        accountId: "acct-a",
        userId: "user-a",
      }),
      "utf8",
    );
    await fsp.writeFile(path.join(codexDir, "current"), `${activeName}\n`, "utf8");
    await fsp.writeFile(
      authPath,
      buildAuthPayload(email, {
        accountId: "acct-b",
        userId: "user-a",
      }),
      "utf8",
    );

    const resolved = await service.resolveLoginAccountNameFromCurrentAuth();
    assert.deepEqual(resolved, {
      name: activeName,
      source: "active",
      forceOverwrite: true,
    });
  });
});

test("resolveLoginAccountNameFromCurrentAuth infers email snapshot when no existing snapshot matches email", async (t) => {
  await withIsolatedCodexDir(t, async ({ authPath }) => {
    const service = new AccountService();
    const email = "new-user@edixai.com";

    await fsp.writeFile(
      authPath,
      buildAuthPayload(email, {
        accountId: "acct-new",
        userId: "user-new",
      }),
      "utf8",
    );

    const resolved = await service.resolveLoginAccountNameFromCurrentAuth();
    assert.deepEqual(resolved, {
      name: email,
      source: "inferred",
    });
  });
});

test("inferAccountNameFromCurrentAuth ignores active alias and still infers email-shaped name", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "work";
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      path.join(accountsDir, `${activeName}.json`),
      buildAuthPayload("admin@recodee.com", {
        accountId: "acct-admin",
        userId: "user-admin",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");
    await fsp.writeFile(
      authPath,
      buildAuthPayload("admin@recodee.com", {
        accountId: "acct-admin",
        userId: "user-admin",
      }),
      "utf8",
    );

    const inferred = await service.inferAccountNameFromCurrentAuth();
    assert.equal(inferred, "admin@recodee.com");
  });
});

test("resolveDefaultAccountNameFromCurrentAuth reuses active snapshot name when identity matches", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "itrexsale";
    const activeSnapshotPath = path.join(accountsDir, `${activeName}.json`);
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      activeSnapshotPath,
      buildAuthPayload("codexina@edixai.com", {
        accountId: "acct-a",
        userId: "user-a",
      }),
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload("codexina@edixai.com", {
        accountId: "acct-a",
        userId: "user-a",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");

    const resolved = await service.resolveDefaultAccountNameFromCurrentAuth();
    assert.deepEqual(resolved, {
      name: activeName,
      source: "active",
    });
  });
});

test("resolveDefaultAccountNameFromCurrentAuth reuses active canonical email snapshot for same-email relogin", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const email = "admin@mite.hu";
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      path.join(accountsDir, `${email}.json`),
      buildAuthPayload(email, {
        accountId: "acct-old",
        userId: "user-admin",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${email}\n`, "utf8");
    await fsp.writeFile(
      authPath,
      buildAuthPayload(email, {
        accountId: "acct-new",
        userId: "user-admin",
      }),
      "utf8",
    );

    const resolved = await service.resolveDefaultAccountNameFromCurrentAuth();
    assert.deepEqual(resolved, {
      name: email,
      source: "active",
      forceOverwrite: true,
    });
  });
});

test("resolveDefaultAccountNameFromCurrentAuth falls back to inferred email-shaped name when active snapshot mismatches identity", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "itrexsale";
    const activeSnapshotPath = path.join(accountsDir, `${activeName}.json`);
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      activeSnapshotPath,
      buildAuthPayload("other@edixai.com", {
        accountId: "acct-other",
        userId: "user-other",
      }),
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload("codexina@edixai.com", {
        accountId: "acct-a",
        userId: "user-a",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");

    const resolved = await service.resolveDefaultAccountNameFromCurrentAuth();
    assert.deepEqual(resolved, {
      name: "codexina@edixai.com",
      source: "inferred",
    });
  });
});

test("listAccountMappings returns active flag and identity metadata for each snapshot", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      path.join(accountsDir, "itrexsale.json"),
      buildAuthPayload("itrex@edixai.com", {
        accountId: "acct-itrex",
        userId: "user-itrex",
      }),
      "utf8",
    );
    await fsp.writeFile(
      path.join(accountsDir, "deadpool.json"),
      buildAuthPayload("deadpool@edixai.com", {
        accountId: "acct-deadpool",
        userId: "user-deadpool",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, "itrexsale\n", "utf8");
    await fsp.writeFile(
      authPath,
      buildAuthPayload("itrex@edixai.com", {
        accountId: "acct-itrex",
        userId: "user-itrex",
      }),
      "utf8",
    );

    await service.saveAccount("itrexsale");
    const mappings = await service.listAccountMappings();

    assert.deepEqual(
      mappings.map((item) => ({
        name: item.name,
        active: item.active,
        email: item.email,
        accountId: item.accountId,
        userId: item.userId,
      })),
      [
        {
          name: "deadpool",
          active: false,
          email: "deadpool@edixai.com",
          accountId: "acct-deadpool",
          userId: "user-deadpool",
        },
        {
          name: "itrexsale",
          active: true,
          email: "itrex@edixai.com",
          accountId: "acct-itrex",
          userId: "user-itrex",
        },
      ],
    );
  });
});

test("listAccountMappings includes 5h and weekly remaining usage percentages", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");
    const registryPath = path.join(accountsDir, "registry.json");
    const nowSeconds = Math.floor(Date.now() / 1000);

    await fsp.writeFile(
      path.join(accountsDir, "alpha.json"),
      buildAuthPayload("alpha@edixai.com", {
        accountId: "acct-alpha",
        userId: "user-alpha",
      }),
      "utf8",
    );
    await fsp.writeFile(
      path.join(accountsDir, "beta.json"),
      buildAuthPayload("beta@edixai.com", {
        accountId: "acct-beta",
        userId: "user-beta",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, "alpha\n", "utf8");
    await fsp.writeFile(authPath, buildAuthPayload("alpha@edixai.com"), "utf8");

    await fsp.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          autoSwitch: {
            enabled: false,
            threshold5hPercent: 10,
            thresholdWeeklyPercent: 5,
          },
          api: {
            usage: true,
          },
          activeAccountName: "alpha",
          accounts: {
            alpha: {
              name: "alpha",
              createdAt: new Date().toISOString(),
              email: "alpha@edixai.com",
              accountId: "acct-alpha",
              userId: "user-alpha",
              lastUsageAt: new Date().toISOString(),
              lastUsage: {
                primary: { usedPercent: 25, windowMinutes: 300 },
                secondary: { usedPercent: 40, windowMinutes: 10080 },
                fetchedAt: new Date().toISOString(),
                source: "cached",
              },
            },
            beta: {
              name: "beta",
              createdAt: new Date().toISOString(),
              email: "beta@edixai.com",
              accountId: "acct-beta",
              userId: "user-beta",
              lastUsageAt: new Date().toISOString(),
              lastUsage: {
                primary: { usedPercent: 99, windowMinutes: 300, resetsAt: nowSeconds - 5 },
                secondary: { usedPercent: 30, windowMinutes: 10080 },
                fetchedAt: new Date().toISOString(),
                source: "cached",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const mappings = await service.listAccountMappings();
    const alpha = mappings.find((item) => item.name === "alpha");
    const beta = mappings.find((item) => item.name === "beta");

    assert.equal(alpha?.remaining5hPercent, 75);
    assert.equal(alpha?.remainingWeeklyPercent, 60);
    assert.equal(beta?.remaining5hPercent, 100);
    assert.equal(beta?.remainingWeeklyPercent, 70);
  });
});

test("syncExternalAuthSnapshotIfNeeded disables auto-switch and snapshots external codex login into inferred email name", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const previousName = "odin@recodee.com";
    const incomingEmail = "odin@edixai.com";
    const currentPath = path.join(codexDir, "current");
    const registryPath = path.join(accountsDir, "registry.json");

    await fsp.writeFile(
      path.join(accountsDir, `${previousName}.json`),
      buildAuthPayload(previousName, {
        accountId: "acct-prev",
        userId: "user-prev",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${previousName}\n`, "utf8");
    await fsp.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          autoSwitch: {
            enabled: true,
            threshold5hPercent: 10,
            thresholdWeeklyPercent: 5,
          },
          api: {
            usage: true,
          },
          activeAccountName: previousName,
          accounts: {
            [previousName]: {
              name: previousName,
              createdAt: new Date().toISOString(),
              email: previousName,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await fsp.writeFile(
      authPath,
      buildAuthPayload(incomingEmail, {
        accountId: "acct-new",
        userId: "user-new",
      }),
      "utf8",
    );

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: true,
      savedName: incomingEmail,
      autoSwitchDisabled: true,
    });

    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), incomingEmail);

    const parsed = await parseAuthSnapshotFile(path.join(accountsDir, `${incomingEmail}.json`));
    assert.equal(parsed.email, incomingEmail);

    const registry = JSON.parse(await fsp.readFile(registryPath, "utf8")) as {
      autoSwitch: { enabled: boolean };
    };
    assert.equal(registry.autoSwitch.enabled, false);
  });
});

test("syncExternalAuthSnapshotIfNeeded refreshes active alias instead of re-keying to email name", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeAlias = "team-primary";
    const incomingEmail = "admin@kozpontihusbolt.hu";
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      path.join(accountsDir, `${activeAlias}.json`),
      buildAuthPayload(incomingEmail, {
        accountId: "acct-team",
        userId: "user-team",
        tokenSeed: "pre-login",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${activeAlias}\n`, "utf8");
    await fsp.writeFile(
      authPath,
      buildAuthPayload(incomingEmail, {
        accountId: "acct-team",
        userId: "user-team",
        tokenSeed: "post-login",
      }),
      "utf8",
    );

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: true,
      savedName: activeAlias,
      autoSwitchDisabled: false,
    });

    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), activeAlias);
    const aliasSnapshotRaw = await fsp.readFile(path.join(accountsDir, `${activeAlias}.json`), "utf8");
    assert.match(aliasSnapshotRaw, /token-post-login/);
    await assert.rejects(() => fsp.access(path.join(accountsDir, `${incomingEmail}.json`)));
  });
});

test("syncExternalAuthSnapshotIfNeeded refreshes active same-identity snapshot after relogin", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "admin@mite.hu";
    const currentPath = path.join(codexDir, "current");
    const registryPath = path.join(accountsDir, "registry.json");

    await fsp.writeFile(
      path.join(accountsDir, `${activeName}.json`),
      buildAuthPayload(activeName, {
        accountId: "acct-admin",
        userId: "user-admin",
        tokenSeed: "pre-login",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");
    await fsp.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          autoSwitch: {
            enabled: true,
            threshold5hPercent: 10,
            thresholdWeeklyPercent: 5,
          },
          api: {
            usage: true,
          },
          activeAccountName: activeName,
          accounts: {
            [activeName]: {
              name: activeName,
              createdAt: new Date().toISOString(),
              email: activeName,
              accountId: "acct-admin",
              userId: "user-admin",
              planType: "team",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload(activeName, {
        accountId: "acct-admin",
        userId: "user-admin",
        tokenSeed: "post-login",
      }),
      "utf8",
    );

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: true,
      savedName: activeName,
      autoSwitchDisabled: false,
    });

    const refreshedSnapshotRaw = await fsp.readFile(path.join(accountsDir, `${activeName}.json`), "utf8");
    assert.match(refreshedSnapshotRaw, /token-post-login/);
    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), activeName);

    const registry = JSON.parse(await fsp.readFile(registryPath, "utf8")) as {
      autoSwitch: { enabled: boolean };
    };
    assert.equal(registry.autoSwitch.enabled, true);
  });
});

test("syncExternalAuthSnapshotIfNeeded recreates a missing snapshot even when auth fingerprint is unchanged", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir, authPath }) => {
    const service = new AccountService();
    const email = "moncsi@gitguardex.com";
    process.env.CODEX_AUTH_SESSION_KEY = "terminal-moncsi";
    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "1";

    await fsp.writeFile(
      authPath,
      buildAuthPayload(email, {
        accountId: "acct-moncsi",
        userId: "user-moncsi",
      }),
      "utf8",
    );

    const firstSync = await service.syncExternalAuthSnapshotIfNeeded();
    assert.equal(firstSync.savedName, email);

    const snapshotPath = path.join(accountsDir, `${email}.json`);
    await fsp.rm(snapshotPath, { force: true });

    const secondSync = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(secondSync, {
      synchronized: true,
      savedName: email,
      autoSwitchDisabled: false,
    });

    const restored = await parseAuthSnapshotFile(snapshotPath);
    assert.equal(restored.email, email);
  });
});

test("useAccount resolves an exact email to its saved duplicate snapshot", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const email = "moncsi@gitguardex.com";
    const duplicateName = `${email}--dup-2`;

    await fsp.writeFile(
      path.join(accountsDir, `${duplicateName}.json`),
      buildAuthPayload(email, {
        accountId: "acct-moncsi",
        userId: "user-moncsi",
      }),
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload(email, {
        accountId: "acct-moncsi",
        userId: "user-moncsi",
      }),
      "utf8",
    );

    const activated = await service.useAccount(email);

    assert.equal(activated, duplicateName);
    assert.equal((await fsp.readFile(path.join(codexDir, "current"), "utf8")).trim(), duplicateName);
  });
});

test("syncExternalAuthSnapshotIfNeeded reuses a saved alias that matches relogin identity", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "primary@edixai.com";
    const savedAlias = "team-primary";
    const incomingEmail = "admin@kozpontihusbolt.hu";
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      path.join(accountsDir, `${activeName}.json`),
      buildAuthPayload(activeName, {
        accountId: "acct-primary",
        userId: "user-primary",
      }),
      "utf8",
    );
    await fsp.writeFile(
      path.join(accountsDir, `${savedAlias}.json`),
      buildAuthPayload(incomingEmail, {
        accountId: "acct-team",
        userId: "user-team",
        tokenSeed: "pre-login",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");
    await fsp.writeFile(
      authPath,
      buildAuthPayload(incomingEmail, {
        accountId: "acct-team",
        userId: "user-team",
        tokenSeed: "post-login",
      }),
      "utf8",
    );

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: true,
      savedName: savedAlias,
      autoSwitchDisabled: false,
    });

    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), savedAlias);
    const aliasSnapshotRaw = await fsp.readFile(path.join(accountsDir, `${savedAlias}.json`), "utf8");
    assert.match(aliasSnapshotRaw, /token-post-login/);
    await assert.rejects(() => fsp.access(path.join(accountsDir, `${incomingEmail}.json`)));
  });
});

test("syncExternalAuthSnapshotIfNeeded uses registry metadata before parsing every saved snapshot", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "primary@edixai.com";
    const savedAlias = "team-primary";
    const incomingEmail = "admin@kozpontihusbolt.hu";
    const currentPath = path.join(codexDir, "current");
    const registryPath = path.join(accountsDir, "registry.json");

    await fsp.writeFile(
      path.join(accountsDir, `${activeName}.json`),
      buildAuthPayload(activeName, {
        accountId: "acct-primary",
        userId: "user-primary",
      }),
      "utf8",
    );
    await fsp.writeFile(path.join(accountsDir, `${savedAlias}.json`), "{broken", "utf8");
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");
    await fsp.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 1,
          autoSwitch: {
            enabled: false,
            threshold5hPercent: 10,
            thresholdWeeklyPercent: 5,
          },
          api: {
            usage: true,
          },
          activeAccountName: activeName,
          accounts: {
            [activeName]: {
              name: activeName,
              createdAt: new Date().toISOString(),
              email: activeName,
              accountId: "acct-primary",
              userId: "user-primary",
            },
            [savedAlias]: {
              name: savedAlias,
              createdAt: new Date().toISOString(),
              email: incomingEmail,
              accountId: "acct-team",
              userId: "user-team",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload(incomingEmail, {
        accountId: "acct-team",
        userId: "user-team",
        tokenSeed: "post-login",
      }),
      "utf8",
    );

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: true,
      savedName: savedAlias,
      autoSwitchDisabled: false,
    });

    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), savedAlias);
    const aliasSnapshotRaw = await fsp.readFile(path.join(accountsDir, `${savedAlias}.json`), "utf8");
    assert.match(aliasSnapshotRaw, /token-post-login/);
    await assert.rejects(() => fsp.access(path.join(accountsDir, `${incomingEmail}.json`)));
  });
});

test("syncExternalAuthSnapshotIfNeeded refreshes active canonical email snapshot instead of creating a duplicate", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const email = "admin@mite.hu";
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(
      path.join(accountsDir, `${email}.json`),
      buildAuthPayload(email, {
        accountId: "acct-old",
        userId: "user-admin",
        tokenSeed: "pre-login",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${email}\n`, "utf8");
    await fsp.writeFile(
      authPath,
      buildAuthPayload(email, {
        accountId: "acct-new",
        userId: "user-admin",
        tokenSeed: "post-login",
      }),
      "utf8",
    );

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: true,
      savedName: email,
      autoSwitchDisabled: false,
    });

    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), email);

    const refreshedSnapshot = await parseAuthSnapshotFile(path.join(accountsDir, `${email}.json`));
    assert.equal(refreshedSnapshot.accountId, "acct-new");

    await assert.rejects(() => fsp.access(path.join(accountsDir, `${email}--dup-2.json`)));
  });
});

test("syncExternalAuthSnapshotIfNeeded materializes auth symlink so external codex login can no longer overwrite snapshot files", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink conversion behavior is Unix-specific in this test");
    return;
  }

  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "team-primary";
    const snapshotPath = path.join(accountsDir, `${activeName}.json`);
    const currentPath = path.join(codexDir, "current");

    await fsp.writeFile(snapshotPath, buildAuthPayload("team-primary@edixai.com"), "utf8");
    await fsp.symlink(snapshotPath, authPath);
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");

    const before = await fsp.lstat(authPath);
    assert.equal(before.isSymbolicLink(), true);

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: false,
      autoSwitchDisabled: false,
    });

    const after = await fsp.lstat(authPath);
    assert.equal(after.isSymbolicLink(), false);
  });
});

test("restoreSessionSnapshotIfNeeded materializes matching auth symlink before codex can overwrite the snapshot", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink conversion behavior is Unix-specific in this test");
    return;
  }

  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "admin@megkapja.hu";
    const snapshotPath = path.join(accountsDir, `${activeName}.json`);
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;

    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "1";

    await fsp.writeFile(
      snapshotPath,
      buildAuthPayload(activeName, {
        accountId: "acct-admin",
        userId: "user-admin",
        tokenSeed: "admin-snapshot",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: activeName,
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.symlink(snapshotPath, authPath);

    const restored = await service.restoreSessionSnapshotIfNeeded();
    assert.deepEqual(restored, {
      restored: false,
      accountName: activeName,
    });

    const authStat = await fsp.lstat(authPath);
    assert.equal(authStat.isSymbolicLink(), false);

    await fsp.writeFile(
      authPath,
      buildAuthPayload("odin@megkapja.hu", {
        accountId: "acct-odin",
        userId: "user-odin",
        tokenSeed: "official-login",
      }),
      "utf8",
    );

    const snapshotAfterLogin = await parseAuthSnapshotFile(snapshotPath);
    assert.equal(snapshotAfterLogin.email, activeName);
    assert.equal(snapshotAfterLogin.accountId, "acct-admin");
  });
});

test("restoreSessionSnapshotIfNeeded materializes the auth symlink even when no session is pinned", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink conversion behavior is Unix-specific in this test");
    return;
  }

  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "kreta@lebenyse.hu";
    const snapshotPath = path.join(accountsDir, `${activeName}.json`);
    const currentPath = path.join(codexDir, "current");

    process.env.CODEX_AUTH_SESSION_KEY = "restore-no-session-pin";
    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "1";

    await fsp.writeFile(
      snapshotPath,
      buildAuthPayload(activeName, {
        accountId: "acct-kreta",
        userId: "user-kreta",
        tokenSeed: "kreta-original",
      }),
      "utf8",
    );
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");
    await fsp.symlink(snapshotPath, authPath);

    const restored = await service.restoreSessionSnapshotIfNeeded();
    assert.deepEqual(restored, { restored: false });

    const authStat = await fsp.lstat(authPath);
    assert.equal(authStat.isSymbolicLink(), false);

    // Simulate `codex login` overwriting auth.json with a different account.
    await fsp.writeFile(
      authPath,
      buildAuthPayload("admin@kollarrobert.sk", {
        accountId: "acct-admin",
        userId: "user-admin",
        tokenSeed: "admin-login",
      }),
      "utf8",
    );

    const previousSnapshot = await parseAuthSnapshotFile(snapshotPath);
    assert.equal(previousSnapshot.email, activeName);
    assert.equal(previousSnapshot.accountId, "acct-kreta");
  });
});

test("listAccountNames excludes the update-check cache file", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir }) => {
    const service = new AccountService();
    await fsp.writeFile(
      path.join(accountsDir, "alice@example.com.json"),
      buildAuthPayload("alice@example.com"),
      "utf8",
    );
    await fsp.writeFile(
      path.join(accountsDir, "update-check.json"),
      JSON.stringify({
        version: 1,
        packageName: "@imdeadpool/codex-account-switcher",
        latestVersion: "0.1.23",
        checkedAt: 1778696332060,
      }),
      "utf8",
    );

    const names = await service.listAccountNames();
    assert.deepEqual(names, ["alice@example.com"]);
  });
});

test("useAccount writes auth.json as a regular file (never symlink)", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir }) => {
    const service = new AccountService();
    const accountName = "regular-file-check";
    const sourcePath = path.join(accountsDir, `${accountName}.json`);

    await fsp.writeFile(sourcePath, buildAuthPayload("regular-file-check@edixai.com"), "utf8");
    await service.useAccount(accountName);

    const authStat = await fsp.lstat(path.join(process.env.CODEX_AUTH_CODEX_DIR as string, "auth.json"));
    assert.equal(authStat.isSymbolicLink(), false);
  });
});

test("useAccount records session auth fingerprint for the switch fast path", async (t) => {
  await withIsolatedCodexDir(t, async ({ accountsDir }) => {
    const service = new AccountService();
    const accountName = "fast-switch";
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;

    await fsp.writeFile(
      path.join(accountsDir, `${accountName}.json`),
      buildAuthPayload("fast-switch@edixai.com"),
      "utf8",
    );

    await service.useAccount(accountName);

    const sessionMap = JSON.parse(await fsp.readFile(sessionMapPath, "utf8")) as {
      sessions: Record<string, { accountName?: string; authFingerprint?: string }>;
    };
    assert.equal(sessionMap.sessions[sessionKey]?.accountName, accountName);
    assert.equal(typeof sessionMap.sessions[sessionKey]?.authFingerprint, "string");

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: false,
      autoSwitchDisabled: false,
    });
  });
});

test("getCurrentAccountName falls back to global current pointer when codex is not active in this terminal", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;

    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "0";

    await fsp.writeFile(
      path.join(accountsDir, "odin@megkapja.hu.json"),
      buildAuthPayload("odin@megkapja.hu", {
        accountId: "acct-odin",
        userId: "user-odin",
      }),
    );
    await fsp.writeFile(
      path.join(accountsDir, "lajos@edix.hu.json"),
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
    );
    await fsp.writeFile(currentPath, "lajos@edix.hu\n", "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: "odin@megkapja.hu",
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const active = await service.getCurrentAccountName();
    assert.equal(active, "lajos@edix.hu");
  });
});

test("getCurrentAccountName prefers session-scoped snapshot when codex is active in this terminal", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;

    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "1";

    await fsp.writeFile(
      path.join(accountsDir, "odin@megkapja.hu.json"),
      buildAuthPayload("odin@megkapja.hu", {
        accountId: "acct-odin",
        userId: "user-odin",
      }),
    );
    await fsp.writeFile(
      path.join(accountsDir, "lajos@edix.hu.json"),
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
    );
    await fsp.writeFile(currentPath, "lajos@edix.hu\n", "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: "odin@megkapja.hu",
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const active = await service.getCurrentAccountName();
    assert.equal(active, "odin@megkapja.hu");
  });
});

test("syncExternalAuthSnapshotIfNeeded follows global sync when codex is not active in this terminal", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;

    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "0";

    await fsp.writeFile(
      path.join(accountsDir, "odin@megkapja.hu.json"),
      buildAuthPayload("odin@megkapja.hu", {
        accountId: "acct-odin",
        userId: "user-odin",
      }),
    );
    await fsp.writeFile(currentPath, "odin@megkapja.hu\n", "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: "odin@megkapja.hu",
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
      "utf8",
    );

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: true,
      savedName: "lajos@edix.hu",
      autoSwitchDisabled: false,
    });

    const parsed = await parseAuthSnapshotFile(path.join(accountsDir, "lajos@edix.hu.json"));
    assert.equal(parsed.email, "lajos@edix.hu");
    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), "lajos@edix.hu");
  });
});

test("syncExternalAuthSnapshotIfNeeded ignores external login from another terminal when codex remains active in this terminal", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;

    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "1";

    await fsp.writeFile(
      path.join(accountsDir, "odin@megkapja.hu.json"),
      buildAuthPayload("odin@megkapja.hu", {
        accountId: "acct-odin",
        userId: "user-odin",
      }),
    );
    await fsp.writeFile(currentPath, "odin@megkapja.hu\n", "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: "odin@megkapja.hu",
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
      "utf8",
    );

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: false,
      autoSwitchDisabled: false,
    });

    await assert.rejects(() => fsp.access(path.join(accountsDir, "lajos@edix.hu.json")));
    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), "odin@megkapja.hu");
  });
});

test("syncExternalAuthSnapshotIfNeeded can be forced for explicit in-terminal codex login sync", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;
    const previousFlag = process.env.CODEX_AUTH_FORCE_EXTERNAL_SYNC;

    await fsp.writeFile(
      path.join(accountsDir, "odin@megkapja.hu.json"),
      buildAuthPayload("odin@megkapja.hu", {
        accountId: "acct-odin",
        userId: "user-odin",
      }),
    );
    await fsp.writeFile(currentPath, "odin@megkapja.hu\n", "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: "odin@megkapja.hu",
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
      "utf8",
    );

    process.env.CODEX_AUTH_FORCE_EXTERNAL_SYNC = "1";
    t.after(() => {
      process.env.CODEX_AUTH_FORCE_EXTERNAL_SYNC = previousFlag;
    });

    const result = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(result, {
      synchronized: true,
      savedName: "lajos@edix.hu",
      autoSwitchDisabled: false,
    });
    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), "lajos@edix.hu");
  });
});

test("syncExternalAuthSnapshotIfNeeded skips auth re-read when the current session already saw the same auth file", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const activeName = "odin@megkapja.hu";
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;
    const snapshotPayload = buildAuthPayload(activeName, {
      accountId: "acct-odin",
      userId: "user-odin",
      tokenSeed: "steady",
    });

    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "1";

    await fsp.writeFile(path.join(accountsDir, `${activeName}.json`), snapshotPayload, "utf8");
    await fsp.writeFile(currentPath, `${activeName}\n`, "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: activeName,
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.writeFile(authPath, snapshotPayload, "utf8");

    const firstResult = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(firstResult, {
      synchronized: false,
      autoSwitchDisabled: false,
    });

    const sessionMapAfterFirstRun = JSON.parse(await fsp.readFile(sessionMapPath, "utf8")) as {
      sessions: Record<string, { authFingerprint?: string }>;
    };
    const cachedFingerprint = sessionMapAfterFirstRun.sessions[sessionKey]?.authFingerprint;
    assert.equal(typeof cachedFingerprint, "string");
    const secondResult = await service.syncExternalAuthSnapshotIfNeeded();
    assert.deepEqual(secondResult, {
      synchronized: false,
      autoSwitchDisabled: false,
    });

    const sessionMapAfterSecondRun = JSON.parse(await fsp.readFile(sessionMapPath, "utf8")) as {
      sessions: Record<string, { authFingerprint?: string }>;
    };
    assert.equal(sessionMapAfterSecondRun.sessions[sessionKey]?.authFingerprint, cachedFingerprint);
  });
});

test("restoreSessionSnapshotIfNeeded skips restore when codex is not active in this terminal", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;

    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "0";

    await fsp.writeFile(
      path.join(accountsDir, "odin@megkapja.hu.json"),
      buildAuthPayload("odin@megkapja.hu", {
        accountId: "acct-odin",
        userId: "user-odin",
      }),
    );
    await fsp.writeFile(
      path.join(accountsDir, "lajos@edix.hu.json"),
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
    );
    await fsp.writeFile(currentPath, "lajos@edix.hu\n", "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: "odin@megkapja.hu",
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
      "utf8",
    );

    const restored = await service.restoreSessionSnapshotIfNeeded();
    assert.deepEqual(restored, {
      restored: false,
    });

    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), "lajos@edix.hu");
    const parsed = await parseAuthSnapshotFile(authPath);
    assert.equal(parsed.email, "lajos@edix.hu");
  });
});

test("restoreSessionSnapshotIfNeeded re-activates the session-pinned snapshot while codex stays active in this terminal", async (t) => {
  await withIsolatedCodexDir(t, async ({ codexDir, accountsDir, authPath }) => {
    const service = new AccountService();
    const currentPath = path.join(codexDir, "current");
    const sessionMapPath = path.join(accountsDir, "sessions.json");
    const sessionKey = `ppid:${process.ppid}`;

    process.env.CODEX_AUTH_SESSION_ACTIVE_OVERRIDE = "1";

    await fsp.writeFile(
      path.join(accountsDir, "odin@megkapja.hu.json"),
      buildAuthPayload("odin@megkapja.hu", {
        accountId: "acct-odin",
        userId: "user-odin",
      }),
    );
    await fsp.writeFile(
      path.join(accountsDir, "lajos@edix.hu.json"),
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
    );
    await fsp.writeFile(currentPath, "lajos@edix.hu\n", "utf8");
    await fsp.writeFile(
      sessionMapPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            [sessionKey]: {
              accountName: "odin@megkapja.hu",
              updatedAt: new Date().toISOString(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fsp.writeFile(
      authPath,
      buildAuthPayload("lajos@edix.hu", {
        accountId: "acct-lajos",
        userId: "user-lajos",
      }),
      "utf8",
    );

    const restored = await service.restoreSessionSnapshotIfNeeded();
    assert.deepEqual(restored, {
      restored: true,
      accountName: "odin@megkapja.hu",
    });

    assert.equal((await fsp.readFile(currentPath, "utf8")).trim(), "odin@megkapja.hu");
    const parsed = await parseAuthSnapshotFile(authPath);
    assert.equal(parsed.email, "odin@megkapja.hu");
  });
});
