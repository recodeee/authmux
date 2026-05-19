export const DEFAULT_THRESHOLD_5H_PERCENT = 10;
export const DEFAULT_THRESHOLD_WEEKLY_PERCENT = 5;

export type UsageSource = "api" | "local" | "cached" | "proxy";

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface UsageSnapshot {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  planType?: string;
  fetchedAt: string;
  source: UsageSource;
}

export interface AccountRegistryEntry {
  name: string;
  email?: string;
  accountId?: string;
  userId?: string;
  planType?: string;
  skillProfile?: string;
  createdAt: string;
  lastUsageAt?: string;
  lastUsage?: UsageSnapshot;
}

export interface AutoSwitchConfig {
  enabled: boolean;
  threshold5hPercent: number;
  thresholdWeeklyPercent: number;
}

export interface ApiConfig {
  usage: boolean;
}

export interface RegistryData {
  version: 1;
  autoSwitch: AutoSwitchConfig;
  api: ApiConfig;
  activeAccountName?: string;
  accounts: Record<string, AccountRegistryEntry>;
}

export interface ParsedAuthSnapshot {
  authMode: "chatgpt" | "apikey" | "unknown";
  email?: string;
  accountId?: string;
  userId?: string;
  planType?: string;
  accessToken?: string;
}

export interface StatusReport {
  autoSwitchEnabled: boolean;
  serviceState: "active" | "inactive" | "unknown";
  threshold5hPercent: number;
  thresholdWeeklyPercent: number;
  usageMode: "api" | "local";
}

export interface AutoSwitchRunResult {
  switched: boolean;
  fromAccount?: string;
  toAccount?: string;
  reason: string;
}

export interface AccountMapping {
  name: string;
  active: boolean;
  email?: string;
  accountId?: string;
  userId?: string;
  planType?: string;
  skillProfile?: string;
  lastUsageAt?: string;
  usageSource?: UsageSource;
  remaining5hPercent?: number;
  remainingWeeklyPercent?: number;
}
