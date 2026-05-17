// Session-pin module extracted from AccountService (Theme N2).
//
// Owns: sessions.json I/O, the session-scope key (env CODEX_AUTH_SESSION_KEY
// or `ppid:<n>`), and the Linux-only PPID heuristic that decides whether the
// pinned session is still attached to a running codex process.

import path from "node:path";
import fsp from "node:fs/promises";
import {
  resolveSessionMapPath,
} from "../../config/paths";
import { ensureSecureDir, secureWriteFile } from "../../io/secure-fs";
import { normalizeAccountName } from "../naming";
import { readAuthSyncState } from "../_internal/fs-helpers";

const SESSION_KEY_ENV = "CODEX_AUTH_SESSION_KEY";
const SESSION_ACTIVE_OVERRIDE_ENV = "CODEX_AUTH_SESSION_ACTIVE_OVERRIDE";

export interface SessionMapEntry {
  accountName: string;
  authFingerprint?: string;
  updatedAt: string;
}

export interface SessionMapData {
  version: 1;
  sessions: Record<string, SessionMapEntry>;
}

export function resolveSessionScopeKey(): string | null {
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

export async function readSessionMap(): Promise<SessionMapData> {
  const sessionMapPath = resolveSessionMapPath();
  try {
    const raw = await fsp.readFile(sessionMapPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, sessions: {} };
    }

    const root = parsed as Record<string, unknown>;
    const sessionsRaw =
      root.sessions && typeof root.sessions === "object"
        ? (root.sessions as Record<string, unknown>)
        : {};
    const sessions: Record<string, SessionMapEntry> = {};

    for (const [key, value] of Object.entries(sessionsRaw)) {
      if (!value || typeof value !== "object") continue;
      const rawEntry = value as Record<string, unknown>;
      const accountName =
        typeof rawEntry.accountName === "string" ? rawEntry.accountName.trim() : "";
      if (!accountName) continue;
      const authFingerprint =
        typeof rawEntry.authFingerprint === "string" &&
        rawEntry.authFingerprint.trim().length > 0
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

    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

export async function writeSessionMap(sessionMap: SessionMapData): Promise<void> {
  const sessionMapPath = resolveSessionMapPath();
  await ensureSecureDir(path.dirname(sessionMapPath));
  await secureWriteFile(sessionMapPath, `${JSON.stringify(sessionMap, null, 2)}\n`);
}

export async function getSessionAccountName(): Promise<string | null> {
  const sessionKey = resolveSessionScopeKey();
  if (!sessionKey) return null;

  const sessionMap = await readSessionMap();
  const entry = sessionMap.sessions[sessionKey];
  if (!entry?.accountName) return null;

  try {
    return normalizeAccountName(entry.accountName);
  } catch {
    return null;
  }
}

export async function getSessionAuthFingerprint(): Promise<string | null> {
  const sessionKey = resolveSessionScopeKey();
  if (!sessionKey) return null;

  const sessionMap = await readSessionMap();
  const entry = sessionMap.sessions[sessionKey];
  if (!entry?.authFingerprint || typeof entry.authFingerprint !== "string") {
    return null;
  }

  return entry.authFingerprint.trim() || null;
}

export async function setSessionAccountName(
  accountName: string,
  authFingerprint?: string,
): Promise<void> {
  const sessionKey = resolveSessionScopeKey();
  if (!sessionKey) return;

  const sessionMap = await readSessionMap();
  const existing = sessionMap.sessions[sessionKey];
  sessionMap.sessions[sessionKey] = {
    accountName,
    authFingerprint: authFingerprint ?? existing?.authFingerprint,
    updatedAt: new Date().toISOString(),
  };
  await writeSessionMap(sessionMap);
}

export async function clearSessionAccountName(): Promise<void> {
  const sessionKey = resolveSessionScopeKey();
  if (!sessionKey) return;

  const sessionMap = await readSessionMap();
  if (!sessionMap.sessions[sessionKey]) return;
  delete sessionMap.sessions[sessionKey];
  await writeSessionMap(sessionMap);
}

export async function rememberSessionAuthFingerprint(authPath: string): Promise<void> {
  const sessionKey = resolveSessionScopeKey();
  if (!sessionKey) return;

  const authState = await readAuthSyncState(authPath);
  if (!authState || authState.isSymbolicLink) return;

  const sessionMap = await readSessionMap();
  const existing = sessionMap.sessions[sessionKey];
  if (!existing?.accountName || existing.authFingerprint === authState.fingerprint) {
    return;
  }

  sessionMap.sessions[sessionKey] = {
    ...existing,
    authFingerprint: authState.fingerprint,
    updatedAt: new Date().toISOString(),
  };
  await writeSessionMap(sessionMap);
}

export async function isSessionPinnedToActiveCodex(): Promise<boolean> {
  const override = process.env[SESSION_ACTIVE_OVERRIDE_ENV]?.trim().toLowerCase();
  if (override) {
    if (["1", "true", "yes", "on"].includes(override)) return true;
    if (["0", "false", "no", "off"].includes(override)) return false;
  }

  const sessionKey = resolveSessionScopeKey();
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

  const childPids = await readChildPids(parentPid);
  if (childPids.length === 0) return false;

  for (const childPid of childPids) {
    if (await isCodexProcess(childPid)) {
      return true;
    }
  }

  return false;
}

export async function readChildPids(parentPid: number): Promise<number[]> {
  try {
    const childrenRaw = await fsp.readFile(
      `/proc/${parentPid}/task/${parentPid}/children`,
      "utf8",
    );
    return childrenRaw
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 1);
  } catch {
    return [];
  }
}

export async function isCodexProcess(pid: number): Promise<boolean> {
  try {
    const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, "utf8");
    const normalized = cmdline.replace(/\0/g, " ").trim();
    if (!normalized) return false;
    if (/\bauthmux\b/.test(normalized)) return false;
    if (/(^|\s|\/)codex(\s|$)/.test(normalized)) return true;
    if (/(^|\s|\/)codex-linux-[^\s]*($|\s)/.test(normalized)) return true;
    return false;
  } catch {
    return false;
  }
}

export async function getActiveSessionAccountName(): Promise<string | null> {
  const sessionAccountName = await getSessionAccountName();
  if (!sessionAccountName) return null;

  const sessionIsActive = await isSessionPinnedToActiveCodex();
  if (sessionIsActive) return sessionAccountName;

  await clearSessionAccountName();
  return null;
}
