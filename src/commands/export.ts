import { Args } from "@oclif/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseCommand } from "../lib/base-command";
import { CodexAuthError } from "../lib/accounts";

const ACCOUNTS_DIR = path.join(os.homedir(), ".codex", "accounts");

export default class Export extends BaseCommand {
  static description = "Export stored account auth files to a directory";

  static args = {
    dir: Args.string({ description: "Target directory (default: ./agent-auth-export/)" }),
  } as const;

  static flags = {
    ...BaseCommand.jsonFlag,
  } as const;

  // Read-snapshot-files command; no need to resync ~/.codex/auth.json.
  protected readonly syncExternalAuthBeforeRun = false;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Export);
    this.setJsonMode(flags);
    const targetDir = args.dir || path.join(process.cwd(), "agent-auth-export");

    await this.runSafe(async () => {
      if (!fs.existsSync(ACCOUNTS_DIR)) {
        throw new CodexAuthError(
          "No accounts found in ~/.codex/accounts/",
          "E_NO_ACCOUNTS",
        );
      }

      const files = fs.readdirSync(ACCOUNTS_DIR).filter((f) => f.endsWith(".json"));
      if (!files.length) {
        throw new CodexAuthError(
          "No account snapshots to export.",
          "E_NO_ACCOUNTS",
        );
      }

      fs.mkdirSync(targetDir, { recursive: true });
      for (const file of files) {
        fs.copyFileSync(path.join(ACCOUNTS_DIR, file), path.join(targetDir, file));
      }

      this.emit(
        { exported: files.length, targetDir, files },
        (data) => {
          this.log(`Exported ${data.exported} accounts to ${data.targetDir}`);
        },
      );
    });
  }
}
