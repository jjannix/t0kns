import { Action, ActionPanel, Color, Icon, Keyboard, List, openExtensionPreferences } from "@raycast/api";
import { useLimitPins } from "../hooks/use-limit-pins";
import { providerTitle } from "../quota/format";
import {
  addPin,
  belongsToProvider,
  createLimitPin,
  findLimitPin,
  pinKey,
  pinnedWindow,
  removePin,
} from "../quota/pins";
import { ProviderState } from "../quota/refresh";
import { QuotaProvider, QuotaWindow } from "../quota/types";

interface LimitPinActionsProps {
  provider: QuotaProvider;
  window: QuotaWindow;
}

/** Choosing a preferred limit also pins it; the first pin becomes preferred automatically. */
export function LimitPinActions({ provider, window }: LimitPinActionsProps) {
  const { settings, isLoading, update } = useLimitPins();
  if (isLoading) return null;
  const candidate = createLimitPin(provider, window);
  const pin = findLimitPin(settings, provider, window);
  const preferred = pin !== undefined && pinKey(pin) === settings.preferred;
  return (
    <ActionPanel.Section title="Quick Check · Limit Pins">
      <Action
        title={pin ? "Unpin from Quick Check" : "Pin for Quick Check"}
        icon={pin ? Icon.PinDisabled : Icon.Pin}
        shortcut={Keyboard.Shortcut.Common.Pin}
        onAction={() => update((settings) => (pin ? removePin(settings, pinKey(pin)) : addPin(settings, candidate)))}
      />
      {!preferred ? (
        <Action
          title="Make Preferred Limit"
          icon={Icon.Star}
          shortcut={{ modifiers: ["ctrl", "shift"], key: "p" }}
          onAction={() => update((settings) => addPin(settings, candidate, true))}
        />
      ) : null}
    </ActionPanel.Section>
  );
}

export function LimitPinsList({
  providers,
  states,
}: {
  providers: readonly QuotaProvider[];
  states: Readonly<Record<string, ProviderState>>;
}) {
  const { settings, isLoading, update } = useLimitPins();
  return (
    <List navigationTitle="Limit Pins" isLoading={isLoading} searchBarPlaceholder="Filter pinned limits">
      <List.EmptyView
        title="Pin the limits you care about"
        description="Go back and pin a limit from its actions. Then choose Limit Pins in Quick Check's HUD Format. Your preferred pin shows first; other relevant limits appear below 10% left."
        icon={Icon.Pin}
      />
      <List.Section title="Quick Check" subtitle="Preferred first · Expands below 10% left">
        {[...settings.pins]
          .sort((a, b) => Number(pinKey(b) === settings.preferred) - Number(pinKey(a) === settings.preferred))
          .map((pin) => {
            const key = pinKey(pin);
            const preferred = settings.preferred === key;
            const provider = providers.find((provider) => belongsToProvider(pin, provider));
            const snapshot = provider ? states[provider.key]?.snapshot : undefined;
            const window = snapshot ? pinnedWindow(pin, snapshot) : undefined;
            const status = !provider
              ? "Provider disabled or profile changed"
              : !snapshot
                ? "No reading yet"
                : !window
                  ? "Limit no longer reported"
                  : window.usedPercent === undefined
                    ? "Usage unavailable"
                    : undefined;
            return (
              <List.Item
                key={key}
                id={key}
                title={[providerTitle(pin.provider), pin.scope, pin.label].filter(Boolean).join(" · ")}
                subtitle={status}
                icon={preferred ? Icon.Star : Icon.Pin}
                accessories={[
                  ...(preferred ? [{ tag: { value: "Preferred", color: Color.Blue } }] : []),
                  ...(status ? [{ icon: Icon.ExclamationMark, tooltip: status }] : []),
                ]}
                actions={
                  <ActionPanel>
                    {!preferred ? (
                      <Action
                        title="Make Preferred Limit"
                        icon={Icon.Star}
                        onAction={() => update((settings) => addPin(settings, pin, true))}
                      />
                    ) : null}
                    <Action
                      title="Unpin from Quick Check"
                      icon={Icon.PinDisabled}
                      shortcut={Keyboard.Shortcut.Common.Pin}
                      onAction={() => update((settings) => removePin(settings, key))}
                    />
                    <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
                  </ActionPanel>
                }
              />
            );
          })}
      </List.Section>
    </List>
  );
}
