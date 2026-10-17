import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  environment,
  Icon,
  Image,
  Keyboard,
  List,
  openExtensionPreferences,
  showHUD,
} from "@raycast/api";
import { getProgressIcon, useCachedState } from "@raycast/utils";
import { ReactNode, useState } from "react";
import { useLimitPins } from "../hooks/use-limit-pins";
import { useNow, useQuota, useSearchSubtitle } from "../hooks/use-quota";
import { ResetReminderController, useResetReminders } from "../hooks/use-reset-reminders";
import { buildDiagnostics } from "../quota/diagnostics";
import {
  formatAge,
  formatDateTime,
  formatExpiryLabel,
  formatPercent,
  formatResetLabel,
  hasResetPassed,
  planLabel,
  providerTitle,
  quotaLevel,
  remainingPercent,
} from "../quota/format";
import { creditsLeft, formatMoney, showsCredits } from "../quota/credits";
import { findLimitPin, LimitPins, pinKey } from "../quota/pins";
import { isStale, ProviderState } from "../quota/refresh";
import { availableResets, expiringSoon } from "../quota/resets";
import { ResetReminder, resetReminderId } from "../quota/reminders";
import { ProviderId, QuotaProvider, QuotaSnapshot, QuotaWindow, UsageCredits } from "../quota/types";
import { CreditsDetail } from "./credits-detail";
import { LimitPinActions, LimitPinsList } from "./limit-pins";
import { ProviderStateItem } from "./provider-state";
import { LEVEL_COLORS, LEVEL_LABELS, QuotaDetail } from "./quota-detail";
import { ResetsDetail } from "./resets-detail";
import { ResetReminderActions, ResetRemindersList } from "./reset-reminders";

const COPY_DIAGNOSTICS_SHORTCUT: Keyboard.Shortcut = { modifiers: ["ctrl", "shift"], key: "d" };

/** Provider logos that tell rows apart when several providers' sections share the list. */
const PROVIDER_ICONS: Record<ProviderId, Image.Asset> = { claude: "claude.svg", codex: "codex.svg" };

/** Each provider's own usage page, for comparing readings or checking limits when the CLI can't. */
const USAGE_PAGES: Record<ProviderId, string> = {
  claude: "https://claude.ai/settings/usage",
  codex: "https://chatgpt.com/codex/settings/usage",
};

export function QuotaList({ providers }: { providers: readonly QuotaProvider[] }) {
  const { states, refresh } = useQuota(providers);
  const { settings: pins } = useLimitPins();
  const reminders = useResetReminders();
  useSearchSubtitle(providers, states);
  const now = useNow();
  // Details show the charts, so they start open; the toggle is remembered per viewer.
  const [isShowingDetail, setShowingDetail] = useCachedState("show-details", true);
  const [filter, setFilter] = useState("all");

  const copyDiagnostics = async () => {
    const text = buildDiagnostics(
      providers.map((provider) => ({ provider, state: states[provider.key] })),
      {
        raycastVersion: environment.raycastVersion,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        now: Date.now(),
      },
    );
    await Clipboard.copy(text);
    // Copy actions close the Raycast window, so a HUD is the confirmation that stays visible.
    await showHUD("Copied diagnostics");
  };

  const actions = (extra?: ReactNode) => (
    <ActionPanel>
      <ActionPanel.Section>
        <Action
          title={isShowingDetail ? "Hide Details" : "Show Details"}
          icon={Icon.Sidebar}
          onAction={() => setShowingDetail((value) => !value)}
        />
        <Action
          title="Refresh Limits"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={refresh}
        />
      </ActionPanel.Section>
      {extra}
      <ActionPanel.Section>
        <Action.Push
          title="Manage Reset Reminders"
          icon={Icon.Bell}
          target={<ResetRemindersList />}
          onPop={reminders.refresh}
        />
        <Action.Push
          title="Manage Limit Pins"
          icon={Icon.Pin}
          target={<LimitPinsList providers={providers} states={states} />}
        />
        <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
        <Action
          title="Copy Diagnostics"
          icon={Icon.Bug}
          shortcut={COPY_DIAGNOSTICS_SHORTCUT}
          onAction={copyDiagnostics}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );

  if (providers.length === 0) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Gauge}
          title="No providers enabled"
          description="Enable Codex or Claude Code in the extension preferences to see their limits."
          actions={
            <ActionPanel>
              <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
              <Action.Push
                title="Manage Reset Reminders"
                icon={Icon.Bell}
                target={<ResetRemindersList />}
                onPop={reminders.refresh}
              />
              <Action.Push
                title="Manage Limit Pins"
                icon={Icon.Pin}
                target={<LimitPinsList providers={providers} states={states} />}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  const visible = providers.filter((provider) => filter === "all" || provider.id === filter);

  return (
    <List
      isLoading={providers.some((provider) => states[provider.key]?.loading)}
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="Filter limits"
      searchBarAccessory={
        providers.length > 1 ? (
          <List.Dropdown tooltip="Provider" storeValue onChange={setFilter}>
            <List.Dropdown.Item title="All Providers" value="all" />
            {providers.map((provider) => (
              <List.Dropdown.Item key={provider.key} title={providerTitle(provider.id)} value={provider.id} />
            ))}
          </List.Dropdown>
        ) : undefined
      }
    >
      {visible.map((provider) => (
        <ProviderSection
          key={provider.key}
          provider={provider}
          state={states[provider.key] ?? { loading: false }}
          now={now}
          compact={isShowingDetail}
          showProvider={visible.length > 1}
          pins={pins}
          reminders={reminders}
          actions={actions}
        />
      ))}
    </List>
  );
}

