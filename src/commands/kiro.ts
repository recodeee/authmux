// Theme X4 divergence: `kiro` bypasses BaseCommand per
// `01-ARCHITECTURE.md` §1.3 (provider-specific; no Codex auth coupling). We
// wire --json manually using `json-envelope.ts` to keep the wire shape
// consistent with BaseCommand commands.

import { Command, Flags } from "@oclif/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import {
  jsonSuccess,
  writeJsonEnvelope,
} from "../lib/cli/json-envelope";

const DATA_DIR = path.join(os.homedir(), ".local/share/kiro-cli");
const DATA_FILE = path.join(DATA_DIR, "data.sqlite3");
const SWITCHER_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "kiro-account-switcher");
const ACTIVE_FILE = path.join(SWITCHER_DIR, "active");

function getAccounts(): string[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".sqlite3") && f !== "data.sqlite3")
    .sort()
    .map((f) => f.replace(/\.sqlite3$/, ""));
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

export default class KiroSwitch extends Command {
  static description = "Switch between saved Kiro CLI accounts";

  static flags = {
    new: Flags.boolean({ description: "Remove symlink to prep for a new kiro-cli login" }),
    json: Flags.boolean({
      description: "Emit a single JSON envelope to stdout (Theme X4).",
      default: false,
    }),
  } as const;

  static args = {} as const;
  static strict = false;

  private jsonMode = false;

  async run(): Promise<void> {
    const { flags, argv } = await this.parse(KiroSwitch);
    this.jsonMode = Boolean(flags.json);

    if (flags.new) {
      this.prepNew();
      return;
    }

    // Direct switch if account name passed
    const directName = (argv as string[])[0];
    if (directName) {
      this.switchTo(directName);
      return;
    }

    // No-arg invocation: list accounts (+ active marker). In JSON mode this
    // is purely a read; in human mode it falls back to the interactive picker.
    const accounts = getAccounts();
    const active = this.getActive();

    if (this.jsonMode) {
      writeJsonEnvelope(jsonSuccess({
        action: "list" as const,
        accounts: accounts.map((name) => ({ name, active: name === active })),
        active: active ?? null,
        dataDir: DATA_DIR,
      }));
      return;
    }

    if (!accounts.length) {
      this.error(`No Kiro account snapshots in ${DATA_DIR}. Run: agent-auth kiro-login`);
    }

    this.log("Kiro accounts:\n");
    for (let i = 0; i < accounts.length; i++) {
      const mark = accounts[i] === active ? " *" : "";
      this.log(`  ${i + 1}) ${accounts[i]}${mark}`);
    }
    this.log("");

    const choice = await prompt("Pick a number: ");
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
      this.error("Invalid choice.");
    }

    this.switchTo(accounts[idx]);
  }

  private switchTo(name: string): void {
    const target = path.join(DATA_DIR, `${name}.sqlite3`);
    if (!fs.existsSync(target)) {
      this.error(`Account "${name}" not found. Available: ${getAccounts().join(", ")}`);
    }

    // Remove existing data file or broken symlink. lstatSync throws ENOENT
    // when the path is completely absent, so wrap it.
    try {
      fs.unlinkSync(DATA_FILE);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw error;
    }

    fs.symlinkSync(target, DATA_FILE);
    fs.mkdirSync(SWITCHER_DIR, { recursive: true });
    fs.writeFileSync(ACTIVE_FILE, name);

    if (this.jsonMode) {
      writeJsonEnvelope(jsonSuccess({
        action: "switch" as const,
        active: name,
        target,
      }));
      return;
    }
    this.log(`Switched Kiro to: ${name}`);
  }

  private prepNew(): void {
    if (!fs.existsSync(DATA_FILE)) {
      if (this.jsonMode) {
        writeJsonEnvelope(jsonSuccess({
          action: "prep-new" as const,
          removed: false,
          reason: "no-data-file",
        }));
        return;
      }
      this.log("No data.sqlite3 to remove. Run: kiro-cli login");
      return;
    }
    const stat = fs.lstatSync(DATA_FILE);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(DATA_FILE);
      if (this.jsonMode) {
        writeJsonEnvelope(jsonSuccess({
          action: "prep-new" as const,
          removed: true,
        }));
        return;
      }
      this.log("Removed symlink. Now run: agent-auth kiro-login");
    } else {
      this.error(`${DATA_FILE} is a regular file. Run: agent-auth kiro-login --name <name>`);
    }
  }

  private getActive(): string | undefined {
    try { return fs.readFileSync(ACTIVE_FILE, "utf-8").trim(); } catch { return undefined; }
  }
}
