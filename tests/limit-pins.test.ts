import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeUsage } from "../src/providers/claude";
import { normalizeCodexRateLimits } from "../src/providers/codex";
import { addPin, createLimitPin, LimitPinStore, pinKey } from "../src/quota/pins";
import { HUD_MAX_LENGTH, quickCheckText } from "../src/quota/summary";
import { QuotaProvider } from "../src/quota/types";

const NOW = Date.parse("2026-10-17T12:00:00Z");

function scenario(opusUsed = 20) {
  const context = { profile: "default", checkedAt: NOW };
  const snapshots = [
    normalizeCodexRateLimits({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } }, context),
    normalizeClaudeUsage(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10 },
          seven_day: { utilization: 15 },
          model_scoped: [{ display_name: "Opus", utilization: opusUsed }],
        },
      },
      context,
    ),
  ];
  const entries = snapshots.map((snapshot) => {
    const provider: QuotaProvider = {
      id: snapshot.provider,
      key: `${snapshot.provider}:${snapshot.profile}`,
      profile: snapshot.profile,
      source: snapshot.source,
      probe: async () => snapshot,
    };
    return { provider, state: { snapshot, loading: false } };
  });
  const main = createLimitPin(entries[0].provider, snapshots[0].windows[0]);
  const opus = createLimitPin(
    entries[1].provider,
    snapshots[1].windows.find((window) => window.scope === "Opus")!,
  );
  return { entries, main, opus, pins: addPin(addPin({ pins: [] }, main), opus) };
}

test("pins and the preferred model limit survive a new launch", async () => {
  const { entries, pins, opus } = scenario();
  const data = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => data.get(key),
    setItem: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const store = new LimitPinStore(storage);
  await store.update(() => addPin(pins, opus, true));
  const reopened = new LimitPinStore(storage);
  await reopened.load();
  const saved = reopened.getState().settings;
  assert.equal(saved.pins.length, 2);
  assert.equal(saved.preferred, pinKey(opus));
  assert.equal(quickCheckText(entries, NOW, "pins", saved), "Claude: Opus wk 80% left");
});

test("Quick Check expands for a critical pinned Opus cap despite healthy account-wide quota", () => {
  const healthy = scenario();
  assert.equal(quickCheckText(healthy.entries, NOW, "pins", healthy.pins), "Codex: 5h 80% left");
  const critical = scenario(99);
  const text = quickCheckText(critical.entries, NOW, "pins", critical.pins);
  assert.equal(text, "Codex: 5h 80% left | Claude: Opus wk 1% left");
  assert.ok(text.length <= HUD_MAX_LENGTH);
});

test("Smart and All Windows stay unchanged, and no pins falls back to Smart", () => {
  const { entries, pins } = scenario(100);
  for (const format of ["smart", "all"] as const) {
    assert.equal(quickCheckText(entries, NOW, format, pins), quickCheckText(entries, NOW, format));
    assert.doesNotMatch(quickCheckText(entries, NOW, format, pins), /Opus/);
  }
  assert.equal(quickCheckText(entries, NOW, "pins"), quickCheckText(entries, NOW, "smart"));
});