interface ProviderSectionProps {
  provider: QuotaProvider;
  state: ProviderState;
  now: number;
  /** True while the detail panel is open and rows are narrow. */
  compact: boolean;
  /** True when other providers' sections share the list, so rows need to say whose they are. */
  showProvider: boolean;
  pins: LimitPins;
  reminders: ResetReminderController;
  actions: (extra?: ReactNode) => ReactNode;
}

function ProviderSection({
  provider,
  state,
  now,
  compact,
  showProvider,
  pins,
  reminders,
  actions,
}: ProviderSectionProps) {
  const snapshot = state.snapshot;
  const showStateItem = state.error !== undefined || !snapshot || snapshot.windows.length === 0;
  const sectionActions = (extra?: ReactNode) =>
    actions(
      <>
        {extra}
        <ActionPanel.Section>
          <Action.OpenInBrowser
            title="Open Usage Page"
            url={USAGE_PAGES[provider.id]}
            shortcut={Keyboard.Shortcut.Common.Open}
          />
        </ActionPanel.Section>
      </>,
    );
  return (
    <List.Section title={providerTitle(provider.id)} subtitle={sectionSubtitle(state, now)}>
      {showStateItem ? (
        <ProviderStateItem provider={provider.id} state={state} now={now} actions={sectionActions} />
      ) : null}
      {snapshot?.windows.map((window) => {
        const pin = findLimitPin(pins, provider, window);
        const reminder = reminders.reminders.find(
          (reminder) => reminder.id === resetReminderId(snapshot, window) && reminder.resetsAt > now,
        );
        return (
          <QuotaWindowItem
            key={window.id}
            snapshot={snapshot}
            window={window}
            state={state}
            now={now}
            compact={compact}
            showProvider={showProvider}
            pinStatus={pin ? (pinKey(pin) === pins.preferred ? "preferred" : "pinned") : undefined}
            pinActions={<LimitPinActions provider={provider} window={window} />}
            reminder={reminder}
            reminderActions={<ResetReminderActions snapshot={snapshot} window={window} controller={reminders} />}
            actions={sectionActions}
          />
        );
      })}
      {snapshot && availableResets(snapshot.resets, now).count > 0 ? (
        <LimitResetsItem
          snapshot={snapshot}
          state={state}
          now={now}
          compact={compact}
          showProvider={showProvider}
          actions={sectionActions}
        />
      ) : null}
      {snapshot && showsCredits(snapshot.credits) ? (
        <UsageCreditsItem
          snapshot={snapshot}
          credits={snapshot.credits}
          state={state}
          now={now}
          compact={compact}
          showProvider={showProvider}
          actions={sectionActions}
        />
      ) : null}
    </List.Section>
  );
}

