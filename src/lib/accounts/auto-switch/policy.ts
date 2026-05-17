// Auto-switch policy extracted from AccountService (Theme N2).
//
// Drives the "should I switch the active account now?" decision: pulls
// fresh usage for the active account, compares to the configured
// thresholds, and if low promotes the candidate with the highest
// remaining quota. `runDaemon("watch")` runs the loop with a 30s cycle.

import { AutoSwitchRunResult, RegistryData } from "../types";
import {
  shouldSwitchCurrent,
  usageScore,
} from "../usage";
import { listAccountNames, loadReconciledRegistry } from "../read/listing";
import {
  hydrateSnapshotMetadata,
  persistRegistry,
} from "../_internal/registry-ops";
import { activateSnapshot } from "../write/use";
import { refreshAccountUsage } from "../usage/adapter";

export function selectBestCandidateFromRegistry(
  candidates: string[],
  registry: RegistryData,
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  let best = candidates[0];
  let bestScore = usageScore(registry.accounts[best]?.lastUsage, nowSeconds) ?? -1;

  for (const candidate of candidates.slice(1)) {
    const score =
      usageScore(registry.accounts[candidate]?.lastUsage, nowSeconds) ?? -1;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

export async function runAutoSwitchOnce(
  getCurrentAccountName: () => Promise<string | null>,
): Promise<AutoSwitchRunResult> {
  const registry = await loadReconciledRegistry();
  if (!registry.autoSwitch.enabled) {
    return { switched: false, reason: "auto-switch is disabled" };
  }

  const accountNames = await listAccountNames();
  if (accountNames.length === 0) {
    return { switched: false, reason: "no saved accounts" };
  }

  const active = (await getCurrentAccountName()) ?? registry.activeAccountName;
  if (!active || !accountNames.includes(active)) {
    return { switched: false, reason: "no active account" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  const activeUsage = await refreshAccountUsage(registry, active, {
    preferApi: registry.api.usage,
    allowLocalFallback: true,
  });

  if (
    !shouldSwitchCurrent(
      activeUsage,
      {
        threshold5hPercent: registry.autoSwitch.threshold5hPercent,
        thresholdWeeklyPercent: registry.autoSwitch.thresholdWeeklyPercent,
      },
      nowSeconds,
    )
  ) {
    await persistRegistry(registry);
    return {
      switched: false,
      reason: "active account is above configured thresholds",
    };
  }

  const currentScore = usageScore(activeUsage, nowSeconds) ?? 0;

  let bestCandidate: string | undefined;
  let bestScore = currentScore;

  for (const candidate of accountNames) {
    if (candidate === active) continue;

    const usage = await refreshAccountUsage(registry, candidate, {
      preferApi: registry.api.usage,
      allowLocalFallback: false,
    });

    const score = usageScore(usage, nowSeconds) ?? 100;
    if (!bestCandidate || score > bestScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  if (!bestCandidate || bestScore <= currentScore) {
    await persistRegistry(registry);
    return {
      switched: false,
      reason: "no candidate has better remaining quota",
    };
  }

  await activateSnapshot(bestCandidate);
  registry.activeAccountName = bestCandidate;
  await hydrateSnapshotMetadata(registry, bestCandidate);
  await persistRegistry(registry);

  return {
    switched: true,
    fromAccount: active,
    toAccount: bestCandidate,
    reason: "switched due to low credits on active account",
  };
}

export async function runDaemon(
  mode: "once" | "watch",
  getCurrentAccountName: () => Promise<string | null>,
): Promise<void> {
  if (mode === "once") {
    await runAutoSwitchOnce(getCurrentAccountName);
    return;
  }

  for (;;) {
    try {
      await runAutoSwitchOnce(getCurrentAccountName);
    } catch {
      // keep daemon alive
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}
