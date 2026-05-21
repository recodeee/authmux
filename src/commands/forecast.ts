import { BaseCommand } from "../lib/base-command";
import { AccountService } from "../lib/accounts/account-service.js";
import { forecastAccounts } from "../lib/account-health.js";
import { listClaudeAccounts } from "../lib/accounts/claude-health";

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
      const claudeAccounts = listClaudeAccounts();

      this.emit({ accounts: forecasts, claude: claudeAccounts }, (data) => {
        if (!data.accounts.length && !data.claude.length) {
          this.log("No saved accounts found.");
          return;
        }
        if (data.accounts.length) {
          this.log("Codex Account Health Forecast (best first):\n");
          for (let i = 0; i < data.accounts.length; i++) {
            const h = data.accounts[i];
            const status = h.usable ? "✓" : "✗";
            this.log(
              `  [${i + 1}] ${status} ${h.name}: score=${Math.round(h.score)} circuit=${h.circuitState} tokens=${Math.round(h.tokensAvailable)}`,
            );
          }
        }
        if (data.claude.length) {
          this.log("\nClaude Code Account Health:\n");
          for (let i = 0; i < data.claude.length; i++) {
            const ca = data.claude[i];
            const status = ca.healthy ? "✓" : "✗";
            const daysLeft = ca.expiresAt
              ? Math.max(0, Math.round((ca.expiresAt - Date.now()) / 86400000))
              : 0;
            this.log(
              `  [${i + 1}] ${status} ${ca.name}: type=${ca.subscriptionType} expires_in=${daysLeft}d healthy=${ca.healthy}`,
            );
          }
        }
      });
    });
  }
}
