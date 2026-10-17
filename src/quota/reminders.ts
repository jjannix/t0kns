import { createHash } from "node:crypto";
import { providerTitle } from "./format";
import { QuotaSnapshot, QuotaWindow } from "./types";

export interface ResetReminder {
  /** Opaque Windows notification ID; one pending reminder per account, profile, and window. */
  id: string;
  title: string;
  resetsAt: number;
}

export function resetReminderId(snapshot: QuotaSnapshot, window: QuotaWindow): string {
  return (
    createHash("sha256")
      .update(
        JSON.stringify([
          snapshot.provider,
          snapshot.source,
          snapshot.profile,
          snapshot.account?.key ?? snapshot.account?.label,
          window.id,
        ]),
      )
      .digest("hex")
      // Current Windows builds reject IDs at the documented 16-character boundary.
      .slice(0, 15)
  );
}

/** Opt-in applies only to an exhausted limit with a reported reset still in the future. */
export function createResetReminder(
  snapshot: QuotaSnapshot,
  window: QuotaWindow,
  now: number,
): ResetReminder | undefined {
  const resetsAt = window.resetsAt;
  if (
    window.usedPercent === undefined ||
    window.usedPercent < 100 ||
    resetsAt === undefined ||
    !Number.isFinite(new Date(resetsAt).getTime()) ||
    resetsAt <= now
  )
    return undefined;
  const account = snapshot.account;
  const accountLabel = account?.key
    ? `${account.label?.trim() || "Account"} (${account.key.slice(0, 8)})`
    : account?.label?.trim();
  const profileLabel = snapshot.profile === "default" ? "Default profile" : snapshot.profile;
  return {
    id: resetReminderId(snapshot, window),
    title: [providerTitle(snapshot.provider), window.scope, window.label, accountLabel, profileLabel]
      .filter(Boolean)
      .join(" · "),
    resetsAt,
  };
}
