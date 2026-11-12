import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { normalizeClaudeUsage, parseClaudeResets, probeClaude } from "../src/providers/claude";
import { ClaudeResetReadOptions, readClaudeResetInventory } from "../src/providers/claude-resets";
import { MAX_LISTED_RESETS, resetNotes } from "../src/quota/resets";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const ENDS = "2026-10-18T12:00:00Z";
const INVENTORY = {
  eligible: true,
  grants: [{ resets_left: 2, starts_at: null, ends_at: ENDS, paused: false, id: "never-store-this" }],
};

async function profile(t: TestContext, credentials: unknown = validCredentials()) {
  const folder = await mkdtemp(path.join(tmpdir(), "t0kns-claude-resets-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(path.join(folder, ".credentials.json"), JSON.stringify(credentials));
  return folder;
}

function validCredentials(overrides: Record<string, unknown> = {}) {
  return {
    claudeAiOauth: {
      accessToken: "test-token",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:profile"],
      ...overrides,
    },
  };
}

function readOptions(configDir: string, transport: typeof fetch): ClaudeResetReadOptions {
  return {
    configDir,
    session: { tokenSource: "claude.ai", apiProvider: "firstParty" },
    env: {},
    signal: new AbortController().signal,
    fetch: transport,
  };
}

function usage(cedar_ember?: unknown) {
  return {
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 100, resets_at: ENDS }, cedar_ember },
  };
}

test("Claude resets normalize into the shared inventory and summary without redemption handles", () => {
  const snapshot = normalizeClaudeUsage(usage(INVENTORY), { profile: "default", checkedAt: NOW });
  assert.deepEqual(snapshot.resets, {
    available: 2,
    items: [{ expiresAt: Date.parse(ENDS) }, { expiresAt: Date.parse(ENDS) }],
  });
  assert.equal(resetNotes(snapshot, NOW).saved, "2 resets saved");
  assert.doesNotMatch(JSON.stringify(snapshot), /never-store-this/);
  assert.equal(parseClaudeResets(null, NOW), undefined);
  assert.equal(parseClaudeResets({ eligible: false, grants: [] }, NOW), undefined);
  assert.deepEqual(parseClaudeResets({ eligible: true, grants: [] }, NOW), { available: 0, items: [] });
});

test("only active, unpaused, well-formed Claude grants count", () => {
  const active = INVENTORY.grants[0];
  const invalid = [
    null,
    { ...active, paused: true },
    { ...active, paused: undefined },
    { ...active, starts_at: ENDS },
    { ...active, ends_at: new Date(NOW).toISOString() },
    { ...active, starts_at: "invalid" },
    { ...active, ends_at: "invalid" },
    ...[-1, 0, 1.5, "2", NaN].map((resets_left) => ({ ...active, resets_left })),
  ];
  assert.deepEqual(parseClaudeResets({ eligible: true, grants: [...invalid, active] }, NOW), {
    available: 2,
    items: [{ expiresAt: Date.parse(ENDS) }, { expiresAt: Date.parse(ENDS) }],
  });
});

test("the detail cap keeps the earliest-expiring resets and the full reported count", () => {
  const resets = parseClaudeResets(
    {
      eligible: true,
      grants: [{ resets_left: MAX_LISTED_RESETS, paused: false }, ...INVENTORY.grants],
    },
    NOW,
  );
  assert.equal(resets?.available, MAX_LISTED_RESETS + 2);
  assert.equal(resets?.items.length, MAX_LISTED_RESETS);
  assert.equal(resets?.items[0].expiresAt, Date.parse(ENDS));
});

test("the optional OAuth read uses the explicit profile, fixed endpoint, and read-only request", async (t) => {
  const configDir = await profile(t);
  const options = readOptions(configDir, async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage?cedar_ember=1");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
    assert.equal(new Headers(init?.headers).get("anthropic-beta"), "oauth-2025-04-20");
    assert.ok(init?.signal);
    return Response.json({ cedar_ember: INVENTORY });
  });
  options.env = { CLAUDE_CONFIG_DIR: path.join(configDir, "nonexistent") };
  assert.deepEqual(await readClaudeResetInventory(options), INVENTORY);
  options.configDir = undefined;
  options.env.CLAUDE_CONFIG_DIR = configDir;
  assert.deepEqual(await readClaudeResetInventory(options), INVENTORY);
});

