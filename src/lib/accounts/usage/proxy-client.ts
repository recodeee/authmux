// Localhost dashboard proxy client (Codex LB). Owns its own session,
// password env, TOTP helper, and retry profile. Extracted from
// `accounts/usage.ts` in Theme X2 with one hardening change: by default
// the client refuses to send credentials to non-loopback URLs. Set
// `AUTHMUX_PROXY_INSECURE=1` to opt back into the legacy behavior for
// one minor release.

import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { ProxyInsecureUrlError } from "../errors";
import { RateLimitWindow, UsageSnapshot } from "../types";

const DEFAULT_PROXY_URL = "http://127.0.0.1:2455";
const DASHBOARD_SESSION_PATH = "/api/dashboard-auth/session";
const PASSWORD_LOGIN_PATH = "/api/dashboard-auth/password/login";
const TOTP_VERIFY_PATH = "/api/dashboard-auth/totp/verify";
const ACCOUNTS_PATH = "/api/accounts";
const PROXY_REQUEST_TIMEOUT_MS = 2000;
const DASHBOARD_PASSWORD_ENV = "CODEX_LB_DASHBOARD_PASSWORD";
const DASHBOARD_TOTP_CODE_ENV = "CODEX_LB_DASHBOARD_TOTP_CODE";
const DASHBOARD_TOTP_COMMAND_ENV = "CODEX_LB_DASHBOARD_TOTP_COMMAND";
const PROXY_URL_ENVS = ["CODEX_LB_DASHBOARD_URL", "CODEX_LB_URL"] as const;
const PROXY_INSECURE_OVERRIDE_ENV = "AUTHMUX_PROXY_INSECURE";

const execAsync = promisify(execCallback);

interface ProxySessionState {
  authenticated: boolean;
  passwordRequired: boolean;
  totpRequiredOnLogin: boolean;
}

interface ProxyAccountRecord {
  accountId?: string;
  email?: string;
  snapshotNames: string[];
  usage: UsageSnapshot;
}

export interface ProxyUsageIndex {
  byAccountId: Map<string, UsageSnapshot>;
  byEmail: Map<string, UsageSnapshot>;
  bySnapshotName: Map<string, UsageSnapshot>;
}

interface ProxyRequestResult {
  status: number;
  payload: unknown;
}

type HeaderLookup = {
  get?(name: string): string | null;
  getSetCookie?(): string[];
};

type ProxyAccountPayload = {
  accountId?: unknown;
  email?: unknown;
  planType?: unknown;
  usage?: {
    primaryRemainingPercent?: unknown;
    secondaryRemainingPercent?: unknown;
  } | null;
  resetAtPrimary?: unknown;
  resetAtSecondary?: unknown;
  windowMinutesPrimary?: unknown;
  windowMinutesSecondary?: unknown;
  codexAuth?: {
    snapshotName?: unknown;
    listedSnapshotName?: unknown;
  } | null;
};

type ProxyAccountsPayload = {
  accounts?: unknown;
};

function parseOptionalTimestampSeconds(input: unknown): number | undefined {
  if (input === undefined || input === null || input === "") {
    return undefined;
  }

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

function coerceRemainingPercent(remainingRaw: unknown): number | undefined {
  if (typeof remainingRaw !== "number" || !Number.isFinite(remainingRaw)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, 100 - remainingRaw));
}

