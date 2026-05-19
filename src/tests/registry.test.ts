import test from "node:test";
import assert from "node:assert/strict";
import { reconcileRegistryWithAccounts, sanitizeRegistry } from "../lib/accounts/registry";

test("sanitizeRegistry falls back to defaults for invalid thresholds", () => {
  const registry = sanitizeRegistry({
    autoSwitch: {
      enabled: true,
      threshold5hPercent: 0,
      thresholdWeeklyPercent: 101,
    },
    api: {
      usage: false,
    },
    accounts: {},
  });

  assert.equal(registry.autoSwitch.enabled, true);
  assert.equal(registry.autoSwitch.threshold5hPercent, 10);
  assert.equal(registry.autoSwitch.thresholdWeeklyPercent, 5);
  assert.equal(registry.api.usage, false);
});

test("sanitizeRegistry preserves the proxy usage source", () => {
  const registry = sanitizeRegistry({
    accounts: {
      foo: {
        name: "foo",
        createdAt: new Date().toISOString(),
        lastUsage: {
          primary: { usedPercent: 42 },
          fetchedAt: new Date().toISOString(),
          source: "proxy",
        },
      },
    },
  });

  assert.equal(registry.accounts.foo.lastUsage?.source, "proxy");
});

test("sanitizeRegistry preserves valid skill profiles and drops invalid names", () => {
  const registry = sanitizeRegistry({
    accounts: {
      keep: {
        name: "keep",
        createdAt: new Date().toISOString(),
        skillProfile: "frontend",
      },
      drop: {
        name: "drop",
        createdAt: new Date().toISOString(),
        skillProfile: "../all",
      },
    },
  });

  assert.equal(registry.accounts.keep.skillProfile, "frontend");
  assert.equal(registry.accounts.drop.skillProfile, undefined);
});

test("sanitizeRegistry preserves api/local/cached sources and rejects unknown", () => {
  for (const source of ["api", "local", "cached", "proxy"] as const) {
    const registry = sanitizeRegistry({
      accounts: {
        x: {
          name: "x",
          createdAt: new Date().toISOString(),
          lastUsage: {
            primary: { usedPercent: 1 },
            fetchedAt: new Date().toISOString(),
            source,
          },
        },
      },
    });
    assert.equal(registry.accounts.x.lastUsage?.source, source);
  }

  const unknown = sanitizeRegistry({
    accounts: {
      x: {
        name: "x",
        createdAt: new Date().toISOString(),
        lastUsage: {
          primary: { usedPercent: 1 },
          fetchedAt: new Date().toISOString(),
          source: "made-up",
        },
      },
    },
  });
  assert.equal(unknown.accounts.x.lastUsage?.source, "cached");
});

test("reconcileRegistryWithAccounts drops missing account entries", () => {
  const registry = sanitizeRegistry({
    accounts: {
      keep: { name: "keep", createdAt: new Date().toISOString() },
      remove: { name: "remove", createdAt: new Date().toISOString() },
    },
    activeAccountName: "remove",
  });

  const reconciled = reconcileRegistryWithAccounts(registry, ["keep"]);
  assert.deepEqual(Object.keys(reconciled.accounts), ["keep"]);
  assert.equal(reconciled.activeAccountName, undefined);
});