export function sectionSubtitle(state: ProviderState, now: number): string | undefined {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return state.loading ? "Checking…" : undefined;
  }
  const parts = [
    planLabel(snapshot.plan),
    state.loading
      ? "Refreshing…"
      : `Updated ${formatAge(snapshot.checkedAt, now)}${isStale(snapshot, now) ? " · Stale" : ""}`,
    snapshot.usageAllowed === false ? "Usage blocked" : undefined,
  ];
  return parts.filter(Boolean).join(" · ");
}

interface QuotaWindowItemProps {
  snapshot: QuotaSnapshot;
  window: QuotaWindow;
  state: ProviderState;
  now: number;
  compact: boolean;
  showProvider: boolean;
  pinStatus?: "pinned" | "preferred";
  pinActions?: ReactNode;
  reminder?: ResetReminder;
  reminderActions?: ReactNode;
  actions: (extra?: ReactNode) => ReactNode;
}

function QuotaWindowItem({
  snapshot,
  window,
  state,
  now,
  compact,
  showProvider,
  pinStatus,
  pinActions,
  reminder,
  reminderActions,
  actions,
}: QuotaWindowItemProps) {
  const used = window.usedPercent;
  const accessories: List.Item.Accessory[] = [];

  if (reminder) {
    accessories.push({
      icon: { source: Icon.Bell, tintColor: Color.Blue },
      tooltip: `Reset reminder around ${formatDateTime(reminder.resetsAt)}`,
    });
  }

  if (pinStatus) {
    accessories.push({
      icon: { source: pinStatus === "preferred" ? Icon.Star : Icon.Pin, tintColor: Color.Blue },
      tooltip: pinStatus === "preferred" ? "Preferred in Quick Check" : "Pinned for critical alerts in Quick Check",
    });
  }

  if (used === undefined) {
    accessories.push({ tag: { value: "Unavailable", color: Color.SecondaryText }, tooltip: "Usage wasn't reported" });
  } else {
    const level = quotaLevel(used);
    const text =
      used > 100
        ? `Over limit (${formatPercent(used)} used)`
        : used === 100
          ? "Limit reached"
          : `${formatPercent(remainingPercent(used))} left`;
    accessories.push({
      tag: { value: text, color: LEVEL_COLORS[level] },
      tooltip: `${LEVEL_LABELS[level]} · ${formatPercent(used)} used`,
    });
  }

  if (window.resetsAt !== undefined) {
    const passed = hasResetPassed(window.resetsAt, now);
    const label = formatResetLabel(window.resetsAt, now);
    if (!compact) {
      accessories.push({
        text: passed ? { value: label, color: Color.Orange } : label,
        icon: passed ? Icon.ArrowClockwise : Icon.Clock,
        tooltip: formatDateTime(window.resetsAt),
      });
    } else if (passed) {
      // The detail panel shows reset times, but a passed reset still needs to stand out in the row.
      accessories.push({ icon: { source: Icon.ArrowClockwise, tintColor: Color.Orange }, tooltip: label });
    }
  }

  const remaining = used === undefined ? undefined : remainingPercent(used);
  return (
    <List.Item
      id={`${snapshot.provider}:${window.id}`}
      title={window.label}
      subtitle={window.scope}
      icon={
        // The tag already carries the level color, so the logo can take the progress ring's place.
        showProvider
          ? { value: PROVIDER_ICONS[snapshot.provider], tooltip: providerTitle(snapshot.provider) }
          : remaining === undefined
            ? Icon.QuestionMarkCircle
            : getProgressIcon(remaining / 100, LEVEL_COLORS[quotaLevel(used ?? 0)])
      }
      keywords={[providerTitle(snapshot.provider), ...(window.scope ? [window.scope] : [])]}
      accessories={accessories}
      detail={<QuotaDetail snapshot={snapshot} window={window} state={state} now={now} />}
      actions={actions(
        <>
          {reminderActions}
          {pinActions}
          {/* The detail panel shows short dates; the full timestamps stay one copy away. */}
          <ActionPanel.Section>
            {window.resetsAt !== undefined ? (
              <Action.CopyToClipboard title="Copy Reset Time" content={formatDateTime(window.resetsAt)} />
            ) : null}
            <Action.CopyToClipboard title="Copy Last Checked Time" content={formatDateTime(snapshot.checkedAt)} />
          </ActionPanel.Section>
        </>,
      )}
    />
  );
}