function normalizeLookupKey(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function buildProxyWindow(
  remainingRaw: unknown,
  windowMinutesRaw: unknown,
  resetAtRaw: unknown,
): RateLimitWindow | undefined {
  const usedPercent = coerceRemainingPercent(remainingRaw);
  if (typeof usedPercent !== "number") {
    return undefined;
  }

  return {
    usedPercent,
    windowMinutes: typeof windowMinutesRaw === "number" && Number.isFinite(windowMinutesRaw)
      ? Math.round(windowMinutesRaw)
      : undefined,
    resetsAt: parseOptionalTimestampSeconds(resetAtRaw),
  };
}

function buildSnapshotFromProxyAccount(account: ProxyAccountPayload): UsageSnapshot | null {
  const primary = buildProxyWindow(
    account.usage?.primaryRemainingPercent,
    account.windowMinutesPrimary,
    account.resetAtPrimary,
  );
  const secondary = buildProxyWindow(
    account.usage?.secondaryRemainingPercent,
    account.windowMinutesSecondary,
    account.resetAtSecondary,
  );

  if (!primary && !secondary) {
    return null;
  }

  return {
    primary,
    secondary,
    planType: typeof account.planType === "string" ? account.planType : undefined,
    fetchedAt: new Date().toISOString(),
    source: "proxy",
  };
}

function buildProxyAccountRecord(payload: ProxyAccountPayload): ProxyAccountRecord | null {
  const usage = buildSnapshotFromProxyAccount(payload);
  if (!usage) {
    return null;
  }

  const snapshotNames = [
    payload.codexAuth?.snapshotName,
    payload.codexAuth?.listedSnapshotName,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return {
    accountId: typeof payload.accountId === "string" ? payload.accountId : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
    snapshotNames,
    usage,
  };
}

function storeUsageIndexEntry(
  map: Map<string, UsageSnapshot>,
  rawKey: string | undefined,
  usage: UsageSnapshot,
): void {
  const normalized = normalizeLookupKey(rawKey);
  if (!normalized || map.has(normalized)) {
    return;
  }

  map.set(normalized, usage);
}

function extractSetCookieHeaders(headers: HeaderLookup | undefined): string[] {
  if (!headers) return [];

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  if (typeof headers.get === "function") {
    const single = headers.get("set-cookie");
    return single ? [single] : [];
  }

  return [];
}

class DashboardProxyClient {
  private readonly cookies = new Map<string, string>();

  public constructor(private readonly baseUrl: string) {}

  public async fetchJson(
    pathName: string,
    options?: {
      method?: "GET" | "POST";
      payload?: Record<string, unknown>;
    },
  ): Promise<ProxyRequestResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "authmux",
      };
      const cookieHeader = this.buildCookieHeader();
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      let body: string | undefined;
      if (options?.payload) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.payload);
      }

      const response = await fetch(new URL(pathName, this.baseUrl), {
        method: options?.method ?? "GET",
        headers,
        body,
        signal: controller.signal,
      });

      this.storeCookies(response.headers as HeaderLookup);

      let payload: unknown = null;
      const raw = await response.text();
      if (raw.trim().length > 0) {
        try {
          payload = JSON.parse(raw) as unknown;
        } catch {
          payload = null;
        }
      }

      return {
        status: response.status,
        payload,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildCookieHeader(): string | null {
    if (this.cookies.size === 0) {
      return null;
    }

    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private storeCookies(headers: HeaderLookup | undefined): void {
    for (const cookie of extractSetCookieHeaders(headers)) {
      const firstPair = cookie.split(";")[0];
      const separatorIndex = firstPair.indexOf("=");
      if (separatorIndex <= 0) continue;

      const name = firstPair.slice(0, separatorIndex).trim();
      const value = firstPair.slice(separatorIndex + 1).trim();
      if (!name) continue;
      this.cookies.set(name, value);
    }
  }
}

function parseProxySessionState(payload: unknown): ProxySessionState | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const session = payload as Record<string, unknown>;
  return {
    authenticated: Boolean(session.authenticated ?? session.authenticated),
    passwordRequired: Boolean(session.passwordRequired ?? session.password_required),
    totpRequiredOnLogin: Boolean(session.totpRequiredOnLogin ?? session.totp_required_on_login),
  };
}

