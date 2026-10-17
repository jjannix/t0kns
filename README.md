# t0kns

A Raycast extension for Windows to check Codex and Claude Code subscription limits and reset times.

Pin the limits you actually care about. Quick Check can show your preferred limit and expand when another relevant quota becomes critical, including model-specific caps such as Claude's Opus limit.

## Commands

- **Check AI Limits** — view remaining quota, reset times, and account details.
- **Quick Limit Check** — show your preferred limit in a brief overlay, with critical quota alerts. Assign a Raycast hotkey for quick access.

## Setup

Install Raycast for Windows and sign in to your subscription through the Codex or Claude Code CLI. Codex is enabled by default; Claude Code is experimental and can be enabled in the extension preferences.

If a CLI isn't detected, set its executable path in preferences. Existing custom profiles can also be configured there. t0kns reads quota through the installed CLIs without sending prompts or starting model turns.

## Limit Pins

Choose the provider and exact limit Quick Check should watch:

1. Open **Check AI Limits** and select an account-wide or model-specific limit.
2. Open its actions and choose **Pin for Quick Check**. Repeat for other limits you care about.
3. Choose **Make Preferred Limit** on the limit you want to see by default. This also pins it; your first pin is preferred automatically.
4. In **Quick Limit Check** preferences, set **HUD Format** to **Limit Pins**.

For example, prefer Codex's 5-hour limit and also pin Claude's weekly Opus limit. While both are healthy, the overlay shows Codex. When Opus has only 1% left, it expands:

```text
Codex: 5h 80% left | Claude: Opus wk 1% left
```

This catches a model cap even when Claude's account-wide quota looks healthy.

Quick Limit Check's **HUD Format** offers three presets:

- **Limit Pins** (default) shows your preferred pin. It expands when another pinned limit or an enabled provider's account-wide limit has **less than 10% left**, including exhausted limits. Other model limits stay out of the HUD unless pinned.
- **Smart** shows each provider's primary account-wide limit and expands for low quota or usage ahead of elapsed time.
- **All Windows** shows all account-wide limits.

With no pins for the enabled profiles, Limit Pins uses Smart. Existing Smart and All Windows selections are kept; choose Limit Pins in Quick Limit Check's preferences to use saved pins.

Pinned rows have a pin icon; the preferred row has a star. Use **Unpin from Quick Check** on a row, or **Manage Limit Pins** in the actions to change your preferred pin and remove saved choices, including limits no longer reported or providers you've disabled.

Pins are saved locally per provider profile and survive quota cache refreshes. Disabled profiles keep their pins for when they're enabled again; if the preferred provider is disabled, Quick Check uses the next enabled pin. Missing pinned limits show as unavailable. Cached readings, failed refreshes, and passed resets still show warnings.

## Reset reminders

When a limit is exhausted and has a future reset time, open its actions in **Check AI Limits** and choose **Remind Me Around This Reset**. This schedules one Windows notification for that reported reset. It works for both account-wide and model-specific limits, independently of Limit Pins.

A bell marks limits with pending reminders. Reminder titles include the reported account label, a short account identifier when available, and the profile, so reminders for different accounts or profiles remain distinguishable. Choose **Cancel Reset Reminder** on the row, or **Manage Reset Reminders** in the actions to see and cancel pending reminders, including ones for providers you've since disabled. If a reading reports a different reset time, **Update Reminder to This Reset** replaces the existing reminder; reminders don't repeat automatically.

Windows delivers the notification without keeping Raycast open, polling quota, or leaving a timer process running. Clicking it opens **Check AI Limits**. The message says the reported reset time has arrived; it doesn't assume your quota has been restored.

Notifications use Windows PowerShell's sender identity, so allow its notifications in Windows settings if needed. Windows notification settings and Do Not Disturb can affect delivery; Windows may drop a scheduled notification when the computer stays asleep or off beyond its delivery window. See [Windows scheduled notification behavior](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/app-notifications-scheduled).

## Development

With Node.js 22.22.2 or newer and npm installed, run:

```sh
npm ci
npm run dev
```

Then open **Check AI Limits** in Raycast.

```sh
npm run lint
npm test
npm run build
```
