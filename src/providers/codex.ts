import { createHash } from "node:crypto";
import path from "node:path";
import { QuotaError } from "../quota/errors";
import { windowLabel } from "../quota/format";
import { byExpiry, MAX_LISTED_RESETS } from "../quota/resets";
import { AccountIdentity, LimitReset, LimitResets, QuotaProvider, QuotaSnapshot, QuotaWindow } from "../quota/types";
import { isDirectory, normalizeUserPath, resolveCodexExecutable, ResolvedExecutable } from "../system/executables";
import { ProcessExit, spawnManaged } from "../system/processes";
import { JsonRpcLineClient, RpcClosedError, RpcProtocolError, RpcResponseError, RpcTimeoutError } from "./codex-rpc";
import {
  BoundedTail,
  delay,
  exitCode,
  EXTENSION_VERSION,
  finiteNumber,
  isRecord,
  nonEmptyString,
  positiveNumber,
  spawnFailure,
  truncate,
  unixToEpochMs,
  withDeadline,
} from "./probe-support";

export const CODEX_SOURCE = "codex-app-server";

/** The main metered bucket. Other buckets are model-scoped and shown after it. */
const MAIN_LIMIT_ID = "codex";

export interface CodexTimeouts {
  initializeMs: number;
  requestMs: number;
  overallMs: number;
}

export const DEFAULT_CODEX_TIMEOUTS: CodexTimeouts = { initializeMs: 10_000, requestMs: 10_000, overallMs: 30_000 };
const RESOLVE_TIMEOUT_MS = 10_000;

export interface CodexProviderConfig {
  executablePath?: string;
  codexHome?: string;
}

export function createCodexProvider(config: CodexProviderConfig): QuotaProvider {
  const codexHome = config.codexHome ? normalizeUserPath(config.codexHome) : undefined;
  const profile = codexHome ? path.resolve(codexHome) : "default";
  return {
    id: "codex",
    key: `codex:${profile}`,
    source: CODEX_SOURCE,
    profile,
    async probe(signal) {
      // File-system lookups can't be cancelled, but a slow PATH entry must not leave the UI waiting forever.
      const executable = await withDeadline(
        (async () => {
          if (codexHome && !(await isDirectory(profile))) {
            // Codex creates state in whatever CODEX_HOME it is given; never create a profile by accident.
            throw new QuotaError("invalid-config", "The configured Codex Home folder does not exist.", {
              code: "codex-home:not-found",
            });
          }
          return resolveCodexExecutable({ override: config.executablePath });
        })(),
        RESOLVE_TIMEOUT_MS,
        () => new QuotaError("timeout", "Looking for the Codex executable took too long.", { code: "timeout:resolve" }),
      );
      return probeCodex({ executable, profile, codexHome: codexHome ? profile : undefined }, signal);
    },
  };
}

export interface CodexProbeOptions {
  executable: Pick<ResolvedExecutable, "command">;
  /** Extra arguments placed before `app-server`; used by tests to run a script through Node. */
  argsPrefix?: string[];
  profile: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  timeouts?: Partial<CodexTimeouts>;
  now?: () => number;
}

