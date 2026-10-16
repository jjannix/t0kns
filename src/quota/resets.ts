import { formatDuration } from "./format";
import { LimitReset, LimitResets, QuotaSnapshot } from "./types";

/** Each reset is listed on its own line, so longer lists are cut; the reported count is kept. */
export const MAX_LISTED_RESETS = 50;

/** A saved reset expiring sooner than this is flagged so it isn't lost unused. */
export const RESET_EXPIRY_WARNING_MS = 3 * 24 * 60 * 60_000;

/** Soonest expiry first; resets that never expire go last. */
export function byExpiry(a: LimitReset, b: LimitReset): number {
  if (a.expiresAt === undefined || b.expiresAt === undefined) {
    return a.expiresAt === b.expiresAt ? 0 : a.expiresAt === undefined ? 1 : -1;
  }
  return a.expiresAt - b.expiresAt;
}

/**
 * Resets still usable at `now`: the reported count less any listed reset that has expired since the reading.
 * Unlisted resets can't be checked, so they keep counting until the next refresh.
 */
export function availableResets(resets: LimitResets | undefined, now: number): { count: number; items: LimitReset[] } {
  if (!resets) {
    return { count: 0, items: [] };
  }
  const items = resets.items.filter((reset) => reset.expiresAt === undefined || reset.expiresAt > now);
  return { count: Math.max(0, resets.available - (resets.items.length - items.length)), items };
}

/** The soonest saved reset's expiry when it falls within the warning period; undefined otherwise. */
export function expiringSoon(resets: LimitResets | undefined, now: number): number | undefined {
  const next = availableResets(resets, now).items[0]?.expiresAt;
  return next !== undefined && next - now < RESET_EXPIRY_WARNING_MS ? next : undefined;
}

/**
 * Saved resets worth pointing out because a limit has run out: a main window is used up (and its reset
 * hasn't passed) or usage is blocked. Model-scoped windows don't count, since a reset isn't known to
 * restore them. 0 when nothing has run out.
 */
export function resetsForBlockedLimit(snapshot: QuotaSnapshot, now: number): number {
  const blocked =
    snapshot.usageAllowed === false ||
    snapshot.windows.some(
      (window) =>
        !window.scope &&
        window.usedPercent !== undefined &&
        window.usedPercent >= 100 &&
        (window.resetsAt === undefined || window.resetsAt > now),
    );
  return blocked ? availableResets(snapshot.resets, now).count : 0;
}

/**
 * Short notes for one-line summaries: saved resets while a limit has run out, and a saved reset about
 * to expire unused.
 */
export function resetNotes(snapshot: QuotaSnapshot, now: number): { saved?: string; expiring?: string } {
  const saved = resetsForBlockedLimit(snapshot, now);
  const expiresAt = expiringSoon(snapshot.resets, now);
  return {
    saved: saved > 0 ? (saved === 1 ? "1 reset saved" : `${saved} resets saved`) : undefined,
    expiring: expiresAt === undefined ? undefined : `saved reset expires in ${formatDuration(expiresAt - now)}`,
  };
}
