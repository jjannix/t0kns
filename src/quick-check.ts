import { getPreferenceValues, LocalStorage, showHUD } from "@raycast/api";
import { createQuotaRefresher } from "./hooks/use-quota";
import { buildProviders } from "./providers";
import { LIMIT_PINS_KEY, parseLimitPins } from "./quota/pins";
import { quickCheckText } from "./quota/summary";

/**
 * Shows the latest limits in Raycast's brief overlay. Readings under five minutes old are reused unless
 * a reported reset has passed, with the same cache, cooldowns, and failure handling as Check AI Limits.
 */
export default async function Command() {
  const preferences = getPreferenceValues<Preferences.QuickCheck>();
  const format = preferences.hudFormat ?? "pins";
  const providers = buildProviders(preferences);
  const refresher = createQuotaRefresher(providers);
  try {
    const [, pins] = await Promise.all([
      refresher.refreshAll({ force: false }),
      format === "pins"
        ? LocalStorage.getItem<string>(LIMIT_PINS_KEY)
            .then(parseLimitPins)
            .catch(() => undefined)
        : undefined,
    ]);
    if (format === "pins" && pins === undefined) {
      await showHUD("Couldn't load limit pins. Try Quick Check again.");
      return;
    }
    const states = refresher.getStates();
    await showHUD(
      quickCheckText(
        providers.map((provider) => ({ provider, state: states[provider.key] })),
        Date.now(),
        format,
        pins,
      ),
    );
  } finally {
    refresher.stop();
  }
}