/** Reads quota through `codex app-server` without starting a thread or model turn. */
export async function probeCodex(options: CodexProbeOptions, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const timeouts = { ...DEFAULT_CODEX_TIMEOUTS, ...options.timeouts };
  const now = options.now ?? Date.now;

  const controller = new AbortController();
  const overallTimer = setTimeout(
    () => controller.abort(new QuotaError("timeout", "Codex did not finish within the overall time limit.")),
    timeouts.overallMs,
  );
  const onAbort = () => controller.abort(new QuotaError("cancelled", "The request was cancelled."));
  if (signal?.aborted) {
    clearTimeout(overallTimer);
    onAbort();
    throw controller.signal.reason;
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  const env = { ...(options.env ?? process.env) };
  if (options.codexHome) {
    env.CODEX_HOME = options.codexHome;
  }

  const child = spawnManaged(options.executable.command, [...(options.argsPrefix ?? []), "app-server"], { env });
  const stderr = new BoundedTail(4096);
  child.child.stderr.setEncoding("utf8");
  child.child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  const client = new JsonRpcLineClient(child.child.stdout, child.child.stdin);
  let exit: ProcessExit | undefined;
  void child.exited.then((result) => {
    exit = result;
    // Output can trail the exit event; the client also closes on its own when stdout ends.
    setTimeout(() => client.close(new RpcClosedError("Codex exited")), 100).unref();
  });

  const call = (method: string, params: unknown, timeoutMs = timeouts.requestMs) =>
    client.request(method, params, { timeoutMs, signal: controller.signal });

  let stage = "initialize";
  try {
    const initialized = await call(
      "initialize",
      { clientInfo: { name: "t0kns", title: "t0kns", version: EXTENSION_VERSION }, capabilities: null },
      timeouts.initializeMs,
    );
    client.notify("initialized");
    const cliVersion = parseCliVersion(initialized);

    stage = "account/read";
    const account = parseCodexAccount(await call("account/read", { refreshToken: false }));

    stage = "account/rateLimits/read";
    // Reads are user-initiated, so include the reset-credit details that background polls skip.
    const rateLimits = await call("account/rateLimits/read", { excludeResetCreditDetails: false });

    return normalizeCodexRateLimits(rateLimits, {
      profile: options.profile,
      checkedAt: now(),
      email: account.email,
      plan: account.plan,
      cliVersion,
    });
  } catch (error) {
    // Let the exit event land so an early crash is reported as such rather than as a closed pipe.
    if (error instanceof RpcClosedError && !exit) {
      await Promise.race([child.exited, delay(250)]);
    }
    throw toCodexError(error, { stage, exit, stderr });
  } finally {
    clearTimeout(overallTimer);
    signal?.removeEventListener("abort", onAbort);
    client.close();
    await child.terminate();
  }
}

interface CodexAccount {
  email?: string;
  plan?: string;
}

export function parseCodexAccount(result: unknown): CodexAccount {
  if (!isRecord(result)) {
    throw new QuotaError("malformed-response", "Codex returned an unexpected account response.", {
      code: "account:shape",
    });
  }
  const account = result.account;
  if (account === null || account === undefined) {
    if (result.requiresOpenaiAuth === false) {
      throw new QuotaError(
        "unsupported-auth",
        "Codex is configured for a model provider that doesn't use ChatGPT sign-in, so there are no subscription limits to read.",
        { code: "auth:not-required" },
      );
    }
    throw new QuotaError("signed-out", "Codex is not signed in.", { code: "auth:signed-out" });
  }
  if (!isRecord(account) || typeof account.type !== "string") {
    throw new QuotaError("malformed-response", "Codex returned an unexpected account response.", {
      code: "account:shape",
    });
  }
  if (account.type === "apiKey" || account.type === "amazonBedrock") {
    throw new QuotaError(
      "unsupported-auth",
      account.type === "apiKey"
        ? "Codex is signed in with an API key. Subscription limits are only available when signed in with ChatGPT."
        : "Codex is using Amazon Bedrock. Subscription limits are only available when signed in with ChatGPT.",
      { code: `auth:${account.type}` },
    );
  }
  // Unknown account types are left for the rate-limit read to accept or reject.
  const plan = nonEmptyString(account.planType);
  return { email: nonEmptyString(account.email), plan: plan === "unknown" ? undefined : plan };
}

export interface NormalizeContext {
  profile: string;
  checkedAt: number;
  email?: string;
  plan?: string;
  cliVersion?: string;
}

interface Bucket {
  id: string;
  scope?: string;
  plan?: string;
  windows: QuotaWindow[];
}

/** Validates an `account/rateLimits/read` result and converts it to a snapshot. */
export function normalizeCodexRateLimits(payload: unknown, context: NormalizeContext): QuotaSnapshot {
  if (!isRecord(payload)) {
    throw new QuotaError("malformed-response", "Codex returned an unexpected rate-limit response.", {
      code: "rate-limits:shape",
    });
  }

  const buckets: Bucket[] = [];
  const byLimitId = isRecord(payload.rateLimitsByLimitId) ? payload.rateLimitsByLimitId : undefined;
  if (byLimitId) {
    for (const [key, value] of Object.entries(byLimitId)) {
      const bucket = parseBucket(value, key);
      if (bucket) {
        buckets.push(bucket);
      }
    }
  }

  // The legacy single-bucket view mirrors one of the multi-bucket entries. Use it only as a fallback.
  const legacy = parseBucket(payload.rateLimits, undefined);
  if (legacy) {
    const legacyHasOwnId = isRecord(payload.rateLimits) && nonEmptyString(payload.rateLimits.limitId) !== undefined;
    const alreadyListed = buckets.some((bucket) => bucket.id === legacy.id);
    if (buckets.length === 0 || (legacyHasOwnId && !alreadyListed)) {
      buckets.push(legacy);
    }
  }

  if (buckets.length === 0 && !isRecord(payload.rateLimits) && !byLimitId) {
    throw new QuotaError("malformed-response", "Codex returned a rate-limit response without limit data.", {
      code: "rate-limits:missing",
    });
  }

  buckets.sort((a, b) => {
    if (a.id === MAIN_LIMIT_ID || b.id === MAIN_LIMIT_ID) {
      return a.id === MAIN_LIMIT_ID ? (b.id === MAIN_LIMIT_ID ? 0 : -1) : 1;
    }
    return a.id.localeCompare(b.id);
  });

  const accountId = nonEmptyString(payload.accountId);
  const account: AccountIdentity | undefined =
    accountId || context.email
      ? { key: accountId ? hashIdentity(accountId) : undefined, label: context.email }
      : undefined;

  return {
    provider: "codex",
    source: CODEX_SOURCE,
    profile: context.profile,
    account,
    plan: context.plan ?? knownPlan(buckets.find((bucket) => bucket.id === MAIN_LIMIT_ID) ?? buckets[0]),
    checkedAt: context.checkedAt,
    usageAllowed: typeof payload.ordinaryUsageAllowed === "boolean" ? payload.ordinaryUsageAllowed : undefined,
    windows: buckets.flatMap((bucket) => bucket.windows),
    resets: parseCodexResets(payload.rateLimitResetCredits),
    cliVersion: context.cliVersion,
  };
}

/**
 * The `rateLimitResetCredits` summary. Credit identifiers are redemption handles, so they are dropped.
 * `credits` is null when only the count is known; a credit with an unreadable expiry is left out
 * rather than shown as never expiring.
 */
export function parseCodexResets(value: unknown): LimitResets | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const available = finiteNumber(value.availableCount);
  if (available === undefined || available < 0 || !Number.isInteger(available)) {
    return undefined;
  }
  const credits = Array.isArray(value.credits) ? value.credits : [];
  const items = credits.flatMap((credit): LimitReset[] => {
    if (!isRecord(credit) || credit.status !== "available") {
      return [];
    }
    const expiresAt = positiveNumber(credit.expiresAt);
    if (expiresAt === undefined && credit.expiresAt !== null && credit.expiresAt !== undefined) {
      return [];
    }
    const grantedAt = positiveNumber(credit.grantedAt);
    return [
      {
        title: nonEmptyString(credit.title),
        grantedAt: grantedAt === undefined ? undefined : unixToEpochMs(grantedAt),
        expiresAt: expiresAt === undefined ? undefined : unixToEpochMs(expiresAt),
      },
    ];
  });
  // The count is authoritative; the detail list may be capped but never adds resets.
  return { available, items: items.sort(byExpiry).slice(0, Math.min(available, MAX_LISTED_RESETS)) };
}

