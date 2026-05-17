import { Command, Flags } from "@oclif/core";
import { accountService, AuthmuxError, CodexAuthError } from "./accounts";
import {
  exitCodeForErrorCode,
  jsonSuccess,
  writeJsonEnvelope,
} from "./cli/json-envelope";

export abstract class BaseCommand extends Command {
  protected readonly accounts = accountService;
  protected readonly syncExternalAuthBeforeRun: boolean = true;

  // Per-command JSON support. Commands that opt in must include
  // `...BaseCommand.jsonFlag` in their static flags.
  static jsonFlag = {
    json: Flags.boolean({
      description: "Emit a single JSON envelope to stdout (Theme N3).",
      default: false,
    }),
  } as const;

  // Set by the per-command parse to route output/error formatting.
  protected jsonMode = false;

  protected async runSafe(action: () => Promise<void>): Promise<void> {
    try {
      if (this.syncExternalAuthBeforeRun) {
        await this.accounts.syncExternalAuthSnapshotIfNeeded();
      }
      await action();
    } catch (error) {
      this.handleError(error);
    }
  }

  // For commands that produce a structured payload. When `--json` is on,
  // emits `{ ok: true, data }` and suppresses any human text the caller
  // would have written. Otherwise calls `humanPrinter(data)`.
  protected emit<T>(data: T, humanPrinter: (data: T) => void): void {
    if (this.jsonMode) {
      writeJsonEnvelope(jsonSuccess(data));
      return;
    }
    humanPrinter(data);
  }

  // Read the parsed --json flag and remember it for the rest of the run.
  // Call this once from inside `run()` after `await this.parse(...)`.
  protected setJsonMode(flags: { json?: boolean }): void {
    this.jsonMode = Boolean(flags.json);
  }

  private handleError(error: unknown): never {
    if (error instanceof AuthmuxError) {
      if (this.jsonMode) {
        writeJsonEnvelope(error.toJSON());
        return this.exit(exitCodeForErrorCode(error.code)) as never;
      }
      // Human path: keep historical wording exactly. oclif `this.error`
      // sets exit=2 by default, which is "usage error". Use a structured
      // exit code from the §6.3 table instead.
      process.stderr.write(`Error: ${error.message}\n`);
      return this.exit(exitCodeForErrorCode(error.code)) as never;
    }

    // Legacy: pre-N3 subclasses that didn't migrate. Preserved for safety
    // — `CodexAuthError` now extends `AuthmuxError`, so this branch is
    // effectively dead, but kept to surface non-Authmux errors.
    if (error instanceof CodexAuthError) {
      this.error((error as Error).message);
    }

    throw error;
  }
}
