// Identity equality helpers extracted from AccountService (Theme N2).
// Pure functions over ParsedAuthSnapshot / AccountRegistryEntry — no I/O,
// no globals. Two snapshots "share identity" when they describe the same
// upstream account (same userId + accountId, or same email as fallback).

import { AccountRegistryEntry, ParsedAuthSnapshot } from "../types";

export function snapshotsShareIdentity(
  a: ParsedAuthSnapshot,
  b: ParsedAuthSnapshot,
): boolean {
  if (a.authMode !== "chatgpt" || b.authMode !== "chatgpt") {
    return false;
  }

  if (a.userId && b.userId && a.accountId && b.accountId) {
    return a.userId === b.userId && a.accountId === b.accountId;
  }

  if (a.accountId && b.accountId) {
    return a.accountId === b.accountId;
  }

  if (a.userId && b.userId) {
    return a.userId === b.userId;
  }

  const aEmail = a.email?.trim().toLowerCase();
  const bEmail = b.email?.trim().toLowerCase();
  if (aEmail && bEmail) {
    return aEmail === bEmail;
  }

  return false;
}

export function snapshotsShareEmail(
  a: ParsedAuthSnapshot,
  b: ParsedAuthSnapshot,
): boolean {
  const aEmail = a.email?.trim().toLowerCase();
  const bEmail = b.email?.trim().toLowerCase();
  return Boolean(aEmail && bEmail && aEmail === bEmail);
}

export function registryEntrySharesIdentity(
  entry: AccountRegistryEntry,
  snapshot: ParsedAuthSnapshot,
): boolean {
  if (snapshot.authMode !== "chatgpt") {
    return false;
  }

  if (entry.userId && snapshot.userId && entry.accountId && snapshot.accountId) {
    return entry.userId === snapshot.userId && entry.accountId === snapshot.accountId;
  }

  if (entry.accountId && snapshot.accountId) {
    return entry.accountId === snapshot.accountId;
  }

  if (entry.userId && snapshot.userId) {
    return entry.userId === snapshot.userId;
  }

  return registryEntrySharesEmail(entry, snapshot);
}

export function registryEntrySharesEmail(
  entry: AccountRegistryEntry,
  snapshot: ParsedAuthSnapshot,
): boolean {
  const entryEmail = entry.email?.trim().toLowerCase();
  const snapshotEmail = snapshot.email?.trim().toLowerCase();
  return Boolean(entryEmail && snapshotEmail && entryEmail === snapshotEmail);
}

export function renderSnapshotIdentity(
  snapshot: ParsedAuthSnapshot,
  fallbackEmail: string,
): string {
  const parts = [fallbackEmail];
  if (snapshot.accountId) parts.push(`account:${snapshot.accountId}`);
  if (snapshot.userId) parts.push(`user:${snapshot.userId}`);
  return parts.join(" | ");
}
