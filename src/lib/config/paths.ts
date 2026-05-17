import os from "node:os";
import path from "node:path";

function resolvePath(raw: string): string {
  const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

export function resolveCodexDir(): string {
  const envPath = process.env.CODEX_AUTH_CODEX_DIR;
  if (envPath && envPath.trim().length > 0) {
    return resolvePath(envPath.trim());
  }

  return path.join(os.homedir(), ".codex");
}

export function resolveAccountsDir(): string {
  const envPath = process.env.CODEX_AUTH_ACCOUNTS_DIR;
  if (envPath && envPath.trim().length > 0) {
    return resolvePath(envPath.trim());
  }

  return path.join(resolveCodexDir(), "accounts");
}

export function resolveAuthPath(): string {
  const envPath = process.env.CODEX_AUTH_JSON_PATH;
  if (envPath && envPath.trim().length > 0) {
    return resolvePath(envPath.trim());
  }

  return path.join(resolveCodexDir(), "auth.json");
}

export function resolveCurrentNamePath(): string {
  const envPath = process.env.CODEX_AUTH_CURRENT_PATH;
  if (envPath && envPath.trim().length > 0) {
    return resolvePath(envPath.trim());
  }

  return path.join(resolveCodexDir(), "current");
}

export function resolveRegistryPath(): string {
  return path.join(resolveAccountsDir(), "registry.json");
}

export function resolveSessionMapPath(): string {
  const envPath = process.env.CODEX_AUTH_SESSION_MAP_PATH;
  if (envPath && envPath.trim().length > 0) {
    return resolvePath(envPath.trim());
  }

  return path.join(resolveAccountsDir(), "sessions.json");
}

export function resolveSnapshotBackupDir(): string {
  return path.join(resolveAccountsDir(), ".snapshot-backups");
}

/**
 * @deprecated Use {@link resolveCodexDir} — this constant is evaluated at
 * module import time, so env-var overrides (`CODEX_AUTH_CODEX_DIR`, `HOME`)
 * set after the first `import` have no effect. Scheduled for removal in
 * v0.2.0 (Theme N4, `docs/future/17-ROADMAP.md`).
 */
export const codexDir: string = resolveCodexDir();
/**
 * @deprecated Use {@link resolveAccountsDir} — eager binding ignores
 * env-var overrides set after import. Scheduled for removal in v0.2.0
 * (Theme N4, `docs/future/17-ROADMAP.md`).
 */
export const accountsDir: string = resolveAccountsDir();
/**
 * @deprecated Use {@link resolveAuthPath} — eager binding ignores env-var
 * overrides set after import. Scheduled for removal in v0.2.0 (Theme N4,
 * `docs/future/17-ROADMAP.md`).
 */
export const authPath: string = resolveAuthPath();
/**
 * @deprecated Use {@link resolveCurrentNamePath} — eager binding ignores
 * env-var overrides set after import. Scheduled for removal in v0.2.0
 * (Theme N4, `docs/future/17-ROADMAP.md`).
 */
export const currentNamePath: string = resolveCurrentNamePath();
/**
 * @deprecated Use {@link resolveRegistryPath} — eager binding ignores
 * env-var overrides set after import. Scheduled for removal in v0.2.0
 * (Theme N4, `docs/future/17-ROADMAP.md`).
 */
export const registryPath: string = resolveRegistryPath();
/**
 * @deprecated Use {@link resolveSessionMapPath} — eager binding ignores
 * env-var overrides set after import. Scheduled for removal in v0.2.0
 * (Theme N4, `docs/future/17-ROADMAP.md`).
 */
export const sessionMapPath: string = resolveSessionMapPath();
