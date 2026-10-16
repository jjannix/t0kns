export type ProviderId = "codex" | "claude";

export interface QuotaWindow {
  /** Stable across refreshes, e.g. `codex:primary`. */
  id: string;
  /** Label derived from the reported duration, e.g. "5-hour limit". */
  label: string;
  /** Model or bucket the window applies to. Absent for the provider's main quota. */
  scope?: string;
  /** Raw provider-reported usage. May exceed 100. Undefined when no valid value was reported. */
  usedPercent?: number;
  durationMinutes?: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
  /** How the window's usage splits across products, largest first. Shares of usage, not of the limit. */
  breakdown?: UsageShare[];
}

export interface UsageShare {
  /** Provider's display name, e.g. "Claude Code". */
  label: string;
  /** Percentage of the window's usage, 0–100. */
  percent: number;
}

/** One saved limit reset that can be redeemed with the provider. Redemption identifiers are never kept. */
export interface LimitReset {
  /** Provider's display title, e.g. "Full reset (Weekly + 5 hr)". */
  title?: string;
  /** Epoch milliseconds. */
  grantedAt?: number;
  /** Epoch milliseconds. Undefined when the reset doesn't expire. */
  expiresAt?: number;
}

export interface LimitResets {
  /** Resets available at the reading. */
  available: number;
  /** Known resets, soonest expiry first. May list fewer than `available`, or none, when the provider caps or omits details. */
  items: LimitReset[];
}

/**
 * Pay-as-you-go spend that covers usage beyond the plan's limits, billed separately from the subscription.
 * Amounts are in minor units of `currency` (cents for USD).
 */
export interface UsageCredits {
  /** Whether credits can currently cover usage past the plan's limits. */
  enabled: boolean;
  /** Spent this billing period. */
  used?: number;
  /** Monthly spending cap. Undefined when uncapped or not reported. */
  monthlyLimit?: number;
  /** Percentage of the monthly cap spent, 0–100. */
  usedPercent?: number;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
}

export interface AccountIdentity {
  /** Opaque hash used only to detect account changes; never the provider's raw identifier. */
  key?: string;
  /** Display label such as an email address. */
  label?: string;
}

export interface QuotaSnapshot {
  provider: ProviderId;
  /** Integration that produced the reading, e.g. `codex-app-server`. */
  source: string;
  /** Configured local profile the reading belongs to. */
  profile: string;
  account?: AccountIdentity;
  plan?: string;
  /** Epoch milliseconds when the provider was read. */
  checkedAt: number;
  /** Provider-reported permission for ordinary usage. Undefined when not reported. */
  usageAllowed?: boolean;
  /** Reported windows in display order. Empty when the provider reported no quota data. */
  windows: QuotaWindow[];
  /** Saved limit resets. Undefined when the provider reported no reset inventory. */
  resets?: LimitResets;
  /** Spend beyond the plan's limits. Undefined when the provider didn't report it. */
  credits?: UsageCredits;
  /** Version of the CLI that produced the reading, for diagnostics. */
  cliVersion?: string;
}

export interface QuotaProvider {
  id: ProviderId;
  /** Unique per provider and profile; used for cache and refresh coalescing. */
  key: string;
  source: string;
  profile: string;
  probe(signal: AbortSignal): Promise<QuotaSnapshot>;
}
