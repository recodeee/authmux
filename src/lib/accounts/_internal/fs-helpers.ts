// Internal filesystem helpers shared across the extracted clusters.
// Not part of the public API — only modules under `src/lib/accounts/`
// should import from here.

import fs from "node:fs";
import fsp from "node:fs/promises";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function filesMatch(firstPath: string, secondPath: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([
      fsp.readFile(firstPath),
      fsp.readFile(secondPath),
    ]);
    return first.equals(second);
  } catch {
    return false;
  }
}

export async function removeIfExists(target: string): Promise<void> {
  try {
    await fsp.rm(target, { force: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

export interface AuthSyncState {
  fingerprint: string;
  isSymbolicLink: boolean;
}

export async function readAuthSyncState(authPath: string): Promise<AuthSyncState | null> {
  try {
    const stat = await fsp.lstat(authPath);
    return {
      fingerprint: createAuthSyncFingerprint(stat),
      isSymbolicLink: stat.isSymbolicLink(),
    };
  } catch {
    return null;
  }
}

export function createAuthSyncFingerprint(stat: fs.Stats): string {
  return [
    stat.isSymbolicLink() ? "symlink" : "file",
    typeof stat.ino === "number" ? Math.trunc(stat.ino) : 0,
    Math.trunc(stat.size),
    Math.trunc(stat.mtimeMs),
  ].join(":");
}