function parseBucket(value: unknown, key: string | undefined): Bucket | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmptyString(value.limitId) ?? key ?? MAIN_LIMIT_ID;
  const scope =
    id === MAIN_LIMIT_ID ? undefined : (nonEmptyString(value.limitName) ?? nonEmptyString(value.normalModelSlug) ?? id);
  const windows = (["primary", "secondary"] as const)
    .map((slot) => parseWindow(value[slot], id, slot, scope))
    .filter((window): window is QuotaWindow => window !== undefined);
  return { id, scope, plan: nonEmptyString(value.planType), windows };
}

function parseWindow(
  value: unknown,
  bucketId: string,
  slot: "primary" | "secondary",
  scope: string | undefined,
): QuotaWindow | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const raw = isRecord(value) ? value : {};
  const usedPercent = finiteNumber(raw.usedPercent);
  const durationMinutes = positiveNumber(raw.windowDurationMins);
  const resetsAt = positiveNumber(raw.resetsAt);
  return {
    id: `${bucketId}:${slot}`,
    label: windowLabel(durationMinutes) ?? (slot === "primary" ? "Primary limit" : "Secondary limit"),
    scope,
    usedPercent: usedPercent !== undefined && usedPercent >= 0 ? usedPercent : undefined,
    durationMinutes,
    resetsAt: resetsAt === undefined ? undefined : unixToEpochMs(resetsAt),
  };
}

