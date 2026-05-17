import { Args, Flags } from "@oclif/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseCommand } from "../lib/base-command";
import { CodexAuthError } from "../lib/accounts";

const ACCOUNTS_DIR = path.join(os.homedir(), ".codex", "accounts");

interface ImportedAccount {
  name: string;
  action: "imported" | "updated" | "skipped";
  source: string;
  reason?: string;
}

export default class Import extends BaseCommand {
  static description = "Import auth file(s) into managed accounts (single file, directory, or --purge to rebuild registry)";

  static args = {
    path: Args.string({ description: "Path to auth JSON file or directory of .json files" }),
  } as const;

  static flags = {
    alias: Flags.string({ description: "Alias name for the imported account (single file only)" }),
    purge: Flags.boolean({ description: "Rebuild registry from existing auth snapshots in ~/.codex/accounts/" }),
    ...BaseCommand.jsonFlag,
  } as const;

  // Import writes snapshot files directly; do not let the base sync clobber
  // any in-flight state before the import runs.
  protected readonly syncExternalAuthBeforeRun = false;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Import);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      if (flags.purge) {
        this.purgeRebuild(args.path);
        return;
      }

      const target = args.path;
      if (!target) {
        throw new CodexAuthError(
          "Provide a path to an auth JSON file or directory.",
        );
      }

      const stat = fs.statSync(target, { throwIfNoEntry: false });
      if (!stat) {
        throw new CodexAuthError(`Path not found: ${target}`);
      }

      fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

      if (stat.isDirectory()) {
        this.importDirectory(target);
      } else {
        const record = this.importFile(target, flags.alias);
        this.emit(
          { mode: "file" as const, imported: [record] },
          (data) => {
            for (const r of data.imported) {
              if (r.action === "imported") this.log(`  Imported: ${r.name}`);
              else if (r.action === "updated") this.log(`  Updated: ${r.name}`);
            }
          },
        );
      }
    });
  }

  private importFile(filePath: string, alias?: string): ImportedAccount {
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CodexAuthError(`Malformed JSON: ${filePath}`);
    }

    const name = alias || this.extractName(parsed, filePath);
    const dest = path.join(ACCOUNTS_DIR, `${name}.json`);
    const existed = fs.existsSync(dest);
    fs.writeFileSync(dest, raw);
    return {
      name,
      action: existed ? "updated" : "imported",
      source: filePath,
    };
  }

  private importDirectory(dirPath: string): void {
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".json"));
    const imported: ImportedAccount[] = [];

    if (!files.length) {
      this.emit(
        { mode: "directory" as const, imported, dir: dirPath, total: 0 },
        () => {
          this.log(`No .json files found in ${dirPath}`);
        },
      );
      return;
    }

    for (const file of files) {
      try {
        imported.push(this.importFile(path.join(dirPath, file)));
      } catch (err) {
        imported.push({
          name: file,
          action: "skipped",
          source: path.join(dirPath, file),
          reason: String(err),
        });
      }
    }

    const succeeded = imported.filter((r) => r.action !== "skipped").length;
    this.emit(
      {
        mode: "directory" as const,
        imported,
        dir: dirPath,
        total: files.length,
        succeeded,
      },
      (data) => {
        for (const r of data.imported) {
          if (r.action === "imported") this.log(`  Imported: ${r.name}`);
          else if (r.action === "updated") this.log(`  Updated: ${r.name}`);
          else if (r.action === "skipped") this.warn(`Skipped ${r.name}: ${r.reason}`);
        }
        this.log(`\nImported ${data.succeeded}/${data.total} files.`);
      },
    );
  }

  private purgeRebuild(scanPath?: string): void {
    const dir = scanPath || ACCOUNTS_DIR;
    if (!fs.existsSync(dir)) {
      throw new CodexAuthError(`Directory not found: ${dir}`);
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

    // Re-import each file to ensure registry consistency
    fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    let count = 0;
    for (const file of files) {
      const src = path.join(dir, file);
      const dest = path.join(ACCOUNTS_DIR, file);
      if (src !== dest) {
        fs.copyFileSync(src, dest);
      }
      count++;
    }

    // Also import current auth.json if it exists
    const authJson = path.join(os.homedir(), ".codex", "auth.json");
    let includedAuthJson = false;
    if (fs.existsSync(authJson) && !fs.lstatSync(authJson).isSymbolicLink()) {
      const dest = path.join(ACCOUNTS_DIR, "current.json");
      fs.copyFileSync(authJson, dest);
      count++;
      includedAuthJson = true;
    }

    this.emit(
      {
        mode: "purge" as const,
        dir,
        scanned: files.length,
        rebuilt: count,
        includedAuthJson,
      },
      (data) => {
        this.log(`Rebuilding registry from ${data.scanned} files in ${data.dir}...`);
        this.log(`Registry rebuilt: ${data.rebuilt} accounts.`);
      },
    );
  }

  private extractName(parsed: Record<string, unknown>, filePath: string): string {
    // Try to extract email from tokens.idToken JWT
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    if (tokens?.idToken && typeof tokens.idToken === "string") {
      try {
        const payload = JSON.parse(Buffer.from(tokens.idToken.split(".")[1], "base64url").toString());
        if (payload.email) {
          return payload.email.replace(/[^a-z0-9._@-]/gi, "-");
        }
      } catch { /* fall through */ }
    }
    return path.basename(filePath, ".json");
  }
}
