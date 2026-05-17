// Tiny structured logger for Theme X3 (Observability v1).
//
// Zero transitive deps; only `node:` built-ins. Default mode is a
// human-readable single line to stderr. `AUTHMUX_LOG=json` switches to
// JSON-lines (one event per line) so log aggregators can parse without
// a regex. The event shape is pin-compatible with `AuthmuxError.toJSON()`
// from N3 — both serialize a `code` (or a `msg`) plus a `details`-style
// bag of structured fields.
//
// A small in-memory ring buffer keeps the last 200 JSON-encoded lines for
// `authmux diag` to bundle. It never persists to disk.

import { randomBytes } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(extra: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.AUTHMUX_LOG_LEVEL || "").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function resolveMode(): "json" | "pretty" {
  const raw = (process.env.AUTHMUX_LOG || "").trim().toLowerCase();
  return raw === "json" ? "json" : "pretty";
}

// In-memory ring buffer of the last 200 JSON-line records. The buffer is
// always JSON-shaped regardless of the active mode so `authmux diag` can
// emit a uniform tail.
const RING_CAPACITY = 200;
const ring: string[] = [];

function pushRing(line: string): void {
  if (ring.length >= RING_CAPACITY) ring.shift();
  ring.push(line);
}

export function getRecentLogLines(): string[] {
  return ring.slice();
}

export function clearRecentLogLines(): void {
  ring.length = 0;
}

export function newCorrelationId(): string {
  return randomBytes(8).toString("hex");
}

function writeLine(line: string): void {
  // Stderr to keep stdout clean for command output / `--json` envelopes.
  try {
    process.stderr.write(line + "\n");
  } catch {
    // best-effort
  }
}

function formatPretty(
  level: LogLevel,
  ts: string,
  msg: string,
  fields: LogFields,
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    let serialized: string;
    if (typeof v === "string") {
      serialized = /\s|"|=/.test(v) ? JSON.stringify(v) : v;
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      serialized = String(v);
    } else {
      try {
        serialized = JSON.stringify(v);
      } catch {
        serialized = String(v);
      }
    }
    parts.push(`${k}=${serialized}`);
  }
  const tail = parts.length > 0 ? " " + parts.join(" ") : "";
  return `${level.toUpperCase()} ${ts} ${msg}${tail}`;
}

function emit(
  level: LogLevel,
  msg: string,
  fields: LogFields,
  bound: LogFields,
): void {
  if (LEVELS[level] < LEVELS[resolveLevel()]) return;

  const ts = new Date().toISOString();
  // Merge bound (child) fields under user-provided fields. User wins on
  // collision so callers can override correlationId per-call if needed.
  const merged: LogFields = { ...bound, ...fields };

  // Always cache a JSON line in the ring for diag.
  const jsonEvent = { level, ts, msg, ...merged };
  let jsonLine: string;
  try {
    jsonLine = JSON.stringify(jsonEvent);
  } catch {
    jsonLine = JSON.stringify({ level, ts, msg, _serializeError: true });
  }
  pushRing(jsonLine);

  if (resolveMode() === "json") {
    writeLine(jsonLine);
  } else {
    writeLine(formatPretty(level, ts, msg, merged));
  }
}

function makeLogger(bound: LogFields): Logger {
  return {
    debug(msg, fields) {
      emit("debug", msg, fields ?? {}, bound);
    },
    info(msg, fields) {
      emit("info", msg, fields ?? {}, bound);
    },
    warn(msg, fields) {
      emit("warn", msg, fields ?? {}, bound);
    },
    error(msg, fields) {
      emit("error", msg, fields ?? {}, bound);
    },
    child(extra) {
      return makeLogger({ ...bound, ...extra });
    },
  };
}

export const logger: Logger = makeLogger({});
