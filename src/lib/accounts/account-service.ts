// Thin orchestrator class. The 1,675-LOC god-file is gone; every method
// here delegates to one of the focused modules under `src/lib/accounts/`.
// See `docs/future/01-ARCHITECTURE.md` §2.1 for the cluster layout.
//
// Behavior is byte-identical to the pre-N2 implementation. Public method
// signatures must NOT change — the singleton `accountService` in
// `index.ts` and every `BaseCommand` subclass via `this.accounts` depend
// on them.

import {
  AccountMapping,
  AutoSwitchRunResult,
  StatusReport,
} from "./types";
import {
  AccountChoice,
  ListAccountMappingsOptions,
  findMatchingAccounts as findMatchingAccountsImpl,
  getCurrentAccountName as getCurrentAccountNameImpl,
  listAccountChoices as listAccountChoicesImpl,
  listAccountMappings as listAccountMappingsImpl,
  listAccountNames as listAccountNamesImpl,
} from "./read/listing";
import {
  ExternalAuthSyncResult,
  restoreSessionSnapshotIfNeeded as restoreSessionSnapshotIfNeededImpl,
  syncExternalAuthSnapshotIfNeeded as syncExternalAuthSnapshotIfNeededImpl,
} from "./sync/external-sync";
import {
  SaveAccountOptions,
  inferAccountNameFromCurrentAuth as inferAccountNameFromCurrentAuthImpl,
  resolveDefaultAccountNameFromCurrentAuth as resolveDefaultAccountNameFromCurrentAuthImpl,
  resolveLoginAccountNameFromCurrentAuth as resolveLoginAccountNameFromCurrentAuthImpl,
  saveAccount as saveAccountImpl,
} from "./write/save";
import {
  useAccount as useAccountImpl,
} from "./write/use";
import {
  RemoveResult,
  removeAccounts as removeAccountsImpl,
  removeAllAccounts as removeAllAccountsImpl,
  removeByQuery as removeByQueryImpl,
} from "./write/remove";
import {
  configureAutoSwitchThresholds as configureAutoSwitchThresholdsImpl,
  getStatus as getStatusImpl,
  setApiUsageEnabled as setApiUsageEnabledImpl,
  setAutoSwitchEnabled as setAutoSwitchEnabledImpl,
} from "./config/auto-switch-config";
import {
  runAutoSwitchOnce as runAutoSwitchOnceImpl,
  runDaemon as runDaemonImpl,
} from "./auto-switch/policy";
import { refreshListUsageIfNeeded } from "./usage/adapter";
import {
  ResolvedDefaultAccountName,
  ResolvedLoginAccountName,
} from "./_internal/name-resolution";

export type {
  AccountChoice,
  ListAccountMappingsOptions,
} from "./read/listing";
export type { RemoveResult } from "./write/remove";
export type { SaveAccountOptions } from "./write/save";
export type {
  ResolvedDefaultAccountName,
  ResolvedLoginAccountName,
} from "./_internal/name-resolution";
export type { ExternalAuthSyncResult } from "./sync/external-sync";

export class AccountService {
  public syncExternalAuthSnapshotIfNeeded(): Promise<ExternalAuthSyncResult> {
    return syncExternalAuthSnapshotIfNeededImpl();
  }

  public restoreSessionSnapshotIfNeeded(): Promise<{ restored: boolean; accountName?: string }> {
    return restoreSessionSnapshotIfNeededImpl();
  }

  public listAccountNames(): Promise<string[]> {
    return listAccountNamesImpl();
  }

  public listAccountChoices(): Promise<AccountChoice[]> {
    return listAccountChoicesImpl(() => this.getCurrentAccountName());
  }

  public listAccountMappings(options?: ListAccountMappingsOptions): Promise<AccountMapping[]> {
    return listAccountMappingsImpl(
      () => this.getCurrentAccountName(),
      refreshListUsageIfNeeded,
      options,
    );
  }

  public findMatchingAccounts(query: string): Promise<AccountChoice[]> {
    return findMatchingAccountsImpl(query, () => this.getCurrentAccountName());
  }

  public getCurrentAccountName(): Promise<string | null> {
    return getCurrentAccountNameImpl();
  }

  public saveAccount(rawName: string, options?: SaveAccountOptions): Promise<string> {
    return saveAccountImpl(rawName, options);
  }

  public inferAccountNameFromCurrentAuth(): Promise<string> {
    return inferAccountNameFromCurrentAuthImpl();
  }

  public resolveDefaultAccountNameFromCurrentAuth(): Promise<ResolvedDefaultAccountName> {
    return resolveDefaultAccountNameFromCurrentAuthImpl(() => this.getCurrentAccountName());
  }

  public resolveLoginAccountNameFromCurrentAuth(): Promise<ResolvedLoginAccountName> {
    return resolveLoginAccountNameFromCurrentAuthImpl(() => this.getCurrentAccountName());
  }

  public useAccount(rawName: string): Promise<string> {
    return useAccountImpl(rawName, () => this.syncExternalAuthSnapshotIfNeeded());
  }

  public removeAccounts(accountNames: string[]): Promise<RemoveResult> {
    return removeAccountsImpl(accountNames, () => this.getCurrentAccountName());
  }

  public removeByQuery(query: string): Promise<RemoveResult> {
    return removeByQueryImpl(query, () => this.getCurrentAccountName());
  }

  public removeAllAccounts(): Promise<RemoveResult> {
    return removeAllAccountsImpl(() => this.getCurrentAccountName());
  }

  public getStatus(): Promise<StatusReport> {
    return getStatusImpl();
  }

  public setAutoSwitchEnabled(enabled: boolean): Promise<StatusReport> {
    return setAutoSwitchEnabledImpl(enabled);
  }

  public setApiUsageEnabled(enabled: boolean): Promise<StatusReport> {
    return setApiUsageEnabledImpl(enabled);
  }

  public configureAutoSwitchThresholds(input: {
    threshold5hPercent?: number;
    thresholdWeeklyPercent?: number;
  }): Promise<StatusReport> {
    return configureAutoSwitchThresholdsImpl(input);
  }

  public runAutoSwitchOnce(): Promise<AutoSwitchRunResult> {
    return runAutoSwitchOnceImpl(() => this.getCurrentAccountName());
  }

  public runDaemon(mode: "once" | "watch"): Promise<void> {
    return runDaemonImpl(mode, () => this.getCurrentAccountName());
  }
}
