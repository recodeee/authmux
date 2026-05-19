#!/usr/bin/env node

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const MARK_START = "# >>> authmux-login-auto-snapshot >>>";
const MARK_END = "# <<< authmux-login-auto-snapshot <<<";

function isTruthy(value) {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

function targetShellRc() {
  const shell = (process.env.SHELL || "").toLowerCase();
  if (shell.includes("zsh")) return path.join(os.homedir(), ".zshrc");
  return path.join(os.homedir(), ".bashrc");
}

function renderHookBlock() {
  return [
    MARK_START,
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
    MARK_END,
  ].join("\n");
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hookBlockRegex() {
  const start = escapeRegex(MARK_START);
  const end = escapeRegex(MARK_END);
  return new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, "g");
}

function normalizeRcContents(contents) {
  const collapsed = contents.replace(/\n{3,}/g, "\n\n");
  return `${collapsed.replace(/\s*$/, "")}\n`;
}

function ensureBuiltDist() {
  const projectRoot = path.resolve(__dirname, "..");
  const distEntry = path.join(projectRoot, "dist", "index.js");
  if (fsSync.existsSync(distEntry)) return;

  const tscPath = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  if (fsSync.existsSync(tscPath)) {
    const result = spawnSync(process.execPath, [tscPath, "-p", "tsconfig.json"], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`TypeScript build failed with exit code ${result.status ?? "unknown"}.`);
    }
    return;
  }

  const npmBinary = process.platform === "win32" ? "npm.cmd" : "npm";
  const fallback = spawnSync(
    npmBinary,
    ["exec", "--yes", "--package", "typescript@5.6.3", "--", "tsc", "-p", "tsconfig.json"],
    {
      cwd: projectRoot,
      stdio: "inherit",
    },
  );
  if (fallback.status !== 0) {
    throw new Error(
      `Missing TypeScript compiler for git install bootstrap (fallback exit ${fallback.status ?? "unknown"}).`,
    );
  }

  if (!fsSync.existsSync(distEntry)) {
    throw new Error("TypeScript build completed but dist/index.js is still missing.");
  }
}

async function maybeInstallHook() {
  if (process.env.npm_config_global !== "true") return;
  if (isTruthy(process.env.CODEX_AUTH_SKIP_POSTINSTALL)) return;
  if (isTruthy(process.env.CI)) return;
  const canPrompt = process.stdin.isTTY && process.stdout.isTTY;

  const rcPath = targetShellRc();
  await fs.mkdir(path.dirname(rcPath), { recursive: true });

  let rc = "";
  try {
    rc = await fs.readFile(rcPath, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  if (rc.includes(MARK_START) && rc.includes(MARK_END)) {
    const refreshed = normalizeRcContents(rc.replace(hookBlockRegex(), `\n${renderHookBlock()}\n`));
    if (refreshed !== normalizeRcContents(rc)) {
      await fs.writeFile(rcPath, refreshed, "utf8");
      process.stdout.write(`\nUpdated shell hook in ${rcPath}. Restart terminal or run: source ${rcPath}\n`);
    }
    return;
  }

  if (!canPrompt) return;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `Install optional codex login auto-snapshot hook in ${rcPath}? [y/N] `,
    );
    if (!/^(y|yes)$/i.test((answer || "").trim())) return;
  } finally {
    rl.close();
  }

  const next = normalizeRcContents(`${rc}\n\n${renderHookBlock()}\n`);
  await fs.writeFile(rcPath, next, "utf8");
  process.stdout.write(`\nInstalled shell hook in ${rcPath}. Restart terminal or run: source ${rcPath}\n`);
}

function runPostinstall() {
  ensureBuiltDist();
  return maybeInstallHook();
}

Promise.resolve()
  .then(() => runPostinstall())
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n[authmux postinstall] Failed: ${message}\n`);
    process.exitCode = 1;
  });
