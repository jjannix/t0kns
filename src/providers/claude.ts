import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { QuotaError } from "../quota/errors";
import { windowLabel } from "../quota/format";
import { byExpiry, MAX_LISTED_RESETS } from "../quota/resets";
import {
  AccountIdentity,
  LimitReset,
  LimitResets,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindow,
  UsageCredits,
  UsageShare,
} from "../quota/types";
import { isDirectory, normalizeUserPath, resolveClaudeExecutable, ResolvedExecutable } from "../system/executables";
import { ProcessExit, spawnManaged } from "../system/processes";
import { ClaudeControlClient, ControlResponseError } from "./claude-control";
import { RpcClosedError, RpcProtocolError, RpcTimeoutError } from "./codex-rpc";
import {
  BoundedTail,
  delay,
  exitCode,
  EXTENSION_VERSION,
  finiteNumber,
  isRecord,
  nonEmptyString,
  spawnFailure,
  truncate,
  withDeadline,
} from "./probe-support";

/**
 * Reads plan limits with the control request behind the Claude Agent SDK's experimental
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` method. The SDK itself can't run inside a
 * Raycast command (it reads `import.meta.url` on load, which Raycast's CommonJS bundle leaves empty), so
 * t0kns sends the same requests to the user's Claude Code CLI. Upstream may change the shape in any release.
 */
export const CLAUDE_SOURCE = "claude-code-control";

const MINUTES_PER_WEEK = 7 * 24 * 60;

/** Windows that apply to all usage. Durations are implied by the field names. */
const MAIN_WINDOWS = [
  { field: "five_hour", durationMinutes: 5 * 60 },
  { field: "seven_day", durationMinutes: MINUTES_PER_WEEK },
] as const;

/** Weekly windows for one model or client, in the response's named fields. */
const SCOPED_WINDOWS = [
  { field: "seven_day_opus", scope: "Opus" },
  { field: "seven_day_sonnet", scope: "Sonnet" },
  { field: "seven_day_oauth_apps", scope: "OAuth apps" },
] as const;

/**
 * A quota-only session: the SDK's stdio protocol, with no built-in tools, no settings files (and so no
 * hooks, plugins, or MCP servers from them), no `.mcp.json` servers, and no saved transcript.
 */
const CLAUDE_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  "--tools",
  "",
  "--setting-sources=",
  "--strict-mcp-config",
  "--no-session-persistence",
];

export interface ClaudeTimeouts {
  initializeMs: number;
  requestMs: number;
  overallMs: number;
}

export const DEFAULT_CLAUDE_TIMEOUTS: ClaudeTimeouts = { initializeMs: 15_000, requestMs: 10_000, overallMs: 30_000 };
const RESOLVE_TIMEOUT_MS = 10_000;

export interface ClaudeProviderConfig {
  executablePath?: string;
  configDir?: string;
}

export function createClaudeProvider(config: ClaudeProviderConfig): QuotaProvider {
  const configDir = config.configDir ? normalizeUserPath(config.configDir) : undefined;
  const profile = configDir ? path.resolve(configDir) : "default";
  return {
    id: "claude",
    key: `claude:${profile}`,
    source: CLAUDE_SOURCE,
    profile,
    async probe(signal) {
      // File-system lookups can't be cancelled, but a slow PATH entry must not leave the UI waiting forever.
      const executable = await withDeadline(
        (async () => {
          if (configDir && !(await isDirectory(profile))) {
            // Claude Code creates state in whatever CLAUDE_CONFIG_DIR it is given; never create a profile by accident.
            throw new QuotaError("invalid-config", "The configured Claude config folder does not exist.", {
              code: "claude-config:not-found",
            });
          }
          return resolveClaudeExecutable({ override: config.executablePath });
        })(),
        RESOLVE_TIMEOUT_MS,
        () =>
          new QuotaError("timeout", "Looking for the Claude Code executable took too long.", {
            code: "timeout:resolve",
          }),
      );
      return probeClaude({ executable, profile, configDir: configDir ? profile : undefined }, signal);
    },
  };
}

export interface ClaudeProbeOptions {
  executable: Pick<ResolvedExecutable, "command">;
  /** Extra arguments placed before Claude Code's own; used by tests to run a script through Node. */
  argsPrefix?: string[];
  profile: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  timeouts?: Partial<ClaudeTimeouts>;
  now?: () => number;
}

