import { QuotaError } from "../quota/errors";
import { windowLabel } from "../quota/format";
import { QuotaProvider, QuotaSnapshot, QuotaWindow, UsageShare } from "../quota/types";
import { finiteNumber, isRecord, nonEmptyString, positiveNumber, truncate, unixToEpochMs } from "./probe-support";

/** Integration that produced the reading. */
export const GLM_SOURCE = "glm-monitor-api";

const GLM_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const MINUTES_PER_MONTH = 30 * 24 * 60;

/**
 * Business codes in the response body, from https://docs.z.ai/api-reference/api-code. Z.ai reports most
 * failures as HTTP 200 with `success: false`, so the body decides and the HTTP status is only the fallback.
 * 1002 and 1004 aren't listed there but sit in the authentication range. A key in the wrong format, such as
 * one from another vendor, is answered with a plain 401 or 403 in the body ("token expired or incorrect").
 */
const AUTH_CODES = new Set([401, 403, 1000, 1001, 1002, 1003, 1004, 1005]);
/** No resource package (1113), or a Coding Plan that has expired or doesn't apply (1309, 1311, 1313-1315). */
const PLAN_CODES = new Set([1113, 1309, 1311, 1313, 1314, 1315]);
const RATE_LIMIT_CODES = new Set([429, 1302]);
/** Network error (1234) and "temporarily overloaded" (1305). */
const UNAVAILABLE_CODES = new Set([1234, 1305]);

/**
 * The windows t0kns understands, in display order. The response identifies a window by limit type, unit
 * (3 = hours, 5 = months, 6 = weeks), and number of units, never by position. Pro plans report the token
 * windows as `CREDIT_LIMIT`.
 */
const WINDOWS = [
  { id: "glm:five_hour", types: ["TOKENS_LIMIT", "CREDIT_LIMIT"], unit: 3, number: 5, durationMinutes: 5 * 60 },
  { id: "glm:weekly", types: ["TOKENS_LIMIT", "CREDIT_LIMIT"], unit: 6, number: 1, durationMinutes: 7 * 24 * 60 },
  // Calls to the plan's search, reader, and repository tools. It doesn't cap model usage, so it is scoped
  // and stays out of the account-wide summaries unless pinned.
  {
    id: "glm:mcp_monthly",
    types: ["TIME_LIMIT"],
    unit: 5,
    number: 1,
    durationMinutes: MINUTES_PER_MONTH,
    label: "Monthly limit",
    scope: "MCP tools",
  },
] as const;

/** Display names for the tools in a window's `usageDetails`. Unknown tools keep their reported code. */
const TOOL_NAMES: Record<string, string> = {
  "search-prime": "Web search",
  "web-reader": "Web reader",
  zread: "Zread",
};

export const DEFAULT_GLM_TIMEOUT_MS = 15_000;

export interface GlmProviderConfig {
  apiKey?: string;
}

/**
 * Reads GLM Coding Plan limits from the monitoring endpoint behind Z.ai's usage page, with the user's API key.
 * The endpoint is undocumented, so upstream may change the shape without notice. Only Z.ai keys against
 * api.z.ai are verified; no other region or host is used.
 */
export function createGlmProvider(config: GlmProviderConfig): QuotaProvider {
  return {
    id: "glm",
    key: "glm:default",
    source: GLM_SOURCE,
    profile: "default",
    probe: (signal) => probeGlm({ apiKey: config.apiKey }, signal),
  };
}

