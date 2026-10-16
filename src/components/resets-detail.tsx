import { Color, List } from "@raycast/api";
import { formatAge, formatDuration, formatExpiryLabel, formatShortDateTime, providerTitle } from "../quota/format";
import { isStale, ProviderState } from "../quota/refresh";
import { availableResets, expiringSoon, RESET_EXPIRY_WARNING_MS } from "../quota/resets";
import { QuotaSnapshot } from "../quota/types";
import { failureCopy } from "./provider-state";

interface ResetsDetailProps {
  snapshot: QuotaSnapshot;
  state: ProviderState;
  now: number;
}

function resetsMarkdown({ snapshot, state, now }: ResetsDetailProps): string {
  const { count, items } = availableResets(snapshot.resets, now);
  const stale = isStale(snapshot, now);
  const soon = expiringSoon(snapshot.resets, now);
  const notes = [
    `${count === 1 ? "1 saved limit reset is" : `${count} saved limit resets are`} available.`,
    items.length < count &&
      (items.length === 0
        ? `${providerTitle(snapshot.provider)} didn't report details for these resets.`
        : `${providerTitle(snapshot.provider)} reported details for ${items.length} of them.`),
    soon !== undefined &&
      `The next saved reset expires in ${formatDuration(soon - now)}. Unused resets are lost when they expire.`,
    stale && `This reading is from ${formatAge(snapshot.checkedAt, now)}. Refresh for current values.`,
    state.error && `Last refresh failed: ${failureCopy(snapshot.provider, state.error, now).title}.`,
  ].filter(Boolean);
  return [`## ${providerTitle(snapshot.provider)} · Limit resets`, ...notes].join("\n\n");
}

export function ResetsDetail({ snapshot, state, now }: ResetsDetailProps) {
  const { items } = availableResets(snapshot.resets, now);
  return (
    <List.Item.Detail
      markdown={resetsMarkdown({ snapshot, state, now })}
      metadata={
        <List.Item.Detail.Metadata>
          {items.map((reset, index) => (
            <List.Item.Detail.Metadata.Label
              key={index}
              title={reset.title ?? "Limit reset"}
              text={
                reset.expiresAt === undefined
                  ? "Doesn't expire"
                  : reset.expiresAt - now < RESET_EXPIRY_WARNING_MS
                    ? { value: formatExpiryLabel(reset.expiresAt, now), color: Color.Orange }
                    : formatExpiryLabel(reset.expiresAt, now)
              }
            />
          ))}
          {items.length > 0 ? <List.Item.Detail.Metadata.Separator /> : null}
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
