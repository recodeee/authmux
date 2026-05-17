import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";

export default class SaveCommand extends BaseCommand {
  static description =
    "Save the current ~/.codex/auth.json as a named account (or infer one from auth email)";

  static args = {
    name: Args.string({
      name: "name",
      required: false,
      description: "Optional account snapshot name. If omitted, inferred from auth email",
    }),
  } as const;

  static flags = {
    force: Flags.boolean({
      char: "f",
      description:
        "Force overwrite when the existing snapshot name belongs to a different email account",
      default: false,
    }),
    ...BaseCommand.jsonFlag,
  } as const;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SaveCommand);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      const providedName = args.name as string | undefined;
      const resolvedName = providedName
        ? { name: providedName, source: "explicit" as const, forceOverwrite: false }
        : await this.accounts.resolveDefaultAccountNameFromCurrentAuth();
      const savedName = await this.accounts.saveAccount(resolvedName.name, {
        force: Boolean(flags.force || resolvedName.forceOverwrite),
      });

      this.emit(
        {
          saved: savedName,
          source: resolvedName.source,
          forced: Boolean(flags.force || resolvedName.forceOverwrite),
        },
        (data) => {
          const suffix =
            data.source === "explicit"
              ? ""
              : data.source === "active"
                ? " (reused active account name)"
                : data.source === "existing"
                  ? " (reused saved account name)"
                  : " (inferred from auth email)";
          this.log(`Saved current Codex auth tokens as "${data.saved}"${suffix}.`);
        },
      );
    });
  }
}
