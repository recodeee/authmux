import { BaseCommand } from "../lib/base-command";
import { getSavingsReport } from "../lib/account-savings.js";

export default class Savings extends BaseCommand {
  static description = "Show account rotation savings and efficiency stats";

  static flags = {
    ...BaseCommand.jsonFlag,
  } as const;

  // Read-only ledger; no auth snapshot sync required.
  protected readonly syncExternalAuthBeforeRun = false;

  async run(): Promise<void> {
    const { flags } = await this.parse(Savings);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      const s = getSavingsReport();
      const autoRate =
        s.totalSwitches > 0 ? Math.round((s.autoSwitches / s.totalSwitches) * 100) : 0;

      this.emit({ ...s, autoSwitchRatePercent: autoRate }, (data) => {
        this.log("Account Rotation Savings:\n");
        this.log(`  Total switches:      ${data.totalSwitches}`);
        this.log(`  Auto-switches:       ${data.autoSwitches}`);
        this.log(`  Rate limits avoided: ${data.rateLimitsAvoided}`);
        this.log(`  Cooldown saved:      ~${data.estimatedMinutesSaved} minutes`);
        this.log(`  Last updated:        ${data.lastUpdated}`);
        if (data.totalSwitches > 0) {
          this.log(`\n  Auto-switch rate:    ${data.autoSwitchRatePercent}%`);
        }
      });
    });
  }
}
