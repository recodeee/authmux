#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testsDir = path.resolve(__dirname, "..", "dist", "tests");

if (!fs.existsSync(testsDir)) {
  console.error(`run-tests: ${testsDir} does not exist. Run "npm run build" first.`);
  process.exit(1);
}

const files = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(testsDir, name))
  .sort();

if (files.length === 0) {
  console.error(`run-tests: no *.test.js files found under ${testsDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });

if (result.error) {
  console.error(`run-tests: failed to spawn node: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
