import { UsageCredits } from "./types";

/** An amount in minor units as currency, e.g. 1240 USD → "$12.40". Minor-unit digits follow ISO 4217. */
export function formatMoney(minor: number, currency: string): string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(undefined, { style: "currency", currency });
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
  return format.format(minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

/** Credits earn a row while they're on or money was spent this period; credits that are off and unused stay out. */
export function showsCredits(credits: UsageCredits | undefined): credits is UsageCredits {
  return credits !== undefined && (credits.enabled || (credits.used ?? 0) > 0);
}

/** What's left under the monthly cap, in minor units. Undefined when uncapped or spend is unknown. */
export function creditsLeft(credits: UsageCredits): number | undefined {
  return credits.monthlyLimit === undefined || credits.used === undefined
    ? undefined
    : Math.max(0, credits.monthlyLimit - credits.used);
}
