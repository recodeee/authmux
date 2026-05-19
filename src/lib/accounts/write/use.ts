// Write-side: useAccount + activateSnapshot + resolveUsableAccountName.
// Extracted from AccountService (Theme N2).
//
// `activateSnapshot` is the I/O primitive: copy a saved snapshot file over
// ~/.codex/auth.json, fix permissions, mark the active name. `useAccount`
// is the public wrapper that also syncs the registry.

import path from "node:path";
import fsp from "node:fs/promises";
import {
  resolveAuthPath,
} from "../../config/paths";
import {
  chmodSecureFile,
  ensureSecureDir,
} from "../../io/secure-fs";
import {
  AccountNotFoundError,
  AmbiguousAccountQueryError,
} from "../errors";
import { parseAuthSnapshotFile } from "../auth-parser";
import { loadRegistry } from "../registry";
import { accountFilePath, normalizeAccountName } from "../naming";
import {
  hydrateSnapshotMetadataIfMissing,
  persistRegistry,
} from "../_internal/registry-ops";
import { listAccountNames } from "../read/listing";
import { writeCurrentName } from "../_internal/auth-state";
import { pathExists, readAuthSyncState } from "../_internal/fs-helpers";
import { normalizeSkillProfileName } from "../../skills/profile";

export interface UseAccountOptions {
  skillProfile?: string;
}

export async function activateSnapshot(accountName: string): Promise<void> {
  const name = normalizeAccountName(accountName);
  const source = accountFilePath(name);

  if (!(await pathExists(source))) {
    throw new AccountNotFoundError(name);
  }

  const authPath = resolveAuthPath();
  await ensureSecureDir(path.dirname(authPath));
  await fsp.copyFile(source, authPath);
  await chmodSecureFile(authPath);

  const authState = await readAuthSyncState(authPath);
  await writeCurrentName(name, {
    authFingerprint: authState && !authState.isSymbolicLink ? authState.fingerprint : undefined,
  });
}

async function findSnapshotNamesByExactEmail(rawEmail: string): Promise<string[]> {
  const normalizedEmail = rawEmail.trim().toLowerCase();
  if (!normalizedEmail.includes("@")) {
    return [];
  }

  const accountNames = await listAccountNames();
  const matches: string[] = [];
  for (const name of accountNames) {
    const snapshotPath = accountFilePath(name);
    try {
      const snapshot = await parseAuthSnapshotFile(snapshotPath);
      if (snapshot.email?.trim().toLowerCase() === normalizedEmail) {
        matches.push(name);
      }
    } catch {
      // Ignore unreadable snapshots here so the existing not-found path
      // remains actionable for the requested email.
    }
  }
  return matches.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

export async function resolveUsableAccountName(
  accountName: string,
  syncExternalAuthSnapshotIfNeeded: () => Promise<unknown>,
): Promise<string> {
  if (await pathExists(accountFilePath(accountName))) {
    return accountName;
  }

  await syncExternalAuthSnapshotIfNeeded();

  if (await pathExists(accountFilePath(accountName))) {
    return accountName;
  }

  const emailMatches = await findSnapshotNamesByExactEmail(accountName);
  if (emailMatches.length === 1) {
    return emailMatches[0];
  }
  if (emailMatches.length > 1) {
    throw new AmbiguousAccountQueryError(accountName);
  }

  throw new AccountNotFoundError(accountName);
}

export async function useAccount(
  rawName: string,
  syncExternalAuthSnapshotIfNeeded: () => Promise<unknown>,
  options?: UseAccountOptions,
): Promise<string> {
  const name = normalizeAccountName(rawName);
  const resolvedName = await resolveUsableAccountName(
    name,
    syncExternalAuthSnapshotIfNeeded,
  );
  await activateSnapshot(resolvedName);

  const registry = await loadRegistry();
  await hydrateSnapshotMetadataIfMissing(registry, resolvedName);
  if (options?.skillProfile) {
    registry.accounts[resolvedName].skillProfile = normalizeSkillProfileName(options.skillProfile);
  }
  registry.activeAccountName = resolvedName;
  await persistRegistry(registry);

  return resolvedName;
}

export async function sessionSnapshotExists(
  getSessionAccountName: () => Promise<string | null>,
): Promise<boolean> {
  const sessionAccountName = await getSessionAccountName();
  if (!sessionAccountName) {
    return true;
  }
  return pathExists(accountFilePath(sessionAccountName));
}