test("other auth sources and custom endpoints never trigger the extra request", async (t) => {
  const configDir = await profile(t);
  let requests = 0;
  const transport: typeof fetch = async () => {
    requests++;
    return Response.json({});
  };
  const options = readOptions(configDir, transport);
  for (const tokenSource of [undefined, "none", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]) {
    assert.equal(await readClaudeResetInventory({ ...options, session: { tokenSource } }), undefined);
  }
  assert.equal(
    await readClaudeResetInventory({ ...options, session: { tokenSource: "claude.ai", apiProvider: "bedrock" } }),
    undefined,
  );
  assert.equal(
    await readClaudeResetInventory({ ...options, env: { ANTHROPIC_BASE_URL: "https://example.com" } }),
    undefined,
  );
  assert.equal(requests, 0);
});

test("missing, malformed, expired, and insufficient-scope credentials are not used", async (t) => {
  const configDir = await profile(t);
  let requests = 0;
  const options = readOptions(configDir, async () => {
    requests++;
    return Response.json({});
  });
  for (const credentials of [
    {},
    validCredentials({ accessToken: "" }),
    validCredentials({ expiresAt: 0 }),
    validCredentials({ expiresAt: "future" }),
    validCredentials({ scopes: ["user:inference"] }),
  ]) {
    await writeFile(path.join(configDir, ".credentials.json"), JSON.stringify(credentials));
    assert.equal(await readClaudeResetInventory(options), undefined);
  }
  await writeFile(path.join(configDir, ".credentials.json"), "not JSON");
  assert.equal(await readClaudeResetInventory(options), undefined);
  await rm(path.join(configDir, ".credentials.json"));
  assert.equal(await readClaudeResetInventory(options), undefined);
  assert.equal(requests, 0);
});

test("HTTP failures, malformed responses, network failures and cancellation leave inventory unknown", async (t) => {
  const configDir = await profile(t);
  for (const status of [401, 403, 429, 500]) {
    assert.equal(
      await readClaudeResetInventory(readOptions(configDir, async () => new Response(null, { status }))),
      undefined,
    );
  }
  assert.equal(await readClaudeResetInventory(readOptions(configDir, async () => new Response("not JSON"))), undefined);
  assert.equal(
    await readClaudeResetInventory(
      readOptions(configDir, async () => {
        throw new Error("private transport details");
      }),
    ),
    undefined,
  );
  const controller = new AbortController();
  const options = readOptions(configDir, async (_url, init) => {
    controller.abort();
    init?.signal?.throwIfAborted();
    assert.fail("must be aborted");
  });
  assert.equal(await readClaudeResetInventory({ ...options, signal: controller.signal }), undefined);
});

test("optional reads have their own timeout even without a caller deadline", async (t) => {
  const configDir = await profile(t);
  // AbortSignal.timeout is unref'ed; keep the test alive while waiting for the simulated network read.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    const options = readOptions(
      configDir,
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const start = performance.now();
    assert.equal(await readClaudeResetInventory(options), undefined);
    assert.ok(performance.now() - start < 3_000);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("the CLI probe supplements missing inventory, skips reported inventory, and survives optional errors", async (t) => {
  const configDir = await profile(t);
  const script = path.join(configDir, "fake-claude.mjs");
  await writeFile(
    script,
    `
    import { createInterface } from "node:readline";
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      const response = message.request.subtype === "initialize"
        ? { account: { tokenSource: "claude.ai", apiProvider: "firstParty" } }
        : JSON.parse(process.env.TEST_USAGE);
      console.log(JSON.stringify({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id, response
      } }));
    }
  `,
  );
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return requests === 1 ? Response.json({ cedar_ember: INVENTORY }) : new Response(null, { status: 429 });
  });
  const probe = (payload: unknown) =>
    probeClaude({
      executable: { command: process.execPath },
      argsPrefix: [script],
      configDir,
      profile: "test-profile",
      env: { ...process.env, TEST_USAGE: JSON.stringify(payload) },
      now: () => NOW,
    });
  assert.equal((await probe(usage())).resets?.available, 2);
  assert.equal(requests, 1);
  assert.equal((await probe(usage(INVENTORY))).resets?.available, 2);
  assert.equal(requests, 1);
  const failed = await probe(usage());
  assert.equal(requests, 2);
  assert.equal(failed.windows[0].usedPercent, 100);
  assert.equal(failed.resets, undefined);
});
