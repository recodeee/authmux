import { Flags } from "@oclif/core";
import prompts from "prompts";
import { BaseCommand } from "../lib/base-command";
import { formatAccountType } from "../lib/accounts/plan-display";
import {
  fetchLatestNpmVersionCached,
  formatGlobalInstallCommand,
  formatUpdateCompletedMessage,
  formatUpdateSummaryInline,
  getUpdateSummary,
  PACKAGE_NAME,
  runGlobalNpmInstall,
} from "../lib/update-check";

export default class ListCommand extends BaseCommand {
  static description = "List accounts managed under ~/.codex";

  static flags = {
    details: Flags.boolean({
      char: "d",
      description: "Show per-account mapping metadata (email/account/user/type/usage)",
      default: false,
    }),
    ...BaseCommand.jsonFlag,
  } as const;

  async run(): Promise<void> {
    const { flags } = await this.parse(ListCommand);
    this.setJsonMode(flags);
    const detailed = Boolean(flags.details);

    await this.runSafe(async () => {
      // Interactive update prompt would corrupt JSON stdout; skip it.
      if (!this.jsonMode) {
        await this.maybeOfferGlobalUpdate();
      }

      const accounts = await this.accounts.listAccountMappings({ refreshUsage: "missing" });

      this.emit({ accounts, detailed }, (payload) => {
        if (!payload.accounts.length) {
          this.log("No saved Codex accounts yet. Run `authmux save <name>`.");
          return;
        }

        for (const account of payload.accounts) {
          const mark = account.active ? "*" : " ";
          if (!payload.detailed) {
            this.log(
              `${mark} ${account.name}  type=${formatAccountType(account.planType)}  5h=${this.formatRemaining(account.remaining5hPercent)}  weekly=${this.formatRemaining(account.remainingWeeklyPercent)}`,
            );
            continue;
          }
          this.log(`${mark} ${account.name}`);
          this.log(
            `    email=${account.email ?? "-"} account=${account.accountId ?? "-"} user=${account.userId ?? "-"}`,
          );
          this.log(
            `    type=${formatAccountType(account.planType)} plan=${account.planType ?? "-"} usage=${account.usageSource ?? "-"} 5h=${this.formatRemaining(account.remaining5hPercent)} weekly=${this.formatRemaining(account.remainingWeeklyPercent)} lastUsageAt=${account.lastUsageAt ?? "-"}`,
          );
        }
      });
    });
  }

  private formatRemaining(value: number | undefined): string {
    if (typeof value !== "number") {
      return "-";
    }
    return `${value}%`;
  }

  private async maybeOfferGlobalUpdate(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;

    const currentVersion = this.config.version;
    if (!currentVersion || typeof currentVersion !== "string") return;

    const latestVersion = await fetchLatestNpmVersionCached(PACKAGE_NAME, {
      currentVersion,
      timeoutMs: 900,
    });
    if (!latestVersion) return;

    const summary = getUpdateSummary(currentVersion, latestVersion);
    if (summary.state !== "update-available") return;

    this.log(formatUpdateSummaryInline(summary));

    const prompt = await prompts({
      type: "confirm",
      name: "install",
      message: `Press Enter to update globally to ${latestVersion}`,
      initial: true,
    });

    if (!prompt.install) {
      this.log(`Skipped update. Run manually: ${formatGlobalInstallCommand(PACKAGE_NAME, latestVersion)}`);
      return;
    }

    const installExitCode = await runGlobalNpmInstall(PACKAGE_NAME, latestVersion);
    if (installExitCode === 0) {
      this.log(formatUpdateCompletedMessage(latestVersion));
      return;
    }

    this.warn(
      `Global update failed (exit code ${installExitCode}). Try: ${formatGlobalInstallCommand(PACKAGE_NAME, latestVersion)}`,
    );
  }
}
