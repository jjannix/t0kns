import { QuotaProvider } from "../quota/types";
import { createClaudeProvider } from "./claude";
import { createCodexProvider } from "./codex";
import { createGlmProvider } from "./glm";

/** Enabled providers for the extension preferences. Raycast relaunches commands when these change. */
export function buildProviders(preferences: ExtensionPreferences): QuotaProvider[] {
  const providers: QuotaProvider[] = [];
  if (preferences.claudeEnabled) {
    providers.push(
      createClaudeProvider({ executablePath: preferences.claudePath, configDir: preferences.claudeConfigDir }),
    );
  }
  if (preferences.codexEnabled) {
    providers.push(createCodexProvider({ executablePath: preferences.codexPath, codexHome: preferences.codexHome }));
  }
  if (preferences.glmEnabled) {
    providers.push(createGlmProvider({ apiKey: preferences.glmApiKey }));
  }
  return providers;
}
