import { SnapshotCache } from "./cache";
import { QuotaFailure, toQuotaFailure } from "./errors";
import { hasResetPassed } from "./format";
import { QuotaProvider, QuotaSnapshot } from "./types";

/** Readings younger than this are reused on open unless a reported reset has passed. */
export const FRESHNESS_MS = 5 * 60_000;
/** Cooldown after a rate-limit response that didn't say when to retry. */
export const FALLBACK_COOLDOWN_MS = 5 * 60_000;

/** Refresh state is kept apart from the last successful snapshot so a failed refresh never hides it. */
export interface ProviderState {
  snapshot?: QuotaSnapshot;
  loading: boolean;
  lastAttemptAt?: number;
  error?: QuotaFailure;
  retryAfter?: number;
}

export type RefreshOutcome =
  | { status: "refreshed" }
  | { status: "failed"; failure: QuotaFailure }
  | { status: "fresh" }
  | { status: "cooling-down"; retryAfter: number }
  | { status: "discarded" };

export function isStale(snapshot: QuotaSnapshot, now: number): boolean {
  return now - snapshot.checkedAt >= FRESHNESS_MS || hasPassedReset(snapshot, now);
}

/** Any reported window reset invalidates the cached reading, including scoped or unmeasured windows. */
export function hasPassedReset(snapshot: QuotaSnapshot, now: number): boolean {
  return snapshot.windows.some((window) => window.resetsAt !== undefined && hasResetPassed(window.resetsAt, now));
}

/**
 * Coordinates probes for a fixed set of providers: renders from cache first, refreshes stale readings,
 * coalesces concurrent requests per provider/profile, honors cooldowns, and drops results that arrive
 * after a session stops. Framework-independent so it can be tested without Raycast.
 *
 * Sessions can stop and start again on the same instance, as when React re-runs an effect.
 */
export class QuotaRefresher {
  private states: Readonly<Record<string, ProviderState>>;
  private readonly inflight = new Map<string, Promise<RefreshOutcome>>();
  private readonly listeners = new Set<() => void>();
  /** The running session's controller; undefined while stopped. */
  private controller: AbortController | undefined = new AbortController();
  private readonly now: () => number;

  constructor(
    private readonly providers: readonly QuotaProvider[],
    private readonly cache: SnapshotCache,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    const now = this.now();
    const initial: Record<string, ProviderState> = {};
    for (const provider of providers) {
      const stored = cache.read(provider);
      initial[provider.key] = {
        snapshot: stored.snapshot,
        loading: false,
        retryAfter: stored.retryAfter !== undefined && stored.retryAfter > now ? stored.retryAfter : undefined,
      };
    }
    this.states = initial;
  }

  readonly getStates = (): Readonly<Record<string, ProviderState>> => this.states;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  refreshAll(options: { force: boolean }): Promise<{ provider: QuotaProvider; outcome: RefreshOutcome }[]> {
    return Promise.all(
      this.providers.map(async (provider) => ({ provider, outcome: await this.refresh(provider, options) })),
    );
  }

  /** `force` bypasses freshness only. It never starts a second probe or skips a cooldown. */
  refresh(provider: QuotaProvider, options: { force: boolean }): Promise<RefreshOutcome> {
    const controller = this.controller;
    if (!controller) {
      return Promise.resolve({ status: "discarded" });
    }
    const running = this.inflight.get(provider.key);
    if (running) {
      return running;
    }
    const state = this.states[provider.key];
    const now = this.now();
    if (state?.retryAfter !== undefined && state.retryAfter > now) {
      return Promise.resolve({ status: "cooling-down", retryAfter: state.retryAfter });
    }
    if (!options.force && state?.snapshot && !isStale(state.snapshot, now)) {
      return Promise.resolve({ status: "fresh" });
    }
    const promise: Promise<RefreshOutcome> = this.run(provider, controller.signal).finally(() => {
      if (this.inflight.get(provider.key) === promise) {
        this.inflight.delete(provider.key);
      }
    });
    this.inflight.set(provider.key, promise);
    return promise;
  }

  /** Starts a session if none is running. Refreshes are discarded while stopped. */
  start(): void {
    this.controller ??= new AbortController();
  }

  /** Cancels running probes, ignores anything they return afterwards, and clears their loading state. */
  stop(): void {
    if (!this.controller) {
      return;
    }
    this.controller.abort();
    this.controller = undefined;
    this.inflight.clear();
    const settled = Object.fromEntries(
      Object.entries(this.states).map(([key, state]) => [key, state.loading ? { ...state, loading: false } : state]),
    );
    if (Object.keys(settled).some((key) => settled[key] !== this.states[key])) {
      this.states = settled;
      this.notify();
    }
  }

  private async run(provider: QuotaProvider, signal: AbortSignal): Promise<RefreshOutcome> {
    this.update(provider.key, { loading: true, lastAttemptAt: this.now() });
    try {
      const snapshot = await provider.probe(signal);
      if (signal.aborted) {
        return { status: "discarded" };
      }
      if (
        snapshot.provider !== provider.id ||
        snapshot.source !== provider.source ||
        snapshot.profile !== provider.profile
      ) {
        this.update(provider.key, { loading: false });
        return { status: "discarded" };
      }
      this.cache.write(provider, { snapshot });
      this.update(provider.key, { snapshot, loading: false, error: undefined, retryAfter: undefined });
      return { status: "refreshed" };
    } catch (error) {
      if (signal.aborted) {
        return { status: "discarded" };
      }
      const failure = toQuotaFailure(error);
      // After a sign-out or an auth change, the previous account's quota is no longer this profile's quota.
      const snapshot =
        failure.kind === "signed-out" || failure.kind === "unsupported-auth"
          ? undefined
          : this.states[provider.key]?.snapshot;
      const retryAfter =
        failure.kind === "rate-limited" ? (failure.retryAfter ?? this.now() + FALLBACK_COOLDOWN_MS) : undefined;
      this.cache.write(provider, { snapshot, retryAfter });
      this.update(provider.key, { snapshot, loading: false, error: failure, retryAfter });
      return { status: "failed", failure };
    }
  }

  private update(key: string, patch: Partial<ProviderState>): void {
    this.states = { ...this.states, [key]: { ...(this.states[key] ?? { loading: false }), ...patch } };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
