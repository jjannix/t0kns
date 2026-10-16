import { Color, List } from "@raycast/api";
import { creditsLeft, formatMoney } from "../quota/credits";
import { formatAge, formatPercent, formatShortDateTime, providerTitle } from "../quota/format";
import { isStale, ProviderState } from "../quota/refresh";
import { QuotaSnapshot, UsageCredits } from "../quota/types";
import { failureCopy } from "./provider-state";

interface CreditsDetailProps {
  snapshot: QuotaSnapshot;
  credits: UsageCredits;
  state: ProviderState;
  now: number;
}

function creditsMarkdown({ snapshot, credits, state, now }: CreditsDetailProps): string {
  const notes = [
    "Usage credits cover usage beyond your plan's limits and are billed separately from the subscription.",
    !credits.enabled && "Usage credits are off, so nothing covers usage once a plan limit is reached.",
    credits.enabled &&
      credits.usedPercent !== undefined &&
      credits.usedPercent >= 100 &&
      "This month's spending limit is reached.",
    isStale(snapshot, now) && `This reading is from ${formatAge(snapshot.checkedAt, now)}. Refresh for current values.`,
    state.error && `Last refresh failed: ${failureCopy(snapshot.provider, state.error, now).title}.`,
  ].filter(Boolean);
  return [`## ${providerTitle(snapshot.provider)} · Usage credits`, ...notes].join("\n\n");
}

export function CreditsDetail({ snapshot, credits, state, now }: CreditsDetailProps) {
  const left = creditsLeft(credits);
  return (
    <List.Item.Detail
      markdown={creditsMarkdown({ snapshot, credits, state, now })}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.TagList title="Status">
            <List.Item.Detail.Metadata.TagList.Item
              text={credits.enabled ? "On" : "Off"}
              color={credits.enabled ? Color.Green : Color.SecondaryText}
            />
          </List.Item.Detail.Metadata.TagList>
          {credits.used !== undefined ? (
            <List.Item.Detail.Metadata.Label
              title="Spent this month"
              text={`${formatMoney(credits.used, credits.currency)}${
                credits.usedPercent !== undefined && credits.monthlyLimit !== undefined
                  ? ` (${formatPercent(credits.usedPercent)})`
                  : ""
              }`}
            />
          ) : null}
          <List.Item.Detail.Metadata.Label
            title="Monthly limit"
            text={credits.monthlyLimit === undefined ? "None" : formatMoney(credits.monthlyLimit, credits.currency)}
          />
          {left !== undefined ? (
            <List.Item.Detail.Metadata.Label title="Left" text={formatMoney(left, credits.currency)} />
          ) : null}
          <List.Item.Detail.Metadata.Separator />
          {snapshot.account?.label ? (
            <List.Item.Detail.Metadata.Label title="Account" text={snapshot.account.label} />
          ) : null}
          <List.Item.Detail.Metadata.Label title="Last checked" text={formatShortDateTime(snapshot.checkedAt, now)} />
          {isStale(snapshot, now) ? (
            <List.Item.Detail.Metadata.TagList title="Freshness">
              <List.Item.Detail.Metadata.TagList.Item text="Stale" color={Color.Orange} />
            </List.Item.Detail.Metadata.TagList>
          ) : null}
        </List.Item.Detail.Metadata>
      }
    />
  );
}
