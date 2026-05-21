/**
 * Read Claude Code parallel account health from ~/.claude-accounts/.
 * Parses .credentials.json to extract subscription type and token expiry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CLAUDE_ACCOUNTS_DIR = path.join(os.homedir(), ".claude-accounts");

export interface ClaudeAccountHealth {
  name: string;
  configDir: string;
  subscriptionType: string;
  expiresAt: number | null;
  expired: boolean;
  healthy: boolean;
  scopes: string[];
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

export function listClaudeAccounts(): ClaudeAccountHealth[] {
  if (!fs.existsSync(CLAUDE_ACCOUNTS_DIR)) return [];

  const dirs = fs.readdirSync(CLAUDE_ACCOUNTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const accounts: ClaudeAccountHealth[] = [];

  for (const name of dirs) {
    const dir = path.join(CLAUDE_ACCOUNTS_DIR, name);
    const credsPath = path.join(dir, ".credentials.json");

    if (!fs.existsSync(credsPath)) {
      accounts.push({
        name,
        configDir: dir,
        subscriptionType: "unknown",
        expiresAt: null,
        expired: true,
        healthy: false,
        scopes: [],
      });
      continue;
    }

    try {
      const raw = fs.readFileSync(credsPath, "utf8");
      const creds = JSON.parse(raw) as ClaudeCredentials;
      const oauth = creds.claudeAiOauth;

      const expiresAt = oauth?.expiresAt ?? null;
      const expired = expiresAt !== null && expiresAt < Date.now();
      const hasToken = Boolean(oauth?.accessToken);

      accounts.push({
        name,
        configDir: dir,
        subscriptionType: oauth?.subscriptionType ?? "unknown",
        expiresAt,
        expired,
        healthy: hasToken && !expired,
        scopes: oauth?.scopes ?? [],
      });
    } catch {
      accounts.push({
        name,
        configDir: dir,
        subscriptionType: "unknown",
        expiresAt: null,
        expired: true,
        healthy: false,
        scopes: [],
      });
    }
  }

  return accounts;
}

/** Pick the healthiest Claude account (longest time until expiry). */
export function pickHealthiestClaude(): ClaudeAccountHealth | null {
  const accounts = listClaudeAccounts().filter((a) => a.healthy);
  if (accounts.length === 0) return null;
  accounts.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  return accounts[0];
}
