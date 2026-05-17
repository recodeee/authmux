import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { atomicWriteFile } from "../infra/fs/atomic-write";
import { withRegistryLock } from "../infra/fs/registry-lock";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-durability-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// "Kill the writer between writeFile and rename": we patch fsp.rename so it
// throws on the first call. The temp file is written, fsync runs, then the
// rename step fails. The original registry file must remain intact and the
// directory must contain no half-written debris that would shadow the real
// file on parse.
test(
  "atomicWriteFile failing at rename leaves the prior registry valid",
  async () => {
    await withTmpDir(async (dir) => {
      const target = path.join(dir, "registry.json");
      const original = `${JSON.stringify({ version: 1, accounts: { keep: { name: "keep" } } }, null, 2)}\n`;
      await fsp.writeFile(target, original, "utf8");

      const realRename = fsp.rename.bind(fsp);
      let attempt = 0;
      const mockedRename = async (from: string, to: string) => {
        attempt += 1;
        if (attempt === 1) {
          // Simulate the process being killed between writeFile and rename:
          // the temp file is on disk, the rename never lands. Delete the temp
          // file ourselves so the test sees the same end-state as a SIGKILL'd
          // writer whose temp file the OS later garbage-collected.
          await fsp.unlink(from).catch(() => {});
          const err = new Error("simulated SIGKILL between writeFile and rename") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return realRename(from, to);
      };
      (fsp as unknown as { rename: typeof fsp.rename }).rename = mockedRename as typeof fsp.rename;

      try {
        await assert.rejects(
          atomicWriteFile(
            target,
            `${JSON.stringify({ version: 1, accounts: { fresh: { name: "fresh" } } }, null, 2)}\n`,
          ),
          /simulated SIGKILL/,
        );
      } finally {
        (fsp as unknown as { rename: typeof fsp.rename }).rename = realRename;
      }

      // The original registry must still parse.
      const onDisk = await fsp.readFile(target, "utf8");
      assert.equal(onDisk, original);
      const parsed = JSON.parse(onDisk) as { accounts: Record<string, unknown> };
      assert.ok(parsed.accounts.keep, "original 'keep' account must survive");

      // No stray temp files left to confuse later readers.
      const entries = await fsp.readdir(dir);
      const stray = entries.filter((e) => e !== "registry.json");
      assert.deepEqual(stray, [], "no .tmp debris left behind after crash");
    });
  },
);

test("withRegistryLock serializes concurrent writers", async () => {
  await withTmpDir(async (dir) => {
    const lockPath = path.join(dir, "registry.json.lock");
    const order: string[] = [];

    const a = withRegistryLock(
      async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-end");
        return "a";
      },
      { lockPath, timeoutMs: 2000 },
    );

    // Give A a head start so B has to wait.
    await new Promise((r) => setTimeout(r, 5));

    const b = withRegistryLock(
      async () => {
        order.push("b-start");
        order.push("b-end");
        return "b";
      },
      { lockPath, timeoutMs: 2000 },
    );

    const results = await Promise.all([a, b]);
    assert.deepEqual(results, ["a", "b"]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);

    // Lock file is cleaned up.
    await assert.rejects(fsp.stat(lockPath));
  });
});

test("withRegistryLock reaps a stale lock left by a dead PID", async () => {
  await withTmpDir(async (dir) => {
    const lockPath = path.join(dir, "registry.json.lock");
    // PID 1 exists, but we forge a wall-clock-old timestamp so the staleMs
    // heuristic also kicks in for hosts where signal(1, 0) returns EPERM.
    await fsp.writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, at: new Date(Date.now() - 60_000).toISOString() }),
      { mode: 0o600 },
    );
    // Backdate the mtime so the staleness heuristic fires.
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(lockPath, past, past);

    const result = await withRegistryLock(async () => 42, { lockPath, timeoutMs: 2000 });
    assert.equal(result, 42);
  });
});
