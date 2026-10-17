import { Action, ActionPanel, Icon, Keyboard, List, showToast, Toast } from "@raycast/api";
import { useNow } from "../hooks/use-quota";
import { ResetReminderController, useResetReminders } from "../hooks/use-reset-reminders";
import { formatDateTime, formatShortDateTime } from "../quota/format";
import { createResetReminder, resetReminderId } from "../quota/reminders";
import { QuotaSnapshot, QuotaWindow } from "../quota/types";

export function ResetReminderActions({
  snapshot,
  window,
  controller,
}: {
  snapshot: QuotaSnapshot;
  window: QuotaWindow;
  controller: ResetReminderController;
}) {
  const now = Date.now();
  const id = resetReminderId(snapshot, window);
  const existing = controller.reminders.find((reminder) => reminder.id === id && reminder.resetsAt > now);
  const eligible = createResetReminder(snapshot, window, now);
  if (controller.isLoading || controller.isWorking || (!existing && !eligible)) return null;
  return (
    <ActionPanel.Section title="Reset Reminder">
      {eligible && (existing?.resetsAt !== eligible.resetsAt || existing?.title !== eligible.title) ? (
        <Action
          title={existing ? "Update Reminder to This Reset" : "Remind Me Around This Reset"}
          icon={Icon.Bell}
          onAction={async () => {
            const reminder = createResetReminder(snapshot, window, Date.now());
            if (reminder) await controller.schedule(reminder);
            else
              await showToast({
                style: Toast.Style.Failure,
                title: "Reset time passed",
                message: "Refresh your limits.",
              });
          }}
        />
      ) : null}
      {existing ? (
        <Action title="Cancel Reset Reminder" icon={Icon.BellDisabled} onAction={() => controller.cancel(id)} />
      ) : null}
    </ActionPanel.Section>
  );
}

export function ResetRemindersList() {
  const controller = useResetReminders();
  const now = useNow();
  const pending = controller.reminders.filter((reminder) => reminder.resetsAt > now);
  return (
    <List
      navigationTitle="Reset Reminders"
      isLoading={controller.isLoading || controller.isWorking}
      searchBarPlaceholder="Filter reset reminders"
    >
      <List.EmptyView
        icon={controller.error ? Icon.ExclamationMark : Icon.Bell}
        title={controller.error ? "Couldn't load reset reminders" : "No reset reminders"}
        description={
          controller.error?.message ??
          "Select an exhausted limit with a future reset and choose Remind Me Around This Reset. Each reminder runs once."
        }
        actions={
          <ActionPanel>
            <Action title="Refresh Reminders" icon={Icon.ArrowClockwise} onAction={controller.refresh} />
          </ActionPanel>
        }
      />
      {pending.map((reminder) => (
        <List.Item
          key={reminder.id}
          title={reminder.title}
          icon={Icon.Bell}
          accessories={[
            {
              text: `Around ${formatShortDateTime(reminder.resetsAt, now)}`,
              tooltip: formatDateTime(reminder.resetsAt),
            },
          ]}
          actions={
            <ActionPanel>
              <Action
                title="Cancel Reset Reminder"
                icon={Icon.BellDisabled}
                onAction={() => controller.cancel(reminder.id)}
              />
              <Action
                title="Refresh Reminders"
                icon={Icon.ArrowClockwise}
                shortcut={Keyboard.Shortcut.Common.Refresh}
                onAction={controller.refresh}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
