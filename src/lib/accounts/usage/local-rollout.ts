// Walk `~/.codex/sessions/` for the most recent `rollout-*.jsonl` records
// and parse usage snapshots out of them. No HTTP, no env-var auth.
// Extracted from `accounts/usage.ts` in Theme X2.

import fsp from "node:fs/promises";
import path from "node:path";
import { UsageSnapshot } from "../types";
import {
  buildSnapshotFromRateLimits,
  findNestedRateLimits,
  parseTimestampSeconds,
} from "./_internal/snapshot-parsers";

const ROLLOUT_FILE_LIMIT = 5;

async function collectRolloutFiles(sessionsDir: string): Promise<string[]> {
  const pending: string[] = [sessionsDir];
  const rolloutFiles: Array<{ filePath: string; mtimeMs: number }> = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;

      try {
        const stat = await fsp.stat(fullPath);
        rolloutFiles.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore unreadable files
      }
    }
  }

  rolloutFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rolloutFiles.slice(0, ROLLOUT_FILE_LIMIT).map((entry) => entry.filePath);
}

async function parseRolloutForUsage(
  filePath: string,
): Promise<{ snapshot: UsageSnapshot; timestampSeconds: number } | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let latest: { snapshot: UsageSnapshot; timestampSeconds: number } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: unknown;
    try {
      record = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }

    const rateLimits = findNestedRateLimits(record);
    const snapshot = buildSnapshotFromRateLimits(rateLimits, "local");
    if (!snapshot) continue;

    const row = record as Record<string, unknown>;
    const timestampSeconds = parseTimestampSeconds(
      row.event_timestamp_ms ?? row.timestamp_ms ?? row.timestamp,
    );

    if (!latest || timestampSeconds >= latest.timestampSeconds) {
      latest = {
        snapshot,
        timestampSeconds,
      };
    }
  }

  return latest;
}

export async function fetchUsageFromLocal(codexDir: string): Promise<UsageSnapshot | null> {
  const sessionsDir = path.join(codexDir, "sessions");
  const files = await collectRolloutFiles(sessionsDir);
  for (const filePath of files) {
    const latest = await parseRolloutForUsage(filePath);
    if (latest) {
      return latest.snapshot;
    }
  }

  return null;
}
