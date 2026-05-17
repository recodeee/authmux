// External-auth sync orchestrator extracted from AccountService (Theme N2).
//
// The two entry points: `syncExternalAuthSnapshotIfNeeded` runs on most
// CLI invocations to detect a fresh `codex login` and import it as a
// saved snapshot; `restoreSessionSnapshotIfNeeded` runs before codex
// starts to defend against codex clobbering the saved snapshot through
// a stale symlink.

import { resolveAuthPath } from "../../config/paths";
import { parseAuthSnapshotFile } from "../auth-parser";
import {
  ensureAuthFileExists,
  materializeAuthSymlink,
} from "../_internal/auth-state";
import {
  pathExists,
  filesMatch,
  readAuthSyncState,
} from "../_internal/fs-helpers";
import { accountFilePath } from "../naming";
import { snapshotsShareIdentity } from "../identity/equality";
import { getCurrentAccountName } from "../read/listing";
import { saveAccount } from "../write/save";
import { activateSnapshot, sessionSnapshotExists } from "../write/use";
import {
  getStatus,
  setAutoSwitchEnabled,
} from "../config/auto-switch-config";
import {
  backupAllSnapshots,
  clearSnapshotBackupVault,
  restoreClobberedSnapshotsFromBackup,
} from "../safety/snapshot-vault";
import {
  clearSessionAccountName,
  getActiveSessionAccountName,
  getSessionAccountName,
  getSessionAuthFingerprint,
  rememberSessionAuthFingerprint,
} from "../session/pin";
import { listAccountNames } from "../read/listing";
import { resolveLoginAccountNameForSnapshot } from "../_internal/name-resolution";

const EXTERNAL_SYNC_FORCE_ENV = "CODEX_AUTH_FORCE_EXTERNAL_SYNC";

export interface ExternalAuthSyncResult {
  synchronized: boolean;
  savedName?: string;
  autoSwitchDisabled: boolean;
}

function isExternalSyncForced(): boolean {
  const raw = process.env[EXTERNAL_SYNC_FORCE_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off"].includes(normalized);
}

export async function syncExternalAuthSnapshotIfNeeded(): Promise<ExternalAuthSyncResult> {
  const authPath = resolveAuthPath();
  if (!(await pathExists(authPath))) {
    return {
      synchronized: false,
      autoSwitchDisabled: false,
    };
  }

  const initialAuthState = await readAuthSyncState(authPath);
  const externalSyncForced = isExternalSyncForced();
  if (
    initialAuthState &&
    !initialAuthState.isSymbolicLink &&
    !externalSyncForced &&
    (await getSessionAuthFingerprint()) === initialAuthState.fingerprint &&
    (await sessionSnapshotExists(getSessionAccountName))
  ) {
    return {
      synchronized: false,
      autoSwitchDisabled: false,
    };
  }

  await materializeAuthSymlink(authPath);
  const rememberAuthState = async (
    result: ExternalAuthSyncResult,
  ): Promise<ExternalAuthSyncResult> => {
    await rememberSessionAuthFingerprint(authPath);
    return result;
  };

  // Repair any snapshot file that codex clobbered through a stale symlink
  // before we attempt name resolution — otherwise the identity-based scan
  // mistakes the clobbered file for a refresh of the previous account.
  await restoreClobberedSnapshotsFromBackup();

  const incomingSnapshot = await parseAuthSnapshotFile(authPath);
  if (incomingSnapshot.authMode !== "chatgpt") {
    return rememberAuthState({
      synchronized: false,
      autoSwitchDisabled: false,
    });
  }

  const sessionAccountName = await getActiveSessionAccountName();
  if (sessionAccountName) {
    const sessionSnapshotPath = accountFilePath(sessionAccountName);
    if (await pathExists(sessionSnapshotPath)) {
      const sessionSnapshot = await parseAuthSnapshotFile(sessionSnapshotPath);
      if (
        sessionSnapshot.authMode === "chatgpt" &&
        !snapshotsShareIdentity(sessionSnapshot, incomingSnapshot) &&
        !externalSyncForced
      ) {
        return rememberAuthState({
          synchronized: false,
          autoSwitchDisabled: false,
        });
      }
    }
  }

  const activeName = await getCurrentAccountName();
  const resolvedName = await resolveLoginAccountNameForSnapshot(
    incomingSnapshot,
    activeName,
  );
  const resolvedSnapshotPath = accountFilePath(resolvedName.name);
  if (
    activeName === resolvedName.name &&
    (await pathExists(resolvedSnapshotPath)) &&
    (await filesMatch(authPath, resolvedSnapshotPath))
  ) {
    return rememberAuthState({
      synchronized: false,
      autoSwitchDisabled: false,
    });
  }

  const status = await getStatus();
  const sameActiveAccountRefresh =
    activeName === resolvedName.name && resolvedName.source === "active";
  const autoSwitchDisabled = status.autoSwitchEnabled && !sameActiveAccountRefresh;
  if (autoSwitchDisabled) {
    await setAutoSwitchEnabled(false);
  }

  const savedName = await saveAccount(resolvedName.name, {
    force: Boolean(resolvedName.forceOverwrite),
  });

  // The backup vault has served its purpose for this codex run.
  await clearSnapshotBackupVault();

  return rememberAuthState({
    synchronized: true,
    savedName,
    autoSwitchDisabled,
  });
}

export async function restoreSessionSnapshotIfNeeded(): Promise<{
  restored: boolean;
  accountName?: string;
}> {
  // Materialize the auth symlink up front, before any early returns. Older
  // installations (and stray `ln -s` setups) can leave ~/.codex/auth.json as
  // a symlink into accounts/<name>.json; if the upcoming `codex login` writes
  // through that symlink, it overwrites the saved snapshot for the previous
  // account and we lose it.
  const authPath = resolveAuthPath();
  if (await pathExists(authPath)) {
    await materializeAuthSymlink(authPath);
  }

  // Defensive safety net: snapshot every saved account into a backup vault
  // before codex runs. If the materialize step is bypassed (e.g., this
  // function isn't invoked because the shell hook is shadowed by another
  // codex() function), the next sync after codex exits can still recover
  // any snapshot file that got clobbered.
  await backupAllSnapshots(listAccountNames);

  const sessionAccountName = await getActiveSessionAccountName();
  if (!sessionAccountName) {
    return { restored: false };
  }

  const snapshotPath = accountFilePath(sessionAccountName);
  if (!(await pathExists(snapshotPath))) {
    await clearSessionAccountName();
    return { restored: false };
  }

  if (await pathExists(authPath)) {
    const [sessionSnapshot, activeSnapshot] = await Promise.all([
      parseAuthSnapshotFile(snapshotPath),
      parseAuthSnapshotFile(authPath),
    ]);
    if (snapshotsShareIdentity(sessionSnapshot, activeSnapshot)) {
      return {
        restored: false,
        accountName: sessionAccountName,
      };
    }
  }

  await activateSnapshot(sessionAccountName);
  return {
    restored: true,
    accountName: sessionAccountName,
  };
}

// Used by the auth-parser ensure check from saveAccount() in particular.
// Re-exported so callers don't need to reach into _internal/.
export { ensureAuthFileExists };
