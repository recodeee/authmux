// Config surface extracted from AccountService (Theme N2).
//
// Status reader + threshold setters + the api-usage toggle. The threshold
// setters validate the percent input via `isValidPercent` to keep the
// `AutoSwitchConfigError` message text identical to the pre-N2 wording.

import {
  AutoSwitchConfigError,
} from "../errors";
import { StatusReport } from "../types";
import {
  disableManagedService,
  enableManagedService,
  getManagedServiceState,
} from "../service-manager";
import { isValidPercent } from "../naming";
import { persistRegistry } from "../_internal/registry-ops";
import { loadReconciledRegistry } from "../read/listing";

export async function getStatus(): Promise<StatusReport> {
  const registry = await loadReconciledRegistry();
  return {
    autoSwitchEnabled: registry.autoSwitch.enabled,
    serviceState: getManagedServiceState(),
    threshold5hPercent: registry.autoSwitch.threshold5hPercent,
    thresholdWeeklyPercent: registry.autoSwitch.thresholdWeeklyPercent,
    usageMode: registry.api.usage ? "api" : "local",
  };
}

export async function setAutoSwitchEnabled(enabled: boolean): Promise<StatusReport> {
  const registry = await loadReconciledRegistry();
  registry.autoSwitch.enabled = enabled;

  if (enabled) {
    try {
      await enableManagedService();
    } catch (error) {
      registry.autoSwitch.enabled = false;
      await persistRegistry(registry);
      throw new AutoSwitchConfigError(
        `Failed to enable managed auto-switch service: ${(error as Error).message}`,
      );
    }
  } else {
    await disableManagedService();
  }

  await persistRegistry(registry);
  return getStatus();
}

export async function setApiUsageEnabled(enabled: boolean): Promise<StatusReport> {
  const registry = await loadReconciledRegistry();
  registry.api.usage = enabled;
  await persistRegistry(registry);
  return getStatus();
}

export async function configureAutoSwitchThresholds(input: {
  threshold5hPercent?: number;
  thresholdWeeklyPercent?: number;
}): Promise<StatusReport> {
  const registry = await loadReconciledRegistry();

  if (typeof input.threshold5hPercent === "number") {
    if (!isValidPercent(input.threshold5hPercent)) {
      throw new AutoSwitchConfigError("`--5h` must be an integer from 1 to 100.");
    }
    registry.autoSwitch.threshold5hPercent = Math.round(input.threshold5hPercent);
  }

  if (typeof input.thresholdWeeklyPercent === "number") {
    if (!isValidPercent(input.thresholdWeeklyPercent)) {
      throw new AutoSwitchConfigError("`--weekly` must be an integer from 1 to 100.");
    }
    registry.autoSwitch.thresholdWeeklyPercent = Math.round(input.thresholdWeeklyPercent);
  }

  await persistRegistry(registry);
  return getStatus();
}
