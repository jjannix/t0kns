import assert from "node:assert/strict";
import test from "node:test";
import { createGlmProvider, GLM_SOURCE, probeGlm } from "../src/providers/glm";
import { SnapshotCache } from "../src/quota/cache";
import { buildDiagnostics } from "../src/quota/diagnostics";
import { QuotaError, QuotaErrorKind, toQuotaFailure } from "../src/quota/errors";
import { addPin, createLimitPin, findLimitPin, parseLimitPins } from "../src/quota/pins";
import { QUICK_CHECK_DEADLINE_MS, readQuickCheck } from "../src/quota/quick-check";
import { QuotaRefresher } from "../src/quota/refresh";
import { quickCheckText } from "../src/quota/summary";
import { QuotaProvider, QuotaSnapshot } from "../src/quota/types";

const KEY = "0123456789abcdef0123456789abcdef.SECRETSECRET";
const NOW = Date.parse("2026-10-26T12:00:00Z");

/** The body observed from a Lite plan. */
const LITE = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    level: "lite",
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 100,
        currentValue: 7,
        remaining: 93,
        percentage: 7,
        nextResetTime: 1793300588979,
        usageDetails: [
          { modelCode: "search-prime", usage: 3 },
          { modelCode: "web-reader", usage: 0 },
          { modelCode: "zread", usage: 4 },
        ],
      },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 73, nextResetTime: 1793019425404 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 56, nextResetTime: 1793024997983 },
    ],
  },
};

/** The shape a community report shows for Pro plans. */
const PRO = {
  code: 200,
  success: true,
  data: {
    level: "pro",
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 12000,
        currentValue: 402,
        remaining: 11615,
        percentage: 3,
        nextResetTime: 1793019425404,
      },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 12, nextResetTime: 1793024997983 },
    ],
  },
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that answers with `respond` and records its requests. Never touches the network. */
function stubFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: { ...(init?.headers as Record<string, string>) } };
    calls.push(call);
    if (init?.signal?.aborted) {
      throw init.signal.reason;
    }
    return respond(call);
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

async function read(body: unknown, init?: ResponseInit): Promise<QuotaSnapshot> {
  return probeGlm({ apiKey: KEY, fetch: stubFetch(() => json(body, init)).fetch, now: () => NOW });
}