/** Reads plan limits from Claude Code without sending a prompt, so no model turn starts. */
export async function probeClaude(options: ClaudeProbeOptions, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const timeouts = { ...DEFAULT_CLAUDE_TIMEOUTS, ...options.timeouts };
  const now = options.now ?? Date.now;

  const controller = new AbortController();
  const overallTimer = setTimeout(
    () => controller.abort(new QuotaError("timeout", "Claude Code did not finish within the overall time limit.")),
    timeouts.overallMs,
  );
  const onAbort = () => controller.abort(new QuotaError("cancelled", "The request was cancelled."));
  if (signal?.aborted) {
    clearTimeout(overallTimer);
    onAbort();
    throw controller.signal.reason;
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  const child = spawnManaged(options.executable.command, [...(options.argsPrefix ?? []), ...CLAUDE_ARGS], {
    env: claudeEnvironment(options.env ?? process.env, options.configDir),
    // A neutral folder: no project's files are involved in reading account limits.
    cwd: tmpdir(),
  });
  const stderr = new BoundedTail(4096);
  child.child.stderr.setEncoding("utf8");
  child.child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  const client = new ClaudeControlClient(child.child.stdout, child.child.stdin);
  let exit: ProcessExit | undefined;
  void child.exited.then((result) => {
    exit = result;
    // Output can trail the exit event; the client also closes on its own when stdout ends.
    setTimeout(() => client.close(new RpcClosedError("Claude Code exited")), 100).unref();
  });

  const call = (subtype: string, params: Record<string, unknown>, timeoutMs = timeouts.requestMs) =>
    client.request(subtype, params, { timeoutMs, signal: controller.signal });

  let stage = "initialize";
  try {
    const session = parseClaudeInitialize(await call("initialize", {}, timeouts.initializeMs));

    stage = "get_usage";
    // Skips the scan of local transcripts that only feeds the /usage dialog's breakdown.
    const usage = await call("get_usage", { skip_behaviors: true });

    return normalizeClaudeUsage(usage, { ...session, profile: options.profile, checkedAt: now() });
  } catch (error) {
    // Let the exit event land so an early crash is reported as such rather than as a closed pipe.
    if (error instanceof RpcClosedError && !exit) {
      await Promise.race([child.exited, delay(250)]);
    }
    throw toClaudeError(error, { stage, exit, stderr });
  } finally {
    clearTimeout(overallTimer);
    signal?.removeEventListener("abort", onAbort);
    client.close();
    await child.terminate();
  }
}

/**
 * The user's environment plus what the Agent SDK sets: its entry-point marker, with t0kns named as the
 * client app. The marker replaces any inherited one, since this is always an SDK-protocol session.
 * `NODE_OPTIONS` and `DEBUG` are dropped, as the SDK does, so they can't change the CLI's output.
 */
function claudeEnvironment(base: NodeJS.ProcessEnv, configDir: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_AGENT_SDK_CLIENT_APP: `t0kns/${EXTENSION_VERSION}`,
  };
  delete env.NODE_OPTIONS;
  delete env.DEBUG;
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return env;
}

/** Account and CLI details from the `initialize` response. */
export interface ClaudeSession {
  email?: string;
  organization?: string;
  /** `none` when Claude Code has no subscription sign-in. */
  tokenSource?: string;
  /** Set when an API key is in use, e.g. `ANTHROPIC_API_KEY`. */
  apiKeySource?: string;
  /** `firstParty` for Anthropic sign-in; otherwise Bedrock, Vertex, a gateway, and so on. */
  apiProvider?: string;
  cliVersion?: string;
}

export function parseClaudeInitialize(result: unknown): ClaudeSession {
  if (!isRecord(result)) {
    throw new QuotaError("malformed-response", "Claude Code returned an unexpected initialize response.", {
      code: "initialize:shape",
    });
  }
  const account = isRecord(result.account) ? result.account : {};
  return {
    email: nonEmptyString(account.email),
    organization: nonEmptyString(account.organization),
    tokenSource: nonEmptyString(account.tokenSource),
    apiKeySource: nonEmptyString(account.apiKeySource),
    apiProvider: nonEmptyString(account.apiProvider),
    cliVersion: nonEmptyString(result.claude_code_version),
  };
}

