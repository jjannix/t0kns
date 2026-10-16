import { formatAge } from "./format";
import { ProviderState } from "./refresh";
import { QuotaProvider } from "./types";

export interface DiagnosticsEnvironment {
  raycastVersion: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  now: number;
}

/**
 * Builds copyable diagnostics from an allowlist of fields: versions, states, counts, and error codes.
 * Never includes account labels or keys, paths, error messages or details, or subprocess output.
 */
export function buildDiagnostics(
  entries: readonly { provider: QuotaProvider; state: ProviderState | undefined }[],
  environment: DiagnosticsEnvironment,
): string {
  const { now } = environment;
  const lines = [
    "t0kns diagnostics",
    `Generated: ${new Date(now).toISOString()}`,
    `Raycast: ${environment.raycastVersion}`,
    `Platform: ${environment.platform} ${environment.arch}`,
    `Node: ${environment.nodeVersion}`,
  ];

  if (entries.length === 0) {
    lines.push("", "No providers enabled");
  }

  for (const { provider, state } of entries) {
    const snapshot = state?.snapshot;
    lines.push(
      "",
      `[${provider.id}]`,
      `Source: ${provider.source}`,
      `Profile: ${provider.profile === "default" ? "default" : "custom"}`,
      `CLI version: ${safeToken(snapshot?.cliVersion) ?? "unknown"}`,
      `Last successful check: ${snapshot ? `${new Date(snapshot.checkedAt).toISOString()} (${formatAge(snapshot.checkedAt, now)})` : "none"}`,
      `Windows reported: ${snapshot ? snapshot.windows.length : "n/a"}`,
      `Usage credits: ${snapshot?.credits ? (snapshot.credits.enabled ? "on" : "off") : snapshot ? "not reported" : "n/a"}`,
      `Limit resets: ${snapshot?.resets ? `${snapshot.resets.available} available, ${snapshot.resets.items.length} listed` : snapshot ? "not reported" : "n/a"}`,
      `Usage allowed: ${snapshot?.usageAllowed === undefined ? "unknown" : snapshot.usageAllowed ? "yes" : "no"}`,
      `Refreshing: ${state?.loading ? "yes" : "no"}`,
      `Last attempt: ${state?.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : "none this session"}`,
      `Last error: ${state?.error ? `${state.error.kind}${state.error.code ? ` (${safeToken(state.error.code) ?? "redacted"})` : ""}` : "none"}`,
    );
    if (state?.retryAfter) {
      lines.push(`Cooldown until: ${new Date(state.retryAfter).toISOString()}`);
    }
  }

  return lines.join("\n");
}

/** Error codes are built by t0kns, but parts may echo provider values; keep only simple tokens. */
function safeToken(value: string | undefined): string | undefined {
  return value && /^[\w:./-]{1,64}$/.test(value) ? value : undefined;
}
