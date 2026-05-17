// Internal: resolve the snapshot file name for a given live auth snapshot.
// Used by save/use/external-sync — kept under _internal/ because the
// public surface only exposes the orchestrator wrappers.

import {
  AccountNameInferenceError,
} from "../errors";
import { parseAuthSnapshotFile } from "../auth-parser";
import { loadRegistry } from "../registry";
import { ParsedAuthSnapshot } from "../types";
import { listAccountNames } from "../read/listing";
import { accountFilePath, normalizeAccountName } from "../naming";
import { pathExists } from "./fs-helpers";
import {
  registryEntrySharesEmail,
  registryEntrySharesIdentity,
  snapshotsShareEmail,
  snapshotsShareIdentity,
} from "../identity/equality";

export type ResolvedAccountNameSource = "active" | "existing" | "inferred";

export interface ResolvedDefaultAccountName {
  name: string;
  source: ResolvedAccountNameSource;
  forceOverwrite?: boolean;
}

export interface ResolvedLoginAccountName {
  name: string;
  source: ResolvedAccountNameSource;
  forceOverwrite?: boolean;
}

function orderReloginSnapshotCandidates(
  accountNames: string[],
  incomingSnapshot: ParsedAuthSnapshot,
  activeName: string | null,
): string[] {
  const ordered: string[] = [];
  const add = (name: string | null | undefined): void => {
    if (!name || !accountNames.includes(name) || ordered.includes(name)) return;
    ordered.push(name);
  };

  add(activeName);

  const incomingEmail = incomingSnapshot.email?.trim().toLowerCase();
  if (incomingEmail) {
    try {
      add(normalizeAccountName(incomingEmail));
    } catch {
      // Invalid email-shaped snapshot names fall through to identity scan.
    }
  }

  for (const name of accountNames) {
    add(name);
  }

  return ordered;
}

async function resolveRegistryAccountNameForIncomingSnapshot(
  incomingSnapshot: ParsedAuthSnapshot,
  candidates: string[],
  activeName: string | null,
): Promise<ResolvedDefaultAccountName | null> {
  const registry = await loadRegistry();
  let activeEmailMatch: ResolvedDefaultAccountName | null = null;

  for (const name of candidates) {
    const entry = registry.accounts[name];
    if (!entry || !(await pathExists(accountFilePath(name)))) continue;

    if (registryEntrySharesIdentity(entry, incomingSnapshot)) {
      return {
        name,
        source: activeName === name ? "active" : "existing",
      };
    }

    if (!activeEmailMatch && registryEntrySharesEmail(entry, incomingSnapshot)) {
      activeEmailMatch = {
        name,
        source: activeName === name ? "active" : "existing",
        forceOverwrite: true,
      };
    }
  }

  return activeEmailMatch;
}

export async function resolveExistingAccountNameForIncomingSnapshot(
  incomingSnapshot: ParsedAuthSnapshot,
  activeName: string | null,
): Promise<ResolvedDefaultAccountName | null> {
  let emailMatch: ResolvedDefaultAccountName | null = null;
  const accountNames = await listAccountNames();
  const candidates = orderReloginSnapshotCandidates(
    accountNames,
    incomingSnapshot,
    activeName,
  );
  const registryMatch = await resolveRegistryAccountNameForIncomingSnapshot(
    incomingSnapshot,
    candidates,
    activeName,
  );
  if (registryMatch) {
    return registryMatch;
  }

  for (const name of candidates) {
    const snapshotPath = accountFilePath(name);
    if (!(await pathExists(snapshotPath))) continue;

    const existingSnapshot = await parseAuthSnapshotFile(snapshotPath);
    if (snapshotsShareIdentity(existingSnapshot, incomingSnapshot)) {
      return {
        name,
        source: activeName === name ? "active" : "existing",
      };
    }

    if (!emailMatch && snapshotsShareEmail(existingSnapshot, incomingSnapshot)) {
      emailMatch = {
        name,
        source: activeName === name ? "active" : "existing",
        forceOverwrite: true,
      };
    }
  }

  return emailMatch;
}

export async function resolveUniqueInferredName(
  baseName: string,
  incomingSnapshot: ParsedAuthSnapshot,
): Promise<string> {
  const hasMatchingIdentity = async (name: string): Promise<boolean> => {
    const parsed = await parseAuthSnapshotFile(accountFilePath(name));
    return snapshotsShareIdentity(parsed, incomingSnapshot);
  };

  const basePath = accountFilePath(baseName);
  if (!(await pathExists(basePath))) {
    return baseName;
  }
  if (await hasMatchingIdentity(baseName)) {
    return baseName;
  }

  for (let i = 2; i <= 99; i += 1) {
    const candidate = normalizeAccountName(`${baseName}--dup-${i}`);
    const candidatePath = accountFilePath(candidate);
    if (!(await pathExists(candidatePath))) {
      return candidate;
    }
    if (await hasMatchingIdentity(candidate)) {
      return candidate;
    }
  }

  throw new AccountNameInferenceError();
}

export async function inferAccountNameFromSnapshot(
  incomingSnapshot: ParsedAuthSnapshot,
): Promise<string> {
  const email = incomingSnapshot.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new AccountNameInferenceError();
  }

  const baseCandidate = normalizeAccountName(email);
  return resolveUniqueInferredName(baseCandidate, incomingSnapshot);
}

export async function resolveLoginAccountNameForSnapshot(
  incomingSnapshot: ParsedAuthSnapshot,
  activeName: string | null,
): Promise<ResolvedLoginAccountName> {
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
