import {
  AccountIdentity,
  LimitReset,
  LimitResets,
  PROVIDER_IDS,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindow,
  UsageCredits,
  UsageShare,
} from "./types";

/** Minimal synchronous storage, satisfied by Raycast's `Cache` and by an in-memory map in tests. */
export interface KeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface StoredProviderState {
  snapshot?: QuotaSnapshot;
  /** Epoch milliseconds before which the provider should not be asked again. */
  retryAfter?: number;
}

const KEY_PREFIX = "quota:v1:";

/**
 * Persists the last successful normalized snapshot and any cooldown per provider, source, and profile.
 * Only normalized quota and display metadata are stored: no credentials or raw protocol payloads.
 */
export class SnapshotCache {
  constructor(private readonly store: KeyValueStore) {}

  read(provider: QuotaProvider): StoredProviderState {
    let raw: string | undefined;
    try {
      raw = this.store.get(cacheKey(provider));
    } catch {
      return {};
    }
    if (!raw) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return {};
      }
      const snapshot = parseSnapshot(parsed.snapshot);
      const belongsHere =
        snapshot?.provider === provider.id &&
        snapshot.source === provider.source &&
        snapshot.profile === provider.profile;
      return {
        snapshot: belongsHere ? snapshot : undefined,
        retryAfter: finite(parsed.retryAfter),
      };
    } catch {
      return {};
    }
  }

  write(provider: QuotaProvider, state: StoredProviderState): void {
    try {
      if (!state.snapshot && state.retryAfter === undefined) {
        this.store.remove(cacheKey(provider));
        return;
      }
      this.store.set(cacheKey(provider), JSON.stringify({ snapshot: state.snapshot, retryAfter: state.retryAfter }));
    } catch {
      // A failed cache write only costs a refresh on the next launch.
    }
  }
}

export function cacheKey(provider: QuotaProvider): string {
  return `${KEY_PREFIX}${provider.source}:${provider.key}`;
}

function parseSnapshot(value: unknown): QuotaSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.windows)) {
    return undefined;
  }
  const provider = PROVIDER_IDS.find((id) => id === value.provider);
  const source = string(value.source);
  const profile = string(value.profile);
  const checkedAt = finite(value.checkedAt);
  if (!provider || !source || !profile || checkedAt === undefined) {
    return undefined;
  }
  const windows: QuotaWindow[] = [];
  for (const window of value.windows) {
    const parsed = parseWindow(window);
    if (!parsed) {
      return undefined;
    }
    windows.push(parsed);
  }
  return {
    provider,
    source,
    profile,
    account: parseAccount(value.account),
    plan: string(value.plan),
    checkedAt,
    usageAllowed: typeof value.usageAllowed === "boolean" ? value.usageAllowed : undefined,
    windows,
    resets: parseResets(value.resets),
    credits: parseCredits(value.credits),
    cliVersion: string(value.cliVersion),
  };
}

function parseCredits(value: unknown): UsageCredits | undefined {
  const currency = isRecord(value) ? string(value.currency) : undefined;
  if (!isRecord(value) || typeof value.enabled !== "boolean" || !currency) {
    return undefined;
  }
  return {
    enabled: value.enabled,
    used: finite(value.used),
    monthlyLimit: finite(value.monthlyLimit),
    usedPercent: finite(value.usedPercent),
    currency,
  };
}

/** A damaged inventory is dropped on its own; the windows are still worth showing. */
function parseResets(value: unknown): LimitResets | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return undefined;
  }
  const available = finite(value.available);
  if (available === undefined || available < 0) {
    return undefined;
  }
  const items: LimitReset[] = value.items.filter(isRecord).map((item) => ({
    title: string(item.title),
    grantedAt: finite(item.grantedAt),
    expiresAt: finite(item.expiresAt),
  }));
  return { available, items };
}

function parseWindow(value: unknown): QuotaWindow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = string(value.id);
  const label = string(value.label);
  if (!id || !label) {
    return undefined;
  }
  return {
    id,
    label,
    scope: string(value.scope),
    usedPercent: finite(value.usedPercent),
    durationMinutes: finite(value.durationMinutes),
    resetsAt: finite(value.resetsAt),
    breakdown: parseBreakdown(value.breakdown),
  };
}

function parseBreakdown(value: unknown): UsageShare[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const shares = value.flatMap((share): UsageShare[] => {
    const label = isRecord(share) ? string(share.label) : undefined;
    const percent = isRecord(share) ? finite(share.percent) : undefined;
    return label && percent !== undefined ? [{ label, percent }] : [];
  });
  return shares.length > 0 ? shares : undefined;
}

function parseAccount(value: unknown): AccountIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const account = { key: string(value.key), label: string(value.label) };
  return account.key || account.label ? account : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
