// Snapshot crash-safety vault extracted from AccountService (Theme N2).
//
// Before codex runs we copy every saved snapshot into a backup dir; if
// codex clobbers a snapshot through a stale symlink we can restore it
// after codex exits. Best-effort throughout — a missing/unreadable
// backup should never block normal account sync.

import path from "node:path";
import fsp from "node:fs/promises";
import {
  resolveSnapshotBackupDir,
} from "../../config/paths";
import { ensureSecureDir, chmodSecureFile } from "../../io/secure-fs";
import { parseAuthSnapshotFile } from "../auth-parser";
import { accountFilePath } from "../naming";
import { pathExists } from "../_internal/fs-helpers";
import { snapshotsShareIdentity } from "../identity/equality";

function snapshotBackupPath(name: string): string {
  return path.join(resolveSnapshotBackupDir(), `${name}.json`);
}

export async function backupAllSnapshots(
  listAccountNames: () => Promise<string[]>,
): Promise<void> {
  let accountNames: string[];
  try {
    accountNames = await listAccountNames();
  } catch {
    return;
  }

  const backupDir = resolveSnapshotBackupDir();
  // Replace stale vault contents from a previous codex run with the current
  // snapshot state so recovery only ever restores from this run's backup.
  await clearSnapshotBackupVault();

  if (accountNames.length === 0) {
    return;
  }

  try {
    await ensureSecureDir(backupDir);
  } catch {
    return;
  }

  await Promise.all(
    accountNames.map(async (name) => {
      const source = accountFilePath(name);
      const destination = snapshotBackupPath(name);
      try {
        await fsp.copyFile(source, destination);
        await chmodSecureFile(destination);
      } catch {
        // Best-effort backup; one failure shouldn't block codex from running.
      }
    }),
  );
}

export async function restoreClobberedSnapshotsFromBackup(): Promise<void> {
  const backupDir = resolveSnapshotBackupDir();
  if (!(await pathExists(backupDir))) {
    return;
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(backupDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.replace(/\.json$/i, "");
    const destination = accountFilePath(name);
    const source = path.join(backupDir, entry);

    try {
      const backupSnapshot = await parseAuthSnapshotFile(source);
      if (backupSnapshot.authMode !== "chatgpt") continue;
    } catch {
      continue;
    }

    if (!(await pathExists(destination))) {
      // Destination missing: codex deleted it (or never saved). Recover.
      try {
        await ensureSecureDir(path.dirname(destination));
        await fsp.copyFile(source, destination);
        await chmodSecureFile(destination);
      } catch {
        // Best-effort; skip on failure.
      }
      continue;
    }

    // Destination exists. If its identity differs from the backup's
    // identity, codex clobbered it through a stale symlink. Restore.
    try {
      const [backupSnapshot, currentSnapshot] = await Promise.all([
        parseAuthSnapshotFile(source),
        parseAuthSnapshotFile(destination),
      ]);
      if (snapshotsShareIdentity(backupSnapshot, currentSnapshot)) {
        continue;
      }
      await fsp.copyFile(source, destination);
      await chmodSecureFile(destination);
    } catch {
      // Skip on any read/write failure rather than abort the whole recovery.
    }
  }
}

export async function clearSnapshotBackupVault(): Promise<void> {
  const backupDir = resolveSnapshotBackupDir();
  try {
    await fsp.rm(backupDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; do not propagate.
  }
}
