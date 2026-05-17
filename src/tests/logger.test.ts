// Theme X3 logger smoke tests. Focus: ring buffer + correlation IDs +
// JSON-mode line shape. We never assert on the stderr stream because the
// logger writes through `process.stderr.write` directly; the in-memory
// ring buffer is the test-friendly observation point.

import test from "node:test";
import assert from "node:assert/strict";

import {
  clearRecentLogLines,
  getRecentLogLines,
  logger,
  newCorrelationId,
} from "../infra/log/logger";

test("logger ring captures the latest events", () => {
  clearRecentLogLines();
  logger.info("hello", { a: 1 });
  logger.warn("boom", { b: "two" });

  const lines = getRecentLogLines();
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.level, "info");
  assert.equal(first.msg, "hello");
  assert.equal(first.a, 1);
  const second = JSON.parse(lines[1]);
  assert.equal(second.level, "warn");
  assert.equal(second.b, "two");
});

test("child logger injects correlationId into every event", () => {
  clearRecentLogLines();
  const cid = newCorrelationId();
  const child = logger.child({ correlationId: cid });
  child.info("daemon.cycle.start", {});
  child.info("daemon.cycle.end", { ms: 12, action: "noop" });

  const lines = getRecentLogLines().map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].correlationId, cid);
  assert.equal(lines[1].correlationId, cid);
  assert.equal(lines[1].action, "noop");
  assert.equal(lines[1].ms, 12);
});

test("newCorrelationId returns 16 hex chars", () => {
  const a = newCorrelationId();
  const b = newCorrelationId();
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.match(b, /^[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});

test("ring buffer caps at 200 entries", () => {
  clearRecentLogLines();
  for (let i = 0; i < 250; i++) {
    logger.info("event", { i });
  }
  const lines = getRecentLogLines();
  assert.equal(lines.length, 200);
  // The earliest surviving entry must be i=50 (we dropped 0..49).
  const first = JSON.parse(lines[0]);
  assert.equal(first.i, 50);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.i, 249);
});
