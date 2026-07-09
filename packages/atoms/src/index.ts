// The single first-party atom pack — the registration entry for @monad/atoms. Default-exports the
// built-in atom pack. The daemon loads the pack through the SAME atom-kind-gated path
// (loadManifestAtomPack) as any third-party pack — the "core is all atoms" invariant: nothing
// first-party bypasses the gate.
//
// Every built-in *atom* monad ships — connectors, channels, reserved slash commands, and model
// providers — is bundled here. Tools are NOT an atom kind: they are always first-party, built into
// the daemon (apps/monad/src/tools), and wired straight into the tool registry — never through an
// atom pack. The daemon owns the sandbox + credentials wrapping. See main.ts's builtin tool wiring.
//
// Sandbox launchers are NOT bundled here either: the light OS launchers are a closed internal set of
// @monad/sandbox, and the heavy docker/e2b launchers are the opt-in @monad/monad-power-pack atom
// pack. So this pack no longer declares the `sandbox` atom kind.
//
// Commands route to the reserved builtin registry (not the third-party attribution path) — see the
// daemon's builtin load branch. The built-in UI locales are NOT here — they live in @monad/i18n
// (the i18n engine owns them); the daemon loads them from @monad/i18n/locale-dir at startup.
//
// Tests that need specific channel adapters, providers, or commands use explicit package subpaths
// instead of reaching through the source tree.

import { defineAtomPack, SDK_VERSION } from '@monad/sdk-atom';

import { builtinAgentAdapters } from './agent-adapters/index.ts';
import { discordChannelAtom } from './channels/discord.ts';
import { emailChannelAtom } from './channels/email.ts';
import { feishuChannelAtom } from './channels/feishu.ts';
import { googleChatChannelAtom } from './channels/google-chat.ts';
import { imessageChannelAtom } from './channels/imessage.ts';
import { ircChannelAtom } from './channels/irc.ts';
import { lineChannelAtom } from './channels/line.ts';
import { qqChannelAtom } from './channels/qq.ts';
import { signalChannelAtom } from './channels/signal.ts';
import { slackChannelAtom } from './channels/slack.ts';
import { teamsChannelAtom } from './channels/teams.ts';
import { telegramChannelAtom } from './channels/telegram.ts';
import { twilioChannelAtom } from './channels/twilio.ts';
import { webhookChannelAtom } from './channels/webhook.ts';
import { wecomChannelAtom } from './channels/wecom.ts';
import { whatsappChannelAtom } from './channels/whatsapp.ts';
import { BUILTIN_COMMANDS } from './commands/builtins.ts';
import { builtinConnectors } from './connectors/registry.ts';
import { configureBuiltinExternalAgentObservationAdapters } from './external-agent-observation-setup.ts';
import { builtinModelProviders } from './providers/registry.ts';
import { builtinWorkspaceExperiences } from './workspace-experiences/registry.ts';

configureBuiltinExternalAgentObservationAdapters();

export default defineAtomPack({
  manifest: {
    name: 'monad-builtins',
    version: '1.0.0',
    sdkVersion: SDK_VERSION,
    atoms: ['connector', 'channel', 'command', 'provider', 'workspace-experience', 'agent-adapter'],
    description: 'First-party atoms bundled with monad',
    author: 'monad'
  },
  connectors: builtinConnectors,
  channels: [
    telegramChannelAtom,
    discordChannelAtom,
    slackChannelAtom,
    webhookChannelAtom,
    ircChannelAtom,
    lineChannelAtom,
    whatsappChannelAtom,
    twilioChannelAtom,
    feishuChannelAtom,
    wecomChannelAtom,
    teamsChannelAtom,
    googleChatChannelAtom,
    emailChannelAtom,
    signalChannelAtom,
    qqChannelAtom,
    imessageChannelAtom
  ],
  commands: BUILTIN_COMMANDS,
  providers: builtinModelProviders,
  agentAdapters: builtinAgentAdapters,
  workspaceExperiences: builtinWorkspaceExperiences
});
