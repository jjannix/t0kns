import { QuotaErrorKind } from "./errors";
import {
  elapsedInWindow,
  formatAge,
  formatDuration,
  formatPercent,
  paceOf,
  providerTitle,
  remainingPercent,
  shortWindowLabel,
} from "./format";
import { hasPassedReset, isStale, ProviderState } from "./refresh";
import { resetNotes } from "./resets";
import { ProviderId, QuotaProvider, QuotaSnapshot } from "./types";

type Entries = readonly { provider: QuotaProvider; state: ProviderState | undefined }[];

export type QuickCheckFormat = "smart" | "all";

interface MainWindow {
  label: string;
  remaining: string;
  usedPercent: number;
  resetsAt?: number;
  durationMinutes?: number;
}

/** Short reasons for one-line summaries when a provider has no reading to show. */
const SHORT_FAILURES: Record<Exclude<QuotaErrorKind, "unsupported-auth">, string> = {
  "cli-missing": "CLI not found",
  "invalid-config": "check preferences",
  "signed-out": "signed out",
  "unsupported-version": "CLI update needed",
  "rate-limited": "rate limited, try again later",
  timeout: "didn't respond",
  cancelled: "couldn't read limits",
  "malformed-response": "couldn't read limits",
  unavailable: "couldn't read limits",
};

/** Each provider's subscription sign-in, which plan limits require. */
const NO_SUBSCRIPTION_SIGN_IN: Record<ProviderId, string> = {
  codex: "not signed in with ChatGPT",
  claude: "not signed in with a Claude plan",
};

/** HUD space is shared by both providers; detailed recovery guidance stays in Check AI Limits. */
const COMPACT_FAILURES: Record<QuotaErrorKind, string> = {
  "cli-missing": "CLI missing",
  "invalid-config": "check preferences",
  "signed-out": "signed out",
  "unsupported-auth": "plan sign-in needed",
  "unsupported-version": "update CLI",
  "rate-limited": "rate limited",
  timeout: "timed out",
  cancelled: "unavailable",
  "malformed-response": "unavailable",
  unavailable: "unavailable",
};

function shortFailure(provider: ProviderId, kind: QuotaErrorKind): string {
  return kind === "unsupported-auth" ? NO_SUBSCRIPTION_SIGN_IN[provider] : SHORT_FAILURES[kind];
}

/**
 * One line for the command's subtitle in Raycast's root search, e.g. "Codex 5h 56% · week 90% left · 21:34".
 * It includes the reading's time because it stays visible long after the reading goes stale.
 * Model-scoped windows are left to the command itself. Undefined when there is nothing to show yet.
 */
export function searchSubtitle(entries: Entries, now: number): string | undefined {
  const parts = entries
    .map(({ provider, state }) => {
      const name = providerTitle(provider.id);
      const snapshot = state?.snapshot;
      if (!snapshot) {
        if (state?.error?.kind === "signed-out") {
          return `${name}: signed out`;
        }
        if (isCoolingDown(state, now)) {
          return `${name}: rate limited`;
        }
        return state?.error && state.error.kind !== "cancelled" ? `${name}: unavailable` : undefined;
      }
      const values = mainWindows(snapshot).map((window) => `${window.label} ${window.remaining}`);
      const warnings = summaryNotes(state, snapshot, now);
      if (values.length === 0) {
        return [`${name}: no quota data`, ...warnings].join(" · ");
      }
      return [`${name} ${values.join(" · ")} left · ${readingTime(snapshot.checkedAt, now)}`, ...warnings].join(" · ");
    })
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("  |  ") : undefined;
}

/**
 * Smart HUDs show the primary window's remaining quota and expand when other limits need attention.
 * The full format keeps all main windows. Both retain cached-reading warnings.
 */
