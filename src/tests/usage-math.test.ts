// Exhaustive coverage of the pure usage-math helpers extracted in
// Theme X2. These functions have zero I/O and zero env access, so we
// cover them via direct inputs only.

import test from "node:test";
import assert from "node:assert/strict";
import {
  remainingPercent,
  resolveRateWindow,
  shouldSwitchCurrent,
  usageScore,
} from "../lib/accounts/usage/math";
import type { RateLimitWindow, UsageSnapshot } from "../lib/accounts/types";

const NOW = 1_700_000_000; // arbitrary fixed `nowSeconds` for reset-time math

function snapshot(parts: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    source: "api",
    fetchedAt: "2025-01-01T00:00:00.000Z",
    ...parts,
  };
}

function window(parts: Partial<RateLimitWindow> & Pick<RateLimitWindow, "usedPercent">): RateLimitWindow {
  return { ...parts };
}

// -----------------------------------------------------------------------
// remainingPercent
// -----------------------------------------------------------------------

test("remainingPercent: undefined window -> undefined", () => {
  assert.equal(remainingPercent(undefined, NOW), undefined);
});

test("remainingPercent: 0% used -> 100", () => {
  assert.equal(remainingPercent(window({ usedPercent: 0 }), NOW), 100);
});

test("remainingPercent: 100% used -> 0", () => {
  assert.equal(remainingPercent(window({ usedPercent: 100 }), NOW), 0);
});

test("remainingPercent: 50% used -> 50", () => {
  assert.equal(remainingPercent(window({ usedPercent: 50 }), NOW), 50);
});

test("remainingPercent: fractional used is truncated", () => {
  // 100 - 33.7 = 66.3, truncated -> 66
  assert.equal(remainingPercent(window({ usedPercent: 33.7 }), NOW), 66);
});

test("remainingPercent: negative used clamped to 100", () => {
  // 100 - (-10) = 110, clamped to 100 by the upper guard
  assert.equal(remainingPercent(window({ usedPercent: -10 }), NOW), 100);
});

test("remainingPercent: >100 used clamped to 0", () => {
  // 100 - 150 = -50, clamped to 0 by the lower guard
  assert.equal(remainingPercent(window({ usedPercent: 150 }), NOW), 0);
});

test("remainingPercent: resetsAt in the past forces 100", () => {
  // Even with usedPercent at the cap, an expired reset means a full window.
  assert.equal(
    remainingPercent(window({ usedPercent: 99, resetsAt: NOW - 1 }), NOW),
    100,
  );
});

test("remainingPercent: resetsAt exactly at now still forces 100", () => {
  // Boundary case: `resetsAt <= nowSeconds` is `true` when equal.
  assert.equal(
    remainingPercent(window({ usedPercent: 80, resetsAt: NOW }), NOW),
    100,
  );
});

test("remainingPercent: resetsAt in the future does not short-circuit", () => {
  assert.equal(
    remainingPercent(window({ usedPercent: 70, resetsAt: NOW + 60 }), NOW),
    30,
  );
});

test("remainingPercent: NaN usedPercent yields NaN, but resetsAt expiry still 100", () => {
  // When the window's reset is past, the early return wins regardless of NaN.
  assert.equal(
    remainingPercent(window({ usedPercent: Number.NaN, resetsAt: NOW - 1 }), NOW),
    100,
  );
});

test("remainingPercent: NaN usedPercent without expiry falls to the trunc branch (NaN)", () => {
  // 100 - NaN = NaN. NaN <= 0 is false, NaN >= 100 is false, Math.trunc(NaN) = NaN.
  // We don't assert behavior here as "correct"; we lock in the observable.
  const result = remainingPercent(window({ usedPercent: Number.NaN }), NOW);
  assert.equal(typeof result, "number");
  assert.ok(Number.isNaN(result));
});

// -----------------------------------------------------------------------
// resolveRateWindow
// -----------------------------------------------------------------------

test("resolveRateWindow: undefined snapshot -> undefined", () => {
  assert.equal(resolveRateWindow(undefined, 300, true), undefined);
});

test("resolveRateWindow: exact primary match", () => {
  const primary = window({ usedPercent: 10, windowMinutes: 300 });
  const result = resolveRateWindow(snapshot({ primary }), 300, true);
  assert.equal(result, primary);
});

test("resolveRateWindow: exact secondary match", () => {
  const secondary = window({ usedPercent: 20, windowMinutes: 10080 });
  const result = resolveRateWindow(snapshot({ secondary }), 10080, false);
  assert.equal(result, secondary);
});

