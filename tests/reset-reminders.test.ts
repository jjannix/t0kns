import assert from "node:assert/strict";
import test from "node:test";
import { createResetReminder, resetReminderId } from "../src/quota/reminders";
import { QuotaSnapshot, QuotaWindow } from "../src/quota/types";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const window: QuotaWindow = {
  id: "claude:model:opus",
  label: "Weekly limit",
  scope: "Opus",
  usedPercent: 100,
  resetsAt: NOW + 60_000,
};
const snapshot: QuotaSnapshot = {
  provider: "claude",
  source: "claude-code-control",
  profile: "default",
  checkedAt: NOW,
  windows: [window],
};

test("only exhausted limits with a future reported reset can create a reminder", () => {
  const reminder = createResetReminder(snapshot, window, NOW);
  assert.equal(reminder?.title, "Claude Code · Opus · Weekly limit · Default profile");
  assert.equal(reminder?.resetsAt, window.resetsAt);
  for (const changed of [
    { ...window, usedPercent: 99 },
    { ...window, usedPercent: undefined },
    { ...window, resetsAt: undefined },
    { ...window, resetsAt: NOW },
    { ...window, resetsAt: Number.NaN },
  ])
    assert.equal(createResetReminder(snapshot, changed, NOW), undefined);
});

test("reminders distinguish profiles and accounts in both their IDs and display titles", () => {
  const id = resetReminderId(snapshot, window);
  assert.ok(id.length < 16, "Windows requires the scheduled notification ID to fit below its boundary");
  assert.equal(resetReminderId(snapshot, { ...window, resetsAt: NOW + 120_000 }), id);
  assert.notEqual(resetReminderId({ ...snapshot, profile: "work" }, window), id);
  assert.notEqual(resetReminderId({ ...snapshot, account: { key: "other-account" } }, window), id);
  assert.notEqual(resetReminderId(snapshot, { ...window, id: "claude:seven_day" }), id);
  const personal = createResetReminder(
    { ...snapshot, account: { key: "12345678-personal", label: "me@example.com" } },
    window,
    NOW,
  )!;
  const work = createResetReminder(
    { ...snapshot, account: { key: "87654321-work", label: "me@example.com" } },
    window,
    NOW,
  )!;
  assert.match(personal.title, /me@example\.com \(12345678\)/);
  assert.notEqual(personal.title, work.title, "Accounts sharing a display label remain distinguishable");
  assert.notEqual(
    createResetReminder({ ...snapshot, profile: "C:\\personal\\profile" }, window, NOW)?.title,
    createResetReminder({ ...snapshot, profile: "C:\\work\\profile" }, window, NOW)?.title,
    "Profiles sharing a folder name remain distinguishable",
  );
});
