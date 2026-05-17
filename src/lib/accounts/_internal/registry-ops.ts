// Internal registry helpers shared across write clusters.
// All durable writes funnel through `persistRegistryAtomic` (Theme N1) —
// this module just adds the reconcile-by-account-name step on top.

import {
  persistRegistryAtomic,
  reconcileRegistryWithAccounts,
} from "../registry";
import { RegistryData } from "../types";
import { parseAuthSnapshotFile } from "../auth-parser";
import { accountFilePath } from "../naming";
import { listAccountNames } from "../read/listing";

export async function persistRegistry(registry: RegistryData): Promise<void> {
  const reconciled = reconcileRegistryWithAccounts(
    registry,
    await listAccountNames(),
  );
  await persistRegistryAtomic(reconciled);
}

export async function hydrateSnapshotMetadata(
  registry: RegistryData,
  accountName: string,
): Promise<void> {
  const parsed = await parseAuthSnapshotFile(accountFilePath(accountName));
  const entry = registry.accounts[accountName] ?? {
    name: accountName,
    createdAt: new Date().toISOString(),
  };

  if (parsed.email) entry.email = parsed.email;
  if (parsed.accountId) entry.accountId = parsed.accountId;
  if (parsed.userId) entry.userId = parsed.userId;
  if (parsed.planType) entry.planType = parsed.planType;

  registry.accounts[accountName] = entry;
}

export async function hydrateSnapshotMetadataIfMissing(
  registry: RegistryData,
  accountName: string,
): Promise<void> {
  const entry = registry.accounts[accountName];
  if (entry?.email && entry.accountId && entry.userId && entry.planType) {
    return;
  }

  await hydrateSnapshotMetadata(registry, accountName);
}