type LimitResetsItemProps = Omit<QuotaWindowItemProps, "window">;

/** Saved resets the provider lets the user redeem early; listed only while some are available. */
function LimitResetsItem({ snapshot, state, now, compact, showProvider, actions }: LimitResetsItemProps) {
  const { count, items } = availableResets(snapshot.resets, now);
  const nextExpiry = items[0]?.expiresAt;
  const soon = expiringSoon(snapshot.resets, now) !== undefined;
  const accessories: List.Item.Accessory[] = [
    { tag: { value: `${count} available`, color: Color.Blue }, tooltip: "Saved limit resets" },
  ];
  if (nextExpiry !== undefined) {
    const label = `Next ${formatExpiryLabel(nextExpiry, now).toLowerCase()}`;
    if (!compact) {
      accessories.push({
        text: soon ? { value: label, color: Color.Orange } : label,
        icon: soon ? { source: Icon.Hourglass, tintColor: Color.Orange } : Icon.Hourglass,
        tooltip: formatDateTime(nextExpiry),
      });
    } else if (soon) {
      // The detail panel lists expiries, but one about to be lost still needs to stand out in the row.
      accessories.push({ icon: { source: Icon.Hourglass, tintColor: Color.Orange }, tooltip: label });
    }
  }
  return (
    <List.Item
      id={`${snapshot.provider}:resets`}
      title="Limit resets"
      icon={
        showProvider
          ? { value: PROVIDER_ICONS[snapshot.provider], tooltip: providerTitle(snapshot.provider) }
          : Icon.RotateAntiClockwise
      }
      keywords={[providerTitle(snapshot.provider), "reset", "credits"]}
      accessories={accessories}
      detail={<ResetsDetail snapshot={snapshot} state={state} now={now} />}
      actions={actions(
        nextExpiry !== undefined ? (
          <ActionPanel.Section>
            <Action.CopyToClipboard title="Copy Next Expiry Time" content={formatDateTime(nextExpiry)} />
          </ActionPanel.Section>
        ) : undefined,
      )}
    />
  );
}

/** Pay-as-you-go spend beyond the plan's limits; kept apart from plan quota, which it doesn't change. */
function UsageCreditsItem({
  snapshot,
  credits,
  state,
  now,
  compact,
  showProvider,
  actions,
}: LimitResetsItemProps & { credits: UsageCredits }) {
  const left = creditsLeft(credits);
  const accessories: List.Item.Accessory[] = [];
  if (!credits.enabled) {
    accessories.push({ tag: { value: "Off", color: Color.SecondaryText }, tooltip: "Usage credits are off" });
  } else if (left !== undefined && credits.usedPercent !== undefined) {
    const level = quotaLevel(credits.usedPercent);
    accessories.push({
      tag: {
        value: left === 0 ? "Monthly limit reached" : `${formatMoney(left, credits.currency)} left`,
        color: LEVEL_COLORS[level],
      },
      tooltip: `${formatPercent(credits.usedPercent)} of the monthly limit spent`,
    });
  } else {
    accessories.push({ tag: { value: "On", color: Color.Green }, tooltip: "No monthly limit reported" });
  }
  if (!compact && credits.used !== undefined) {
    accessories.push({
      text: `${formatMoney(credits.used, credits.currency)} spent${
        credits.monthlyLimit === undefined ? "" : ` of ${formatMoney(credits.monthlyLimit, credits.currency)}`
      }`,
    });
  }
  return (
    <List.Item
      id={`${snapshot.provider}:credits`}
      title="Usage credits"
      icon={
        showProvider
          ? { value: PROVIDER_ICONS[snapshot.provider], tooltip: providerTitle(snapshot.provider) }
          : Icon.Coins
      }
      keywords={[providerTitle(snapshot.provider), "credits", "extra usage", "spend"]}
      accessories={accessories}
      detail={<CreditsDetail snapshot={snapshot} credits={credits} state={state} now={now} />}
      actions={actions()}
    />
  );
}