export function quickCheckText(entries: Entries, now: number, format: QuickCheckFormat = "smart"): string {
  if (entries.length === 0) {
    return "No providers enabled in t0kns's preferences";
  }
  if (format === "smart") {
    return fitHud(entries.map(({ provider, state }) => smartProviderTexts(provider, state, now)));
  }
  const compact = entries.length > 1;
  let hasQuota = false;
  const parts = entries.map(({ provider, state }) => {
    const name = compact && provider.id === "claude" ? "Claude" : providerTitle(provider.id);
    const snapshot = state?.snapshot;
    if (!snapshot) {
      const kind = state?.error?.kind ?? (isCoolingDown(state, now) ? "rate-limited" : undefined);
      if (compact) {
        return `${name}: ${kind ? COMPACT_FAILURES[kind] : "no reading yet"}`;
      }
      return `${name}: ${kind ? shortFailure(provider.id, kind) : "no reading yet"}`;
    }
    const warnings = summaryNotes(state, snapshot, now);
    const [first, ...rest] = mainWindows(snapshot);
    if (!first) {
      return [`${name}: no quota data`, ...warnings].join(" · ");
    }
    hasQuota = true;
    if (compact) {
      const values = [first, ...rest].map(
        (window) => `${window.label === "week" ? "wk" : window.label} ${window.remaining}`,
      );
      const age = isStale(snapshot, now) ? ` (${formatAge(snapshot.checkedAt, now)})` : "";
      return [`${name} ${values.join(" / ")}${age}`, ...warnings].join(" · ");
    }
    const values = [`${first.remaining} left (${first.label})`, ...rest.map((w) => `${w.remaining} (${w.label})`)];
    const age = isStale(snapshot, now) ? ` · from ${formatAge(snapshot.checkedAt, now)}` : "";
    return [`${name}: ${values.join(" · ")}${age}`, ...warnings].join(" · ");
  });
  return `${compact && hasQuota ? "Left · " : ""}${parts.join(" | ")}`;
}

/** Raycast truncates longer HUDs; on Windows a two-provider HUD was cut off after about 65 characters. */
export const HUD_MAX_LENGTH = 60;

/**
 * Joins one text per provider, stepping the longest provider down to a shorter text until the HUD fits.
 * Every provider stays visible; detail is what gets dropped.
 */
function fitHud(texts: readonly string[][]): string {
  const levels = texts.map(() => 0);
  const joined = () => texts.map((options, i) => options[levels[i]]).join(" | ");
  while (joined().length > HUD_MAX_LENGTH) {
    let longest: number | undefined;
    texts.forEach((options, i) => {
      if (
        levels[i] < options.length - 1 &&
        (longest === undefined || options[levels[i]].length > texts[longest][levels[longest]].length)
      ) {
        longest = i;
      }
    });
    if (longest === undefined) break;
    levels[longest] += 1;
  }
  return joined();
}

/** The provider's smart HUD text, followed by shorter versions for when the HUD runs out of space. */
function smartProviderTexts(provider: QuotaProvider, state: ProviderState | undefined, now: number): string[] {
  const name = provider.id === "claude" ? "Claude" : providerTitle(provider.id);
  const snapshot = state?.snapshot;
  if (!snapshot) {
    const kind = state?.error?.kind ?? (isCoolingDown(state, now) ? "rate-limited" : undefined);
    return [`${name}: ${kind ? COMPACT_FAILURES[kind] : "no reading yet"}`];
  }

  // Saved resets matter most once a limit has run out, so that note stays at every length;
  // an expiring reset is the first detail to go.
  const { saved, expiring } = resetNotes(snapshot, now);
  const texts = smartSnapshotTexts(name, snapshot, state, now).map((text) => (saved ? `${text} · ${saved}` : text));
  return expiring ? [`${texts[0]} · ${expiring}`, ...texts] : texts;
}

