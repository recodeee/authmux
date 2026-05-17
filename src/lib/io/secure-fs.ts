import fsp from "node:fs/promises";

import { atomicWriteFile } from "../../infra/fs/atomic-write";

export const SECURE_FILE_MODE = 0o600;
export const SECURE_DIR_MODE = 0o700;

const IS_WINDOWS = process.platform === "win32";

export async function ensureSecureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true, mode: SECURE_DIR_MODE });
  if (!IS_WINDOWS) {
    try {
      await fsp.chmod(dirPath, SECURE_DIR_MODE);
    } catch {
      // best-effort; some filesystems disallow chmod
    }
  }
}

/**
 * Atomic, fsync-durable write with 0600 perms applied BEFORE rename.
 * Thin wrapper over `atomicWriteFile`; kept for call-site compatibility.
 */
export async function secureWriteFile(filePath: string, data: string | Buffer): Promise<void> {
  await atomicWriteFile(filePath, data, { mode: SECURE_FILE_MODE });
}

export async function chmodSecureFile(filePath: string): Promise<void> {
  if (IS_WINDOWS) return;
  try {
    await fsp.chmod(filePath, SECURE_FILE_MODE);
  } catch {
    // ignore
  }
}

export async function chmodSecureDir(dirPath: string): Promise<void> {
  if (IS_WINDOWS) return;
  try {
    await fsp.chmod(dirPath, SECURE_DIR_MODE);
  } catch {
    // ignore
  }
}
