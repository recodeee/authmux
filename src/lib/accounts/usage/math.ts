// Pure scoring / threshold math for usage snapshots. No I/O, no env access.
// Extracted from `accounts/usage.ts` in Theme X2.

import { RateLimitWindow, UsageSnapshot } from "../types";

/**
 * Choose the rate-limit window from a snapshot matching the requested
 * window length (minutes). Falls back to `primary` or `secondary` based
 * on `fallbackPrimary` when no exact match exists.
 */
export function resolveRateWindow(
  snapshot: UsageSnapshot | undefined,
  minutes: number,
  fallbackPrimary: boolean,
): RateLimitWindow | undefined {
  if (!snapshot) return undefined;

  if (snapshot.primary && snapshot.primary.windowMinutes === minutes) {
    return snapshot.primary;
  }

  if (snapshot.secondary && snapshot.secondary.windowMinutes === minutes) {
    return snapshot.secondary;
  }

  return fallbackPrimary ? snapshot.primary : snapshot.secondary;
}

/**
 * Remaining capacity for a window as an integer percent in [0, 100].
 * Returns `undefined` when no window is available. Returns 100 when the
 * window's reset timestamp has already passed.
 */
export function remainingPercent(
  window: RateLimitWindow | undefined,
  nowSeconds: number,
): number | undefined {
  if (!window) return undefined;
  if (typeof window.resetsAt === "number" && window.resetsAt <= nowSeconds) return 100;

  const remaining = 100 - window.usedPercent;
  if (remaining <= 0) return 0;
  if (remaining >= 100) return 100;
  return Math.trunc(remaining);
}

/**
 * Composite score = min(5h remaining %, weekly remaining %). Returns
 * whichever single window is available, or `undefined` when neither is.
 */
export function usageScore(
  snapshot: UsageSnapshot | undefined,
  nowSeconds: number,
): number | undefined {
  const fiveHour = remainingPercent(resolveRateWindow(snapshot, 300, true), nowSeconds);
  const weekly = remainingPercent(resolveRateWindow(snapshot, 10080, false), nowSeconds);

  if (typeof fiveHour === "number" && typeof weekly === "number") return Math.min(fiveHour, weekly);
  if (typeof fiveHour === "number") return fiveHour;
  if (typeof weekly === "number") return weekly;
  return undefined;
}

/**
 * True iff either the 5h or weekly remaining percent has crossed the
 * caller-supplied threshold.
 */
export function shouldSwitchCurrent(
  snapshot: UsageSnapshot | undefined,
  thresholds: { threshold5hPercent: number; thresholdWeeklyPercent: number },
  nowSeconds: number,
): boolean {
  const remaining5h = remainingPercent(resolveRateWindow(snapshot, 300, true), nowSeconds);
  const remainingWeekly = remainingPercent(resolveRateWindow(snapshot, 10080, false), nowSeconds);

  return (
    (typeof remaining5h === "number" && remaining5h < thresholds.threshold5hPercent) ||
    (typeof remainingWeekly === "number" && remainingWeekly < thresholds.thresholdWeeklyPercent)
  );
}