test("resolveRateWindow: primary windowMinutes mismatch + fallbackPrimary=true returns primary", () => {
  // No exact match, fallback says primary.
  const primary = window({ usedPercent: 10, windowMinutes: 60 });
  const secondary = window({ usedPercent: 20, windowMinutes: 60 });
  const result = resolveRateWindow(snapshot({ primary, secondary }), 300, true);
  assert.equal(result, primary);
});

test("resolveRateWindow: primary windowMinutes mismatch + fallbackPrimary=false returns secondary", () => {
  const primary = window({ usedPercent: 10, windowMinutes: 60 });
  const secondary = window({ usedPercent: 20, windowMinutes: 60 });
  const result = resolveRateWindow(snapshot({ primary, secondary }), 300, false);
  assert.equal(result, secondary);
});

test("resolveRateWindow: missing primary, fallbackPrimary=true returns undefined", () => {
  const secondary = window({ usedPercent: 20, windowMinutes: 60 });
  const result = resolveRateWindow(snapshot({ secondary }), 300, true);
  assert.equal(result, undefined);
});

test("resolveRateWindow: missing secondary, fallbackPrimary=false returns undefined", () => {
  const primary = window({ usedPercent: 10, windowMinutes: 60 });
  const result = resolveRateWindow(snapshot({ primary }), 300, false);
  assert.equal(result, undefined);
});

test("resolveRateWindow: undefined windowMinutes on primary never matches a request", () => {
  const primary = window({ usedPercent: 10 });
  const secondary = window({ usedPercent: 20, windowMinutes: 300 });
  const result = resolveRateWindow(snapshot({ primary, secondary }), 300, true);
  // Exact secondary match should win over the unlabelled primary.
  assert.equal(result, secondary);
});

// -----------------------------------------------------------------------
// usageScore
// -----------------------------------------------------------------------

test("usageScore: undefined snapshot -> undefined", () => {
  assert.equal(usageScore(undefined, NOW), undefined);
});

test("usageScore: snapshot with no windows -> undefined", () => {
  assert.equal(usageScore(snapshot({}), NOW), undefined);
});

test("usageScore: only 5h window -> 5h remaining", () => {
  const result = usageScore(
    snapshot({ primary: window({ usedPercent: 30, windowMinutes: 300 }) }),
    NOW,
  );
  assert.equal(result, 70);
});

test("usageScore: only weekly window -> weekly remaining", () => {
  const result = usageScore(
    snapshot({ secondary: window({ usedPercent: 10, windowMinutes: 10080 }) }),
    NOW,
  );
  assert.equal(result, 90);
});

test("usageScore: 5h and weekly both present -> min(remaining)", () => {
  const result = usageScore(
    snapshot({
      primary: window({ usedPercent: 30, windowMinutes: 300 }),
      secondary: window({ usedPercent: 10, windowMinutes: 10080 }),
    }),
    NOW,
  );
  // Remaining: 5h=70, weekly=90. min -> 70.
  assert.equal(result, 70);
});

test("usageScore: weekly tighter than 5h still returns the min", () => {
  const result = usageScore(
    snapshot({
      primary: window({ usedPercent: 10, windowMinutes: 300 }),
      secondary: window({ usedPercent: 95, windowMinutes: 10080 }),
    }),
    NOW,
  );
  // Remaining: 5h=90, weekly=5. min -> 5.
  assert.equal(result, 5);
});

test("usageScore: 5h at 0% used -> 100", () => {
  const result = usageScore(
    snapshot({ primary: window({ usedPercent: 0, windowMinutes: 300 }) }),
    NOW,
  );
  assert.equal(result, 100);
});

test("usageScore: 5h at 100% used -> 0", () => {
  const result = usageScore(
    snapshot({ primary: window({ usedPercent: 100, windowMinutes: 300 }) }),
    NOW,
  );
  assert.equal(result, 0);
});

test("usageScore: primary 5h + secondary weekly with weekly reset expired -> weekly forced to 100", () => {
  const result = usageScore(
    snapshot({
      primary: window({ usedPercent: 30, windowMinutes: 300 }),
      secondary: window({ usedPercent: 95, windowMinutes: 10080, resetsAt: NOW - 1 }),
    }),
    NOW,
  );
  // 5h=70, weekly=100 (reset expired). min -> 70.
  assert.equal(result, 70);
});

