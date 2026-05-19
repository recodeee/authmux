import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../lib/base-command";
import {
  activateSkillProfile,
  listAvailableSkillProfiles,
  SkillAgent,
} from "../lib/skills/profile";

type SkillAction = "list" | "current" | "use" | "activate" | "activate-current";

export default class SkillsCommand extends BaseCommand {
  protected readonly syncExternalAuthBeforeRun = false;

  static description = "Manage Soul skill profiles for Codex and Claude launches";

  static args = {
    action: Args.string({
      name: "action",
      required: false,
      description: "list, current, use, activate, or activate-current",
    }),
    profile: Args.string({
      name: "profile",
      required: false,
      description: "Skill profile name",
    }),
  } as const;

  static flags = {
    account: Flags.string({
      description: "Account to attach a profile to; defaults to current account for `use`",
    }),
    agent: Flags.string({
      description: "Agent skill target",
      options: ["codex", "claude"],
      default: "codex",
    }),
    target: Flags.string({
      description: "Explicit skills directory target",
    }),
    "no-activate": Flags.boolean({
      description: "For `use`, save metadata without activating the skills directory",
      default: false,
    }),
    ...BaseCommand.jsonFlag,
  } as const;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SkillsCommand);
    this.setJsonMode(flags);

    await this.runSafe(async () => {
      const action = this.normalizeAction(args.action as string | undefined);
      const agent = flags.agent as SkillAgent;

      if (action === "list") {
        const profiles = listAvailableSkillProfiles();
        this.emit({ profiles }, (data) => {
          for (const profile of data.profiles) this.log(profile);
        });
        return;
      }

      if (action === "current") {
        const resolved = await this.accounts.resolveCurrentSkillProfile();
        this.emit(resolved, (data) => {
          const suffix = data.accountName ? ` account=${data.accountName}` : "";
          this.log(`skill-profile: ${data.profile} source=${data.source}${suffix}`);
        });
        return;
      }

      if (action === "use") {
        const profile = this.requireProfile(args.profile as string | undefined, action);
        const accountName = flags.account ?? await this.accounts.getCurrentAccountName();
        if (!accountName) {
          this.error("No active account. Pass --account <name> or run `authmux use <account>` first.");
        }
        const saved = await this.accounts.setSkillProfileForAccount(accountName, profile);
        const activation = flags["no-activate"]
          ? undefined
          : activateSkillProfile({ profile: saved.skillProfile, agent, target: flags.target });

        this.emit({ ...saved, activation }, (data) => {
          this.log(`Saved skill profile "${data.skillProfile}" for account "${data.accountName}".`);
          if (!data.activation) return;
          this.printActivation(data.activation);
        });
        return;
      }

      if (action === "activate") {
        const profile = this.requireProfile(args.profile as string | undefined, action);
        const activation = activateSkillProfile({ profile, agent, target: flags.target });
        this.emit(activation, (data) => this.printActivation(data));
        return;
      }

      const resolved = await this.accounts.resolveCurrentSkillProfile();
      const activation = activateSkillProfile({ profile: resolved.profile, agent, target: flags.target });
      this.emit({ ...resolved, activation }, (data) => {
        this.log(`Resolved skill profile "${data.profile}" from ${data.source}.`);
        this.printActivation(data.activation);
      });
    });
  }

  private normalizeAction(raw: string | undefined): SkillAction {
    const action = (raw ?? "current").trim();
    if (
      action === "list" ||
      action === "current" ||
      action === "use" ||
      action === "activate" ||
      action === "activate-current"
    ) {
      return action;
    }
    this.error(`Unknown skills action: ${action}`);
  }

  private requireProfile(profile: string | undefined, action: string): string {
    if (!profile) {
      this.error(`Missing profile. Usage: authmux skills ${action} <profile>`);
    }
    return profile;
  }

  private printActivation(data: { activated: boolean; profile: string; target?: string; skillCount?: number; reason?: string }): void {
    if (!data.activated) {
      this.warn(`Skill profile "${data.profile}" not activated: ${data.reason ?? "unknown reason"}`);
      return;
    }
    this.log(
      `Activated skill profile "${data.profile}" at ${data.target ?? "default target"} (${data.skillCount ?? "?"} skills).`,
    );
  }
}
