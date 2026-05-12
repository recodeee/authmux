import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  resolveAccountsDir,
  resolveAuthPath,
  resolveCodexDir,
  resolveCurrentNamePath,
  resolveSessionMapPath,
} from "../config/paths";
import {
  AccountNotFoundError,
  AccountNameInferenceError,
  AmbiguousAccountQueryError,
  AuthFileMissingError,
  AutoSwitchConfigError,
  InvalidAccountNameError,
  SnapshotEmailMismatchError,
} from "./errors";
import { parseAuthSnapshotFile } from "./auth-parser";
import {
  createDefaultRegistry,
  loadRegistry,
  reconcileRegistryWithAccounts,
  saveRegistry,
} from "./registry";
import {
  AccountMapping,
  AutoSwitchRunResult,
  ParsedAuthSnapshot,
  RegistryData,
  StatusReport,
  UsageSnapshot,
  AccountRegistryEntry,
} from "./types";
import {
  fetchUsageFromApi,
  fetchUsageFromLocal,
  fetchUsageFromProxy,
  ProxyUsageIndex,
  remainingPercent,
  resolveRateWindow,
  shouldSwitchCurrent,
  usageScore,
} from "./usage";
import {
  disableManagedService,
  enableManagedService,
  getManagedServiceState,
} from "./service-manager";

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._@+-]*$/;
const EXTERNAL_SYNC_FORCE_ENV = "CODEX_AUTH_FORCE_EXTERNAL_SYNC";
const SESSION_KEY_ENV = "CODEX_AUTH_SESSION_KEY";
const SESSION_ACTIVE_OVERRIDE_ENV = "CODEX_AUTH_SESSION_ACTIVE_OVERRIDE";
const LIST_USAGE_REFRESH_CONCURRENCY = 6;

interface SessionMapEntry {
  accountName: string;
  authFingerprint?: string;
  updatedAt: string;
}

interface SessionMapData {
  version: 1;
  sessions: Record<string, SessionMapEntry>;
}

export interface AccountChoice {
  name: string;
  email?: string;
  active: boolean;
}

export interface ListAccountMappingsOptions {
  refreshUsage?: "never" | "missing" | "always";
}

export interface RemoveResult {
  removed: string[];
  activated?: string;
}

export interface SaveAccountOptions {
  force?: boolean;
}

type ResolvedAccountNameSource = "active" | "existing" | "inferred";

export interface ResolvedDefaultAccountName {
  name: string;
  source: ResolvedAccountNameSource;
  forceOverwrite?: boolean;
}

export interface ResolvedLoginAccountName {
  name: string;
  source: ResolvedAccountNameSource;
  forceOverwrite?: boolean;
}

export interface ExternalAuthSyncResult {
  synchronized: boolean;
  savedName?: string;
  autoSwitchDisabled: boolean;
}

export class AccountService {
  public async syncExternalAuthSnapshotIfNeeded(): Promise<ExternalAuthSyncResult> {
    const authPath = resolveAuthPath();
    if (!(await this.pathExists(authPath))) {
      return {
        synchronized: false,
        autoSwitchDisabled: false,
      };
    }

    const initialAuthState = await this.readAuthSyncState(authPath);
    const externalSyncForced = this.isExternalSyncForced();
    if (
      initialAuthState &&
      !initialAuthState.isSymbolicLink &&
      !externalSyncForced &&
      (await this.getSessionAuthFingerprint()) === initialAuthState.fingerprint &&
      (await this.sessionSnapshotExists())
    ) {
      return {
        synchronized: false,
        autoSwitchDisabled: false,
      };
    }

    await this.materializeAuthSymlink(authPath);
    const rememberAuthState = async (result: ExternalAuthSyncResult): Promise<ExternalAuthSyncResult> => {
      await this.rememberSessionAuthFingerprint(authPath);
      return result;
    };

    const incomingSnapshot = await parseAuthSnapshotFile(authPath);
    if (incomingSnapshot.authMode !== "chatgpt") {
      return rememberAuthState({
        synchronized: false,
        autoSwitchDisabled: false,
      });
    }

    const sessionAccountName = await this.getActiveSessionAccountName();
    if (sessionAccountName) {
      const sessionSnapshotPath = this.accountFilePath(sessionAccountName);
      if (await this.pathExists(sessionSnapshotPath)) {
        const sessionSnapshot = await parseAuthSnapshotFile(sessionSnapshotPath);
        if (
          sessionSnapshot.authMode === "chatgpt" &&
          !this.snapshotsShareIdentity(sessionSnapshot, incomingSnapshot) &&
          !externalSyncForced
        ) {
          return rememberAuthState({
            synchronized: false,
            autoSwitchDisabled: false,
          });
        }
      }
    }

    const activeName = await this.getCurrentAccountName();
    const resolvedName = await this.resolveLoginAccountNameForSnapshot(incomingSnapshot, activeName);
    const resolvedSnapshotPath = this.accountFilePath(resolvedName.name);
    if (
      activeName === resolvedName.name &&
      (await this.pathExists(resolvedSnapshotPath)) &&
      (await this.filesMatch(authPath, resolvedSnapshotPath))
    ) {
      return rememberAuthState({
        synchronized: false,
        autoSwitchDisabled: false,
      });
    }

    const status = await this.getStatus();
    const sameActiveAccountRefresh = activeName === resolvedName.name && resolvedName.source === "active";
    const autoSwitchDisabled = status.autoSwitchEnabled && !sameActiveAccountRefresh;
    if (autoSwitchDisabled) {
      await this.setAutoSwitchEnabled(false);
    }

    const savedName = await this.saveAccount(resolvedName.name, {
      force: Boolean(resolvedName.forceOverwrite),
    });

    return rememberAuthState({
      synchronized: true,
      savedName,
      autoSwitchDisabled,
    });
  }

