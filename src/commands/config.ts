import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";
import { AutoSwitchConfigError, CodexAuthError } from "../lib/accounts";

export default class ConfigCommand extends BaseCommand {
  static description = "Manage auto-switch and usage API configuration";

  static args = {
    section: Args.string({
      name: "section",
      required: true,
      options: ["auto", "api"],
      description: "Config section",
    }),
    action: Args.string({
      name: "action",
      required: false,
      description: "Action for the section",
    }),
  } as const;

  static flags = {
    "5h": Flags.integer({
      description: "Set 5h threshold percent (1-100)",
      required: false,
    }),
    weekly: Flags.integer({
      description: "Set weekly threshold percent (1-100)",
      required: false,
    }),
    ...BaseCommand.jsonFlag,
  } as const;

  async run(): Promise<void> {
    await this.runSafe(async () => {
      const { args, flags } = await this.parse(ConfigCommand);
      this.setJsonMode(flags);
      const section = args.section as "auto" | "api";
      const action = (args.action as string | undefined)?.toLowerCase();

      if (section === "auto") {
        await this.handleAutoConfig(action, flags["5h"], flags.weekly);
        return;
      }

      await this.handleApiConfig(action);
    });
  }

  private async handleAutoConfig(
    action: string | undefined,
    threshold5h: number | undefined,
    thresholdWeekly: number | undefined,
  ): Promise<void> {
    const hasThresholds = typeof threshold5h === "number" || typeof thresholdWeekly === "number";

    if (action === "enable") {
      if (hasThresholds) {
        throw new AutoSwitchConfigError(
          "`config auto` cannot mix enable/disable with threshold flags.",
        );
      }
      const status = await this.accounts.setAutoSwitchEnabled(true);
      this.emit(
        { section: "auto" as const, action: "enable" as const, status },
        (data) => {
          this.log(
            `auto-switch enabled; usage mode: ${data.status.usageMode === "api" ? "api" : "local-only"}`,
          );
        },
      );
      return;
    }

    if (action === "disable") {
      if (hasThresholds) {
        throw new AutoSwitchConfigError(
          "`config auto` cannot mix enable/disable with threshold flags.",
        );
      }
      const status = await this.accounts.setAutoSwitchEnabled(false);
      this.emit(
        { section: "auto" as const, action: "disable" as const, status },
        () => {
          this.log("auto-switch disabled");
        },
      );
      return;
    }

    if (action) {
      throw new AutoSwitchConfigError(
        `Unknown action "${action}" for \`config auto\`.`,
      );
    }

    if (!hasThresholds) {
      throw new AutoSwitchConfigError(
        "`config auto` requires `enable`, `disable`, or threshold flags.",
      );
    }

    const status = await this.accounts.configureAutoSwitchThresholds({
      threshold5hPercent: threshold5h,
      thresholdWeeklyPercent: thresholdWeekly,
    });

    this.emit(
      { section: "auto" as const, action: "thresholds" as const, status },
      (data) => {
        this.log(
          `auto-switch thresholds updated: 5h<${data.status.threshold5hPercent}%, weekly<${data.status.thresholdWeeklyPercent}%`,
        );
      },
    );
  }

  private async handleApiConfig(action: string | undefined): Promise<void> {
    if (action !== "enable" && action !== "disable") {
      throw new CodexAuthError(
        "`config api` requires `enable` or `disable`.",
      );
    }

    const status = await this.accounts.setApiUsageEnabled(action === "enable");
    this.emit(
      { section: "api" as const, action: action as "enable" | "disable", status },
      (data) => {
        this.log(`usage mode: ${data.status.usageMode}`);
      },
    );
  }
}