export interface ClaudeNormalizeContext extends ClaudeSession {
  profile: string;
  checkedAt: number;
}

/** Validates a `get_usage` result and converts its plan limits to a snapshot. */
export function normalizeClaudeUsage(payload: unknown, context: ClaudeNormalizeContext): QuotaSnapshot {
  if (!isRecord(payload) || typeof payload.rate_limits_available !== "boolean") {
    throw new QuotaError("malformed-response", "Claude Code returned an unexpected usage response.", {
      code: "usage:shape",
    });
  }
  if (!payload.rate_limits_available) {
    throw noPlanLimits(context);
  }
  const limits = payload.rate_limits;
  if (limits === null || limits === undefined) {
    // Limits apply to this account but weren't loaded; keep the last reading rather than show none.
    throw new QuotaError("unavailable", "Claude Code couldn't load plan limits.", { code: "usage:no-data" });
  }
  if (!isRecord(limits)) {
    throw new QuotaError("malformed-response", "Claude Code returned unexpected plan limits.", {
      code: "usage:rate-limits",
    });
  }

  const main = MAIN_WINDOWS.map(({ field, durationMinutes }) =>
    parseWindow(limits[field], `claude:${field}`, durationMinutes, undefined),
  ).filter((window): window is QuotaWindow => window !== undefined);
  const weekly = main.find((window) => window.id === "claude:seven_day");
  const breakdown = parseUsageBreakdown(limits.seven_day_breakdown, weekly);
  if (weekly && breakdown) {
    weekly.breakdown = breakdown;
  }

  const scoped = new Map<string, QuotaWindow>();
  const modelScoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : [];
  for (const entry of modelScoped) {
    const name = isRecord(entry) ? nonEmptyString(entry.display_name) : undefined;
    const window = name ? parseWindow(entry, `claude:model:${slug(name)}`, MINUTES_PER_WEEK, name) : undefined;
    if (window && !scoped.has(window.id)) {
      scoped.set(window.id, window);
    }
  }
  // The named fields predate `model_scoped` and may describe the same window; prefer the newer entry.
  const scopes = new Set([...scoped.values()].map((window) => window.scope?.toLowerCase()));
  for (const { field, scope } of SCOPED_WINDOWS) {
    const window = scopes.has(scope.toLowerCase())
      ? undefined
      : parseWindow(limits[field], `claude:${field}`, MINUTES_PER_WEEK, scope);
    if (window) {
      scoped.set(window.id, window);
    }
  }

  const account: AccountIdentity | undefined = context.email
    ? { key: hashIdentity(`${context.email.toLowerCase()}\n${context.organization ?? ""}`), label: context.email }
    : undefined;

  return {
    provider: "claude",
    source: CLAUDE_SOURCE,
    profile: context.profile,
    account,
    plan: nonEmptyString(payload.subscription_type),
    checkedAt: context.checkedAt,
    windows: [...main, ...[...scoped.values()].sort((a, b) => (a.scope ?? "").localeCompare(b.scope ?? ""))],
    resets: parseClaudeResets(limits.cedar_ember, context.checkedAt),
    credits: parseUsageCredits(limits.extra_usage),
    cliVersion: context.cliVersion,
  };
}

/**
 * Usage credits from the `extra_usage` block, which the Agent SDK documents as overage spend for the billing
 * period in minor units of `currency` (cents for USD), with `is_enabled` false while it can't cover requests.
 * Claude Code assumes USD when no currency is given, and so does this.
 */
export function parseUsageCredits(value: unknown): UsageCredits | undefined {
  if (!isRecord(value) || typeof value.is_enabled !== "boolean") {
    return undefined;
  }
  const amount = (raw: unknown) => {
    const number = finiteNumber(raw);
    return number !== undefined && number >= 0 ? number : undefined;
  };
  const used = amount(value.used_credits);
  const monthlyLimit = amount(value.monthly_limit);
  const currency = nonEmptyString(value.currency);
  return {
    enabled: value.is_enabled,
    used,
    monthlyLimit,
    usedPercent:
      amount(value.utilization) ??
      (used !== undefined && monthlyLimit !== undefined && monthlyLimit > 0 ? (used / monthlyLimit) * 100 : undefined),
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "USD",
  };
}

