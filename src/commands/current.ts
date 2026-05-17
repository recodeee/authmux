import { BaseCommand } from "../lib/base-command";

export default class CurrentCommand extends BaseCommand {
  static description = "Show the currently active account name";

  static flags = {
    ...BaseCommand.jsonFlag,
  } as const;

  async run(): Promise<void> {
    const { flags } = await this.parse(CurrentCommand);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      const name = await this.accounts.getCurrentAccountName();
      this.emit({ active: name ?? null }, (data) => {
        this.log(data.active ?? "No Codex account is active yet.");
      });
    });
  }
}
