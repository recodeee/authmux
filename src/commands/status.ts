import { BaseCommand } from "../lib/base-command";

export default class StatusCommand extends BaseCommand {
  static description = "Show auto-switch, service, and usage status";

  static flags = {
    ...BaseCommand.jsonFlag,
  } as const;

  async run(): Promise<void> {
    const { flags } = await this.parse(StatusCommand);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      const status = await this.accounts.getStatus();
      this.emit(status, (data) => {
        this.log(`auto-switch: ${data.autoSwitchEnabled ? "ON" : "OFF"}`);
        this.log(`service: ${data.serviceState}`);
        this.log(`thresholds: 5h<${data.threshold5hPercent}%, weekly<${data.thresholdWeeklyPercent}%`);
        this.log(`usage: ${data.usageMode}`);
      });
    });
  }
}
