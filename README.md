# t0kns

A Raycast extension for Windows to check Codex and Claude Code subscription limits and reset times.

## Commands

- **Check AI Limits** — view remaining quota, reset times, and account details.
- **Quick Limit Check** — show a brief quota overlay. Assign a Raycast hotkey for quick access.

## Setup

Install Raycast for Windows and sign in to your subscription through the Codex or Claude Code CLI. Codex is enabled by default; Claude Code is experimental and can be enabled in the extension preferences.

If a CLI isn't detected, set its executable path in preferences. Existing custom profiles can also be configured there. t0kns reads quota through the installed CLIs without sending prompts or starting model turns.

## Limit Pins

In **Check AI Limits**, select an account-wide or model-specific limit and choose **Pin for Quick Check** from its actions. For example, pin Codex's 5-hour limit and Claude's weekly Opus limit. The first pin becomes preferred; **Make Preferred Limit** pins and prefers any other limit, including one from another provider.

Quick Limit Check's **HUD Format** offers three presets:

- **Limit Pins** (default) shows your preferred pin. It expands when another pinned limit or an enabled provider's account-wide limit has **less than 10% left**, including exhausted limits. Other model limits stay out of the HUD unless pinned. Missing pinned limits show as unavailable.
- **Smart** shows each provider's primary account-wide limit and expands for low quota or usage ahead of elapsed time.
- **All Windows** shows all account-wide limits.

With no pins for the enabled profiles, Limit Pins uses Smart. Existing Smart and All Windows selections are kept; choose Limit Pins in Quick Limit Check's preferences to use saved pins.

Pinned rows have a pin icon; the preferred row has a star. Use **Manage Limit Pins** in the actions to change the preferred pin or remove saved choices, including limits no longer reported or providers you've disabled. Pins are saved locally per provider profile, survive quota cache refreshes, and resume when that profile is enabled again. A missing preferred provider yields to the next enabled pin. Cached readings, failed refreshes, and passed resets still show warnings.

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
