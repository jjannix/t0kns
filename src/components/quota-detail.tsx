import { Color, environment, List } from "@raycast/api";
import {
  elapsedInWindow,
  formatAge,
  formatDuration,
  formatPercent,
  formatResetLabel,
  formatShortDateTime,
  hasResetPassed,
  PaceKind,
  paceOf,
  providerTitle,
  QuotaLevel,
  quotaLevel,
  remainingPercent,
} from "../quota/format";
import { isStale, ProviderState } from "../quota/refresh";
import { availableResets } from "../quota/resets";
import { QuotaSnapshot, QuotaWindow } from "../quota/types";
import { CHART_PALETTES, quotaHeroSvg, svgDataUri } from "./charts";
import { failureCopy } from "./provider-state";

function usageSummary(used: number): string {
  return used > 100
    ? `${formatPercent(used)} used (over limit)`
    : `${formatPercent(remainingPercent(used))} left · ${formatPercent(used)} used`;
}

function windowElapsed(window: QuotaWindow, now: number): { elapsed?: number; elapsedLabel?: string } {
  const elapsed = elapsedInWindow(window, now);
  return elapsed
    ? {
        elapsed: elapsed.fraction,
        elapsedLabel: `${formatDuration(elapsed.elapsedMs)} of ${formatDuration(elapsed.durationMs)}`,
      }
    : {};
}

export const LEVEL_COLORS: Record<QuotaLevel, Color> = {
  ok: Color.Green,
  low: Color.Yellow,
  critical: Color.Orange,
  exhausted: Color.Red,
};

export const LEVEL_LABELS: Record<QuotaLevel, string> = {
  ok: "Plenty left",
  low: "Running low",
  critical: "Almost used up",
  exhausted: "Limit reached",
};

interface QuotaDetailProps {
  snapshot: QuotaSnapshot;
  window: QuotaWindow;
  state: ProviderState;
  now: number;
}

const PACE_COLORS: Record<PaceKind, Color> = { faster: Color.Orange, even: Color.Blue, slower: Color.Green };
const PACE_LABELS: Record<PaceKind, string> = {
  faster: "Fast",
  even: "On pace",
  slower: "Slow",
};

function quotaDetailMarkdown({ snapshot, window, state, now }: QuotaDetailProps): string {
  const used = window.usedPercent;
  const level = used === undefined ? undefined : quotaLevel(used);
  const stale = isStale(snapshot, now);
  const resetPassed = window.resetsAt !== undefined && hasResetPassed(window.resetsAt, now);
  // Saved resets are pointed out on used-up main windows; they aren't known to restore model-scoped ones.
  const saved =
    !window.scope && used !== undefined && used >= 100 && !resetPassed
      ? availableResets(snapshot.resets, now).count
      : 0;
  const headline =
    used === undefined || !level
      ? "Usage for this window wasn't reported."
      : `![${usageSummary(used)}](${svgDataUri(
          quotaHeroSvg({
            remaining: remainingPercent(used),
            remainingLabel: formatPercent(remainingPercent(used)),
            level,
            usedLabel: used > 100 ? `${formatPercent(used)} · over limit` : formatPercent(used),
            ...windowElapsed(window, now),
            footer: window.resetsAt === undefined ? undefined : formatResetLabel(window.resetsAt, now),
            palette: CHART_PALETTES[environment.appearance],
          }),
        )})`;
  const notes = [
    stale && `This reading is from ${formatAge(snapshot.checkedAt, now)}. Refresh for current values.`,
    resetPassed && "The reported reset time has passed. Refresh to see the new window; quota isn't assumed to be back.",
    snapshot.usageAllowed === false &&
      `${providerTitle(snapshot.provider)} reports that ordinary usage is currently blocked.`,
    saved > 0 &&
      `${saved === 1 ? "1 saved limit reset is" : `${saved} saved limit resets are`} available; see Limit resets.`,
    state.error && `Last refresh failed: ${failureCopy(snapshot.provider, state.error, now).title}.`,
  ].filter(Boolean);
  const heading = [providerTitle(snapshot.provider), window.label, window.scope].filter(Boolean).join(" · ");
  return [`## ${heading}`, headline, ...notes].join("\n\n");
}

export function QuotaDetail({ snapshot, window, state, now }: QuotaDetailProps) {
  const used = window.usedPercent;
  const stale = isStale(snapshot, now);
  const resetPassed = window.resetsAt !== undefined && hasResetPassed(window.resetsAt, now);
  const markdown = quotaDetailMarkdown({ snapshot, window, state, now });
  // Usage is only known at the reading, so compare it with the time elapsed then. A passed reset ends the window.
  const pace = resetPassed ? undefined : paceOf(used, elapsedInWindow(window, snapshot.checkedAt)?.fraction);

  return (
    <List.Item.Detail
      markdown={markdown}
      metadata={
        <List.Item.Detail.Metadata>
          {pace ? (
            <List.Item.Detail.Metadata.TagList title="Pace">
              <List.Item.Detail.Metadata.TagList.Item text={PACE_LABELS[pace.kind]} color={PACE_COLORS[pace.kind]} />
            </List.Item.Detail.Metadata.TagList>
          ) : null}
          {pace ? <List.Item.Detail.Metadata.Separator /> : null}
          {window.scope ? <List.Item.Detail.Metadata.Label title="Applies to" text={window.scope} /> : null}
          <List.Item.Detail.Metadata.Label
            title="Resets"
            text={
              window.resetsAt === undefined
                ? "Not reported"
                : resetPassed
                  ? "Passed — refresh needed"
                  : formatShortDateTime(window.resetsAt, now)
            }
          />
          {window.breakdown?.length ? (
            <List.Item.Detail.Metadata.TagList title="Used in">
              {window.breakdown.map((share) => (
                <List.Item.Detail.Metadata.TagList.Item
                  key={share.label}
                  text={`${share.label} ${formatPercent(share.percent)}`}
                />
              ))}
            </List.Item.Detail.Metadata.TagList>
          ) : null}
          <List.Item.Detail.Metadata.Separator />
          {snapshot.account?.label ? (
            <List.Item.Detail.Metadata.Label title="Account" text={snapshot.account.label} />
          ) : null}
          <List.Item.Detail.Metadata.Label title="Last checked" text={formatShortDateTime(snapshot.checkedAt, now)} />
          {stale ? (
            <List.Item.Detail.Metadata.TagList title="Freshness">
              <List.Item.Detail.Metadata.TagList.Item text="Stale" color={Color.Orange} />
            </List.Item.Detail.Metadata.TagList>
          ) : null}
        </List.Item.Detail.Metadata>
      }
    />
  );
}
