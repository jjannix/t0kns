import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeSession } from "./claude";
import { isRecord, nonEmptyString } from "./probe-support";

const RESET_USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
const RESET_READ_TIMEOUT_MS = 1_500;

export interface ClaudeResetReadOptions {
  session: ClaudeSession;
  configDir?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Injectable transport for tests; credentials are sent only to the fixed Anthropic endpoint. */
  fetch?: typeof fetch;
}

/**
 * The CLI's get_usage doesn't opt into reset inventory. Read it separately using the same profile's
 * existing OAuth access token. Never refresh credentials, write to the profile, or redeem a grant.
 * This optional read must not turn an otherwise successful quota check into a failure.
 */
export async function readClaudeResetInventory(options: ClaudeResetReadOptions): Promise<unknown> {
  const { session, env } = options;
  if (
    session.tokenSource !== "claude.ai" ||
    (session.apiProvider !== undefined && session.apiProvider !== "firstParty") ||
    (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== "https://api.anthropic.com")
  ) {
    return undefined;
  }

  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(RESET_READ_TIMEOUT_MS)]);
  try {
    signal.throwIfAborted();
    // Relative inherited config paths are resolved just as they are for the CLI, which runs in tmpdir.
    const configDir = options.configDir ?? nonEmptyString(env.CLAUDE_CONFIG_DIR) ?? path.join(homedir(), ".claude");
    const credentials: unknown = JSON.parse(
      await readFile(path.resolve(tmpdir(), configDir, ".credentials.json"), { encoding: "utf8", signal }),
    );
    const oauth = isRecord(credentials) ? credentials.claudeAiOauth : undefined;
    if (!isRecord(oauth)) return undefined;
    const token = nonEmptyString(oauth.accessToken);
    if (
      !token ||
      typeof oauth.expiresAt !== "number" ||
      !Number.isFinite(oauth.expiresAt) ||
      oauth.expiresAt <= Date.now() ||
      !Array.isArray(oauth.scopes) ||
      !oauth.scopes.includes("user:profile")
    ) {
      return undefined;
    }

    const response = await (options.fetch ?? fetch)(RESET_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const usage: unknown = await response.json();
    return isRecord(usage) ? usage.cedar_ember : undefined;
  } catch {
    // Missing credentials, auth/scope errors, rate limits, and timeouts leave reset inventory unknown.
    // In particular, don't expose fetch errors or raw responses, which could contain credentials.
    return undefined;
  }
}
