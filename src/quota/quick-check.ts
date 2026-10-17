import { QuotaRefresher } from "./refresh";
import { QuickCheckEntry } from "./summary";
import { QuotaProvider } from "./types";

/** One budget for the whole command, including executable discovery and CLI requests. */
export const QUICK_CHECK_DEADLINE_MS = 2_000;

/** Returns completed readings or explicitly marked fallbacks without waiting for probe cleanup. */
export async function readQuickCheck(
  providers: readonly QuotaProvider[],
  refresher: QuotaRefresher,
): Promise<QuickCheckEntry[]> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, QUICK_CHECK_DEADLINE_MS);
  });
  try {
    await Promise.race([refresher.refreshAll({ force: false }), deadline]);
    const states = refresher.getStates();
    return providers.map((provider) => {
      const state = states[provider.key];
      return { provider, state, timedOut: state?.loading ?? false };
    });
  } finally {
    clearTimeout(timer);
    // Abort before showing the HUD. Even probes that ignore cancellation cannot update the cache later.
    refresher.stop();
  }
}