/** How far a breakdown's window start may drift from the weekly window's before it is taken as another week. */
const BREAKDOWN_START_TOLERANCE_MS = 60 * 60_000;

/**
 * How the weekly window's usage splits across products (Claude Code, chats, Cowork, …), from the
 * `seven_day_breakdown` block: largest share first, products without usage left out. Dropped when its
 * `window_started_at` belongs to a different week than the weekly window, e.g. a breakdown from before a reset.
 */
export function parseUsageBreakdown(value: unknown, weekly: QuotaWindow | undefined): UsageShare[] | undefined {
  if (!weekly || !isRecord(value) || !Array.isArray(value.rows)) {
    return undefined;
  }
  const startedAt = parseTimestamp(value.window_started_at);
  if (
    startedAt !== undefined &&
    weekly.resetsAt !== undefined &&
    Math.abs(weekly.resetsAt - MINUTES_PER_WEEK * 60_000 - startedAt) > BREAKDOWN_START_TOLERANCE_MS
  ) {
    return undefined;
  }
  const shares = value.rows.flatMap((row): UsageShare[] => {
    const label = isRecord(row) ? nonEmptyString(row.display_name) : undefined;
    const percent = isRecord(row) ? finiteNumber(row.percent) : undefined;
    return label && percent !== undefined && percent > 0 && percent <= 100 ? [{ label, percent }] : [];
  });
  return shares.length > 0 ? shares.sort((a, b) => b.percent - a.percent) : undefined;
}

/**
 * Saved usage-limit resets ("Reset for free" on claude.ai) from the `cedar_ember` block, shaped
 * `{ eligible, grants: [{ resets_left, starts_at, ends_at, paused }] }` as observed by CodexBar. Claude Code's
 * `get_usage` reads the usage endpoint without opting into this block, so it is usually null; it is read
 * whenever present. Grant identifiers are redemption handles and are never read. A grant that is paused,
 * not yet started, expired, or has an unreadable bound is left out without hiding the others.
 */
export function parseClaudeResets(value: unknown, checkedAt: number): LimitResets | undefined {
  if (!isRecord(value) || value.eligible !== true || !Array.isArray(value.grants)) {
    return undefined;
  }
  let available = 0;
  const items: LimitReset[] = [];
  for (const grant of value.grants) {
    if (!isRecord(grant) || grant.paused !== false) {
      continue;
    }
    const left = finiteNumber(grant.resets_left);
    const startsAt = parseBound(grant.starts_at);
    const endsAt = parseBound(grant.ends_at);
    if (left === undefined || left <= 0 || !Number.isInteger(left) || startsAt === null || endsAt === null) {
      continue;
    }
    if ((startsAt !== undefined && startsAt > checkedAt) || (endsAt !== undefined && endsAt <= checkedAt)) {
      continue;
    }
    available += left;
    for (let i = 0; i < left && items.length < MAX_LISTED_RESETS; i++) {
      items.push({ expiresAt: endsAt });
    }
  }
  return { available, items: items.sort(byExpiry) };
}

/** An absent bound is open (undefined); a supplied but unreadable one is malformed (null), never open. */
function parseBound(value: unknown): number | undefined | null {
  if (value === null || value === undefined) {
    return undefined;
  }
  return parseTimestamp(value) ?? null;
}

function parseWindow(
  value: unknown,
  id: string,
  durationMinutes: number,
  scope: string | undefined,
): QuotaWindow | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const raw = isRecord(value) ? value : {};
  // Already a percentage (0–100), unlike the 0–1 fractions in the CLI's turn-time rate-limit events.
  const usedPercent = finiteNumber(raw.utilization);
  return {
    id,
    label: windowLabel(durationMinutes) ?? "Limit",
    scope,
    usedPercent: usedPercent !== undefined && usedPercent >= 0 ? usedPercent : undefined,
    durationMinutes,
    resetsAt: parseTimestamp(raw.resets_at),
  };
}