  public async restoreSessionSnapshotIfNeeded(): Promise<{ restored: boolean; accountName?: string }> {
    const sessionAccountName = await this.getActiveSessionAccountName();
    if (!sessionAccountName) {
      return { restored: false };
    }

    const snapshotPath = this.accountFilePath(sessionAccountName);
    if (!(await this.pathExists(snapshotPath))) {
      await this.clearSessionAccountName();
      return { restored: false };
    }

    const authPath = resolveAuthPath();
    if (await this.pathExists(authPath)) {
      await this.materializeAuthSymlink(authPath);
      const [sessionSnapshot, activeSnapshot] = await Promise.all([
        parseAuthSnapshotFile(snapshotPath),
        parseAuthSnapshotFile(authPath),
      ]);
      if (this.snapshotsShareIdentity(sessionSnapshot, activeSnapshot)) {
        return {
          restored: false,
          accountName: sessionAccountName,
        };
      }
    }

    await this.activateSnapshot(sessionAccountName);
    return {
      restored: true,
      accountName: sessionAccountName,
    };
  }

  public async listAccountNames(): Promise<string[]> {
    const accountsDir = resolveAccountsDir();
    if (!(await this.pathExists(accountsDir))) {
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
          entry.name !== sessionMapBasename,
      )
      .map((entry) => entry.name.replace(/\.json$/i, ""))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  public async listAccountChoices(): Promise<AccountChoice[]> {
    const [accounts, current, registry] = await Promise.all([
      this.listAccountNames(),
      this.getCurrentAccountName(),
      this.loadReconciledRegistry(),
    ]);

    return accounts.map((name) => ({
      name,
      email: registry.accounts[name]?.email,
      active: current === name,
    }));
  }

  public async listAccountMappings(options?: ListAccountMappingsOptions): Promise<AccountMapping[]> {
    const [accounts, current, registry] = await Promise.all([
      this.listAccountNames(),
      this.getCurrentAccountName(),
      this.loadReconciledRegistry(),
    ]);
    const nowSeconds = Math.floor(Date.now() / 1000);
    await this.refreshListUsageIfNeeded(
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
          fallbackSnapshot = await parseAuthSnapshotFile(this.accountFilePath(name));
        }

        const remaining5hPercent = remainingPercent(resolveRateWindow(entry?.lastUsage, 300, true), nowSeconds);
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
          lastUsageAt: entry?.lastUsageAt,
          usageSource: entry?.lastUsage?.source,
          remaining5hPercent,
          remainingWeeklyPercent,
        };
      }),
    );
  }

  public async findMatchingAccounts(query: string): Promise<AccountChoice[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];

    const choices = await this.listAccountChoices();
    const registry = await this.loadReconciledRegistry();
    return choices.filter((choice) => {
      if (choice.name.toLowerCase().includes(normalized)) return true;
      if (choice.email && choice.email.toLowerCase().includes(normalized)) return true;
      const meta = registry.accounts[choice.name];
      if (meta?.accountId?.toLowerCase().includes(normalized)) return true;
      if (meta?.userId?.toLowerCase().includes(normalized)) return true;
      return false;
    });
  }

  public async getCurrentAccountName(): Promise<string | null> {
    const sessionAccountName = await this.getActiveSessionAccountName();
    if (sessionAccountName) {
      const sessionSnapshotPath = this.accountFilePath(sessionAccountName);
      if (await this.pathExists(sessionSnapshotPath)) {
        return sessionAccountName;
      }

      await this.clearSessionAccountName();
    }

    const currentNamePath = resolveCurrentNamePath();
    const currentName = await this.readCurrentNameFile(currentNamePath);
    if (currentName) {
      await this.setSessionAccountName(currentName);
      return currentName;
    }

    const authPath = resolveAuthPath();
    if (!(await this.pathExists(authPath))) return null;

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
    await this.setSessionAccountName(resolvedName);
    return resolvedName;
  }

  public async saveAccount(rawName: string, options?: SaveAccountOptions): Promise<string> {
    const name = this.normalizeAccountName(rawName);
    const authPath = resolveAuthPath();
    const accountsDir = resolveAccountsDir();

    await this.ensureAuthFileExists(authPath);
    await this.ensureDir(accountsDir);
    const destination = this.accountFilePath(name);
    await this.assertSafeSnapshotOverwrite({
      authPath,
      destinationPath: destination,
      accountName: name,
      force: Boolean(options?.force),
    });
    await fsp.copyFile(authPath, destination);

    await this.writeCurrentName(name);

    const registry = await this.loadReconciledRegistry();
    await this.hydrateSnapshotMetadata(registry, name);
    registry.activeAccountName = name;
    await this.persistRegistry(registry);

    return name;
  }

  public async inferAccountNameFromCurrentAuth(): Promise<string> {
    const authPath = resolveAuthPath();
    await this.ensureAuthFileExists(authPath);

    const parsed = await parseAuthSnapshotFile(authPath);
    const email = parsed.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw new AccountNameInferenceError();
    }

    const baseCandidate = this.normalizeAccountName(email);
    const uniqueName = await this.resolveUniqueInferredName(baseCandidate, parsed);
    return uniqueName;
  }

  public async resolveDefaultAccountNameFromCurrentAuth(): Promise<ResolvedDefaultAccountName> {
    const authPath = resolveAuthPath();
    await this.ensureAuthFileExists(authPath);
    const incomingSnapshot = await parseAuthSnapshotFile(authPath);
    const activeName = await this.getCurrentAccountName();
    const existing = await this.resolveExistingAccountNameForIncomingSnapshot(incomingSnapshot, activeName);
    if (existing) return existing;

    return {
      name: await this.inferAccountNameFromSnapshot(incomingSnapshot),
      source: "inferred",
    };
  }

  public async resolveLoginAccountNameFromCurrentAuth(): Promise<ResolvedLoginAccountName> {
    const authPath = resolveAuthPath();
    await this.ensureAuthFileExists(authPath);
    const incomingSnapshot = await parseAuthSnapshotFile(authPath);
    const activeName = await this.getCurrentAccountName();
    return this.resolveLoginAccountNameForSnapshot(incomingSnapshot, activeName);
  }

  public async useAccount(rawName: string): Promise<string> {
    const name = this.normalizeAccountName(rawName);
    const resolvedName = await this.resolveUsableAccountName(name);
    await this.activateSnapshot(resolvedName);

    const registry = await loadRegistry();
    await this.hydrateSnapshotMetadataIfMissing(registry, resolvedName);
    registry.activeAccountName = resolvedName;
    await saveRegistry(registry);

    return resolvedName;
  }

  public async removeAccounts(accountNames: string[]): Promise<RemoveResult> {
    const uniqueNames = [...new Set(accountNames.map((name) => this.normalizeAccountName(name)))];
    if (uniqueNames.length === 0) {
      return { removed: [] };
    }

    const current = await this.getCurrentAccountName();
    const registry = await this.loadReconciledRegistry();
    const removed: string[] = [];

    for (const name of uniqueNames) {
      const snapshotPath = this.accountFilePath(name);
      if (!(await this.pathExists(snapshotPath))) {
        throw new AccountNotFoundError(name);
      }

      await fsp.rm(snapshotPath, { force: true });
      delete registry.accounts[name];
      removed.push(name);
    }

    const removedSet = new Set(removed);
    let activated: string | undefined;

    if (current && removedSet.has(current)) {
      const remaining = (await this.listAccountNames()).filter((name) => !removedSet.has(name));
      if (remaining.length > 0) {
        const best = this.selectBestCandidateFromRegistry(remaining, registry);
        await this.activateSnapshot(best);
        activated = best;
        registry.activeAccountName = best;
      } else {
        await this.clearActivePointers();
        delete registry.activeAccountName;
      }
    } else if (registry.activeAccountName && removedSet.has(registry.activeAccountName)) {
      delete registry.activeAccountName;
    }

    await this.persistRegistry(registry);
    return {
      removed,
      activated,
    };
  }

  public async removeByQuery(query: string): Promise<RemoveResult> {
    const matches = await this.findMatchingAccounts(query);
    if (matches.length === 0) {
      throw new AccountNotFoundError(query);
    }
    if (matches.length > 1) {
      throw new AmbiguousAccountQueryError(query);
    }

    return this.removeAccounts([matches[0].name]);
  }

  public async removeAllAccounts(): Promise<RemoveResult> {
    const all = await this.listAccountNames();
    return this.removeAccounts(all);
  }

  public async getStatus(): Promise<StatusReport> {
    const registry = await this.loadReconciledRegistry();
    return {
      autoSwitchEnabled: registry.autoSwitch.enabled,
      serviceState: getManagedServiceState(),
      threshold5hPercent: registry.autoSwitch.threshold5hPercent,
      thresholdWeeklyPercent: registry.autoSwitch.thresholdWeeklyPercent,
      usageMode: registry.api.usage ? "api" : "local",
    };
  }

  public async setAutoSwitchEnabled(enabled: boolean): Promise<StatusReport> {
    const registry = await this.loadReconciledRegistry();
    registry.autoSwitch.enabled = enabled;

    if (enabled) {
      try {
        await enableManagedService();
      } catch (error) {
        registry.autoSwitch.enabled = false;
        await this.persistRegistry(registry);
        throw new AutoSwitchConfigError(
          `Failed to enable managed auto-switch service: ${(error as Error).message}`,
        );
      }
    } else {
      await disableManagedService();
    }

    await this.persistRegistry(registry);
    return this.getStatus();
  }

  public async setApiUsageEnabled(enabled: boolean): Promise<StatusReport> {
    const registry = await this.loadReconciledRegistry();
    registry.api.usage = enabled;
    await this.persistRegistry(registry);
    return this.getStatus();
  }

  public async configureAutoSwitchThresholds(input: {
    threshold5hPercent?: number;
    thresholdWeeklyPercent?: number;
  }): Promise<StatusReport> {
    const registry = await this.loadReconciledRegistry();

    if (typeof input.threshold5hPercent === "number") {
      if (!this.isValidPercent(input.threshold5hPercent)) {
        throw new AutoSwitchConfigError("`--5h` must be an integer from 1 to 100.");
      }
      registry.autoSwitch.threshold5hPercent = Math.round(input.threshold5hPercent);
    }

    if (typeof input.thresholdWeeklyPercent === "number") {
      if (!this.isValidPercent(input.thresholdWeeklyPercent)) {
        throw new AutoSwitchConfigError("`--weekly` must be an integer from 1 to 100.");
      }
      registry.autoSwitch.thresholdWeeklyPercent = Math.round(input.thresholdWeeklyPercent);
    }

    await this.persistRegistry(registry);
    return this.getStatus();
  }

  public async runAutoSwitchOnce(): Promise<AutoSwitchRunResult> {
    const registry = await this.loadReconciledRegistry();
    if (!registry.autoSwitch.enabled) {
      return { switched: false, reason: "auto-switch is disabled" };
    }

    const accountNames = await this.listAccountNames();
    if (accountNames.length === 0) {
      return { switched: false, reason: "no saved accounts" };
    }

    const active = (await this.getCurrentAccountName()) ?? registry.activeAccountName;
    if (!active || !accountNames.includes(active)) {
      return { switched: false, reason: "no active account" };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    const activeUsage = await this.refreshAccountUsage(registry, active, {
      preferApi: registry.api.usage,
      allowLocalFallback: true,
    });

    if (!shouldSwitchCurrent(activeUsage, {
      threshold5hPercent: registry.autoSwitch.threshold5hPercent,
      thresholdWeeklyPercent: registry.autoSwitch.thresholdWeeklyPercent,
    }, nowSeconds)) {
      await this.persistRegistry(registry);
      return { switched: false, reason: "active account is above configured thresholds" };
    }

    const currentScore = usageScore(activeUsage, nowSeconds) ?? 0;

    let bestCandidate: string | undefined;
    let bestScore = currentScore;

    for (const candidate of accountNames) {
      if (candidate === active) continue;

      const usage = await this.refreshAccountUsage(registry, candidate, {
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
      await this.persistRegistry(registry);
      return {
        switched: false,
        reason: "no candidate has better remaining quota",
      };
    }

    await this.activateSnapshot(bestCandidate);
    registry.activeAccountName = bestCandidate;
    await this.hydrateSnapshotMetadata(registry, bestCandidate);
    await this.persistRegistry(registry);

    return {
      switched: true,
      fromAccount: active,
      toAccount: bestCandidate,
      reason: "switched due to low credits on active account",
    };
  }

  public async runDaemon(mode: "once" | "watch"): Promise<void> {
    if (mode === "once") {
      await this.runAutoSwitchOnce();
      return;
    }

    for (;;) {
      try {
        await this.runAutoSwitchOnce();
      } catch {
        // keep daemon alive
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }

  private selectBestCandidateFromRegistry(candidates: string[], registry: RegistryData): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    let best = candidates[0];
    let bestScore = usageScore(registry.accounts[best]?.lastUsage, nowSeconds) ?? -1;

    for (const candidate of candidates.slice(1)) {
      const score = usageScore(registry.accounts[candidate]?.lastUsage, nowSeconds) ?? -1;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  private async refreshAccountUsage(
    registry: RegistryData,
    accountName: string,
    options: { preferApi: boolean; allowLocalFallback: boolean; proxyUsageIndex?: ProxyUsageIndex | null },
  ): Promise<UsageSnapshot | undefined> {
    const snapshotPath = this.accountFilePath(accountName);
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
      usage = this.resolveProxyUsage(options.proxyUsageIndex, accountName, entry, parsed);
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

  private async refreshListUsageIfNeeded(
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

      return this.isUsageMissingForList(registry.accounts[accountName]?.lastUsage, nowSeconds);
    });

    if (accountNamesToRefresh.length === 0) {
      return;
    }

    let index = 0;
    const workerCount = Math.min(LIST_USAGE_REFRESH_CONCURRENCY, accountNamesToRefresh.length);
    const proxyUsageIndex = registry.api.usage
      ? await fetchUsageFromProxy()
      : null;
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const accountName = accountNamesToRefresh[index];
          index += 1;
          if (!accountName) {
            return;
          }

          await this.refreshAccountUsage(registry, accountName, {
            preferApi: registry.api.usage,
            allowLocalFallback: currentAccountName === accountName,
            proxyUsageIndex,
          });
        }
      }),
    );

    await this.persistRegistry(registry);
  }

  private isUsageMissingForList(usage: UsageSnapshot | undefined, nowSeconds: number): boolean {
    const remaining5hPercent = remainingPercent(resolveRateWindow(usage, 300, true), nowSeconds);
    const remainingWeeklyPercent = remainingPercent(resolveRateWindow(usage, 10080, false), nowSeconds);
    return typeof remaining5hPercent !== "number" || typeof remainingWeeklyPercent !== "number";
  }

  private resolveProxyUsage(
    proxyUsageIndex: ProxyUsageIndex | null | undefined,
    accountName: string,
    entry: RegistryData["accounts"][string],
    parsed: ParsedAuthSnapshot,
  ): UsageSnapshot | null {
    if (!proxyUsageIndex) {
      return null;
    }

    const candidates = [
      parsed.accountId,
      entry.accountId,
    ];
    for (const candidate of candidates) {
      const usage = this.lookupProxyUsage(proxyUsageIndex.byAccountId, candidate);
      if (usage) {
        return usage;
      }
    }

    const emailCandidates = [
      parsed.email,
      entry.email,
    ];
    for (const candidate of emailCandidates) {
      const usage = this.lookupProxyUsage(proxyUsageIndex.byEmail, candidate);
      if (usage) {
        return usage;
      }
    }

    return this.lookupProxyUsage(proxyUsageIndex.bySnapshotName, accountName);
  }

  private lookupProxyUsage(map: Map<string, UsageSnapshot>, rawValue: string | undefined): UsageSnapshot | null {
    if (!rawValue) {
      return null;
    }

    const normalized = rawValue.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    return map.get(normalized) ?? null;
  }

  private accountFilePath(name: string): string {
    return path.join(resolveAccountsDir(), `${name}.json`);
  }

  private normalizeAccountName(rawName: string | undefined): string {
    if (typeof rawName !== "string") {
      throw new InvalidAccountNameError();
    }

    const trimmed = rawName.trim();
    if (!trimmed.length) {
      throw new InvalidAccountNameError();
    }

    const withoutExtension = trimmed.replace(/\.json$/i, "");
    if (!ACCOUNT_NAME_PATTERN.test(withoutExtension)) {
      throw new InvalidAccountNameError();
    }

    return withoutExtension;
  }

  private isValidPercent(value: number): boolean {
    return Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value <= 100;
  }

  private async ensureAuthFileExists(authPath: string): Promise<void> {
    if (!(await this.pathExists(authPath))) {
      throw new AuthFileMissingError(authPath);
    }
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fsp.mkdir(dirPath, { recursive: true });
  }

  private async materializeAuthSymlink(authPath: string): Promise<void> {
    const stat = await fsp.lstat(authPath);
    if (!stat.isSymbolicLink()) {
      return;
    }

    const snapshotData = await fsp.readFile(authPath);
    await this.removeIfExists(authPath);
    await fsp.writeFile(authPath, snapshotData);
  }

  private async assertSafeSnapshotOverwrite(input: {
    authPath: string;
    destinationPath: string;
    accountName: string;
    force: boolean;
  }): Promise<void> {
    if (input.force || !(await this.pathExists(input.destinationPath))) {
      return;
    }

    const [existingSnapshot, incomingSnapshot] = await Promise.all([
      parseAuthSnapshotFile(input.destinationPath),
      parseAuthSnapshotFile(input.authPath),
    ]);

    const existingEmail = existingSnapshot.email?.trim().toLowerCase();
    const incomingEmail = incomingSnapshot.email?.trim().toLowerCase();

    if (existingEmail && incomingEmail && existingEmail !== incomingEmail) {
      throw new SnapshotEmailMismatchError(input.accountName, existingEmail, incomingEmail);
    }

    if (this.snapshotsShareIdentity(existingSnapshot, incomingSnapshot)) return;

    if (!existingEmail || !incomingEmail) return;

    const existingIdentity = this.renderSnapshotIdentity(existingSnapshot, existingEmail);
    const incomingIdentity = this.renderSnapshotIdentity(incomingSnapshot, incomingEmail);
    throw new SnapshotEmailMismatchError(input.accountName, existingIdentity, incomingIdentity);
  }

  private async removeIfExists(target: string): Promise<void> {
    try {
      await fsp.rm(target, { force: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async writeCurrentName(name: string, options?: { authFingerprint?: string }): Promise<void> {
    const currentNamePath = resolveCurrentNamePath();
    await this.ensureDir(path.dirname(currentNamePath));
    await fsp.writeFile(currentNamePath, `${name}\n`, "utf8");
    await this.setSessionAccountName(name, options?.authFingerprint);
  }

  private async readCurrentNameFile(currentNamePath: string): Promise<string | null> {
    try {
      const contents = await fsp.readFile(currentNamePath, "utf8");
      const trimmed = contents.trim();
      return trimmed.length ? trimmed : null;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fsp.access(targetPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async filesMatch(firstPath: string, secondPath: string): Promise<boolean> {
    try {
      const [first, second] = await Promise.all([fsp.readFile(firstPath), fsp.readFile(secondPath)]);
      return first.equals(second);
    } catch {
      return false;
    }
  }

  private async readAuthSyncState(authPath: string): Promise<{ fingerprint: string; isSymbolicLink: boolean } | null> {
    try {
      const stat = await fsp.lstat(authPath);
      return {
        fingerprint: this.createAuthSyncFingerprint(stat),
        isSymbolicLink: stat.isSymbolicLink(),
      };
    } catch {
      return null;
    }
  }

  private createAuthSyncFingerprint(stat: fs.Stats): string {
    return [
      stat.isSymbolicLink() ? "symlink" : "file",
      typeof stat.ino === "number" ? Math.trunc(stat.ino) : 0,
      Math.trunc(stat.size),
      Math.trunc(stat.mtimeMs),
    ].join(":");
  }

  private async hydrateSnapshotMetadata(registry: RegistryData, accountName: string): Promise<void> {
    const parsed = await parseAuthSnapshotFile(this.accountFilePath(accountName));
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

  private async hydrateSnapshotMetadataIfMissing(registry: RegistryData, accountName: string): Promise<void> {
    const entry = registry.accounts[accountName];
    if (entry?.email && entry.accountId && entry.userId && entry.planType) {
      return;
    }

    await this.hydrateSnapshotMetadata(registry, accountName);
  }

  private async resolveLoginAccountNameForSnapshot(
    incomingSnapshot: ParsedAuthSnapshot,
    activeName: string | null,
  ): Promise<ResolvedLoginAccountName> {
    const existing = await this.resolveExistingAccountNameForIncomingSnapshot(incomingSnapshot, activeName);
    if (existing) return existing;

    return {
      name: await this.inferAccountNameFromSnapshot(incomingSnapshot),
      source: "inferred",
    };
  }

  private async resolveExistingAccountNameForIncomingSnapshot(
    incomingSnapshot: ParsedAuthSnapshot,
    activeName: string | null,
  ): Promise<ResolvedDefaultAccountName | null> {
    let emailMatch: ResolvedDefaultAccountName | null = null;
    const accountNames = await this.listAccountNames();
    const candidates = this.orderReloginSnapshotCandidates(accountNames, incomingSnapshot, activeName);
    const registryMatch = await this.resolveRegistryAccountNameForIncomingSnapshot(
      incomingSnapshot,
      candidates,
      activeName,
    );
    if (registryMatch) {
      return registryMatch;
    }

    for (const name of candidates) {
      const snapshotPath = this.accountFilePath(name);
      if (!(await this.pathExists(snapshotPath))) continue;

      const existingSnapshot = await parseAuthSnapshotFile(snapshotPath);
      if (this.snapshotsShareIdentity(existingSnapshot, incomingSnapshot)) {
        return {
          name,
          source: activeName === name ? "active" : "existing",
        };
      }

      if (!emailMatch && this.snapshotsShareEmail(existingSnapshot, incomingSnapshot)) {
        emailMatch = {
          name,
          source: activeName === name ? "active" : "existing",
          forceOverwrite: true,
        };
      }
    }

    return emailMatch;
  }

  private async resolveRegistryAccountNameForIncomingSnapshot(
    incomingSnapshot: ParsedAuthSnapshot,
    candidates: string[],
    activeName: string | null,
  ): Promise<ResolvedDefaultAccountName | null> {
    const registry = await loadRegistry();
    let activeEmailMatch: ResolvedDefaultAccountName | null = null;

    for (const name of candidates) {
      const entry = registry.accounts[name];
      if (!entry || !(await this.pathExists(this.accountFilePath(name)))) continue;

      if (this.registryEntrySharesIdentity(entry, incomingSnapshot)) {
        return {
          name,
          source: activeName === name ? "active" : "existing",
        };
      }

      if (
        !activeEmailMatch &&
        this.registryEntrySharesEmail(entry, incomingSnapshot)
      ) {
        activeEmailMatch = {
          name,
          source: activeName === name ? "active" : "existing",
          forceOverwrite: true,
        };
      }
    }

    return activeEmailMatch;
  }

  private orderReloginSnapshotCandidates(
    accountNames: string[],
    incomingSnapshot: ParsedAuthSnapshot,
    activeName: string | null,
  ): string[] {
    const ordered: string[] = [];
    const add = (name: string | null | undefined): void => {
      if (!name || !accountNames.includes(name) || ordered.includes(name)) return;
      ordered.push(name);
    };

    add(activeName);

    const incomingEmail = incomingSnapshot.email?.trim().toLowerCase();
    if (incomingEmail) {
      try {
        add(this.normalizeAccountName(incomingEmail));
      } catch {
        // Invalid email-shaped snapshot names fall through to identity scan.
      }
    }

    for (const name of accountNames) {
      add(name);
    }

    return ordered;
  }

  private async resolveUniqueInferredName(
    baseName: string,
    incomingSnapshot: ParsedAuthSnapshot,
  ): Promise<string> {
    const accountPathFor = (name: string): string => this.accountFilePath(name);
    const hasMatchingIdentity = async (name: string): Promise<boolean> => {
      const parsed = await parseAuthSnapshotFile(accountPathFor(name));
      return this.snapshotsShareIdentity(parsed, incomingSnapshot);
    };

    const basePath = accountPathFor(baseName);
    if (!(await this.pathExists(basePath))) {
      return baseName;
    }
    if (await hasMatchingIdentity(baseName)) {
      return baseName;
    }

    for (let i = 2; i <= 99; i += 1) {
      const candidate = this.normalizeAccountName(`${baseName}--dup-${i}`);
      const candidatePath = accountPathFor(candidate);
      if (!(await this.pathExists(candidatePath))) {
        return candidate;
      }
      if (await hasMatchingIdentity(candidate)) {
        return candidate;
      }
    }

    throw new AccountNameInferenceError();
  }

  private async inferAccountNameFromSnapshot(incomingSnapshot: ParsedAuthSnapshot): Promise<string> {
    const email = incomingSnapshot.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw new AccountNameInferenceError();
    }

    const baseCandidate = this.normalizeAccountName(email);
    return this.resolveUniqueInferredName(baseCandidate, incomingSnapshot);
  }

  private async loadReconciledRegistry(): Promise<RegistryData> {
    const accountNames = await this.listAccountNames();
    const loaded = await loadRegistry();
    const base = loaded.version === 1 ? loaded : createDefaultRegistry();
    return reconcileRegistryWithAccounts(base, accountNames);
  }

  private async persistRegistry(registry: RegistryData): Promise<void> {
    const reconciled = reconcileRegistryWithAccounts(registry, await this.listAccountNames());
    await saveRegistry(reconciled);
  }

  private async activateSnapshot(accountName: string): Promise<void> {
    const name = this.normalizeAccountName(accountName);
    const source = this.accountFilePath(name);

    if (!(await this.pathExists(source))) {
      throw new AccountNotFoundError(name);
    }

    const authPath = resolveAuthPath();
    await this.ensureDir(path.dirname(authPath));
    await fsp.copyFile(source, authPath);

    const authState = await this.readAuthSyncState(authPath);
    await this.writeCurrentName(name, {
      authFingerprint: authState && !authState.isSymbolicLink ? authState.fingerprint : undefined,
    });
  }

  private async resolveUsableAccountName(accountName: string): Promise<string> {
    if (await this.pathExists(this.accountFilePath(accountName))) {
      return accountName;
    }

    await this.syncExternalAuthSnapshotIfNeeded();

    if (await this.pathExists(this.accountFilePath(accountName))) {
      return accountName;
    }

    const emailMatches = await this.findSnapshotNamesByExactEmail(accountName);
    if (emailMatches.length === 1) {
      return emailMatches[0];
    }
    if (emailMatches.length > 1) {
      throw new AmbiguousAccountQueryError(accountName);
    }

    throw new AccountNotFoundError(accountName);
  }

  private async findSnapshotNamesByExactEmail(rawEmail: string): Promise<string[]> {
    const normalizedEmail = rawEmail.trim().toLowerCase();
    if (!normalizedEmail.includes("@")) {
      return [];
    }

    const accountNames = await this.listAccountNames();
    const matches: string[] = [];
    for (const name of accountNames) {
      const snapshotPath = this.accountFilePath(name);
      try {
        const snapshot = await parseAuthSnapshotFile(snapshotPath);
        if (snapshot.email?.trim().toLowerCase() === normalizedEmail) {
          matches.push(name);
        }
      } catch {
        // Ignore unreadable snapshots here so the existing not-found path
        // remains actionable for the requested email.
      }
    }
    return matches.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  private async sessionSnapshotExists(): Promise<boolean> {
    const sessionAccountName = await this.getSessionAccountName();
    if (!sessionAccountName) {
      return true;
    }
    return this.pathExists(this.accountFilePath(sessionAccountName));
  }

  private async clearActivePointers(): Promise<void> {
    const currentPath = resolveCurrentNamePath();
    const authPath = resolveAuthPath();
    await this.removeIfExists(currentPath);
    await this.removeIfExists(authPath);
    await this.clearSessionAccountName();
  }

  private isExternalSyncForced(): boolean {
    const raw = process.env[EXTERNAL_SYNC_FORCE_ENV];
    if (!raw) return false;
    const normalized = raw.trim().toLowerCase();
    if (!normalized) return false;
    return !["0", "false", "no", "off"].includes(normalized);
  }

  private resolveSessionScopeKey(): string | null {
    const explicit = process.env[SESSION_KEY_ENV]?.trim();
    if (explicit) {
      const sanitized = explicit.replace(/\s+/g, " ").slice(0, 160);
      return `session:${sanitized}`;
    }

    if (typeof process.ppid === "number" && process.ppid > 1) {
      return `ppid:${process.ppid}`;
    }

    return null;
  }

  private async getSessionAccountName(): Promise<string | null> {
    const sessionKey = this.resolveSessionScopeKey();
    if (!sessionKey) return null;

    const sessionMap = await this.readSessionMap();
    const entry = sessionMap.sessions[sessionKey];
    if (!entry?.accountName) return null;

    try {
      return this.normalizeAccountName(entry.accountName);
    } catch {
      return null;
    }
  }

  private async getSessionAuthFingerprint(): Promise<string | null> {
    const sessionKey = this.resolveSessionScopeKey();
    if (!sessionKey) return null;

    const sessionMap = await this.readSessionMap();
    const entry = sessionMap.sessions[sessionKey];
    if (!entry?.authFingerprint || typeof entry.authFingerprint !== "string") {
      return null;
    }

    return entry.authFingerprint.trim() || null;
  }

  private async getActiveSessionAccountName(): Promise<string | null> {
    const sessionAccountName = await this.getSessionAccountName();
    if (!sessionAccountName) return null;

    const sessionIsActive = await this.isSessionPinnedToActiveCodex();
    if (sessionIsActive) return sessionAccountName;

    await this.clearSessionAccountName();
    return null;
  }

  private async setSessionAccountName(accountName: string, authFingerprint?: string): Promise<void> {
    const sessionKey = this.resolveSessionScopeKey();
    if (!sessionKey) return;

    const sessionMap = await this.readSessionMap();
    const existing = sessionMap.sessions[sessionKey];
    sessionMap.sessions[sessionKey] = {
      accountName,
      authFingerprint: authFingerprint ?? existing?.authFingerprint,
      updatedAt: new Date().toISOString(),
    };
    await this.writeSessionMap(sessionMap);
  }

  private async clearSessionAccountName(): Promise<void> {
    const sessionKey = this.resolveSessionScopeKey();
    if (!sessionKey) return;

    const sessionMap = await this.readSessionMap();
    if (!sessionMap.sessions[sessionKey]) return;
    delete sessionMap.sessions[sessionKey];
    await this.writeSessionMap(sessionMap);
  }

  private async readSessionMap(): Promise<SessionMapData> {
    const sessionMapPath = resolveSessionMapPath();
    try {
      const raw = await fsp.readFile(sessionMapPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return {
          version: 1,
          sessions: {},
        };
      }

      const root = parsed as Record<string, unknown>;
      const sessionsRaw = root.sessions && typeof root.sessions === "object"
        ? (root.sessions as Record<string, unknown>)
        : {};
      const sessions: Record<string, SessionMapEntry> = {};

      for (const [key, value] of Object.entries(sessionsRaw)) {
        if (!value || typeof value !== "object") continue;
        const rawEntry = value as Record<string, unknown>;
        const accountName = typeof rawEntry.accountName === "string" ? rawEntry.accountName.trim() : "";
        if (!accountName) continue;
        const authFingerprint =
          typeof rawEntry.authFingerprint === "string" && rawEntry.authFingerprint.trim().length > 0
            ? rawEntry.authFingerprint.trim()
            : undefined;
        sessions[key] = {
          accountName,
          authFingerprint,
          updatedAt:
            typeof rawEntry.updatedAt === "string" && rawEntry.updatedAt.length > 0
              ? rawEntry.updatedAt
              : new Date().toISOString(),
        };
      }

      return {
        version: 1,
        sessions,
      };
    } catch {
      return {
        version: 1,
        sessions: {},
      };
    }
  }

  private async writeSessionMap(sessionMap: SessionMapData): Promise<void> {
    const sessionMapPath = resolveSessionMapPath();
    await this.ensureDir(path.dirname(sessionMapPath));
    await fsp.writeFile(sessionMapPath, `${JSON.stringify(sessionMap, null, 2)}\n`, "utf8");
  }

  private async rememberSessionAuthFingerprint(authPath: string): Promise<void> {
    const sessionKey = this.resolveSessionScopeKey();
    if (!sessionKey) return;

    const authState = await this.readAuthSyncState(authPath);
    if (!authState || authState.isSymbolicLink) return;

    const sessionMap = await this.readSessionMap();
    const existing = sessionMap.sessions[sessionKey];
    if (!existing?.accountName || existing.authFingerprint === authState.fingerprint) {
      return;
    }

    sessionMap.sessions[sessionKey] = {
      ...existing,
      authFingerprint: authState.fingerprint,
      updatedAt: new Date().toISOString(),
    };
    await this.writeSessionMap(sessionMap);
  }

  private async isSessionPinnedToActiveCodex(): Promise<boolean> {
    const override = process.env[SESSION_ACTIVE_OVERRIDE_ENV]?.trim().toLowerCase();
    if (override) {
      if (["1", "true", "yes", "on"].includes(override)) return true;
      if (["0", "false", "no", "off"].includes(override)) return false;
    }

    const sessionKey = this.resolveSessionScopeKey();
    if (!sessionKey) return false;

    if (sessionKey.startsWith("session:")) {
      return true;
    }

    if (process.platform !== "linux") {
      return true;
    }

    const ppidMatch = sessionKey.match(/^ppid:(\d+)$/);
    if (!ppidMatch) return false;

    const parentPid = Number(ppidMatch[1]);
    if (!Number.isFinite(parentPid) || parentPid <= 1) return false;

    const childPids = await this.readChildPids(parentPid);
    if (childPids.length === 0) return false;

    for (const childPid of childPids) {
      if (await this.isCodexProcess(childPid)) {
        return true;
      }
    }

    return false;
  }

  private async readChildPids(parentPid: number): Promise<number[]> {
    try {
      const childrenRaw = await fsp.readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8");
      return childrenRaw
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 1);
    } catch {
      return [];
    }
  }

  private async isCodexProcess(pid: number): Promise<boolean> {
    try {
      const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, "utf8");
      const normalized = cmdline.replace(/\0/g, " ").trim();
      if (!normalized) return false;
      if (/\bcodex-auth\b/.test(normalized)) return false;
      if (/(^|\s|\/)codex(\s|$)/.test(normalized)) return true;
      if (/(^|\s|\/)codex-linux-[^\s]*($|\s)/.test(normalized)) return true;
      return false;
    } catch {
      return false;
    }
  }

  private snapshotsShareIdentity(a: ParsedAuthSnapshot, b: ParsedAuthSnapshot): boolean {
    if (a.authMode !== "chatgpt" || b.authMode !== "chatgpt") {
      return false;
    }

    if (a.userId && b.userId && a.accountId && b.accountId) {
      return a.userId === b.userId && a.accountId === b.accountId;
    }

    if (a.accountId && b.accountId) {
      return a.accountId === b.accountId;
    }

    if (a.userId && b.userId) {
      return a.userId === b.userId;
    }

    const aEmail = a.email?.trim().toLowerCase();
    const bEmail = b.email?.trim().toLowerCase();
    if (aEmail && bEmail) {
      return aEmail === bEmail;
    }

    return false;
  }

  private registryEntrySharesIdentity(entry: AccountRegistryEntry, snapshot: ParsedAuthSnapshot): boolean {
    if (snapshot.authMode !== "chatgpt") {
      return false;
    }

    if (entry.userId && snapshot.userId && entry.accountId && snapshot.accountId) {
      return entry.userId === snapshot.userId && entry.accountId === snapshot.accountId;
    }

    if (entry.accountId && snapshot.accountId) {
      return entry.accountId === snapshot.accountId;
    }

    if (entry.userId && snapshot.userId) {
      return entry.userId === snapshot.userId;
    }

    return this.registryEntrySharesEmail(entry, snapshot);
  }

  private registryEntrySharesEmail(entry: AccountRegistryEntry, snapshot: ParsedAuthSnapshot): boolean {
    const entryEmail = entry.email?.trim().toLowerCase();
    const snapshotEmail = snapshot.email?.trim().toLowerCase();
    return Boolean(entryEmail && snapshotEmail && entryEmail === snapshotEmail);
  }

  private snapshotsShareEmail(a: ParsedAuthSnapshot, b: ParsedAuthSnapshot): boolean {
    const aEmail = a.email?.trim().toLowerCase();
    const bEmail = b.email?.trim().toLowerCase();
    return Boolean(aEmail && bEmail && aEmail === bEmail);
  }

  private renderSnapshotIdentity(snapshot: ParsedAuthSnapshot, fallbackEmail: string): string {
    const parts = [fallbackEmail];
    if (snapshot.accountId) parts.push(`account:${snapshot.accountId}`);
    if (snapshot.userId) parts.push(`user:${snapshot.userId}`);
    return parts.join(" | ");
  }
}
