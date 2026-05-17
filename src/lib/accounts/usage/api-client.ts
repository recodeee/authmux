// Public ChatGPT backend-api client for usage. One fetch with a 5s
// timeout, no retries, no auth dance. Extracted from `accounts/usage.ts`
// in Theme X2.

import { ParsedAuthSnapshot, UsageSnapshot } from "../types";
import { buildSnapshotFromRateLimits } from "./_internal/snapshot-parsers";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 5000;

export async function fetchUsageFromApi(
  snapshotInfo: ParsedAuthSnapshot,
): Promise<UsageSnapshot | null> {
  if (snapshotInfo.authMode !== "chatgpt" || !snapshotInfo.accessToken || !snapshotInfo.accountId) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${snapshotInfo.accessToken}`,
        "ChatGPT-Account-Id": snapshotInfo.accountId,
        "User-Agent": "authmux",
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    const snapshot = buildSnapshotFromRateLimits(data.rate_limit, "api");
    if (!snapshot) return null;

    if (!snapshot.planType && typeof data.plan_type === "string") {
      snapshot.planType = data.plan_type;
    }

    return snapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