export interface GlmProbeOptions {
  apiKey?: string;
  /** Replaces the global `fetch`; used by tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Reads plan limits from Z.ai. The key is trimmed here, sent only as a request header, and never kept in the result. */
export async function probeGlm(options: GlmProbeOptions, signal?: AbortSignal): Promise<QuotaSnapshot> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new QuotaError("signed-out", "No GLM API key is set.", { code: "auth:no-key" });
  }
  // Anything else can't be sent in a header, and fetch would report that as a network failure.
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new QuotaError("signed-out", "The GLM API key contains a character that can't be sent.", {
      code: "auth:bad-key",
    });
  }
  const now = options.now ?? Date.now;
  const request = options.fetch ?? fetch;

  if (signal?.aborted) {
    throw new QuotaError("cancelled", "The request was cancelled.");
  }
  // One controller for the caller's cancellation and the time limit, so the cause can be told apart.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_GLM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let status: number;
  let retryAfter: string | null;
  let text: string;
  try {
    const response = await request(GLM_QUOTA_URL, {
      headers: { Authorization: apiKey, "Accept-Language": "en-US,en", Accept: "application/json" },
      signal: controller.signal,
    });
    status = response.status;
    retryAfter = response.headers.get("retry-after");
    text = await response.text();
  } catch (error) {
    throw toGlmError(error, { cancelled: signal?.aborted === true, timedOut });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  return normalizeGlmResponse(status, text, { checkedAt: now(), retryAfter, apiKey });
}

interface GlmNormalizeContext {
  checkedAt: number;
  /** The `Retry-After` header, when the response had one. */
  retryAfter: string | null;
  /** Scrubbed from anything echoed from the response. */
  apiKey: string;
}

/** Classifies an HTTP response from the quota endpoint and converts a successful one to a snapshot. */
function normalizeGlmResponse(status: number, text: string, context: GlmNormalizeContext): QuotaSnapshot {
  const body = parseJson(text);
  const code = isRecord(body) ? finiteNumber(body.code) : undefined;
  if (isRecord(body) && (body.success === false || (code !== undefined && code !== 200))) {
    throw bodyFailure(status, code, body.msg, context);
  }
  if (status === 401 || status === 403) {
    throw rejectedKey(`http:${status}`);
  }
  if (status === 429) {
    throw rateLimited("http:429", context);
  }
  if (status >= 500) {
    throw unavailable(`http:${status}`);
  }
  if (status < 200 || status >= 300) {
    throw new QuotaError("malformed-response", `GLM answered with HTTP ${status}.`, { code: `http:${status}` });
  }
  if (body === undefined) {
    throw new QuotaError("malformed-response", "GLM returned a response that isn't JSON.", { code: "usage:not-json" });
  }

  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data) || !Array.isArray(data.limits)) {
    throw new QuotaError("malformed-response", "GLM returned an unexpected usage response.", { code: "usage:shape" });
  }
  const windows = parseWindows(data.limits);
  if (windows.length === 0) {
    throw new QuotaError("malformed-response", "GLM reported no limits t0kns recognizes.", {
      code: "usage:no-windows",
    });
  }

  return {
    provider: "glm",
    source: GLM_SOURCE,
    profile: "default",
    plan: nonEmptyString(data.level),
    checkedAt: context.checkedAt,
    windows,
  };
}

/** Recognized windows in display order. Unknown limit types and unit combinations are skipped. */
function parseWindows(limits: unknown[]): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const spec of WINDOWS) {
    const entry = limits.find(
      (limit): limit is Record<string, unknown> =>
        isRecord(limit) &&
        spec.types.some((type) => type === limit.type) &&
        limit.unit === spec.unit &&
        limit.number === spec.number,
    );
    if (!entry) {
      continue;
    }
    const resetsAt = positiveNumber(entry.nextResetTime);
    windows.push({
      id: spec.id,
      label: "label" in spec ? spec.label : (windowLabel(spec.durationMinutes) ?? "Limit"),
      scope: "scope" in spec ? spec.scope : undefined,
      usedPercent: usedPercentOf(entry),
      durationMinutes: spec.durationMinutes,
      // Unix seconds are accepted as well as milliseconds.
      resetsAt: resetsAt === undefined ? undefined : unixToEpochMs(resetsAt),
      breakdown: parseToolShares(entry.usageDetails),
    });
  }
  return windows;
}

/** The share of `usage` that `currentValue` makes up, else the reported integer percentage; bounded to 0-100. */
function usedPercentOf(entry: Record<string, unknown>): number | undefined {
  const used = finiteNumber(entry.currentValue);
  const total = positiveNumber(entry.usage);
  const percent =
    used !== undefined && used >= 0 && total !== undefined ? (used * 100) / total : finiteNumber(entry.percentage);
  return percent === undefined ? undefined : Math.min(100, Math.max(0, percent));
}

