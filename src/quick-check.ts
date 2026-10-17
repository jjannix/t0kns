import { getPreferenceValues, LocalStorage, showHUD } from "@raycast/api";
import { createQuotaRefresher } from "./hooks/use-quota";
import { buildProviders } from "./providers";
import { LIMIT_PINS_KEY, parseLimitPins } from "./quota/pins";
import { readQuickCheck } from "./quota/quick-check";
import { quickCheckText } from "./quota/summary";

/**
 * Shows the latest limits in Raycast's brief overlay. Readings under five minutes old are reused unless
 * a reported reset has passed. A shared two-second deadline bounds discovery and refreshes, with cached
 * or unavailable results for providers that take longer.
 */
export default async function Command() {
  const preferences = getPreferenceValues<Preferences.QuickCheck>();
  const format = preferences.hudFormat ?? "pins";
  const providers = buildProviders(preferences);
  const refresher = createQuotaRefresher(providers);
  const [entries, pins] = await Promise.all([
    readQuickCheck(providers, refresher),
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
  await showHUD(quickCheckText(entries, Date.now(), format, pins));
}
