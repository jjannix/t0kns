# t0kns

A Raycast extension for Windows to check Codex and Claude Code subscription limits and reset times.

## Commands

- **Check AI Limits** — view remaining quota, reset times, and account details.
- **Quick Limit Check** — show a brief quota overlay. Assign a Raycast hotkey for quick access.

## Setup

Install Raycast for Windows and sign in to your subscription through the Codex or Claude Code CLI. Codex is enabled by default; Claude Code is experimental and can be enabled in the extension preferences.

If a CLI isn't detected, set its executable path in preferences. Existing custom profiles can also be configured there. t0kns reads quota through the installed CLIs without sending prompts or starting model turns.

## Development

With Node.js 22.22.2 or newer and npm installed, run:

```sh
npm ci
npm run dev
```

Then open **Check AI Limits** in Raycast.

```sh
npm run lint
npm run build
```
