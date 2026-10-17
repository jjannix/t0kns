import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotCache } from "../src/quota/cache";
import { QuotaError } from "../src/quota/errors";
import { addPin, createLimitPin } from "../src/quota/pins";
import { QUICK_CHECK_DEADLINE_MS, readQuickCheck } from "../src/quota/quick-check";
import { FRESHNESS_MS, QuotaRefresher } from "../src/quota/refresh";
import { HUD_MAX_LENGTH, quickCheckText } from "../src/quota/summary";
import { ProviderId, QuotaProvider, QuotaSnapshot } from "../src/quota/types";

const NOW = Date.UTC(2026, 9, 17, 12);

function pendingProvider(id: ProviderId) {
  let resolve!: (snapshot: QuotaSnapshot) => void;
  let reject!: (error: Error) => void;
  let signal: AbortSignal | undefined;
  const reading = new Promise<QuotaSnapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const provider: QuotaProvider = {
    id,
    key: `${id}:default`,
    source: `${id}-test`,
    profile: "default",
    probe(abortSignal) {
      signal = abortSignal;
      // Intentionally ignores cancellation, like non-cancellable executable discovery.
      return reading;
    },
  };
  return {
    provider,
    resolve,
    reject,
    get signal() {
      return signal;
    },
  };
}

function snapshot(provider: QuotaProvider, checkedAt = NOW): QuotaSnapshot {
  return {
    provider: provider.id,
    source: provider.source,
    profile: provider.profile,
    checkedAt,
    windows: [
      { id: "primary", label: "5-hour limit", durationMinutes: 300, usedPercent: 10 },
      { id: "secondary", label: "Weekly limit", durationMinutes: 10080, usedPercent: 20 },
    ],
  };
}

function memoryCache() {
  const store = new Map<string, string>();
  const cache = new SnapshotCache({
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
    remove: (key) => {
      store.delete(key);
    },
  });
  return { cache, store };
}

/** Flush promise chains without advancing the mocked deadline clock. */
async function settlePromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

for (const cached of [false, true]) {
  test(`a slow provider returns ${cached ? "cached quota" : "unavailable"} alongside the completed provider`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
    const fast = pendingProvider("codex");
    const slow = pendingProvider("claude");
    const providers = [slow.provider, fast.provider];
    const pins = addPin({ pins: [] }, createLimitPin(fast.provider, snapshot(fast.provider).windows[0]));
    const { cache, store } = memoryCache();
    if (cached) cache.write(slow.provider, { snapshot: snapshot(slow.provider, NOW - FRESHNESS_MS * 2) });
    const refresher = new QuotaRefresher(providers, cache);
    let finished = false;
    const reading = readQuickCheck(providers, refresher).then((entries) => {
      finished = true;
      return entries;
    });
    fast.resolve(snapshot(fast.provider));
    await settlePromises();
    t.mock.timers.tick(QUICK_CHECK_DEADLINE_MS - 1);
    await settlePromises();
    assert.equal(finished, false);
    t.mock.timers.tick(1);
    const entries = await reading;

    assert.equal(Date.now(), NOW + QUICK_CHECK_DEADLINE_MS);
    assert.equal(entries[0].timedOut, true);
    assert.equal(entries[1].timedOut, false);
    assert.equal(slow.signal?.aborted, true);
    assert.equal(refresher.getStates()[slow.provider.key].loading, false);
    for (const format of ["pins", "smart", "all"] as const) {
      const text = quickCheckText(entries, Date.now(), format, pins);
      assert.match(text, cached ? /Claude.*cached/ : /Claude: unavailable/);
      assert.match(text, /Codex.*90%/);
      if (cached && format !== "pins") {
        assert.match(text, /Claude.*5h 90%/);
        assert.match(text, /wk 80%/);
      }
      assert.doesNotMatch(text, /no reading yet|last refresh failed/);
      if (format === "smart") assert.ok(text.length <= HUD_MAX_LENGTH, text);
    }

    // A probe finishing after the overlay must not replace either the result or the shared cache.
    const stoppedStates = refresher.getStates();
    const stoppedCache = new Map(store);
    slow.resolve(snapshot(slow.provider, Date.now()));
    await settlePromises();
    assert.equal(refresher.getStates(), stoppedStates);
    assert.deepEqual(store, stoppedCache);
    assert.equal(entries[0].state?.snapshot?.checkedAt, cached ? NOW - FRESHNESS_MS * 2 : undefined);
  });
}