/** How a window's tool calls split across tools, largest first. Tools without calls are left out. */
function parseToolShares(value: unknown): UsageShare[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tools = value.flatMap((item): { label: string; calls: number }[] => {
    const code = isRecord(item) ? nonEmptyString(item.modelCode) : undefined;
    const calls = isRecord(item) ? finiteNumber(item.usage) : undefined;
    return code && calls !== undefined && calls > 0 ? [{ label: TOOL_NAMES[code] ?? truncate(code, 40), calls }] : [];
  });
  const total = tools.reduce((sum, tool) => sum + tool.calls, 0);
  return total > 0
    ? tools.map(({ label, calls }) => ({ label, percent: (calls / total) * 100 })).sort((a, b) => b.percent - a.percent)
    : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A failure reported in the body, falling back to the HTTP status when its code isn't one t0kns knows. */
function bodyFailure(
  status: number,
  code: number | undefined,
  message: unknown,
  context: GlmNormalizeContext,
): QuotaError {
  const id = `api:${code ?? "unknown"}`;
  const detail = reported(message, context);
  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return rejectedKey(id, detail);
    if (code === 1313) return restricted(id, detail);
    if (PLAN_CODES.has(code)) return noPlan(id, detail);
    if (RATE_LIMIT_CODES.has(code)) return rateLimited(id, context, detail);
    if (UNAVAILABLE_CODES.has(code)) return unavailable(id, detail);
  } else if (status === 429) {
    return rateLimited("http:429", context, detail);
  }
  if (status === 401 || status === 403) return rejectedKey(`http:${status}`, detail);
  if (status >= 500) return unavailable(`http:${status}`, detail);
  return new QuotaError("malformed-response", "GLM reported an error t0kns doesn't recognize.", { code: id, detail });
}

function rejectedKey(code: string, detail?: string): QuotaError {
  return new QuotaError("signed-out", "The GLM API key was rejected.", { code, detail });
}

function noPlan(code: string, detail?: string): QuotaError {
  return new QuotaError("unsupported-auth", "This API key has no active GLM Coding Plan.", { code, detail });
}

/** 1313: the account is limited under Z.ai's Fair Usage Policy, which isn't an expired plan. */
function restricted(code: string, detail?: string): QuotaError {
  return new QuotaError("unsupported-auth", "Z.ai has restricted this account.", { code, detail });
}

function unavailable(code: string, detail?: string): QuotaError {
  return new QuotaError("unavailable", "Z.ai is temporarily unavailable.", { code, detail });
}

function rateLimited(code: string, context: GlmNormalizeContext, detail?: string): QuotaError {
  return new QuotaError("rate-limited", "GLM usage requests are rate limited.", {
    code,
    detail,
    retryAfter: retryAfterOf(context.retryAfter, context.checkedAt),
  });
}

/** A `Retry-After` of seconds or an HTTP date, as a time at most a day away. Undefined when absent or unusable. */
function retryAfterOf(header: string | null, now: number): number | undefined {
  const value = header?.trim();
  if (!value) {
    return undefined;
  }
  const at = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(at) && at > now && at - now <= 24 * 60 * 60_000 ? at : undefined;
}

/** The server's own message for display, with the key removed in case a validation error echoes it. */
function reported(message: unknown, context: GlmNormalizeContext): string | undefined {
  const text = nonEmptyString(message);
  return text ? truncate(text.split(context.apiKey).join("[redacted]")) : undefined;
}

function toGlmError(error: unknown, context: { cancelled: boolean; timedOut: boolean }): QuotaError {
  if (context.cancelled) {
    return new QuotaError("cancelled", "The request was cancelled.");
  }
  if (context.timedOut) {
    return new QuotaError("timeout", "Z.ai did not respond in time.", { code: "timeout:request" });
  }
  // `fetch` wraps the system error (ENOTFOUND, ECONNRESET, …) as the cause; its message is not used.
  const cause = error instanceof Error && isRecord(error.cause) ? nonEmptyString(error.cause.code) : undefined;
  return new QuotaError("unavailable", "Couldn't reach Z.ai.", {
    code: `network:${cause && /^[A-Z0-9_]{3,32}$/.test(cause) ? cause : "unknown"}`,
  });
}