function knownPlan(bucket: Bucket | undefined): string | undefined {
  return bucket?.plan === "unknown" ? undefined : bucket?.plan;
}

function parseCliVersion(initializeResult: unknown): string | undefined {
  const userAgent = isRecord(initializeResult) ? nonEmptyString(initializeResult.userAgent) : undefined;
  return userAgent ? /^[^/\s]+\/(\d+\.\d+\.\d+[\w.-]*)/.exec(userAgent)?.[1] : undefined;
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(`codex:${value}`).digest("hex").slice(0, 16);
}

function toCodexError(error: unknown, context: { stage: string; exit?: ProcessExit; stderr: BoundedTail }): QuotaError {
  if (error instanceof QuotaError) {
    return error;
  }

  if (context.exit?.error) {
    return spawnFailure("Codex", context.exit.error);
  }

  if (error instanceof RpcResponseError) {
    const message = error.message;
    const rpcCode = `rpc:${error.code}`;
    if (error.code === -32601 || /unknown variant/i.test(message)) {
      return new QuotaError("unsupported-version", `This Codex version doesn't support ${error.method}.`, {
        code: rpcCode,
      });
    }
    if (/authentication required|not (?:logged|signed) in|unauthori[sz]ed|\b401\b/i.test(message)) {
      return new QuotaError("signed-out", "Codex is not signed in.", { code: rpcCode, detail: truncate(message) });
    }
    if (/\b429\b|too many requests/i.test(message)) {
      return new QuotaError("rate-limited", "Codex usage requests are rate limited.", { code: rpcCode });
    }
    return new QuotaError("unavailable", `Codex couldn't complete ${error.method}.`, {
      code: rpcCode,
      detail: truncate(message),
    });
  }

  if (error instanceof RpcTimeoutError) {
    return new QuotaError("timeout", `Codex didn't respond to ${error.method} in time.`, {
      code: `timeout:${error.method}`,
    });
  }

  if (error instanceof RpcProtocolError) {
    return new QuotaError("malformed-response", "Codex sent output t0kns couldn't read.", { code: "protocol" });
  }

  if (error instanceof RpcClosedError) {
    const lastLine = context.stderr.lastLine();
    return new QuotaError("unavailable", `Codex exited unexpectedly during ${context.stage}.`, {
      code: `exit:${exitCode(context.exit)}`,
      detail: lastLine ? truncate(lastLine) : undefined,
    });
  }

  return new QuotaError("unavailable", "Unexpected error while reading Codex limits.", {
    detail: error instanceof Error ? truncate(error.message) : undefined,
    cause: error,
  });
}
