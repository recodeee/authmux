// Read-side listings extracted from AccountService (Theme N2).
//
// Owns the read-only "show me what accounts exist" surface: a directory
// scan of `~/.codex/accounts/`, joined with registry metadata to produce
// AccountMapping / AccountChoice rows. Write paths live elsewhere.

import path from "node:path";
import fsp from "node:fs/promises";
import {
  resolveAccountsDir,
  resolveAuthPath,
  resolveCurrentNamePath,
  resolveSessionMapPath,
} from "../../config/paths";
import { parseAuthSnapshotFile } from "../auth-parser";
import {
  createDefaultRegistry,
  loadRegistry,
  reconcileRegistryWithAccounts,
} from "../registry";
import {
  AccountMapping,
  ParsedAuthSnapshot,
  RegistryData,
} from "../types";
import {
  remainingPercent,
  resolveRateWindow,
} from "../usage";
import { accountFilePath } from "../naming";
import { pathExists } from "../_internal/fs-helpers";
import {
  clearSessionAccountName,
  getActiveSessionAccountName,
  setSessionAccountName,
} from "../session/pin";
import { readCurrentNameFile } from "../_internal/auth-state";

export interface AccountChoice {
  name: string;
  email?: string;
  active: boolean;
}

export interface ListAccountMappingsOptions {
  refreshUsage?: "never" | "missing" | "always";
}

export async function listAccountNames(): Promise<string[]> {
  const accountsDir = resolveAccountsDir();
  if (!(await pathExists(accountsDir))) {
    return [];
  }

  const sessionMapPath = resolveSessionMapPath();
  const sessionMapBasename =
    path.dirname(sessionMapPath) === accountsDir
      ? path.basename(sessionMapPath)
      : undefined;

  const entries = await fsp.readdir(accountsDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "registry.json" &&
        entry.name !== "update-check.json" &&
        entry.name !== sessionMapBasename,
    )
    .map((entry) => entry.name.replace(/\.json$/i, ""))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export async function loadReconciledRegistry(): Promise<RegistryData> {
  const accountNames = await listAccountNames();
  const loaded = await loadRegistry();
  const base = loaded.version === 1 ? loaded : createDefaultRegistry();
  return reconcileRegistryWithAccounts(base, accountNames);
}

export async function listAccountChoices(
  getCurrentAccountName: () => Promise<string | null>,
): Promise<AccountChoice[]> {
  const [accounts, current, registry] = await Promise.all([
    listAccountNames(),
    getCurrentAccountName(),
    loadReconciledRegistry(),
  ]);

  return accounts.map((name) => ({
    name,
    email: registry.accounts[name]?.email,
    active: current === name,
  }));
}

export async function listAccountMappings(
  getCurrentAccountName: () => Promise<string | null>,
  refreshListUsageIfNeeded: (
    accounts: string[],
    current: string | null,
    registry: RegistryData,
    refreshUsage: "never" | "missing" | "always",
    nowSeconds: number,
  ) => Promise<void>,
  options?: ListAccountMappingsOptions,
): Promise<AccountMapping[]> {
  const [accounts, current, registry] = await Promise.all([
    listAccountNames(),
    getCurrentAccountName(),
    loadReconciledRegistry(),
  ]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  await refreshListUsageIfNeeded(
    accounts,
    current,
    registry,
    options?.refreshUsage ?? "never",
    nowSeconds,
  );

  return Promise.all(
    accounts.map(async (name) => {
      const entry = registry.accounts[name];
      let fallbackSnapshot: ParsedAuthSnapshot | undefined;

      if (!entry?.email || !entry?.accountId || !entry?.userId || !entry?.planType) {
        fallbackSnapshot = await parseAuthSnapshotFile(accountFilePath(name));
      }

      const remaining5hPercent = remainingPercent(
        resolveRateWindow(entry?.lastUsage, 300, true),
        nowSeconds,
      );
      const remainingWeeklyPercent = remainingPercent(
        resolveRateWindow(entry?.lastUsage, 10080, false),
        nowSeconds,
      );

      return {
        name,
        active: current === name,
        email: entry?.email ?? fallbackSnapshot?.email,
        accountId: entry?.accountId ?? fallbackSnapshot?.accountId,
        userId: entry?.userId ?? fallbackSnapshot?.userId,
        planType: entry?.planType ?? fallbackSnapshot?.planType,
        skillProfile: entry?.skillProfile,
        lastUsageAt: entry?.lastUsageAt,
        usageSource: entry?.lastUsage?.source,
        remaining5hPercent,
        remainingWeeklyPercent,
      };
    }),
  );
}

export async function getCurrentAccountName(): Promise<string | null> {
  const sessionAccountName = await getActiveSessionAccountName();
  if (sessionAccountName) {
    const sessionSnapshotPath = accountFilePath(sessionAccountName);
    if (await pathExists(sessionSnapshotPath)) {
      return sessionAccountName;
    }

    await clearSessionAccountName();
  }

  const currentNamePath = resolveCurrentNamePath();
  const currentName = await readCurrentNameFile(currentNamePath);
  if (currentName) {
    await setSessionAccountName(currentName);
    return currentName;
  }

  const authPath = resolveAuthPath();
  if (!(await pathExists(authPath))) return null;

  const stat = await fsp.lstat(authPath);
  if (!stat.isSymbolicLink()) return null;

  const rawTarget = await fsp.readlink(authPath);
  const resolvedTarget = path.resolve(path.dirname(authPath), rawTarget);
  const accountsRoot = path.resolve(resolveAccountsDir());
  const relative = path.relative(accountsRoot, resolvedTarget);
  if (relative.startsWith("..")) return null;

  const base = path.basename(resolvedTarget);
  if (!base.endsWith(".json") || base === "registry.json") return null;
  const resolvedName = base.replace(/\.json$/i, "");
  await setSessionAccountName(resolvedName);
  return resolvedName;
}

export async function findMatchingAccounts(
  query: string,
  getCurrentAccountName: () => Promise<string | null>,
): Promise<AccountChoice[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const choices = await listAccountChoices(getCurrentAccountName);
  const registry = await loadReconciledRegistry();
  return choices.filter((choice) => {
    if (choice.name.toLowerCase().includes(normalized)) return true;
    if (choice.email && choice.email.toLowerCase().includes(normalized)) return true;
    const meta = registry.accounts[choice.name];
    if (meta?.accountId?.toLowerCase().includes(normalized)) return true;
    if (meta?.userId?.toLowerCase().includes(normalized)) return true;
    return false;
  });
}
