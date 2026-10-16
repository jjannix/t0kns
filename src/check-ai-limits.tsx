import { getPreferenceValues } from "@raycast/api";
import { useState } from "react";
import { QuotaList } from "./components/quota-list";
import { buildProviders } from "./providers";

export default function Command() {
  // Raycast relaunches the command when preferences change, so providers are built once per launch.
  const [providers] = useState(() => buildProviders(getPreferenceValues<Preferences.CheckAiLimits>()));
  return <QuotaList providers={providers} />;
}