test("usageScore: windows present but neither labelled with 300/10080 -> falls back, picks min", () => {
  // primary fallback for 5h, secondary fallback for weekly.
  const result = usageScore(
    snapshot({
      primary: window({ usedPercent: 25, windowMinutes: 60 }),
      secondary: window({ usedPercent: 80, windowMinutes: 60 }),
    }),
    NOW,
  );
  // 5h fallback -> primary -> remaining 75. Weekly fallback -> secondary -> remaining 20. min -> 20.
  assert.equal(result, 20);
});

// -----------------------------------------------------------------------
// shouldSwitchCurrent
// -----------------------------------------------------------------------

const THRESHOLDS = { threshold5hPercent: 10, thresholdWeeklyPercent: 5 };

test("shouldSwitchCurrent: undefined snapshot -> false", () => {
  assert.equal(shouldSwitchCurrent(undefined, THRESHOLDS, NOW), false);
});

test("shouldSwitchCurrent: snapshot with no windows -> false", () => {
  assert.equal(shouldSwitchCurrent(snapshot({}), THRESHOLDS, NOW), false);
});

test("shouldSwitchCurrent: 5h above threshold + weekly above threshold -> false", () => {
  const usage = snapshot({
    primary: window({ usedPercent: 50, windowMinutes: 300 }),
    secondary: window({ usedPercent: 50, windowMinutes: 10080 }),
  });
  assert.equal(shouldSwitchCurrent(usage, THRESHOLDS, NOW), false);
});

test("shouldSwitchCurrent: 5h remaining below threshold5hPercent -> true", () => {
  // remaining = 9 < 10
  const usage = snapshot({
    primary: window({ usedPercent: 91, windowMinutes: 300 }),
  });
  assert.equal(shouldSwitchCurrent(usage, THRESHOLDS, NOW), true);
});

test("shouldSwitchCurrent: 5h remaining at threshold (not strictly less) -> false", () => {
  // remaining = 10, threshold = 10, predicate is `<` not `<=`.
  const usage = snapshot({
    primary: window({ usedPercent: 90, windowMinutes: 300 }),
  });
  assert.equal(shouldSwitchCurrent(usage, THRESHOLDS, NOW), false);
});

test("shouldSwitchCurrent: weekly remaining below threshold -> true", () => {
  // weekly remaining = 4 < 5
  const usage = snapshot({
    secondary: window({ usedPercent: 96, windowMinutes: 10080 }),
  });
  assert.equal(shouldSwitchCurrent(usage, THRESHOLDS, NOW), true);
});

test("shouldSwitchCurrent: both windows ok, then weekly trips -> true", () => {
  const usage = snapshot({
    primary: window({ usedPercent: 50, windowMinutes: 300 }),
    secondary: window({ usedPercent: 99, windowMinutes: 10080 }),
  });
  assert.equal(shouldSwitchCurrent(usage, THRESHOLDS, NOW), true);
});

test("shouldSwitchCurrent: expired 5h reset forces remaining to 100 -> does not trigger 5h", () => {
  // Used near cap, but the reset already passed; remaining = 100.
  const usage = snapshot({
    primary: window({ usedPercent: 99, windowMinutes: 300, resetsAt: NOW - 1 }),
  });
  assert.equal(shouldSwitchCurrent(usage, THRESHOLDS, NOW), false);
});

test("shouldSwitchCurrent: threshold of 0 never trips", () => {
  // Threshold 0 means "switch when remaining < 0", which is unreachable.
  const usage = snapshot({
    primary: window({ usedPercent: 100, windowMinutes: 300 }),
  });
  assert.equal(
    shouldSwitchCurrent(
      usage,
      { threshold5hPercent: 0, thresholdWeeklyPercent: 0 },
      NOW,
    ),
    false,
  );
});

test("shouldSwitchCurrent: missing window does not contribute to the OR", () => {
  // Only a weekly window present, 5h missing — must not crash, weekly decides.
  const usage = snapshot({
    secondary: window({ usedPercent: 50, windowMinutes: 10080 }),
  });
  assert.equal(shouldSwitchCurrent(usage, THRESHOLDS, NOW), false);
});

test("shouldSwitchCurrent: fallback windows are honored when exact match is absent", () => {
  // No window labelled 300/10080, but primary/secondary still resolve via fallback.
  const usage = snapshot({
    primary: window({ usedPercent: 95, windowMinutes: 60 }),
    secondary: window({ usedPercent: 50, windowMinutes: 60 }),
  });
  // 5h fallback -> primary -> remaining=5, below threshold 10 -> trigger.
  assert.equal(shouldSwitchCurrent(usage, THRESHOLDS, NOW), true);
});
