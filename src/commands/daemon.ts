import { Flags } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";
import { CodexAuthError } from "../lib/accounts";

export default class DaemonCommand extends BaseCommand {
  static description = "Run the background auto-switch daemon";

  static flags = {
    watch: Flags.boolean({
      description: "Run continuously and evaluate switching every 30s",
      default: false,
    }),
    once: Flags.boolean({
      description: "Run one evaluation pass and exit",
      default: false,
    }),
    ...BaseCommand.jsonFlag,
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { flags } = await this.parse(DaemonCommand);
      this.setJsonMode(flags);
      const watch = Boolean(flags.watch);
      const once = Boolean(flags.once);

      if (watch === once) {
        throw new CodexAuthError(
          "`daemon` requires exactly one of `--watch` or `--once`.",
        );
      }

      if (once) {
        const result = await this.accounts.runAutoSwitchOnce();
        this.emit(result, (data) => {
          if (data.switched) {
            this.log(`switched: ${data.fromAccount} -> ${data.toAccount}`);
          } else {
            this.log(`no switch: ${data.reason}`);
          }
        });
        return;
      }

      // Watch mode streams events over time; X3 will land --json streaming.
      // For X4 we leave it on the human path only.
      if (this.jsonMode) {
        throw new CodexAuthError(
          "`daemon --watch --json` is not yet supported. Use `daemon --once --json`.",
        );
      }
      await this.accounts.runDaemon("watch");
    });
  }
}
