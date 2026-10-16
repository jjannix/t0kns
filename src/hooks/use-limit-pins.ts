import { LocalStorage, showToast, Toast } from "@raycast/api";
import { useEffect, useSyncExternalStore } from "react";
import { LimitPins, LimitPinStore } from "../quota/pins";

const store = new LimitPinStore(LocalStorage);

export function useLimitPins() {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  useEffect(() => {
    void store.load().catch(() => showToast({ style: Toast.Style.Failure, title: "Couldn't load limit pins" }));
  }, []);

  const update = async (change: (settings: LimitPins) => LimitPins) => {
    try {
      await store.update(change);
    } catch {
      await showToast({ style: Toast.Style.Failure, title: "Couldn't save limit pins", message: "Try again." });
    }
  };

  return { ...state, update };
}
