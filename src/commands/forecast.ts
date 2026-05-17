import { BaseCommand } from "../lib/base-command";
import { AccountService } from "../lib/accounts/account-service.js";
import { forecastAccounts } from "../lib/account-health.js";

export default class Forecast extends BaseCommand {
  static description = "Show health forecast for all saved accounts (best-first)";

  static flags = {
    ...BaseCommand.jsonFlag,
  } as const;

  // Forecast does not require the codex auth snapshot sync; it only reads
  // the per-account health/circuit state stored in ~/.codex/multi-auth.
  protected readonly syncExternalAuthBeforeRun = false;

  async run(): Promise<void> {
    const { flags } = await this.parse(Forecast);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      const service = new AccountService();
      const names = await service.listAccountNames();
      const forecasts = names.length ? forecastAccounts(names) : [];

      this.emit({ accounts: forecasts }, (data) => {
        if (!data.accounts.length) {
          this.log("No saved accounts found.");
          return;
        }
        this.log("Account Health Forecast (best first):\n");
        for (let i = 0; i < data.accounts.length; i++) {
          const h = data.accounts[i];
          const status = h.usable ? "✓" : "✗";
          this.log(
            `  [${i + 1}] ${status} ${h.name}: score=${Math.round(h.score)} circuit=${h.circuitState} tokens=${Math.round(h.tokensAvailable)}`,
          );
        }
      });
    });
  }
}
