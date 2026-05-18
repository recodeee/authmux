// Barrel for the usage subsystem. Public surface only — internal helpers
// in `_internal/` are deliberately not re-exported.

export { fetchUsageFromApi } from "./api-client";
export { fetchUsageFromLocal } from "./local-rollout";
export { fetchUsageFromProxy, type ProxyUsageIndex } from "./proxy-client";
export {
  remainingPercent,
  resolveRateWindow,
  shouldSwitchCurrent,
  usageScore,
} from "./math";

// Re-export the underlying snapshot types so callers can keep using
// `import { UsageSnapshot } from "lib/accounts/usage"` without a second
// import from `types`.
export type { RateLimitWindow, UsageSnapshot } from "../types";