async function failure(options: Parameters<typeof probeGlm>[0], signal?: AbortSignal): Promise<QuotaError> {
  try {
    await probeGlm(options, signal);
  } catch (error) {
    assert.ok(error instanceof QuotaError, `expected a QuotaError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the probe to fail");
}

async function failureFor(response: () => Response): Promise<QuotaError> {
  return failure({ apiKey: KEY, fetch: stubFetch(response).fetch, now: () => NOW });
}

test("reads the Lite plan windows by type, unit, and number", async () => {
  const stub = stubFetch(() => json(LITE));
  const snapshot = await probeGlm({ apiKey: KEY, fetch: stub.fetch, now: () => NOW });

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(stub.calls[0].headers.Authorization, KEY);
  assert.equal(stub.calls[0].headers["Accept-Language"], "en-US,en");

  assert.equal(snapshot.provider, "glm");
  assert.equal(snapshot.source, GLM_SOURCE);
  assert.equal(snapshot.profile, "default");
  assert.equal(snapshot.plan, "lite");
  assert.equal(snapshot.checkedAt, NOW);
  assert.deepEqual(
    snapshot.windows.map(({ id, label, scope, usedPercent, durationMinutes, resetsAt }) => ({
      id,
      label,
      scope,
      usedPercent,
      durationMinutes,
      resetsAt,
    })),
    [
      {
        id: "glm:five_hour",
        label: "5-hour limit",
        scope: undefined,
        usedPercent: 73,
        durationMinutes: 300,
        resetsAt: 1793019425404,
      },
      {
        id: "glm:weekly",
        label: "Weekly limit",
        scope: undefined,
        usedPercent: 56,
        durationMinutes: 10080,
        resetsAt: 1793024997983,
      },
      {
        id: "glm:mcp_monthly",
        label: "Monthly limit",
        scope: "MCP tools",
        usedPercent: 7,
        durationMinutes: 43200,
        resetsAt: 1793300588979,
      },
    ],
  );
  const mcp = snapshot.windows[2];
  assert.deepEqual(
    mcp.breakdown?.map(({ label, percent }) => [label, Math.round(percent)]),
    [
      ["Zread", 57],
      ["Web search", 43],
    ],
    "tools without calls are left out, largest share first",
  );
});

test("maps windows by identity, not array position", async () => {
  const reversed = { ...LITE, data: { ...LITE.data, limits: [...LITE.data.limits].reverse() } };
  const snapshot = await read(reversed);
  assert.deepEqual(
    snapshot.windows.map((window) => [window.id, window.usedPercent]),
    [
      ["glm:five_hour", 73],
      ["glm:weekly", 56],
      ["glm:mcp_monthly", 7],
    ],
  );
});

test("treats CREDIT_LIMIT like TOKENS_LIMIT", async () => {
  const snapshot = await read(PRO);
  assert.equal(snapshot.plan, "pro");
  assert.deepEqual(
    snapshot.windows.map((window) => [window.id, window.usedPercent, window.durationMinutes]),
    [
      // Counts win over the rounded percentage when both are given: 402 of 12000.
      ["glm:five_hour", 3.35, 300],
      ["glm:weekly", 12, 10080],
    ],
  );
});

test("skips unknown types and combinations without failing", async () => {
  const snapshot = await read({
    ...LITE,
    data: {
      level: "lite",
      limits: [
        { type: "SOMETHING_NEW", unit: 3, number: 5, percentage: 99, nextResetTime: 1793019425404 },
        { type: "TOKENS_LIMIT", unit: 4, number: 1, percentage: 99, nextResetTime: 1793019425404 },
        { type: "TOKENS_LIMIT", unit: 3, number: 2, percentage: 99, nextResetTime: 1793019425404 },
        { type: "TIME_LIMIT", unit: 3, number: 5, percentage: 99, nextResetTime: 1793019425404 },
        "garbage",
        null,
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: 1793024997983 },
      ],
    },
  });
  assert.deepEqual(
    snapshot.windows.map((window) => [window.id, window.usedPercent]),
    [["glm:weekly", 40]],
  );
});

test("a recognized window without usage keeps its place with no percentage", async () => {
  const snapshot = await read({
    ...LITE,
    data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, nextResetTime: 1793019425404 }] },
  });
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].usedPercent, undefined);
  assert.equal(snapshot.plan, undefined);
});

test("falls back to counts when the percentage is missing", async () => {
  const snapshot = await read({
    data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 200, currentValue: 50 }] },
  });
  assert.equal(snapshot.windows[0].usedPercent, 25);
  assert.equal(snapshot.windows[0].resetsAt, undefined);
});

test("a response with no recognized windows is malformed", async () => {
  for (const limits of [[], [{ type: "TOKENS_LIMIT", unit: 9, number: 9, percentage: 1 }]]) {
    const error = await failureFor(() => json({ code: 200, success: true, data: { level: "lite", limits } }));
    assert.equal(error.kind, "malformed-response");
    assert.equal(error.code, "usage:no-windows");
  }
});

test("authentication failures are signed-out", async () => {
  for (const code of [1000, 1001, 1002, 1003, 1004, 1005]) {
    const error = await failureFor(() => json({ code, msg: "Authentication Failed", success: false }));
    assert.equal(error.kind, "signed-out", `code ${code}`);
    assert.equal(error.code, `api:${code}`);
  }
  for (const status of [401, 403]) {
    const error = await failureFor(() => new Response("", { status }));
    assert.equal(error.kind, "signed-out", `HTTP ${status}`);
    assert.equal(error.code, `http:${status}`);
  }
});

test("HTTP 200 with success false is classified by its body code", async () => {
  const bad = await failureFor(() => json({ code: 1000, msg: "Authentication Failed", success: false }));
  assert.equal(bad.kind, "signed-out");
  assert.equal(bad.detail, "Authentication Failed");

  const params = await failureFor(() =>
    json({ code: 500, msg: "Parameter validation failed: bad value", success: false }),
  );
  assert.equal(params.kind, "malformed-response");
  assert.equal(params.code, "api:500");

  const nothing = await failureFor(() => json({ success: false }));
  assert.equal(nothing.kind, "malformed-response");
  assert.equal(nothing.code, "api:unknown");
});

test("rate limits come from HTTP 429 and body codes 429 and 1302", async () => {
  const cases: [string, () => Response][] = [
    ["http:429", () => new Response("", { status: 429 })],
    ["api:429", () => json({ code: 429, msg: "Too many requests", success: false })],
    ["api:1302", () => json({ code: 1302, msg: "Rate limit reached", success: false })],
  ];
  for (const [code, response] of cases) {
    const error = await failureFor(response);
    assert.equal(error.kind, "rate-limited", code);
    assert.equal(error.code, code);
    assert.equal(error.retryAfter, undefined);
  }
});

test("Retry-After sets the cooldown when it is usable", async () => {
  const seconds = await failureFor(() => new Response("", { status: 429, headers: { "Retry-After": "120" } }));
  assert.equal(seconds.retryAfter, NOW + 120_000);

  const date = new Date(NOW + 90_000).toUTCString();
  const http = await failureFor(() => new Response("", { status: 429, headers: { "Retry-After": date } }));
  assert.equal(http.retryAfter, NOW + 90_000);

  const absurd = await failureFor(() => new Response("", { status: 429, headers: { "Retry-After": "999999999" } }));
  assert.equal(absurd.retryAfter, undefined);
});

test("unreadable responses are malformed", async () => {
  const cases: [string, () => Response][] = [
    ["usage:not-json", () => new Response("<html>nope</html>", { status: 200 })],
    ["usage:shape", () => json({ code: 200, success: true })],
    ["usage:shape", () => json({ code: 200, success: true, data: {} })],
    ["usage:shape", () => json({ code: 200, success: true, data: { limits: "none" } })],
    ["usage:shape", () => json([1, 2, 3])],
    ["http:404", () => new Response("Not Found", { status: 404 })],
    ["api:500", () => json({ code: 500, msg: "Parameter validation failed", success: false })],
    ["api:42", () => json({ code: 42, msg: "?", success: false })],
  ];
  for (const [code, response] of cases) {
    const error = await failureFor(response);
    assert.equal(error.kind, "malformed-response", code);
    assert.equal(error.code, code);
  }
});

test("without a key it asks for one and never calls Z.ai", async () => {
  for (const apiKey of [undefined, "", "   "]) {
    const stub = stubFetch(() => json(LITE));
    const error = await failure({ apiKey, fetch: stub.fetch });
    assert.equal(error.kind, "signed-out");
    assert.equal(error.code, "auth:no-key");
    assert.equal(stub.calls.length, 0);
  }
  const provider = createGlmProvider({ apiKey: " " });
  await assert.rejects(provider.probe(new AbortController().signal), { kind: "signed-out", code: "auth:no-key" });
});

test("an already-aborted signal cancels before any request", async () => {
  const stub = stubFetch(() => json(LITE));
  const controller = new AbortController();
  controller.abort();
  const error = await failure({ apiKey: KEY, fetch: stub.fetch }, controller.signal);
  assert.equal(error.kind, "cancelled");
  assert.equal(stub.calls.length, 0);
});

test("aborting an in-flight request cancels it", async () => {
  const controller = new AbortController();
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  const pending = failure({ apiKey: KEY, fetch: hanging }, controller.signal);
  setTimeout(() => controller.abort(), 10);
  const error = await pending;
  assert.equal(error.kind, "cancelled");
  assert.equal(toQuotaFailure(error).kind, "cancelled");
});

test("a request that never answers times out", async () => {
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  const error = await failure({ apiKey: KEY, fetch: hanging, timeoutMs: 20 }, new AbortController().signal);
  assert.equal(error.kind, "timeout");
});

test("network failures are unavailable and keep only a safe error code", async () => {
  const refused = (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error(`could not reach ${KEY}`), { code: "ENOTFOUND" }),
    });
  }) as typeof fetch;
  const error = await failure({ apiKey: KEY, fetch: refused });
  assert.equal(error.kind, "unavailable");
  assert.equal(error.code, "network:ENOTFOUND");

  const odd = (async () => {
    throw new Error(KEY);
  }) as typeof fetch;
  const unknown = await failure({ apiKey: KEY, fetch: odd });
  assert.equal(unknown.code, "network:unknown");
  assert.doesNotMatch(JSON.stringify(unknown.toFailure()), /SECRETSECRET/);
});

test("the API key never reaches the snapshot, cache, diagnostics, or error text", async () => {
  const snapshot = await read(LITE);
  assert.ok(!JSON.stringify(snapshot).includes("SECRETSECRET"));

  const stored = new Map<string, string>();
  const cache = new SnapshotCache({
    get: (key) => stored.get(key),
    set: (key, value) => void stored.set(key, value),
    remove: (key) => void stored.delete(key),
  });
  const provider = createGlmProvider({ apiKey: KEY });
  cache.write(provider, { snapshot });
  assert.ok([...stored.values()].every((value) => !value.includes("SECRETSECRET")));
  // JSON drops undefined fields, so compare what each side would serialize.
  assert.deepEqual(
    JSON.parse(JSON.stringify(cache.read(provider).snapshot)),
    JSON.parse(JSON.stringify(snapshot)),
    "a GLM reading survives the cache round trip",
  );

  // A validation error may echo the request; the key is scrubbed before it can reach the UI.
  const echo = await failureFor(() =>
    json({ code: 500, msg: `Parameter validation failed: Authorization=${KEY}`, success: false }),
  );
  assert.equal(echo.detail, "Parameter validation failed: Authorization=[redacted]");

  const diagnostics = buildDiagnostics([{ provider, state: { snapshot, error: echo.toFailure(), loading: false } }], {
    raycastVersion: "1",
    platform: "win32",
    arch: "x64",
    nodeVersion: "22",
    now: NOW,
  });
  assert.ok(!diagnostics.includes("SECRETSECRET"));
  assert.match(diagnostics, /Last error: malformed-response \(api:500\)/);
});

test("the provider reads through the global fetch with its configured key", async () => {
  const original = globalThis.fetch;
  const stub = stubFetch(() => json(LITE));
  globalThis.fetch = stub.fetch;
  try {
    const snapshot = await createGlmProvider({ apiKey: ` ${KEY} ` }).probe(new AbortController().signal);
    assert.equal(snapshot.windows.length, 3);
    assert.equal(stub.calls[0].headers.Authorization, KEY, "the key is trimmed");
  } finally {
    globalThis.fetch = original;
  }
});

function glmEntry(snapshot: QuotaSnapshot) {
  const provider = createGlmProvider({ apiKey: KEY });
  return { provider, state: { snapshot, loading: false } };
}

function failedEntry(kind: QuotaErrorKind) {
  const provider: QuotaProvider = createGlmProvider({ apiKey: KEY });
  return { provider, state: { loading: false, error: { kind, message: "x" } } };
}

test("pins for GLM windows are saved, matched, and survive parsing", async () => {
  const snapshot = await read(LITE);
  const { provider } = glmEntry(snapshot);
  const weekly = createLimitPin(provider, snapshot.windows[1]);
  const mcp = createLimitPin(provider, snapshot.windows[2]);
  const pins = addPin(addPin({ pins: [] }, weekly), mcp);

  const restored = parseLimitPins(JSON.stringify(pins));
  assert.equal(restored.pins.length, 2, "glm pins are not dropped as an unknown provider");
  assert.deepEqual(restored, pins);
  assert.equal(findLimitPin(restored, provider, snapshot.windows[1])?.windowId, "glm:weekly");
  assert.equal(findLimitPin(restored, provider, snapshot.windows[0]), undefined);
  assert.equal(parseLimitPins(JSON.stringify({ pins: [{ ...weekly, provider: "nope" }] })).pins.length, 0);
});

test("Quick Check names GLM and keeps the MCP quota out unless it is pinned", async () => {
  const snapshot = await read(LITE);
  const entry = glmEntry(snapshot);

  const text = quickCheckText([entry], NOW, "all");
  assert.match(text, /^GLM: 27% left \(5h\)/);
  assert.doesNotMatch(text, /MCP|30d/, "the scoped MCP window is not an account-wide limit");

  const exhausted = await read({
    ...LITE,
    data: {
      ...LITE.data,
      limits: LITE.data.limits.map((l) => (l.type === "TIME_LIMIT" ? { ...l, percentage: 97 } : l)),
    },
  });
  const mcp = createLimitPin(entry.provider, exhausted.windows[2]);
  const pinned = quickCheckText([glmEntry(exhausted)], NOW, "pins", addPin({ pins: [] }, mcp));
  assert.match(pinned, /^GLM: /);
  assert.match(pinned, /3% left/);
});

test("a missing or rejected key reads as an API key problem, not a sign-in", () => {
  assert.equal(quickCheckText([failedEntry("signed-out")], NOW, "all"), "GLM: check API key");
  assert.equal(quickCheckText([failedEntry("signed-out")], NOW, "smart"), "GLM: check API key");
  assert.equal(quickCheckText([failedEntry("rate-limited")], NOW, "all"), "GLM: rate limited, try again later");
});

test("shared HUD text still shortens Claude next to GLM", () => {
  const entries = [
    { ...failedEntry("signed-out"), provider: { ...createGlmProvider({ apiKey: KEY }), id: "claude" as const } },
    failedEntry("signed-out"),
  ];
  assert.equal(quickCheckText(entries, NOW, "all"), "Claude: signed out | GLM: check API key");
});

test("cancelling wins when the time limit also passes", async () => {
  const controller = new AbortController();
  const slow = (async (_input: string | URL | Request, init?: RequestInit) => {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 40));
    throw init?.signal?.reason;
  }) as typeof fetch;
  const error = await failure({ apiKey: KEY, fetch: slow, timeoutMs: 10 }, controller.signal);
  assert.equal(error.kind, "cancelled");
});

test("usage is bounded to 0-100, whether it comes from counts or the percentage", async () => {
  const snapshot = await read({
    data: {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 140 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: -5 },
        { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 250, percentage: 7 },
      ],
    },
  });
  assert.deepEqual(
    snapshot.windows.map((window) => window.usedPercent),
    [100, 0, 100],
  );
});

test("tool details that aren't a list are ignored without dropping the window", async () => {
  for (const usageDetails of ["none", { zread: 4 }, null]) {
    const snapshot = await read({
      data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 7, usageDetails }] },
    });
    assert.equal(snapshot.windows[0].usedPercent, 7);
    assert.equal(snapshot.windows[0].breakdown, undefined);
  }
});

test("reset times in seconds are normalized and unusable ones are dropped", async () => {
  const snapshot = await read({
    data: {
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1793019425 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 1, nextResetTime: -5 },
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 1, nextResetTime: "soon" },
      ],
    },
  });
  assert.deepEqual(
    snapshot.windows.map((window) => window.resetsAt),
    [1793019425000, undefined, undefined],
  );
});

test("plan, outage, and two-factor failures are classified by their body code", async () => {
  const body = (code: number, msg: string) => JSON.stringify({ code, msg, success: false });
  const cases: [string, QuotaErrorKind, () => Response][] = [
    ["api:1309", "unsupported-auth", () => new Response(body(1309, "Plan expired"), { status: 429 })],
    ["api:1309", "unsupported-auth", () => json({ code: 1309, msg: "Plan expired", success: false })],
    ["api:1113", "unsupported-auth", () => json({ code: 1113, msg: "No resource package", success: false })],
    ["api:1311", "unsupported-auth", () => new Response(body(1311, "Plan lacks model"), { status: 403 })],
    ["api:1005", "signed-out", () => json({ code: 1005, msg: "Need Two-Factor Authentication", success: false })],
    // Observed live for a key without the id.secret form or from another vendor.
    ["api:401", "signed-out", () => json({ code: 401, msg: "token expired or incorrect", success: false })],
    ["api:403", "signed-out", () => json({ code: 403, msg: "Forbidden", success: false })],
    ["api:1313", "unsupported-auth", () => new Response(body(1313, "Fair Usage Policy"), { status: 429 })],
    ["api:1305", "unavailable", () => json({ code: 1305, msg: "Overloaded", success: false })],
    ["api:1305", "unavailable", () => new Response(body(1305, "Overloaded"), { status: 429 })],
    ["api:1234", "unavailable", () => json({ code: 1234, msg: "Network error", success: false })],
    ["http:500", "unavailable", () => new Response("", { status: 500 })],
    ["http:502", "unavailable", () => new Response("<html>Bad Gateway</html>", { status: 502 })],
    ["http:503", "unavailable", () => new Response(body(500, "Internal Error"), { status: 503 })],
    ["http:429", "rate-limited", () => new Response("slow down", { status: 429 })],
    ["http:429", "rate-limited", () => new Response(JSON.stringify({ success: false }), { status: 429 })],
    // Exhausted limits aren't plan problems, and a 429 with another code isn't a rate limit.
    ["api:1310", "malformed-response", () => new Response(body(1310, "Limit exhausted"), { status: 429 })],
  ];
  for (const [code, kind, response] of cases) {
    const error = await failureFor(response);
    assert.equal(error.kind, kind, code);
    assert.equal(error.code, code);
  }
  const plan = await failureFor(() => json({ code: 1309, msg: "Plan expired", success: false }));
  assert.equal(plan.detail, "Plan expired");
  assert.match(plan.message, /no active GLM Coding Plan/);
  const fairUse = await failureFor(() => json({ code: 1313, msg: "Fair Usage Policy", success: false }));
  assert.equal(fairUse.message, "Z.ai has restricted this account.");
});

test("a key that can't go in a header is rejected without a request", async () => {
  const keys = ["abc​def.ghi", "abc“def.ghi", "abc\ndef.ghi", "abc def.ghi", "kéy.secret"];
  for (const apiKey of keys) {
    const stub = stubFetch(() => json(LITE));
    const error = await failure({ apiKey, fetch: stub.fetch });
    assert.equal(error.kind, "signed-out", JSON.stringify(apiKey));
    assert.equal(error.code, "auth:bad-key");
    assert.equal(stub.calls.length, 0, "no request is sent");
    assert.ok(!JSON.stringify(error.toFailure()).includes("def"), "the key isn't echoed");
  }
  // Surrounding whitespace, as pasted from a page, is trimmed rather than rejected.
  const stub = stubFetch(() => json(LITE));
  await probeGlm({ apiKey: `\n ${KEY}\t`, fetch: stub.fetch });
  assert.equal(stub.calls[0].headers.Authorization, KEY);
});

test("a hanging GLM request is aborted by the Quick Check deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(init.signal?.reason);
        },
        { once: true },
      );
    })) as typeof fetch;
  try {
    const provider = createGlmProvider({ apiKey: KEY });
    const refresher = new QuotaRefresher(
      [provider],
      new SnapshotCache({ get: () => undefined, set: () => undefined, remove: () => undefined }),
    );
    const reading = readQuickCheck([provider], refresher);
    t.mock.timers.tick(QUICK_CHECK_DEADLINE_MS);
    const [entry] = await reading;

    assert.equal(entry.timedOut, true);
    assert.equal(aborted, true, "the shared deadline aborts the request");
    assert.equal(quickCheckText([entry], Date.now(), "all"), "GLM: unavailable");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(refresher.getStates()[provider.key].loading, false);
  } finally {
    globalThis.fetch = original;
  }
});
