// `authmux diag` — Theme X3 observability bundle.
//
// Produces a shareable diagnostic bundle for bug reports. Two hard rules
// (also enforced by `src/tests/diag-redaction.test.ts`):
//
//   1. Never read or include snapshot file contents. The accounts dir is
//      listed by filename / size / mtime ONLY; the bundle's accounts table
//      stats files but never opens them.
//   2. Never include `auth.json`. Even its existence flag is captured via
//      `fs.statSync` — no read. Same rule for any *.json under accountsDir.
//
// The env table uses a hard-coded ALLOWLIST (see `collectEnvAllowlisted`)
// because a denylist is too easy to outflank by adding a new env var name.

import { Flags } from "@oclif/core";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { BaseCommand } from "../lib/base-command";
import { getRecentLogLines } from "../infra/log/logger";
import {
  resolveAccountsDir,
  resolveCodexDir,
  resolveRegistryPath,
  resolveSessionMapPath,
} from "../lib/config/paths";

// Env var name allowlist. Anything not in this list is dropped before the
// bundle is written. Tokens / keys / passwords / secrets never appear here.
const ENV_ALLOWLIST_LITERAL = new Set<string>([
  "NODE_ENV",
  "NODE_VERSION",
  "PATH",
  "HOME",
  "SHELL",
  "TERM",
  "OS",
  "PLATFORM",
]);

// Prefixes that are considered safe (authmux/codex flag knobs only).
const ENV_ALLOWLIST_PREFIXES = ["CODEX_AUTH_", "AUTHMUX_"];

// Defense-in-depth: even if a future contributor adds one of these to the
// prefix lists by mistake, the suffix check below catches anything that
// looks remotely credential-shaped.
const FORBIDDEN_SUFFIXES = ["TOKEN", "KEY", "PASSWORD", "SECRET", "COOKIE"];

interface EnvEntry {
  name: string;
  value: string;
}

