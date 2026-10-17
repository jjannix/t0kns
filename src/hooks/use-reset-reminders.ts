import { showToast, Toast } from "@raycast/api";
import { createDeeplink } from "@raycast/utils";
import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "../quota/format";
import { ResetReminder } from "../quota/reminders";
import { cancelResetReminder, getResetReminders, scheduleResetReminder } from "../system/reset-reminders";

export function useResetReminders() {
  const [reminders, setReminders] = useState<ResetReminder[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [isWorking, setWorking] = useState(false);
  const [error, setError] = useState<Error>();

  // Inspect Windows' pending schedule on open or explicit refresh; never poll quota or create reminders automatically.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReminders(await getResetReminders());
      setError(undefined);
    } catch (error) {
      setError(error instanceof Error ? error : new Error("Couldn't read reset reminders."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = async (operation: () => Promise<ResetReminder[]>, title: string, message?: string) => {
    setWorking(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: "Updating reset reminder…" });
    try {
      setReminders(await operation());
      setError(undefined);
      toast.style = Toast.Style.Success;
      toast.title = title;
      toast.message = message;
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn't update reset reminder";
      toast.message = error instanceof Error ? error.message : "Try again.";
    } finally {
      setWorking(false);
    }
  };

  return {
    reminders,
    isLoading,
    isWorking,
    error,
    refresh,
    schedule: (reminder: ResetReminder) =>
      update(
        () => scheduleResetReminder(reminder, createDeeplink({ command: "check-ai-limits" })),
        "Reset reminder scheduled",
        `Around ${formatDateTime(reminder.resetsAt)}`,
      ),
    cancel: (id: string) => update(() => cancelResetReminder(id), "Reset reminder cancelled"),
  };
}

export type ResetReminderController = ReturnType<typeof useResetReminders>;
