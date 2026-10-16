import { getPreferenceValues, showHUD } from "@raycast/api";
import { createQuotaRefresher } from "./hooks/use-quota";
import { buildProviders } from "./providers";
import { quickCheckText } from "./quota/summary";

/**
 * Shows the latest limits in Raycast's brief overlay. Readings under five minutes old are reused unless
 * a reported reset has passed, with the same cache, cooldowns, and failure handling as Check AI Limits.
 */
export default async function Command() {
  const preferences = getPreferenceValues<Preferences.QuickCheck>();
  const providers = buildProviders(preferences);
  const refresher = createQuotaRefresher(providers);
  try {
    await refresher.refreshAll({ force: false });
    const states = refresher.getStates();
    await showHUD(
      quickCheckText(
        providers.map((provider) => ({ provider, state: states[provider.key] })),
        Date.now(),
        preferences.hudFormat,
      ),
    );
  } finally {
    refresher.stop();
  }
}