export function collectEnvAllowlisted(
  source: NodeJS.ProcessEnv = process.env,
): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (const [rawName, rawValue] of Object.entries(source)) {
    if (rawValue === undefined) continue;
    const name = rawName;
    if (isAllowlistedEnvName(name) === false) continue;

    let value = String(rawValue);
    // PATH gets truncated to keep the bundle small and to avoid leaking
    // unrelated tool installs.
    if (name === "PATH" && value.length > 256) {
      value = value.slice(0, 256) + "...<truncated>";
    }
    // HOME is reported by length only, never by value. The actual home
    // dir often appears in support requests anyway, but redacting here
    // keeps the diag bundle conservative.
    if (name === "HOME") {
      value = `<set, len=${value.length}>`;
    }
    out.push({ name, value });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function isAllowlistedEnvName(name: string): boolean {
  // Block credential-shaped names regardless of any prefix match.
  for (const suffix of FORBIDDEN_SUFFIXES) {
    if (name === suffix) return false;
    if (name.endsWith("_" + suffix) || name.endsWith(suffix)) return false;
  }
  if (ENV_ALLOWLIST_LITERAL.has(name)) return true;
  for (const prefix of ENV_ALLOWLIST_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

interface AccountsListing {
  dir: string;
  exists: boolean;
  entries: Array<{ name: string; size: number; mtime: string }>;
}

async function listAccountsDir(): Promise<AccountsListing> {
  const dir = resolveAccountsDir();
  let exists = false;
  try {
    const st = await fsp.stat(dir);
    exists = st.isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return { dir, exists, entries: [] };

  const names = await fsp.readdir(dir);
  const entries: AccountsListing["entries"] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      // Files only. Subdirs are surfaced as 0-byte entries with their
      // mtime so users see backup vault presence.
      entries.push({
        name,
        size: st.isFile() ? st.size : 0,
        mtime: new Date(st.mtimeMs).toISOString(),
      });
    } catch {
      // Skip unreadable entries.
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, exists, entries };
}

interface DiagBundle {
  generatedAt: string;
  authmuxVersion: string;
  nodeVersion: string;
  platform: { os: NodeJS.Platform; arch: string; release: string };
  paths: {
    codexDir: string;
    accountsDir: string;
    registry: string;
    sessions: string;
  };
  env: EnvEntry[];
  accounts: AccountsListing;
  logTail: string[];
}

async function readAuthmuxVersion(): Promise<string> {
  // Resolve relative to the compiled dist layout: `dist/commands/diag.js`
  // → look up two levels for package.json. Falls back to "unknown".
  const candidate = path.join(__dirname, "..", "..", "package.json");
  try {
    const raw = await fsp.readFile(candidate, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function collectDiag(): Promise<DiagBundle> {
  const version = await readAuthmuxVersion();
  const accounts = await listAccountsDir();
  return {
    generatedAt: new Date().toISOString(),
    authmuxVersion: version,
    nodeVersion: process.version,
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    paths: {
      codexDir: resolveCodexDir(),
      accountsDir: resolveAccountsDir(),
      registry: resolveRegistryPath(),
      sessions: resolveSessionMapPath(),
    },
    env: collectEnvAllowlisted(),
    accounts,
    logTail: getRecentLogLines(),
  };
}

function renderHumanSummary(b: DiagBundle): string {
  const lines: string[] = [];
  lines.push(`authmux diag — ${b.generatedAt}`);
  lines.push(`version          : ${b.authmuxVersion}`);
  lines.push(`node             : ${b.nodeVersion}`);
  lines.push(`platform         : ${b.platform.os} ${b.platform.arch} (${b.platform.release})`);
  lines.push("");
  lines.push("paths");
  lines.push(`  codex dir      : ${b.paths.codexDir}`);
  lines.push(`  accounts dir   : ${b.paths.accountsDir}`);
  lines.push(`  registry       : ${b.paths.registry}`);
  lines.push(`  sessions       : ${b.paths.sessions}`);
  lines.push("");
  lines.push(`accounts dir entries: ${b.accounts.entries.length}`);
  for (const e of b.accounts.entries) {
    lines.push(`  ${e.name} (size=${e.size}, mtime=${e.mtime})`);
  }
  lines.push("");
  lines.push("env (allowlisted)");
  for (const e of b.env) {
    lines.push(`  ${e.name}=${e.value}`);
  }
  lines.push("");
  lines.push(`log tail: ${b.logTail.length} line(s)`);
  return lines.join("\n");
}

// Minimal in-memory ustar tar writer. We only need to pack a handful of
// small text files, so streaming/long-name handling is out of scope.
function tarEntry(filename: string, body: Buffer): Buffer {
  if (Buffer.byteLength(filename) > 100) {
    throw new Error(`diag: tar filename too long: ${filename}`);
  }
  const header = Buffer.alloc(512);
  header.write(filename, 0, 100, "utf8");
  header.write("0000644", 100, 7, "utf8"); // mode
  header.write("0000000", 108, 7, "utf8"); // uid
  header.write("0000000", 116, 7, "utf8"); // gid
  header.write(body.length.toString(8).padStart(11, "0"), 124, 11, "utf8");
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0"), 136, 11, "utf8");
  // checksum placeholder
  header.write("        ", 148, 8, "utf8");
  header.write("0", 156, 1, "utf8"); // typeflag (normal file)
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  // compute checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
  header.write(checksum, 148, 8, "utf8");

  const padLen = (512 - (body.length % 512)) % 512;
  return Buffer.concat([header, body, Buffer.alloc(padLen)]);
}

function buildTarball(files: Array<{ name: string; body: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(tarEntry(f.name, Buffer.from(f.body, "utf8")));
  }
  // Two 512-byte zero blocks mark end-of-archive.
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export interface WriteBundleResult {
  outPath: string;
  bytes: number;
}

export async function writeDiagBundle(
  bundle: DiagBundle,
  cwd: string = process.cwd(),
): Promise<WriteBundleResult> {
  const ts = bundle.generatedAt.replace(/[:.]/g, "-");
  const stem = `authmux-diag-${ts}`;
  const outPath = path.join(cwd, `${stem}.tgz`);

  const files = [
    { name: `${stem}/summary.txt`, body: renderHumanSummary(bundle) },
    { name: `${stem}/bundle.json`, body: JSON.stringify(bundle, null, 2) },
    { name: `${stem}/log-tail.jsonl`, body: bundle.logTail.join("\n") + (bundle.logTail.length > 0 ? "\n" : "") },
  ];

  const tar = buildTarball(files);
  const gz = zlib.gzipSync(tar);
  await fsp.writeFile(outPath, gz);
  return { outPath, bytes: gz.length };
}

export default class DiagCommand extends BaseCommand {
  static description =
    "Write a redacted diagnostic bundle to the current dir (authmux-diag-<ts>.tgz).";

  static flags = {
    ...BaseCommand.jsonFlag,
    "print-env": Flags.boolean({
      description:
        "Print the allowlisted env table to stdout (for verification).",
      default: false,
    }),
  } as const;

  // The diag command must work even when there is no auth.json yet, so
  // suppress the BaseCommand's external-sync preflight.
  protected readonly syncExternalAuthBeforeRun: boolean = false;

  async run(): Promise<void> {
    const { flags } = await this.parse(DiagCommand);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      const bundle = await collectDiag();

      if (flags["print-env"]) {
        for (const e of bundle.env) {
          this.log(`${e.name}=${e.value}`);
        }
        return;
      }

      let result: WriteBundleResult;
      try {
        result = await writeDiagBundle(bundle);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fallback: write a plain directory if tar packing fails.
        const ts = bundle.generatedAt.replace(/[:.]/g, "-");
        const stem = `authmux-diag-${ts}`;
        const dir = path.join(process.cwd(), stem);
        fs.mkdirSync(dir, { recursive: true });
        await fsp.writeFile(
          path.join(dir, "summary.txt"),
          renderHumanSummary(bundle),
        );
        await fsp.writeFile(
          path.join(dir, "bundle.json"),
          JSON.stringify(bundle, null, 2),
        );
        await fsp.writeFile(
          path.join(dir, "log-tail.jsonl"),
          bundle.logTail.join("\n") + (bundle.logTail.length > 0 ? "\n" : ""),
        );
        this.emit(
          { ok: true, outPath: dir, fallback: true, error: msg },
          (d) => {
            this.log(`wrote diag bundle (uncompressed): ${d.outPath}`);
          },
        );
        return;
      }

      this.emit(result, (d) => {
        this.log(`wrote diag bundle: ${d.outPath} (${d.bytes} bytes)`);
      });
    });
  }
}
