import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOGIN_HOOK_MARK_START = "# >>> authmux-login-auto-snapshot >>>";
export const LOGIN_HOOK_MARK_END = "# <<< authmux-login-auto-snapshot <<<";

export type HookInstallStatus = "installed" | "updated" | "already-installed";
export type HookRemoveStatus = "removed" | "not-installed";
export interface LoginHookStatus {
  installed: boolean;
  rcPath: string;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hookBlockRegex(): RegExp {
  const start = escapeRegex(LOGIN_HOOK_MARK_START);
  const end = escapeRegex(LOGIN_HOOK_MARK_END);
  return new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, "g");
}

function normalizeRcContents(contents: string): string {
  const collapsed = contents.replace(/\n{3,}/g, "\n\n");
  return `${collapsed.replace(/\s*$/, "")}\n`;
}

export function resolveDefaultShellRcPath(): string {
  const shell = (process.env.SHELL ?? "").toLowerCase();
  if (shell.includes("zsh")) {
    return path.join(os.homedir(), ".zshrc");
  }

  return path.join(os.homedir(), ".bashrc");
}

export function renderLoginHookBlock(): string {
  return [
    LOGIN_HOOK_MARK_START,
    "# Keep terminal-scoped snapshot memory in sync before/after each `codex` run.",
    "# Also restore common terminal modes to avoid leaked escape sequences after codex exits.",
    "__codex_auth_restore_tty() {",
    "  [[ -t 1 ]] || return 0",
    "  local __tty_target=/dev/tty",
    "  [[ -w \"$__tty_target\" ]] || __tty_target=/dev/stdout",
    "  printf '\\033[>4m\\033[<u\\033[?2026l\\033[?1004l\\033[?1l\\033[?2004l\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?1015l\\033[?1049l\\033[0m\\033[?25h\\033[H\\033>' >\"$__tty_target\" 2>/dev/null || true",
    "}",
    "codex() {",
    "  if command -v authmux >/dev/null 2>&1; then",
    "    command authmux restore-session >/dev/null 2>&1 || true",
    "    command authmux skills activate-current --agent codex >/dev/null 2>&1 || true",
    "  fi",
    "  command codex \"$@\"",
    "  local __codex_exit=$?",
    "  if command -v authmux >/dev/null 2>&1; then",
    "    CODEX_AUTH_FORCE_EXTERNAL_SYNC=1 command authmux status >/dev/null 2>&1 || true",
    "  fi",
    "  if [[ -z \"${CODEX_AUTH_SKIP_TTY_RESTORE:-}\" ]]; then",
    "    __codex_auth_restore_tty",
    "  fi",
    "  return $__codex_exit",
    "}",
    LOGIN_HOOK_MARK_END,
  ].join("\n");
}

export async function installLoginHook(rcPath = resolveDefaultShellRcPath()): Promise<HookInstallStatus> {
  await fsp.mkdir(path.dirname(rcPath), { recursive: true });

  let existing = "";
  try {
    existing = await fsp.readFile(rcPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }

  if (existing.includes(LOGIN_HOOK_MARK_START) && existing.includes(LOGIN_HOOK_MARK_END)) {
    const refreshed = normalizeRcContents(
      existing.replace(hookBlockRegex(), `\n${renderLoginHookBlock()}\n`),
    );
    if (refreshed === normalizeRcContents(existing)) {
      return "already-installed";
    }

    await fsp.writeFile(rcPath, refreshed, "utf8");
    return "updated";
  }

  const next = normalizeRcContents(`${existing}\n\n${renderLoginHookBlock()}\n`);
  await fsp.writeFile(rcPath, next, "utf8");
  return "installed";
}

export async function removeLoginHook(rcPath = resolveDefaultShellRcPath()): Promise<HookRemoveStatus> {
  let existing = "";
  try {
    existing = await fsp.readFile(rcPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return "not-installed";
    }
    throw error;
  }

  const regex = hookBlockRegex();
  const stripped = existing.replace(regex, "\n");
  if (stripped === existing) {
    return "not-installed";
  }

  await fsp.writeFile(rcPath, normalizeRcContents(stripped), "utf8");
  return "removed";
}

export async function getLoginHookStatus(rcPath = resolveDefaultShellRcPath()): Promise<LoginHookStatus> {
  let existing = "";
  try {
    existing = await fsp.readFile(rcPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        installed: false,
        rcPath,
      };
    }
    throw error;
  }

  const installed = existing.includes(LOGIN_HOOK_MARK_START) && existing.includes(LOGIN_HOOK_MARK_END);
  return {
    installed,
    rcPath,
  };
}
