import { ProviderId, QuotaProvider, QuotaSnapshot, QuotaWindow } from "./types";

export const LIMIT_PINS_KEY = "limit-pins:v1";

/** A window choice belongs to a configured provider profile, independently of cached readings. */
export interface LimitPin {
  provider: ProviderId;
  providerKey: string;
  source: string;
  windowId: string;
  label: string;
  scope?: string;
  durationMinutes?: number;
}

export interface LimitPins {
  pins: LimitPin[];
  /** Identity of the pin shown while the other relevant limits are healthy. */
  preferred?: string;
}

export function pinKey(pin: LimitPin): string {
  return JSON.stringify([pin.source, pin.providerKey, pin.windowId]);
}

export function belongsToProvider(pin: LimitPin, provider: QuotaProvider): boolean {
  return pin.provider === provider.id && pin.providerKey === provider.key && pin.source === provider.source;
}

export function createLimitPin(provider: QuotaProvider, window: QuotaWindow): LimitPin {
  return {
    provider: provider.id,
    providerKey: provider.key,
    source: provider.source,
    windowId: window.id,
    label: window.label,
    scope: window.scope,
    durationMinutes: window.durationMinutes,
  };
}

export function findLimitPin(settings: LimitPins, provider: QuotaProvider, window: QuotaWindow): LimitPin | undefined {
  return settings.pins.find(
    (pin) =>
      belongsToProvider(pin, provider) &&
      (pin.windowId === window.id ||
        (pin.provider === "claude" &&
          pin.scope !== undefined &&
          pin.durationMinutes !== undefined &&
          pin.scope.toLowerCase() === window.scope?.toLowerCase() &&
          pin.durationMinutes === window.durationMinutes)),
  );
}

/** Claude can report the same scoped window through a legacy field or its newer model-scoped list. */
export function pinnedWindow(pin: LimitPin, snapshot: QuotaSnapshot): QuotaWindow | undefined {
  if (pin.provider !== snapshot.provider || pin.source !== snapshot.source) return undefined;
  return (
    snapshot.windows.find((window) => window.id === pin.windowId) ??
    (pin.provider === "claude" && pin.scope && pin.durationMinutes !== undefined
      ? snapshot.windows.find(
          (window) =>
            window.scope?.toLowerCase() === pin.scope?.toLowerCase() && window.durationMinutes === pin.durationMinutes,
        )
      : undefined)
  );
}

export function addPin(settings: LimitPins, pin: LimitPin, prefer = false): LimitPins {
  // Resolve aliases before adding, so switching a provider's response shape doesn't create a second pin.
  const existing = settings.pins.find(
    (item) =>
      item.provider === pin.provider &&
      item.providerKey === pin.providerKey &&
      item.source === pin.source &&
      (item.windowId === pin.windowId ||
        (pin.provider === "claude" &&
          pin.scope !== undefined &&
          pin.durationMinutes !== undefined &&
          item.scope?.toLowerCase() === pin.scope.toLowerCase() &&
          item.durationMinutes === pin.durationMinutes)),
  );
  const key = pinKey(existing ?? pin);
  return {
    pins: existing ? settings.pins : [...settings.pins, pin],
    preferred: prefer || !settings.preferred ? key : settings.preferred,
  };
}

export function removePin(settings: LimitPins, key: string): LimitPins {
  const pins = settings.pins.filter((pin) => pinKey(pin) !== key);
  return {
    pins,
    preferred: settings.preferred === key ? (pins[0] ? pinKey(pins[0]) : undefined) : settings.preferred,
  };
}

/** Damaged settings fall back to Smart; valid pins survive a damaged neighbor. */
export function parseLimitPins(raw: unknown): LimitPins {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : undefined;
    if (!isRecord(value) || !Array.isArray(value.pins)) return { pins: [] };
    const pins: LimitPin[] = [];
    const keys = new Set<string>();
    for (const item of value.pins) {
      if (
        !isRecord(item) ||
        (item.provider !== "codex" && item.provider !== "claude") ||
        !nonEmpty(item.providerKey) ||
        !nonEmpty(item.source) ||
        !nonEmpty(item.windowId) ||
        !nonEmpty(item.label)
      ) {
        continue;
      }
      const pin: LimitPin = {
        provider: item.provider,
        providerKey: item.providerKey,
        source: item.source,
        windowId: item.windowId,
        label: item.label,
        scope: nonEmpty(item.scope) ? item.scope : undefined,
        durationMinutes:
          typeof item.durationMinutes === "number" && Number.isFinite(item.durationMinutes) && item.durationMinutes > 0
            ? item.durationMinutes
            : undefined,
      };
      const key = pinKey(pin);
      if (!keys.has(key)) {
        keys.add(key);
        pins.push(pin);
      }
    }
    return {
      pins,
      preferred:
        typeof value.preferred === "string" && keys.has(value.preferred)
          ? value.preferred
          : pins[0]
            ? pinKey(pins[0])
            : undefined,
    };
  } catch {
    return { pins: [] };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

interface PinStorage {
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: string): Promise<void>;
}

/** Shared by the list and pushed pin manager; writes finish before the visible selection changes. */
export class LimitPinStore {
  private state: { settings: LimitPins; isLoading: boolean } = { settings: { pins: [] }, isLoading: true };
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> = Promise.resolve();
  private loading: Promise<void> | undefined;

  constructor(private readonly storage: PinStorage) {}

  readonly getState = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  load(): Promise<void> {
    this.loading ??= this.storage
      .getItem(LIMIT_PINS_KEY)
      .then((raw) => {
        this.state = { settings: parseLimitPins(raw), isLoading: false };
        this.notify();
      })
      .catch((error: unknown) => {
        this.loading = undefined;
        throw error;
      });
    return this.loading;
  }

  update(change: (settings: LimitPins) => LimitPins): Promise<void> {
    const next = this.pending.then(async () => {
      await this.load();
      const settings = change(this.state.settings);
      await this.storage.setItem(LIMIT_PINS_KEY, JSON.stringify(settings));
      this.state = { settings, isLoading: false };
      this.notify();
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}
