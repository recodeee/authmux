import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveAccountsDir,
  resolveAuthPath,
  resolveCodexDir,
  resolveCurrentNamePath,
  resolveRegistryPath,
  resolveSessionMapPath,
  // Deprecated bare-constant exports — kept for one release per Theme N4.
  // Imported here so the regression guard below can prove they do NOT track
  // env-var changes after module load (which is exactly why they are
  // deprecated). When v0.2.0 removes them, delete this import along with the
  // dedicated regression-guard test below.
  codexDir as eagerCodexDir,
  accountsDir as eagerAccountsDir,
  authPath as eagerAuthPath,
  currentNamePath as eagerCurrentNamePath,
  registryPath as eagerRegistryPath,
  sessionMapPath as eagerSessionMapPath,
} from "../lib/config/paths";

type EnvKey =
  | "CODEX_AUTH_CODEX_DIR"
  | "CODEX_AUTH_ACCOUNTS_DIR"
  | "CODEX_AUTH_JSON_PATH"
  | "CODEX_AUTH_CURRENT_PATH"
  | "CODEX_AUTH_SESSION_MAP_PATH";

const ENV_KEYS: EnvKey[] = [
  "CODEX_AUTH_CODEX_DIR",
  "CODEX_AUTH_ACCOUNTS_DIR",
  "CODEX_AUTH_JSON_PATH",
  "CODEX_AUTH_CURRENT_PATH",
  "CODEX_AUTH_SESSION_MAP_PATH",
];

function snapshotEnv(): Record<EnvKey, string | undefined> {
  const snap = {} as Record<EnvKey, string | undefined>;
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: Record<EnvKey, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-paths-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("resolveCodexDir() reflects CODEX_AUTH_CODEX_DIR set after module load", async () => {
  const snap = snapshotEnv();
  try {
    await withTmpDir(async (dirA) => {
      process.env.CODEX_AUTH_CODEX_DIR = dirA;
      assert.equal(resolveCodexDir(), path.resolve(dirA));

      await withTmpDir(async (dirB) => {
        process.env.CODEX_AUTH_CODEX_DIR = dirB;
        assert.equal(resolveCodexDir(), path.resolve(dirB));

        delete process.env.CODEX_AUTH_CODEX_DIR;
        assert.equal(resolveCodexDir(), path.join(os.homedir(), ".codex"));
      });
    });
  } finally {
    restoreEnv(snap);
  }
});

test("resolveAccountsDir() prefers CODEX_AUTH_ACCOUNTS_DIR, falls back under codex dir", async () => {
  const snap = snapshotEnv();
  try {
    await withTmpDir(async (codex) => {
      process.env.CODEX_AUTH_CODEX_DIR = codex;
      delete process.env.CODEX_AUTH_ACCOUNTS_DIR;
      assert.equal(resolveAccountsDir(), path.join(path.resolve(codex), "accounts"));

      await withTmpDir(async (override) => {
        process.env.CODEX_AUTH_ACCOUNTS_DIR = override;
        assert.equal(resolveAccountsDir(), path.resolve(override));
      });
    });
  } finally {
    restoreEnv(snap);
  }
});

test("resolveAuthPath() reflects CODEX_AUTH_JSON_PATH set after module load", async () => {
  const snap = snapshotEnv();
  try {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, "auth.json");
      process.env.CODEX_AUTH_JSON_PATH = target;
      assert.equal(resolveAuthPath(), path.resolve(target));

      delete process.env.CODEX_AUTH_JSON_PATH;
      process.env.CODEX_AUTH_CODEX_DIR = dir;
      assert.equal(resolveAuthPath(), path.join(path.resolve(dir), "auth.json"));
    });
  } finally {
    restoreEnv(snap);
  }
});

test("resolveCurrentNamePath() reflects CODEX_AUTH_CURRENT_PATH set after module load", async () => {
  const snap = snapshotEnv();
  try {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, "current");
      process.env.CODEX_AUTH_CURRENT_PATH = target;
      assert.equal(resolveCurrentNamePath(), path.resolve(target));
    });
  } finally {
    restoreEnv(snap);
  }
});

test("resolveRegistryPath() and resolveSessionMapPath() track CODEX_AUTH_ACCOUNTS_DIR", async () => {
  const snap = snapshotEnv();
  try {
    await withTmpDir(async (accounts) => {
      process.env.CODEX_AUTH_ACCOUNTS_DIR = accounts;
      delete process.env.CODEX_AUTH_SESSION_MAP_PATH;
      assert.equal(
        resolveRegistryPath(),
        path.join(path.resolve(accounts), "registry.json"),
      );
      assert.equal(
        resolveSessionMapPath(),
        path.join(path.resolve(accounts), "sessions.json"),
      );

      await withTmpDir(async (sessions) => {
        const override = path.join(sessions, "sessions.json");
        process.env.CODEX_AUTH_SESSION_MAP_PATH = override;
        assert.equal(resolveSessionMapPath(), path.resolve(override));
      });
    });
  } finally {
    restoreEnv(snap);
  }
});

test("deprecated bare constants do NOT track env-var changes (regression guard)", async () => {
  // Snapshot the eager values once. They were bound at module import time,
  // before this test changed any env vars. Mutating env after import must
  // not change them — that is the very defect Theme N4 documents and is
  // the reason callers must use the resolveX() functions.
  const initialCodexDir = eagerCodexDir;
  const initialAccountsDir = eagerAccountsDir;
  const initialAuthPath = eagerAuthPath;
  const initialCurrentNamePath = eagerCurrentNamePath;
  const initialRegistryPath = eagerRegistryPath;
  const initialSessionMapPath = eagerSessionMapPath;

  const snap = snapshotEnv();
  try {
    await withTmpDir(async (dir) => {
      process.env.CODEX_AUTH_CODEX_DIR = dir;
      process.env.CODEX_AUTH_ACCOUNTS_DIR = path.join(dir, "alt-accounts");
      process.env.CODEX_AUTH_JSON_PATH = path.join(dir, "alt-auth.json");
      process.env.CODEX_AUTH_CURRENT_PATH = path.join(dir, "alt-current");
      process.env.CODEX_AUTH_SESSION_MAP_PATH = path.join(dir, "alt-sessions.json");

      assert.equal(eagerCodexDir, initialCodexDir);
      assert.equal(eagerAccountsDir, initialAccountsDir);
      assert.equal(eagerAuthPath, initialAuthPath);
      assert.equal(eagerCurrentNamePath, initialCurrentNamePath);
      assert.equal(eagerRegistryPath, initialRegistryPath);
      assert.equal(eagerSessionMapPath, initialSessionMapPath);

      // And confirm the resolvers DO pick up the override, so the
      // documented migration target genuinely fixes the bug.
      assert.notEqual(resolveCodexDir(), eagerCodexDir);
    });
  } finally {
    restoreEnv(snap);
  }
});
