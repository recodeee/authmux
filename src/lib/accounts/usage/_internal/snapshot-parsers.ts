// Shared snapshot/rate-limit parsing helpers used by both the API client
// (`usage/api-client.ts`) and the local rollout walker
// (`usage/local-rollout.ts`). Kept internal — not re-exported from
// `usage/index.ts` — because callers should consume the typed fetchers
// rather than the parsers.

import { RateLimitWindow, UsageSnapshot } from "../../types";

export function coerceWindow(raw: unknown): RateLimitWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const value = raw as Record<string, unknown>;
  const usedRaw = value.used_percent;
  if (typeof usedRaw !== "number" || !Number.isFinite(usedRaw)) return undefined;

  const windowMinutes = typeof value.window_minutes === "number"
    ? Math.round(value.window_minutes)
    : typeof value.limit_window_seconds === "number"
      ? Math.ceil(value.limit_window_seconds / 60)
      : undefined;

  const resetsAt = typeof value.resets_at === "number"
    ? Math.round(value.resets_at)
    : typeof value.reset_at === "number"
      ? Math.round(value.reset_at)
      : undefined;

  return {
    usedPercent: Math.max(0, Math.min(100, usedRaw)),
    windowMinutes,
    resetsAt,
  };
}

export function buildSnapshotFromRateLimits(
  rateLimits: unknown,
  source: UsageSnapshot["source"],
): UsageSnapshot | null {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const input = rateLimits as Record<string, unknown>;

  const primary = coerceWindow(input.primary_window ?? input.primary);
  const secondary = coerceWindow(input.secondary_window ?? input.secondary);
  if (!primary && !secondary) return null;

  const planType = typeof input.plan_type === "string" ? input.plan_type : undefined;
  return {
    primary,
    secondary,
    planType,
    fetchedAt: new Date().toISOString(),
    source,
  };
}

export function findNestedRateLimits(input: unknown): unknown {
  if (!input || typeof input !== "object") return null;
  const root = input as Record<string, unknown>;
  if (root.rate_limits) return root.rate_limits;
  if (root.payload && typeof root.payload === "object") {
    const payload = root.payload as Record<string, unknown>;
    if (payload.rate_limits) return payload.rate_limits;
    if (payload.event && typeof payload.event === "object") {
      const event = payload.event as Record<string, unknown>;
      if (event.rate_limits) return event.rate_limits;
    }
  }
  return null;
}

export function parseTimestampSeconds(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    if (input > 1_000_000_000_000) {
      return Math.floor(input / 1000);
    }
    return Math.floor(input);
  }

  if (typeof input === "string") {
    const parsed = Date.parse(input);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  return Math.floor(Date.now() / 1000);
}