test("two slow providers share one deadline, including a late rejection", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const codex = pendingProvider("codex");
  const claude = pendingProvider("claude");
  const providers = [claude.provider, codex.provider];
  const { cache, store } = memoryCache();
  const refresher = new QuotaRefresher(providers, cache);
  const reading = readQuickCheck(providers, refresher);
  assert.ok(codex.signal && claude.signal, "both probes start before the deadline");
  t.mock.timers.tick(QUICK_CHECK_DEADLINE_MS);
  const entries = await reading;
  assert.ok(entries.every((entry) => entry.timedOut));
  assert.equal(quickCheckText(entries, Date.now()), "Claude: unavailable | Codex: unavailable");
  assert.equal(codex.signal.aborted, true);
  assert.equal(claude.signal.aborted, true);
  claude.reject(new QuotaError("rate-limited", "Late rate limit"));
  codex.resolve(snapshot(codex.provider));
  await settlePromises();
  assert.equal(store.size, 0);
  assert.ok(Object.values(refresher.getStates()).every((state) => !state.loading && !state.error && !state.retryAfter));
});

test("compact cached fallbacks retain exhausted and low quota for both providers", () => {
  const providers = [pendingProvider("claude").provider, pendingProvider("codex").provider];
  const entries = providers.map((provider) => {
    const stored = snapshot(provider, NOW - FRESHNESS_MS);
    stored.windows[0].usedPercent = 100;
    stored.windows[1].usedPercent = 95;
    return { provider, state: { snapshot: stored, loading: false }, timedOut: true };
  });
  const text = quickCheckText(entries, NOW);
  assert.ok(text.length <= HUD_MAX_LENGTH, text);
  for (const name of ["Claude", "Codex"]) {
    assert.ok(text.includes(`${name}: cached 5h 0%/wk 5%`), text);
  }
});

test("completed probes return immediately and clear the shared timer", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const codex = pendingProvider("codex");
  const { cache } = memoryCache();
  const refresher = new QuotaRefresher([codex.provider], cache);
  const reading = readQuickCheck([codex.provider], refresher);
  codex.resolve(snapshot(codex.provider));
  const entries = await reading;
  assert.equal(entries[0].timedOut, false);
  assert.equal(quickCheckText(entries, Date.now()), "Codex: 5h 90% left");
  t.mock.timers.runAll();
  assert.equal(Date.now(), NOW, "no deadline timer remains after an early result");
});

test("a passed reset still refreshes, with an explicitly cached fallback at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const codex = pendingProvider("codex");
  const stored = snapshot(codex.provider);
  stored.windows[0].resetsAt = NOW - 1;
  const pins = addPin({ pins: [] }, createLimitPin(codex.provider, stored.windows[0]));
  const { cache } = memoryCache();
  cache.write(codex.provider, { snapshot: stored });
  const reading = readQuickCheck([codex.provider], new QuotaRefresher([codex.provider], cache));
  assert.ok(codex.signal);
  t.mock.timers.tick(QUICK_CHECK_DEADLINE_MS);
  const entries = await reading;
  for (const format of ["pins", "smart", "all"] as const) {
    const text = quickCheckText(entries, Date.now(), format, pins);
    assert.match(text, /cached/);
    assert.match(text, /reset passed, refresh needed/);
  }
  codex.resolve(snapshot(codex.provider));
  await settlePromises();
});
