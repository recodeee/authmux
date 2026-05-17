// Theme X3 redaction guard.
//
// The diag command uses an env allowlist. This test pokes a handful of
// "obviously sensitive" var names into an isolated env, runs the
// allowlist collector, and asserts:
//   - secret-shaped values never appear in the output
//   - approved AUTHMUX_* / CODEX_AUTH_* flags do appear
//   - HOME's literal value is never emitted (length-only stand-in)

import test from "node:test";
import assert from "node:assert/strict";

import { collectEnvAllowlisted } from "../commands/diag";

test("env allowlist drops OPENAI_API_KEY and *_TOKEN/*_SECRET names", () => {
  const fakeEnv: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "sk-leak-1",
    MY_TOKEN: "leak-token",
    DB_PASSWORD: "leak-pw",
    SOME_SECRET: "leak-secret",
    AWS_ACCESS_KEY: "leak-aws",
    CODEX_AUTH_DEBUG: "1",
    AUTHMUX_LOG: "json",
    PATH: "/usr/bin",
    HOME: "/home/alice",
    NODE_ENV: "test",
  };

  const out = collectEnvAllowlisted(fakeEnv);
  const flat = out.map((e) => `${e.name}=${e.value}`).join("\n");

  // None of the secret-shaped values may appear, by name or by value.
  assert.ok(!flat.includes("sk-leak-1"), "OPENAI_API_KEY value leaked");
  assert.ok(!flat.includes("leak-token"), "*_TOKEN value leaked");
  assert.ok(!flat.includes("leak-pw"), "*_PASSWORD value leaked");
  assert.ok(!flat.includes("leak-secret"), "*_SECRET value leaked");
  assert.ok(!flat.includes("leak-aws"), "*_KEY value leaked");
  assert.ok(!flat.includes("OPENAI_API_KEY"), "OPENAI_API_KEY name leaked");
  assert.ok(!flat.includes("MY_TOKEN"), "MY_TOKEN name leaked");
  assert.ok(!flat.includes("DB_PASSWORD"), "DB_PASSWORD name leaked");
  assert.ok(!flat.includes("SOME_SECRET"), "SOME_SECRET name leaked");
  assert.ok(!flat.includes("AWS_ACCESS_KEY"), "AWS_ACCESS_KEY name leaked");

  // Approved flags do show up.
  assert.ok(flat.includes("CODEX_AUTH_DEBUG=1"), "CODEX_AUTH_DEBUG missing");
  assert.ok(flat.includes("AUTHMUX_LOG=json"), "AUTHMUX_LOG missing");
  assert.ok(flat.includes("NODE_ENV=test"), "NODE_ENV missing");
  assert.ok(flat.includes("PATH=/usr/bin"), "PATH missing");

  // HOME is in the allowlist but its literal value is replaced by a
  // length-only stand-in.
  const home = out.find((e) => e.name === "HOME");
  assert.ok(home, "HOME should be in output");
  assert.ok(
    home!.value.startsWith("<set, len="),
    `HOME value should be a length stand-in, got ${home!.value}`,
  );
  assert.ok(!flat.includes("/home/alice"), "raw HOME path leaked");
});

test("env allowlist refuses suffix-shaped names even with safe prefix", () => {
  // Defense-in-depth: an allowlist prefix must not waive the suffix check.
  const fakeEnv: NodeJS.ProcessEnv = {
    AUTHMUX_DEBUG_TOKEN: "leak-1",
    AUTHMUX_API_KEY: "leak-2",
    AUTHMUX_USER_PASSWORD: "leak-3",
    AUTHMUX_LOG_LEVEL: "info",
  };
  const out = collectEnvAllowlisted(fakeEnv);
  const flat = out.map((e) => `${e.name}=${e.value}`).join("\n");
  assert.ok(!flat.includes("leak-1"), "AUTHMUX_DEBUG_TOKEN should be filtered");
  assert.ok(!flat.includes("leak-2"), "AUTHMUX_API_KEY should be filtered");
  assert.ok(!flat.includes("leak-3"), "AUTHMUX_USER_PASSWORD should be filtered");
  assert.ok(flat.includes("AUTHMUX_LOG_LEVEL=info"), "AUTHMUX_LOG_LEVEL missing");
});
