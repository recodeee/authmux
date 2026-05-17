// Write-side: remove one / many / all accounts. Extracted from
// AccountService (Theme N2).
//
// On removing the active account we promote the best remaining candidate
// (highest registry usageScore) and activate it. If the registry has no
// remaining accounts we clear ~/.codex/auth.json and the current-name file.

import fsp from "node:fs/promises";
import {
  AccountNotFoundError,
  AmbiguousAccountQueryError,
} from "../errors";
import { accountFilePath, normalizeAccountName } from "../naming";
import { persistRegistry } from "../_internal/registry-ops";
import {
  findMatchingAccounts,
  listAccountNames,
  loadReconciledRegistry,
} from "../read/listing";
import { clearActivePointers } from "../_internal/auth-state";
import { pathExists } from "../_internal/fs-helpers";
import { activateSnapshot } from "./use";
import { clearSessionAccountName } from "../session/pin";
import { selectBestCandidateFromRegistry } from "../auto-switch/policy";

export interface RemoveResult {
  removed: string[];
  activated?: string;
}

export async function removeAccounts(
  accountNames: string[],
  getCurrentAccountName: () => Promise<string | null>,
): Promise<RemoveResult> {
  const uniqueNames = [
    ...new Set(accountNames.map((name) => normalizeAccountName(name))),
  ];
  if (uniqueNames.length === 0) {
    return { removed: [] };
  }

  const current = await getCurrentAccountName();
  const registry = await loadReconciledRegistry();
  const removed: string[] = [];

  for (const name of uniqueNames) {
    const snapshotPath = accountFilePath(name);
    if (!(await pathExists(snapshotPath))) {
      throw new AccountNotFoundError(name);
    }

    await fsp.rm(snapshotPath, { force: true });
    delete registry.accounts[name];
    removed.push(name);
  }

  const removedSet = new Set(removed);
  let activated: string | undefined;

  if (current && removedSet.has(current)) {
    const remaining = (await listAccountNames()).filter((name) => !removedSet.has(name));
    if (remaining.length > 0) {
      const best = selectBestCandidateFromRegistry(remaining, registry);
      await activateSnapshot(best);
      activated = best;
      registry.activeAccountName = best;
    } else {
      await clearActivePointers(clearSessionAccountName);
      delete registry.activeAccountName;
    }
  } else if (
    registry.activeAccountName &&
    removedSet.has(registry.activeAccountName)
  ) {
    delete registry.activeAccountName;
  }

  await persistRegistry(registry);
  return {
    removed,
    activated,
  };
}

export async function removeByQuery(
  query: string,
  getCurrentAccountName: () => Promise<string | null>,
): Promise<RemoveResult> {
  const matches = await findMatchingAccounts(query, getCurrentAccountName);
  if (matches.length === 0) {
    throw new AccountNotFoundError(query);
  }
  if (matches.length > 1) {
    throw new AmbiguousAccountQueryError(query);
  }

  return removeAccounts([matches[0].name], getCurrentAccountName);
}

export async function removeAllAccounts(
  getCurrentAccountName: () => Promise<string | null>,
): Promise<RemoveResult> {
  const all = await listAccountNames();
  return removeAccounts(all, getCurrentAccountName);
}