/** ISO 8601 to epoch milliseconds; undefined when absent or unparseable. */
function parseTimestamp(value: unknown): number | undefined {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

/** Why plan limits don't apply, from the account Claude Code reported at initialize. */
function noPlanLimits(session: ClaudeSession): QuotaError {
  const provider = session.apiProvider;
  if (provider && provider !== "firstParty") {
    return new QuotaError(
      "unsupported-auth",
      `Claude Code is using ${API_PROVIDERS[provider] ?? "a provider other than Anthropic"}. Subscription limits are only available when signed in with a Claude account.`,
      { code: `auth:${/^\w{1,32}$/.test(provider) ? provider : "provider"}` },
    );
  }
  if (session.apiKeySource) {
    // Name a plain source such as ANTHROPIC_API_KEY or apiKeyHelper; never echo anything shaped like a key.
    const source = /^[A-Za-z_][\w ]{0,47}$/.test(session.apiKeySource) ? ` (${session.apiKeySource})` : "";
    return new QuotaError(
      "unsupported-auth",
      `Claude Code is using an API key${source}. Subscription limits are only available when signed in with a Claude account.`,
      { code: "auth:apiKey" },
    );
  }
  if (!session.tokenSource || session.tokenSource === "none") {
    return new QuotaError("signed-out", "Claude Code is not signed in.", { code: "auth:signed-out" });
  }
  return new QuotaError(
    "unsupported-auth",
    "Claude Code's sign-in can't read plan limits. Tokens from `claude setup-token`, for example, can only run models.",
    { code: "auth:no-plan-limits" },
  );
}

const API_PROVIDERS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  mantle: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  anthropicAws: "Claude Platform on AWS",
  anthropicGoogleCloud: "Claude on Google Cloud",
  gateway: "an enterprise gateway",
};

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "model"
  );
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(`claude:${value}`).digest("hex").slice(0, 16);
}

function toClaudeError(
  error: unknown,
  context: { stage: string; exit?: ProcessExit; stderr: BoundedTail },
): QuotaError {
  if (error instanceof QuotaError) {
    return error;
  }

  if (context.exit?.error) {
    return spawnFailure("Claude Code", context.exit.error);
  }

  if (error instanceof ControlResponseError) {
    const message = error.message;
    if (/unsupported control request subtype/i.test(message)) {
      return new QuotaError("unsupported-version", "This Claude Code version can't report plan limits.", {
        code: `control:unsupported:${error.subtype}`,
      });
    }
    if (
      /\b401\b|unauthori[sz]ed|not (?:logged|signed) in|log ?in again|\/login\b|token (?:has )?expired/i.test(message)
    ) {
      return new QuotaError("signed-out", "Claude Code is not signed in.", {
        code: `control:${error.subtype}`,
        detail: truncate(message),
      });
    }
    if (/\b429\b|too many requests|rate[- ]limited/i.test(message)) {
      return new QuotaError("rate-limited", "Claude Code usage requests are rate limited.", {
        code: `control:${error.subtype}`,
      });
    }
    return new QuotaError("unavailable", `Claude Code couldn't complete ${error.subtype}.`, {
      code: `control:${error.subtype}`,
      detail: truncate(message),
    });
  }

  if (error instanceof RpcTimeoutError) {
    return new QuotaError("timeout", `Claude Code didn't respond to ${error.method} in time.`, {
      code: `timeout:${error.method}`,
    });
  }

  if (error instanceof RpcProtocolError) {
    return new QuotaError("malformed-response", "Claude Code sent output t0kns couldn't read.", { code: "protocol" });
  }

  if (error instanceof RpcClosedError) {
    const lastLine = context.stderr.lastLine();
    const detail = lastLine ? truncate(lastLine) : undefined;
    if (lastLine && /unknown option|unrecognized option/i.test(lastLine)) {
      return new QuotaError("unsupported-version", "This Claude Code version doesn't support a quota-only session.", {
        code: `exit:${exitCode(context.exit)}`,
        detail,
      });
    }
    return new QuotaError("unavailable", `Claude Code exited unexpectedly during ${context.stage}.`, {
      code: `exit:${exitCode(context.exit)}`,
      detail,
    });
  }

  return new QuotaError("unavailable", "Unexpected error while reading Claude Code limits.", {
    detail: error instanceof Error ? truncate(error.message) : undefined,
    cause: error,
  });
}
