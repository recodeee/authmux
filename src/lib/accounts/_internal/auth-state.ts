// Internal: auth.json read/state helpers — symlink materialization,
// ensure-exists guard, current-name file I/O. Extracted from the
// monolithic AccountService (Theme N2).

import path from "node:path";
import fsp from "node:fs/promises";
import {
  resolveAuthPath,
  resolveCurrentNamePath,
} from "../../config/paths";
import {
  ensureSecureDir,
  secureWriteFile,
} from "../../io/secure-fs";
import { AuthFileMissingError } from "../errors";
import {
  setSessionAccountName,
} from "../session/pin";
import { pathExists, removeIfExists } from "./fs-helpers";

export async function ensureAuthFileExists(authPath: string): Promise<void> {
  if (!(await pathExists(authPath))) {
    throw new AuthFileMissingError(authPath);
  }
}

export async function materializeAuthSymlink(authPath: string): Promise<void> {
  const stat = await fsp.lstat(authPath);
  if (!stat.isSymbolicLink()) {
    return;
  }

  const snapshotData = await fsp.readFile(authPath);
  await removeIfExists(authPath);
  await secureWriteFile(authPath, snapshotData);
}

export async function writeCurrentName(
  name: string,
  options?: { authFingerprint?: string },
): Promise<void> {
  const currentNamePath = resolveCurrentNamePath();
  await ensureSecureDir(path.dirname(currentNamePath));
  await secureWriteFile(currentNamePath, `${name}\n`);
  await setSessionAccountName(name, options?.authFingerprint);
}

export async function readCurrentNameFile(currentNamePath: string): Promise<string | null> {
  try {
    const contents = await fsp.readFile(currentNamePath, "utf8");
    const trimmed = contents.trim();
    return trimmed.length ? trimmed : null;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function clearActivePointers(
  clearSessionAccountName: () => Promise<void>,
): Promise<void> {
  const currentPath = resolveCurrentNamePath();
  const authPath = resolveAuthPath();
  await removeIfExists(currentPath);
  await removeIfExists(authPath);
  await clearSessionAccountName();
}
