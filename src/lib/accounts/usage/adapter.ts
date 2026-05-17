// Usage-refresh adapter extracted from AccountService (Theme N2).
//
// Wraps the three usage fetchers in `accounts/usage.ts` (API, local,
// proxy) and writes the result onto a registry entry. Also handles the
// list-side concurrent refresh loop used by `listAccountMappings`.

import { resolveCodexDir } from "../../config/paths";
import { parseAuthSnapshotFile } from "../auth-parser";
import { accountFilePath } from "../naming";
import { persistRegistry } from "../_internal/registry-ops";
import {
  ParsedAuthSnapshot,
  RegistryData,
  UsageSnapshot,
} from "../types";
import {
  fetchUsageFromApi,
  fetchUsageFromLocal,
  fetchUsageFromProxy,
  ProxyUsageIndex,
  remainingPercent,
  resolveRateWindow,
} from "../usage";

const LIST_USAGE_REFRESH_CONCURRENCY = 6;

export function lookupProxyUsage(
  map: Map<string, UsageSnapshot>,
  rawValue: string | undefined,
): UsageSnapshot | null {
  if (!rawValue) {
    return null;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return map.get(normalized) ?? null;
}

export function resolveProxyUsage(
  proxyUsageIndex: ProxyUsageIndex | null | undefined,
  accountName: string,
  entry: RegistryData["accounts"][string],
  parsed: ParsedAuthSnapshot,
): UsageSnapshot | null {
  if (!proxyUsageIndex) {
    return null;
  }

  const candidates = [parsed.accountId, entry.accountId];
  for (const candidate of candidates) {
    const usage = lookupProxyUsage(proxyUsageIndex.byAccountId, candidate);
    if (usage) {
      return usage;
    }
  }

  const emailCandidates = [parsed.email, entry.email];
  for (const candidate of emailCandidates) {
    const usage = lookupProxyUsage(proxyUsageIndex.byEmail, candidate);
    if (usage) {
      return usage;
    }
  }

  return lookupProxyUsage(proxyUsageIndex.bySnapshotName, accountName);
}

export async function refreshAccountUsage(
  registry: RegistryData,
  accountName: string,
  options: {
    preferApi: boolean;
    allowLocalFallback: boolean;
    proxyUsageIndex?: ProxyUsageIndex | null;
  },
): Promise<UsageSnapshot | undefined> {
  const snapshotPath = accountFilePath(accountName);
  const parsed = await parseAuthSnapshotFile(snapshotPath);

  const entry = registry.accounts[accountName] ?? {
    name: accountName,
    createdAt: new Date().toISOString(),
  };

  if (parsed.email) entry.email = parsed.email;
  if (parsed.accountId) entry.accountId = parsed.accountId;
  if (parsed.userId) entry.userId = parsed.userId;
  if (parsed.planType) entry.planType = parsed.planType;

  let usage: UsageSnapshot | null = null;
  if (options.preferApi) {
    usage = resolveProxyUsage(options.proxyUsageIndex, accountName, entry, parsed);
  }

  if (!usage && options.preferApi) {
    usage = await fetchUsageFromApi(parsed);
  }

  if (!usage && options.allowLocalFallback) {
    usage = await fetchUsageFromLocal(resolveCodexDir());
  }

  if (usage) {
    entry.lastUsage = usage;
    entry.lastUsageAt = usage.fetchedAt;
    if (usage.planType) {
      entry.planType = usage.planType;
    }
  }

  registry.accounts[accountName] = entry;
  return entry.lastUsage;
}

export function isUsageMissingForList(
  usage: UsageSnapshot | undefined,
  nowSeconds: number,
): boolean {
  const remaining5hPercent = remainingPercent(
    resolveRateWindow(usage, 300, true),
    nowSeconds,
  );
  const remainingWeeklyPercent = remainingPercent(
    resolveRateWindow(usage, 10080, false),
    nowSeconds,
  );
  return (
    typeof remaining5hPercent !== "number" ||
    typeof remainingWeeklyPercent !== "number"
  );
}

export async function refreshListUsageIfNeeded(
  accountNames: string[],
  currentAccountName: string | null,
  registry: RegistryData,
  refreshUsage: "never" | "missing" | "always",
  nowSeconds: number,
): Promise<void> {
  if (refreshUsage === "never" || accountNames.length === 0) {
    return;
  }

  const accountNamesToRefresh = accountNames.filter((accountName) => {
    if (!registry.api.usage && currentAccountName !== accountName) {
      return false;
    }

    if (refreshUsage === "always") {
      return true;
    }

    return isUsageMissingForList(
      registry.accounts[accountName]?.lastUsage,
      nowSeconds,
    );
  });

  if (accountNamesToRefresh.length === 0) {
    return;
  }

  let index = 0;
  const workerCount = Math.min(
    LIST_USAGE_REFRESH_CONCURRENCY,
    accountNamesToRefresh.length,
  );
  const proxyUsageIndex = registry.api.usage ? await fetchUsageFromProxy() : null;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const accountName = accountNamesToRefresh[index];
        index += 1;
        if (!accountName) {
          return;
        }

        await refreshAccountUsage(registry, accountName, {
          preferApi: registry.api.usage,
          allowLocalFallback: currentAccountName === accountName,
          proxyUsageIndex,
        });
      }
    }),
  );

  await persistRegistry(registry);
}
