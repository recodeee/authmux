import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveRegistryPath } from "../../lib/config/paths";

/**
 * Advisory lock for the accounts registry.
 *
 * Cooperating writers (interactive commands + daemon) call
 * `withRegistryLock(fn)` to serialize their reload-merge-write sequence. The
 * lock file is a sibling of `registry.json` named `registry.json.lock` and
 * contains the locking process's PID plus an ISO timestamp.
 *
 * Stale-lock reaping: if `O_EXCL` create fails, we read the file. If the
 * recorded PID is no longer alive, or the timestamp is older than
 * `STALE_LOCK_MS`, we steal the lock by overwriting it with our own PID.
 *
 * The lock is best-effort within a single host; it does NOT protect against
 * NFS / shared filesystems. Authmux state is per-user / local, so that is
 * acceptable.
 */

export const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
export const STALE_LOCK_MS = 30_000;
const INITIAL_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 250;

export interface LockOptions {
  /** Override the default path used for the lock file (testing only). */
  lockPath?: string;
  /** Maximum wall-clock time to wait for the lock. Default 5000 ms. */
  timeoutMs?: number;
  /** Threshold past which a lock with a live-looking PID is still reaped. */
  staleMs?: number;
}

interface LockPayload {
  pid: number;
  at: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 is the standard POSIX liveness probe; on Windows Node maps it
    // to a process-exists check too.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it (different user).
    return code === "EPERM";
  }
}

function parsePayload(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; at?: unknown };
    const pid = typeof parsed.pid === "number" ? parsed.pid : NaN;
    const at = typeof parsed.at === "string" ? parsed.at : "";
    if (!Number.isFinite(pid)) return null;
    return { pid, at };
  } catch {
    return null;
  }
}

async function tryCreateExclusive(lockPath: string, payload: string): Promise<boolean> {
  try {
    // wx = write + O_EXCL + O_CREAT — fails atomically if the file exists.
    // We deliberately do NOT go through atomicWriteFile here: an atomic
    // temp+rename would defeat the O_EXCL semantics that make the lock work.
    await fsp.writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  }
}

async function readLock(lockPath: string): Promise<{ payload: LockPayload | null; mtimeMs: number } | null> {
  try {
    const [raw, stat] = await Promise.all([
      fsp.readFile(lockPath, "utf8"),
      fsp.stat(lockPath),
    ]);
    return { payload: parsePayload(raw), mtimeMs: stat.mtimeMs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

function shouldReap(lock: { payload: LockPayload | null; mtimeMs: number }, staleMs: number): boolean {
  if (!lock.payload) return true; // unparseable -> reap
  // NOTE: do NOT reap on `pid === process.pid` — within a single Node process
  // multiple async callers legitimately share a PID, and they must block each
  // other rather than stomp the lock. Cross-process stale ownership is what
  // the liveness probe and wall-clock heuristic below cover.
  if (!isAlive(lock.payload.pid)) return true;
  const ageMs = Date.now() - lock.mtimeMs;
  return ageMs > staleMs;
}

async function acquire(lockPath: string, timeoutMs: number, staleMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  let backoff = INITIAL_BACKOFF_MS;

  await fsp.mkdir(path.dirname(lockPath), { recursive: true });

  // Loop until we either acquire or time out.
  for (;;) {
    if (await tryCreateExclusive(lockPath, payload)) return;

    const current = await readLock(lockPath);
    if (current && shouldReap(current, staleMs)) {
      // Steal the lock. Use an unlink-then-create dance; if another process
      // beat us to either step, we just loop again.
      try {
        await fsp.unlink(lockPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          // Could not remove; fall through to retry.
        }
      }
      if (await tryCreateExclusive(lockPath, payload)) return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `registry lock at ${lockPath} held by pid=${current?.payload?.pid ?? "unknown"} ` +
          `(timed out after ${timeoutMs} ms)`,
      );
    }

    await delay(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

function release(lockPath: string): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = parsePayload(raw);
    if (parsed && parsed.pid !== process.pid) {
      // Not ours anymore (we were preempted by a stale-reap). Leave it alone.
      return;
    }
    fs.unlinkSync(lockPath);
  } catch {
    // best-effort; the next acquirer will reap a stale file if we crashed.
  }
}

/**
 * Run `fn` under the registry lock. Reload-merge-write logic lives in the
 * callback so two writers cannot race-lose mutations.
 */
export async function withRegistryLock<T>(
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = options.lockPath ?? `${resolveRegistryPath()}.lock`;
  const timeoutMs = options.timeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const staleMs = options.staleMs ?? STALE_LOCK_MS;

  await acquire(lockPath, timeoutMs, staleMs);

  // Best-effort: drop the lock on abnormal process exit. We attach once; the
  // listeners are idempotent (release() no-ops if the lock isn't ours).
  const cleanup = () => release(lockPath);
  process.once("exit", cleanup);

  try {
    return await fn();
  } finally {
    process.removeListener("exit", cleanup);
    release(lockPath);
  }
}