function smartSnapshotTexts(
  name: string,
  snapshot: QuotaSnapshot,
  state: ProviderState | undefined,
  now: number,
): string[] {
  const windows = mainWindows(snapshot);
  const warnings = readingWarnings(state, now);
  const stale = isStale(snapshot, now);
  const partial = snapshot.windows.some((window) => !window.scope && window.usedPercent === undefined);
  if (partial && windows.length > 0) warnings.push("some limits unavailable");

  if (warnings.length > 0 || stale || windows.length === 0) {
    const values = windows.length > 0 ? windows.map(windowQuotaText) : ["no quota data"];
    if (stale) values.push(`cached ${formatAge(snapshot.checkedAt, now)}`);
    return [`${name}: ${[...warnings, ...values].join(" · ")}`];
  }

  // Never choose between independent limits just by their remaining percentages.
  // Show every attention-worthy window, with exhausted/critical windows first.
  const attention = windows
    .map((window) => ({ window, priority: attentionPriority(window, snapshot.checkedAt) }))
    .filter(({ priority }) => priority > 0)
    .sort((a, b) => b.priority - a.priority);
  if (attention.length === 0) return [`${name}: ${windowQuotaText(windows[0])}`];

  // Shorter texts first drop countdowns from pace-only notes, then the pace notes, then the less
  // urgent countdowns. Low and exhausted quota keep its percentage in every version.
  const describe = (level: number) =>
    `${name}: ${attention
      .map(({ window }, index) => {
        const paceOnly = remainingPercent(window.usedPercent) >= 25;
        const values = [
          window.usedPercent >= 100
            ? `${window.label === "week" ? "wk" : window.label} limit reached`
            : windowQuotaText(window),
        ];
        if (paceOnly && level < 2) values.push("ahead of pace");
        const countdown = paceOnly ? level === 0 : level < 3 || (level === 3 && index === 0);
        if (window.resetsAt !== undefined && countdown) {
          values.push(`resets in ${formatDuration(window.resetsAt - now)}`);
        }
        return values.join(" · ");
      })
      .join("; ")}`;
  return [0, 1, 2, 3, 4].map(describe).filter((text, i, texts) => i === 0 || text !== texts[i - 1]);
}

function windowQuotaText(window: MainWindow): string {
  return `${window.label === "week" ? "wk" : window.label} ${window.remaining} left`;
}

/**
 * Descriptive comparison of reported usage with elapsed time, not a depletion forecast. Elapsed time is
 * measured at the reading, since usage after it is unknown.
 */
function attentionPriority(window: MainWindow, checkedAt: number): number {
  if (window.usedPercent >= 100) return 300;
  const remaining = remainingPercent(window.usedPercent);
  if (remaining < 10) return 200 + window.usedPercent;

  const elapsed = elapsedInWindow(window, checkedAt);
  if (!elapsed) return remaining < 25 ? 100 + window.usedPercent : 0;
  const pace = paceOf(window.usedPercent, elapsed.fraction);
  // Ignore small opening bursts. Low quota near a reset does not need a warning if it is on pace.
  return window.usedPercent >= 25 && pace?.kind === "faster" ? 100 + pace.usedPercent - pace.elapsedPercent : 0;
}

/** Reading warnings followed by saved-reset notes, for summaries that show both. */
function summaryNotes(state: ProviderState | undefined, snapshot: QuotaSnapshot, now: number): string[] {
  const { saved, expiring } = resetNotes(snapshot, now);
  return [...readingWarnings(state, now), ...[saved, expiring].filter((note): note is string => note !== undefined)];
}

/** Status applies to the whole reading even when the summary omits a window or has no percentages. */
function readingWarnings(state: ProviderState | undefined, now: number): string[] {
  const snapshot = state?.snapshot;
  const warnings: string[] = [];
  if (snapshot?.usageAllowed === false) {
    warnings.push("usage blocked");
  }
  if (snapshot && hasPassedReset(snapshot, now)) {
    warnings.push("reset passed, refresh needed");
  }
  if (state?.error) {
    warnings.push(`last refresh failed: ${COMPACT_FAILURES[state.error.kind]}`);
  } else if (isCoolingDown(state, now)) {
    // Cooldowns survive command launches even though the original failure does not.
    warnings.push("refresh paused: rate limited");
  }
  return warnings;
}

function isCoolingDown(state: ProviderState | undefined, now: number): boolean {
  return state?.retryAfter !== undefined && state.retryAfter > now;
}

/** The provider's main windows with a reported percentage, as compact labels and remaining quota. */
function mainWindows(snapshot: QuotaSnapshot): MainWindow[] {
  return snapshot.windows
    .filter((window) => !window.scope && window.usedPercent !== undefined)
    .map((window) => ({
      label: shortWindowLabel(window.durationMinutes) ?? window.label,
      remaining: formatPercent(remainingPercent(window.usedPercent ?? 0)),
      usedPercent: window.usedPercent ?? 0,
      resetsAt: window.resetsAt,
      durationMinutes: window.durationMinutes,
    }));
}

function readingTime(checkedAt: number, now: number): string {
  const sameDay = new Date(checkedAt).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" },
  ).format(checkedAt);
}
