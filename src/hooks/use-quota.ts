import { Cache, showToast, Toast, updateCommandMetadata } from "@raycast/api";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SnapshotCache } from "../quota/cache";
import { formatRelative, providerTitle } from "../quota/format";
import { ProviderState, QuotaRefresher } from "../quota/refresh";
import { searchSubtitle } from "../quota/summary";
import { QuotaProvider } from "../quota/types";
import { failureCopy } from "../components/provider-state";

const store = new Cache({ namespace: "quota" });

/** A refresher backed by the cache all of t0kns's commands share. */
export function createQuotaRefresher(providers: readonly QuotaProvider[]): QuotaRefresher {
  return new QuotaRefresher(providers, new SnapshotCache(store));
}

/** Cached snapshots render immediately; stale or missing readings refresh once on open. */
export function useQuota(providers: readonly QuotaProvider[]) {
  const [refresher] = useState(() => createQuotaRefresher(providers));
  const states = useSyncExternalStore(refresher.subscribe, refresher.getStates);

  // React may run this effect's cleanup and then the effect again on the same refresher (development mode,
  // hot reload), so each run starts its own session instead of disposing the refresher for good.
  useEffect(() => {
    refresher.start();
    void refresher.refreshAll({ force: false });
    return () => refresher.stop();
  }, [refresher]);

  const refresh = useCallback(async () => {
    const results = await refresher.refreshAll({ force: true });
    for (const { provider, outcome } of results) {
      const title = providerTitle(provider.id);
      if (outcome.status === "cooling-down") {
        await showToast({
          style: Toast.Style.Failure,
          title: `${title} is rate limited`,
          message: `Next refresh allowed ${formatRelative(outcome.retryAfter, Date.now())}`,
        });
      } else if (outcome.status === "failed") {
        await showToast({
          style: Toast.Style.Failure,
          title: `Couldn't refresh ${title}`,
          message: failureCopy(provider.id, outcome.failure, Date.now()).title,
        });
      }
    }
  }, [refresher]);

  return { states, refresh };
}

/** Mirrors the latest readings into the command's subtitle, so Raycast's root search shows them without opening. */
export function useSearchSubtitle(
  providers: readonly QuotaProvider[],
  states: Readonly<Record<string, ProviderState>>,
): void {
  const subtitle = searchSubtitle(
    providers.map((provider) => ({ provider, state: states[provider.key] })),
    Date.now(),
  );
  const applied = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const next = subtitle ?? null;
    if (applied.current === next) {
      return;
    }
    applied.current = next;
    // A missing subtitle is cosmetic; never surface it as an error.
    updateCommandMetadata({ subtitle: next }).catch(() => undefined);
  }, [subtitle]);
}

/** Current time, ticking so relative labels stay current without new requests. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
