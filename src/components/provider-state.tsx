import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { ReactNode } from "react";
import { QuotaFailure } from "../quota/errors";
import { formatAge, formatRelative, formatShortDateTime, providerTitle } from "../quota/format";
import { ProviderState } from "../quota/refresh";
import { ProviderId } from "../quota/types";

interface FailureCopy {
  title: string;
  guidance: string;
  /** A command the user can run to resolve the state, offered as a copy action. */
  command?: { title: string; value: string };
}

/** Commands and wording that differ between the providers' CLIs. */
interface ProviderSetup {
  install: string;
  update: string;
  login: string;
  /** Command that starts the CLI, to check it works on its own. */
  cli: string;
  executablePreference: string;
  /** Completes "sign in …, then refresh". */
  signIn: string;
  /** How to switch to the sign-in plan limits need. */
  subscriptionSignIn: string;
  /** Why a response may be unreadable. */
  protocolNote: string;
}

const SETUP: Record<ProviderId, ProviderSetup> = {
  codex: {
    install: "npm install -g @openai/codex",
    update: "npm install -g @openai/codex@latest",
    login: "codex login",
    cli: "codex",
    executablePreference: "Codex Executable",
    signIn: "sign in with ChatGPT",
    subscriptionSignIn: "run `codex login` and choose **Sign in with ChatGPT**",
    protocolNote: "Codex may have changed its protocol.",
  },
  claude: {
    install: "npm install -g @anthropic-ai/claude-code",
    update: "claude update",
    login: "claude auth login",
    cli: "claude",
    executablePreference: "Claude Executable",
    signIn: "sign in with your Claude account",
    subscriptionSignIn:
      "run `claude auth login` and sign in with the Claude account that has your plan. Claude Code also needs to be set up without an API key or cloud provider",
    protocolNote: "Claude Code's usage interface is experimental and may have changed.",
  },
};

export function failureCopy(provider: ProviderId, failure: QuotaFailure, now: number): FailureCopy {
  const name = providerTitle(provider);
  const setup = SETUP[provider];
  switch (failure.kind) {
    case "cli-missing":
      if (failure.code === "path:not-found") {
        return {
          title: `${name} CLI not found`,
          guidance: `${failure.message}\n\nCorrect **${setup.executablePreference}** in the extension preferences, or clear it to let t0kns search common install locations.`,
        };
      }
      return {
        title: `${name} CLI not found`,
        guidance: `${failure.message}\n\nInstall ${name} (for example \`${setup.install}\`), sign in with \`${setup.login}\`, then refresh. If ${name} is installed somewhere t0kns doesn't search, set **${setup.executablePreference}** in the extension preferences.`,
        command: { title: "Copy Install Command", value: setup.install },
      };
    case "invalid-config":
      return {
        title: `Check ${name} preferences`,
        guidance: `${failure.message}\n\nOpen the extension preferences to correct the setting, then refresh.`,
      };
    case "signed-out":
      return {
        title: `Signed out of ${name}`,
        guidance: `Run \`${setup.login}\` in a terminal and ${setup.signIn}, then refresh. t0kns never asks for your credentials; ${name} manages sign-in.`,
        command: { title: "Copy Login Command", value: setup.login },
      };
    case "unsupported-auth":
      return {
        title: "Subscription limits unavailable",
        guidance: `${failure.message}\n\nThis is not the same as having quota left or being unlimited. To see plan limits, ${setup.subscriptionSignIn}.`,
        command: { title: "Copy Login Command", value: setup.login },
      };
    case "unsupported-version":
      return {
        title: `${name} update needed`,
        guidance: `${failure.message}\n\nUpdate ${name} (for example \`${setup.update}\`), then refresh.`,
        command: { title: "Copy Update Command", value: setup.update },
      };
    case "rate-limited":
      return {
        title: `${name} is rate limited`,
        guidance: failure.retryAfter
          ? `Usage checks are paused until ${formatShortDateTime(failure.retryAfter, now)} (${formatRelative(failure.retryAfter, now)}).`
          : "Usage checks are paused for a few minutes.",
      };
    case "timeout":
      return {
        title: `${name} didn't respond in time`,
        guidance: `${failure.message}\n\nTry again. If it keeps happening, run \`${setup.cli}\` in a terminal to check that it starts normally.`,
      };
    case "malformed-response":
      return {
        title: `Unexpected response from ${name}`,
        guidance: `${failure.message}\n\n${setup.protocolNote} Updating ${name} and t0kns usually resolves this.`,
      };
    case "cancelled":
    case "unavailable":
      return {
        title: `Couldn't read ${name} limits`,
        guidance: `${failure.message}\n\nTry again in a moment.`,
      };
  }
}

interface ProviderStateItemProps {
  provider: ProviderId;
  state: ProviderState;
  now: number;
  actions: (extra?: ReactNode) => ReactNode;
}

/** The provider's error or empty state, shown in its section above any cached rows. */
export function ProviderStateItem({ provider, state, now, actions }: ProviderStateItemProps) {
  const failure = state.error;
  const name = providerTitle(provider);

  if (!failure) {
    const title = state.loading ? "Checking limits…" : state.snapshot ? "No quota data reported" : "No reading yet";
    const guidance = state.snapshot
      ? `${name} answered but reported no quota windows. This doesn't mean usage is unlimited.`
      : "Refresh to read current limits.";
    return (
      <List.Item
        id={`${provider}:state`}
        title={title}
        icon={state.loading ? Icon.CircleProgress : Icon.QuestionMarkCircle}
        keywords={[name]}
        detail={<List.Item.Detail markdown={`## ${title}\n\n${guidance}`} />}
        actions={actions()}
      />
    );
  }

  const copy = failureCopy(provider, failure, now);
  const snapshot = state.snapshot;
  const title = snapshot ? "Refresh failed" : copy.title;
  const subtitle = snapshot ? `Showing reading from ${formatAge(snapshot.checkedAt, now)} · ${copy.title}` : undefined;
  const markdown = [
    `## ${copy.title}`,
    snapshot
      ? `The rows below are from the last successful check, ${formatAge(snapshot.checkedAt, now)}. They may be out of date.`
      : undefined,
    copy.guidance,
    failure.detail ? `Reported by ${name}:\n\n\`\`\`\n${failure.detail.replace(/`/g, "'")}\n\`\`\`` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <List.Item
      id={`${provider}:state`}
      title={title}
      subtitle={subtitle}
      icon={{ source: Icon.Warning, tintColor: snapshot ? Color.Yellow : Color.Orange }}
      keywords={[name, copy.title]}
      detail={<List.Item.Detail markdown={markdown} />}
      actions={actions(
        copy.command ? (
          <ActionPanel.Section>
            <Action.CopyToClipboard title={copy.command.title} content={copy.command.value} />
          </ActionPanel.Section>
        ) : undefined,
      )}
    />
  );
}