async function resolveTotpCode(): Promise<string | null> {
  const directCode = process.env[DASHBOARD_TOTP_CODE_ENV]?.trim();
  if (directCode) {
    return directCode;
  }

  const command = process.env[DASHBOARD_TOTP_COMMAND_ENV]?.trim();
  if (!command) {
    return null;
  }

  try {
    const { stdout } = await execAsync(command, { timeout: PROXY_REQUEST_TIMEOUT_MS });
    const code = stdout.trim();
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

async function ensureDashboardSession(client: DashboardProxyClient): Promise<boolean> {
  const sessionResponse = await client.fetchJson(DASHBOARD_SESSION_PATH);
  const initialState = parseProxySessionState(sessionResponse?.payload);
  if (!sessionResponse || sessionResponse.status !== 200 || !initialState) {
    return false;
  }

  if (initialState.authenticated || !initialState.passwordRequired) {
    return true;
  }

  const password = process.env[DASHBOARD_PASSWORD_ENV]?.trim();
  if (!password) {
    return false;
  }

  const loginResponse = await client.fetchJson(PASSWORD_LOGIN_PATH, {
    method: "POST",
    payload: { password },
  });
  if (!loginResponse || loginResponse.status !== 200) {
    return false;
  }

  const loginState = parseProxySessionState((await client.fetchJson(DASHBOARD_SESSION_PATH))?.payload);
  if (!loginState) {
    return false;
  }

  if (loginState.authenticated) {
    return true;
  }

  if (loginState.totpRequiredOnLogin) {
    const code = await resolveTotpCode();
    if (!code) {
      return false;
    }

    const verifyResponse = await client.fetchJson(TOTP_VERIFY_PATH, {
      method: "POST",
      payload: { code },
    });
    if (!verifyResponse || verifyResponse.status !== 200) {
      return false;
    }
  }

  const finalState = parseProxySessionState((await client.fetchJson(DASHBOARD_SESSION_PATH))?.payload);
  return Boolean(finalState?.authenticated);
}

/**
 * Resolve the configured proxy URL from env vars at call time (N4 lazy
 * path resolution: no module-level capture). Returns the raw URL string
 * even if it is non-loopback — the loopback gate lives in
 * `assertLoopbackOrAllowed`.
 */
function resolveRawProxyUrl(): string {
  for (const name of PROXY_URL_ENVS) {
    const raw = process.env[name]?.trim();
    if (raw) {
      return raw;
    }
  }
  return DEFAULT_PROXY_URL;
}

/**
 * Loopback check. Accepts:
 *   - 127.0.0.0/8 (any 127.x.x.x literal)
 *   - ::1
 *   - localhost (case-insensitive)
 *   - IPv4-mapped loopback ([::ffff:127.x.x.x])
 *
 * Anything else is treated as non-loopback. Hostnames that resolve via
 * DNS to a loopback address are NOT trusted — only literal addresses /
 * `localhost`. The proxy auth flow is single-machine by design.
 */
function isLoopbackHostname(hostname: string): boolean {
  if (!hostname) return false;

  // `URL` parses IPv6 hosts wrapped in `[…]`; strip the brackets first.
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const lower = bare.toLowerCase();

  if (lower === "localhost") return true;
  if (lower === "::1") return true;

  // IPv4-mapped IPv6 loopback, e.g. `::ffff:127.0.0.1`.
  if (lower.startsWith("::ffff:")) {
    return isLoopbackHostname(lower.slice("::ffff:".length));
  }

  // 127.x.x.x literal. Must be exactly four numeric octets.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower)) {
    const octets = lower.split(".").map((octet) => Number(octet));
    if (octets.some((value) => value < 0 || value > 255)) return false;
    return octets[0] === 127;
  }

  return false;
}

function isInsecureOverrideEnabled(): boolean {
  return process.env[PROXY_INSECURE_OVERRIDE_ENV]?.trim() === "1";
}

/**
 * Parse + gate the proxy URL. On insecure URL:
 *   - default: throw `ProxyInsecureUrlError`
 *   - with `AUTHMUX_PROXY_INSECURE=1`: emit a process warning and proceed
 *
 * Returns the normalized URL string when allowed, or throws/returns null:
 *   - returns `null` when the URL is unparseable or protocol is unsupported
 *   - throws `ProxyInsecureUrlError` when non-loopback and override is off
 */
function resolveProxyBaseUrl(): string | null {
  const raw = resolveRawProxyUrl();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  if (!isLoopbackHostname(url.hostname)) {
    if (!isInsecureOverrideEnabled()) {
      throw new ProxyInsecureUrlError(url.toString(), url.hostname);
    }
    process.emitWarning(
      "Proxy non-loopback URL allowed — credentials sent over non-loopback. " +
        "Will be hard-blocked next release.",
    );
  }

  return url.toString();
}

export async function fetchUsageFromProxy(): Promise<ProxyUsageIndex | null> {
  const baseUrl = resolveProxyBaseUrl();
  if (!baseUrl) {
    return null;
  }

  const client = new DashboardProxyClient(baseUrl);
  if (!(await ensureDashboardSession(client))) {
    return null;
  }

  const accountsResponse = await client.fetchJson(ACCOUNTS_PATH);
  if (!accountsResponse || accountsResponse.status !== 200) {
    return null;
  }

  const payload = accountsResponse.payload as ProxyAccountsPayload | null;
  if (!payload || !Array.isArray(payload.accounts)) {
    return null;
  }

  const index: ProxyUsageIndex = {
    byAccountId: new Map<string, UsageSnapshot>(),
    byEmail: new Map<string, UsageSnapshot>(),
    bySnapshotName: new Map<string, UsageSnapshot>(),
  };

  for (const account of payload.accounts) {
    if (!account || typeof account !== "object") {
      continue;
    }

    const record = buildProxyAccountRecord(account as ProxyAccountPayload);
    if (!record) {
      continue;
    }

    storeUsageIndexEntry(index.byAccountId, record.accountId, record.usage);
    storeUsageIndexEntry(index.byEmail, record.email, record.usage);
    for (const snapshotName of record.snapshotNames) {
      storeUsageIndexEntry(index.bySnapshotName, snapshotName, record.usage);
    }
  }

  return index;
}

// Exposed for tests only.
export const __testing = {
  isLoopbackHostname,
  resolveProxyBaseUrl,
};
