// Write-side: saveAccount + safety guard + inference helpers (Theme N2).
//
// Owns the "copy ~/.codex/auth.json into ~/.codex/accounts/<name>.json,
// update the registry, mark <name> active" path. Pre-write safety check
// refuses to clobber a snapshot belonging to a different email unless the
// caller passes `force: true`.

import fsp from "node:fs/promises";
import {
  resolveAccountsDir,
  resolveAuthPath,
} from "../../config/paths";
import {
  chmodSecureDir,
  chmodSecureFile,
  ensureSecureDir,
} from "../../io/secure-fs";
import {
  AccountNameInferenceError,
  SnapshotEmailMismatchError,
} from "../errors";
import { parseAuthSnapshotFile } from "../auth-parser";
import { accountFilePath, normalizeAccountName } from "../naming";
import {
  hydrateSnapshotMetadata,
  persistRegistry,
} from "../_internal/registry-ops";
import { loadReconciledRegistry } from "../read/listing";
import {
  ensureAuthFileExists,
  writeCurrentName,
} from "../_internal/auth-state";
import { pathExists } from "../_internal/fs-helpers";
import {
  renderSnapshotIdentity,
  snapshotsShareIdentity,
} from "../identity/equality";
import {
  inferAccountNameFromSnapshot,
  resolveExistingAccountNameForIncomingSnapshot,
  resolveLoginAccountNameForSnapshot,
  resolveUniqueInferredName,
  ResolvedDefaultAccountName,
  ResolvedLoginAccountName,
} from "../_internal/name-resolution";
import { normalizeSkillProfileName } from "../../skills/profile";

export interface SaveAccountOptions {
  force?: boolean;
  skillProfile?: string;
}

export async function assertSafeSnapshotOverwrite(input: {
  authPath: string;
  destinationPath: string;
  accountName: string;
  force: boolean;
}): Promise<void> {
  if (input.force || !(await pathExists(input.destinationPath))) {
    return;
  }

  const [existingSnapshot, incomingSnapshot] = await Promise.all([
    parseAuthSnapshotFile(input.destinationPath),
    parseAuthSnapshotFile(input.authPath),
  ]);

  const existingEmail = existingSnapshot.email?.trim().toLowerCase();
  const incomingEmail = incomingSnapshot.email?.trim().toLowerCase();

  if (existingEmail && incomingEmail && existingEmail !== incomingEmail) {
    throw new SnapshotEmailMismatchError(input.accountName, existingEmail, incomingEmail);
  }

  if (snapshotsShareIdentity(existingSnapshot, incomingSnapshot)) return;

  if (!existingEmail || !incomingEmail) return;

  const existingIdentity = renderSnapshotIdentity(existingSnapshot, existingEmail);
  const incomingIdentity = renderSnapshotIdentity(incomingSnapshot, incomingEmail);
  throw new SnapshotEmailMismatchError(
    input.accountName,
    existingIdentity,
    incomingIdentity,
  );
}

export async function saveAccount(
  rawName: string,
  options?: SaveAccountOptions,
): Promise<string> {
  const name = normalizeAccountName(rawName);
  const authPath = resolveAuthPath();
  const accountsDir = resolveAccountsDir();

  await ensureAuthFileExists(authPath);
  await ensureSecureDir(accountsDir);
  const destination = accountFilePath(name);
  await assertSafeSnapshotOverwrite({
    authPath,
    destinationPath: destination,
    accountName: name,
    force: Boolean(options?.force),
  });
  await fsp.copyFile(authPath, destination);
  await chmodSecureFile(destination);
  await chmodSecureDir(accountsDir);

  await writeCurrentName(name);

  const registry = await loadReconciledRegistry();
  await hydrateSnapshotMetadata(registry, name);
  if (options?.skillProfile) {
    registry.accounts[name].skillProfile = normalizeSkillProfileName(options.skillProfile);
  }
  registry.activeAccountName = name;
  await persistRegistry(registry);

  return name;
}

export async function inferAccountNameFromCurrentAuth(): Promise<string> {
  const authPath = resolveAuthPath();
  await ensureAuthFileExists(authPath);

  const parsed = await parseAuthSnapshotFile(authPath);
  const email = parsed.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new AccountNameInferenceError();
  }

  const baseCandidate = normalizeAccountName(email);
  const uniqueName = await resolveUniqueInferredName(baseCandidate, parsed);
  return uniqueName;
}

export async function resolveDefaultAccountNameFromCurrentAuth(
  getCurrentAccountName: () => Promise<string | null>,
): Promise<ResolvedDefaultAccountName> {
  const authPath = resolveAuthPath();
  await ensureAuthFileExists(authPath);
  const incomingSnapshot = await parseAuthSnapshotFile(authPath);
  const activeName = await getCurrentAccountName();
  const existing = await resolveExistingAccountNameForIncomingSnapshot(
    incomingSnapshot,
    activeName,
  );
  if (existing) return existing;

  return {
    name: await inferAccountNameFromSnapshot(incomingSnapshot),
    source: "inferred",
  };
}

export async function resolveLoginAccountNameFromCurrentAuth(
  getCurrentAccountName: () => Promise<string | null>,
): Promise<ResolvedLoginAccountName> {
  const authPath = resolveAuthPath();
  await ensureAuthFileExists(authPath);
  const incomingSnapshot = await parseAuthSnapshotFile(authPath);
  const activeName = await getCurrentAccountName();
  return resolveLoginAccountNameForSnapshot(incomingSnapshot, activeName);
}
