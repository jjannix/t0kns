import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ResetReminder } from "../quota/reminders";

const execute = promisify(execFile);
type Request =
  | { action: "list" }
  | { action: "cancel"; id: string }
  | { action: "schedule"; reminder: ResetReminder; deeplink: string };

export function getResetReminders(): Promise<ResetReminder[]> {
  return request({ action: "list" });
}

export function scheduleResetReminder(reminder: ResetReminder, deeplink: string): Promise<ResetReminder[]> {
  if (!Number.isFinite(new Date(reminder.resetsAt).getTime()) || reminder.resetsAt <= Date.now())
    return Promise.reject(new Error("The reset time has passed. Refresh your limits."));
  return request({ action: "schedule", reminder, deeplink });
}

export function cancelResetReminder(id: string): Promise<ResetReminder[]> {
  return request({ action: "cancel", id });
}

/** Windows owns the one-shot schedule, so neither Raycast nor a waiting process needs to stay open. */
async function request(input: Request): Promise<ResetReminder[]> {
  if (process.platform !== "win32") throw new Error("Reset reminders require Windows.");
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  // Data travels as base64 JSON and XML text nodes, never as executable PowerShell or XML markup.
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.UI.Notifications.ScheduledToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
# Use Windows PowerShell's existing sender identity rather than registering another app.
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsPowerShell')
$existing = @($notifier.GetScheduledToastNotifications() | Where-Object { $_.Group -eq 't0kns-reset' })
if ($request.action -eq 'schedule') {
  $at = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$request.reminder.resetsAt)
  if ($at -le [DateTimeOffset]::Now) { throw 'The reset time has passed. Refresh your limits.' }
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text>t0kns reset reminder</text><text></text><text>The reported reset time has arrived. Check your limits before continuing.</text></binding></visual></toast>')
  $document.DocumentElement.SetAttribute('launch', [string]$request.deeplink)
  $document.GetElementsByTagName('text').Item(1).InnerText = [string]$request.reminder.title
  $scheduled = [Windows.UI.Notifications.ScheduledToastNotification]::new($document, $at)
  $scheduled.Id = [string]$request.reminder.id
  $scheduled.Tag = [string]$request.reminder.id
  $scheduled.Group = 't0kns-reset'
  $previous = @($existing | Where-Object { $_.Id -eq $request.reminder.id })
  foreach ($item in $previous) { $notifier.RemoveFromSchedule($item) }
  try { $notifier.AddToSchedule($scheduled) }
  catch {
    foreach ($item in $previous) {
      if ($item.DeliveryTime -gt [DateTimeOffset]::Now) { try { $notifier.AddToSchedule($item) } catch {} }
    }
    throw
  }
} elseif ($request.action -eq 'cancel') {
  foreach ($item in $existing) {
    if ($item.Id -eq $request.id) { $notifier.RemoveFromSchedule($item) }
  }
}
$pending = @(
  foreach ($item in $notifier.GetScheduledToastNotifications()) {
    if ($item.Group -eq 't0kns-reset' -and $item.DeliveryTime -gt [DateTimeOffset]::Now) {
      [pscustomobject]@{
        id = $item.Id
        title = $item.Content.GetElementsByTagName('text').Item(1).InnerText
        resetsAt = $item.DeliveryTime.ToUnixTimeMilliseconds()
      }
    }
  }
)
ConvertTo-Json -InputObject @($pending | Sort-Object resetsAt) -Compress
`;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const { stdout } = await execute(
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
  ).catch((cause: unknown) => {
    throw new Error("Windows couldn't update reset reminders. Try again.", { cause });
  });
  const reminders: unknown = JSON.parse(stdout.trim());
  if (!Array.isArray(reminders) || !reminders.every(isReminder))
    throw new Error("Windows returned unreadable reset reminders.");
  if (
    input.action === "schedule" &&
    !reminders.some((reminder) => reminder.id === input.reminder.id && reminder.resetsAt === input.reminder.resetsAt)
  )
    throw new Error("Windows didn't keep the reset reminder. Check notification settings and try again.");
  return reminders;
}

function isReminder(value: unknown): value is ResetReminder {
  if (typeof value !== "object" || value === null) return false;
  const reminder = value as Record<string, unknown>;
  return (
    typeof reminder.id === "string" &&
    typeof reminder.title === "string" &&
    typeof reminder.resetsAt === "number" &&
    Number.isFinite(reminder.resetsAt)
  );
}
