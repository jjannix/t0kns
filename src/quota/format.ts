import { ProviderId } from "./types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

const PROVIDER_TITLES: Record<ProviderId, string> = { codex: "Codex", claude: "Claude Code", glm: "GLM" };

/** For providers whose title is too long for a shared HUD. */
const PROVIDER_SHORT_TITLES: Partial<Record<ProviderId, string>> = { claude: "Claude" };

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  max: "Max",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

export function providerTitle(provider: ProviderId): string {
  return PROVIDER_TITLES[provider];
}

export function providerShortTitle(provider: ProviderId): string {
  return PROVIDER_SHORT_TITLES[provider] ?? PROVIDER_TITLES[provider];
}

export function planLabel(plan: string | undefined): string | undefined {
  if (!plan || plan === "unknown") {
    return undefined;
  }
  return (
    PLAN_LABELS[plan] ??
    plan
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

/** Remaining quota for display, bounded to 0–100. The raw used value is kept separately. */
export function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

/** Rounds for display without turning a sliver of quota into 0% or 100%. */
export function formatPercent(value: number): string {
  if (value > 0 && value < 1) {
    return "<1%";
  }
  if (value > 99 && value < 100) {
    return ">99%";
  }
  return `${Math.round(value)}%`;
}

export type QuotaLevel = "ok" | "low" | "critical" | "exhausted";

export function quotaLevel(usedPercent: number): QuotaLevel {
  const remaining = 100 - usedPercent;
  if (remaining <= 0) {
    return "exhausted";
  }
  if (remaining < 10) {
    return "critical";
  }
  if (remaining < 25) {
    return "low";
  }
  return "ok";
}

export function windowLabel(durationMinutes: number | undefined): string | undefined {
  if (durationMinutes === undefined || durationMinutes <= 0) {
    return undefined;
  }
  const minutes = Math.round(durationMinutes);
  if (minutes % MINUTES_PER_WEEK === 0) {
    const weeks = minutes / MINUTES_PER_WEEK;
    return weeks === 1 ? "Weekly limit" : `${weeks}-week limit`;
  }
  if (minutes % MINUTES_PER_DAY === 0) {
    const days = minutes / MINUTES_PER_DAY;
    return days === 1 ? "Daily limit" : `${days}-day limit`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}-hour limit`;
  }
  return `${minutes}-minute limit`;
}

/** Compact window name for tight spaces, e.g. "5h" or "week". */
export function shortWindowLabel(durationMinutes: number | undefined): string | undefined {
  if (durationMinutes === undefined || durationMinutes <= 0) {
    return undefined;
  }
  const minutes = Math.round(durationMinutes);
  if (minutes === MINUTES_PER_WEEK) {
    return "week";
  }
  if (minutes === MINUTES_PER_DAY) {
    return "day";
  }
  if (minutes % MINUTES_PER_WEEK === 0) {
    return `${minutes / MINUTES_PER_WEEK}w`;
  }
  if (minutes % MINUTES_PER_DAY === 0) {
    return `${minutes / MINUTES_PER_DAY}d`;
  }
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export type PaceKind = "faster" | "even" | "slower";

/** Percentage points by which usage may lead or trail elapsed time and still count as even. */
export const PACE_TOLERANCE = 10;

/**
 * Compares the share of quota used with the share of the window's time that has passed. Both are
 * reported or derived facts; this is not a forecast. Undefined once the limit is used up or the window is over.
 */
export function paceOf(
  usedPercent: number | undefined,
  elapsedFraction: number | undefined,
): { kind: PaceKind; usedPercent: number; elapsedPercent: number } | undefined {
  if (usedPercent === undefined || elapsedFraction === undefined || usedPercent >= 100 || elapsedFraction >= 1) {
    return undefined;
  }
  const elapsedPercent = elapsedFraction * 100;
  const lead = usedPercent - elapsedPercent;
  const kind = lead > PACE_TOLERANCE ? "faster" : lead < -PACE_TOLERANCE ? "slower" : "even";
  return { kind, usedPercent, elapsedPercent };
}

export function formatWindowDuration(durationMinutes: number): string {
  const minutes = Math.round(durationMinutes);
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (minutes % MINUTES_PER_WEEK === 0) {
    return plural(minutes / MINUTES_PER_WEEK, "week");
  }
  if (minutes % MINUTES_PER_DAY === 0) {
    return plural(minutes / MINUTES_PER_DAY, "day");
  }
  if (minutes % 60 === 0) {
    return plural(minutes / 60, "hour");
  }
  return plural(minutes, "minute");
}

/** Compact duration such as "2h 14m" or "3d 4h". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE_MS) {
    return "<1m";
  }
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/**
 * How much of a window's time has passed, derived only from its reported duration and reset time.
 * Undefined when either is unknown.
 */
export function elapsedInWindow(
  window: { durationMinutes?: number; resetsAt?: number },
  now: number,
): { elapsedMs: number; durationMs: number; fraction: number } | undefined {
  if (window.durationMinutes === undefined || window.resetsAt === undefined || window.durationMinutes <= 0) {
    return undefined;
  }
  const durationMs = window.durationMinutes * MINUTE_MS;
  const elapsedMs = Math.min(durationMs, Math.max(0, now - (window.resetsAt - durationMs)));
  return { elapsedMs, durationMs, fraction: elapsedMs / durationMs };
}

export function hasResetPassed(resetsAt: number, now: number): boolean {
  return resetsAt <= now;
}

export function formatResetLabel(resetsAt: number, now: number): string {
  if (hasResetPassed(resetsAt, now)) {
    return "Reset time passed — refresh needed";
  }
  const remaining = resetsAt - now;
  if (remaining < DAY_MS) {
    return `Resets in ${formatDuration(remaining)}`;
  }
  return `Resets ${formatShortDateTime(resetsAt, now)}`;
}

/** When a saved reset expires: "Expires in 5h 20m" within a day, otherwise "Expires Thu, 5 Nov, 08:31". */
export function formatExpiryLabel(expiresAt: number, now: number): string {
  if (expiresAt <= now) {
    return "Expired";
  }
  return expiresAt - now < DAY_MS
    ? `Expires in ${formatDuration(expiresAt - now)}`
    : `Expires ${formatShortDateTime(expiresAt, now)}`;
}

/** Exact local date and time including the time zone. */
export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(timestamp);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Compact local date and time such as "Today, 05:55" or "Tue, 20 Oct, 14:32". The year appears only
 * when it differs from the current one; the full timestamp is left to formatDateTime.
 */
export function formatShortDateTime(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const current = new Date(now);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === current.toDateString()) {
    return `Today, ${time}`;
  }
  const year = date.getFullYear() === current.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}${year}, ${time}`;
}

export function formatRelative(timestamp: number, now: number): string {
  const delta = timestamp - now;
  if (Math.abs(delta) < MINUTE_MS) {
    return "now";
  }
  return delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

export function formatAge(checkedAt: number, now: number): string {
  const age = Math.max(0, now - checkedAt);
  if (age < MINUTE_MS) {
    return "just now";
  }
  if (age < HOUR_MS) {
    return `${Math.floor(age / MINUTE_MS)}m ago`;
  }
  if (age < DAY_MS) {
    return `${Math.floor(age / HOUR_MS)}h ago`;
  }
  return `${Math.floor(age / DAY_MS)}d ago`;
}
