// The single first-party atom pack — the registration entry for @monad/atoms. Default-exports the
// built-in atom pack; the only named export is configureNativeLauncherPath, the daemon→launcher
// config bridge the daemon must push before it selects a launcher (the native landlock/win32
// launchers ship here, so their binary-path override lives here too). The daemon loads the pack
// through the SAME atom-kind-gated path (loadManifestAtomPack) as any third-party pack — the "core
// is all atoms" invariant: nothing first-party bypasses the gate.
//
// Every built-in *atom* monad ships — connectors, channels, reserved slash commands, and model
// providers — is bundled here. Tools are NOT an atom kind: they are always first-party, built into
// the daemon (apps/monad/src/tools), and wired straight into the tool registry — never through an
// atom pack. The daemon owns the sandbox + credentials wrapping. See main.ts's builtin tool wiring.
//
// Commands route to the reserved builtin registry (not the third-party attribution path) — see the
// daemon's builtin load branch. The built-in UI locales are NOT here — they live in @monad/i18n
// (the i18n engine owns them); the daemon loads them from @monad/i18n/locale-dir at startup.
//
// Tests that need specific channel adapters, providers, commands, or launchers use explicit
// package subpaths instead of reaching through the source tree.

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
import { builtinModelProviders } from './providers/registry.ts';
import { bwrapLauncher } from './sandbox/bwrap.ts';
import { configureDockerImage, detectDockerRuntime, dockerLauncher, dockerRuntimeAvailable } from './sandbox/docker.ts';
import { __setE2bLoaderForTest, configureE2bApiKey, e2bLauncher } from './sandbox/e2b.ts';
import { landlockLauncher } from './sandbox/landlock.ts';
import { configureNativeLauncherPath } from './sandbox/native-path.ts';
import { seatbeltLauncher } from './sandbox/seatbelt.ts';
import { win32Launcher } from './sandbox/win32.ts';
import { sweepOrphanAppContainerProfiles, win32AppContainerLauncher } from './sandbox/win32-appcontainer.ts';
import { builtinWorkspaceExperiences } from './workspace-experiences/registry.ts';

// The one named export: the daemon pushes config.agent.sandbox.launcherPath here before launcher
// selection so the native landlock/win32 launchers can find their helper binary.
export {
  __setE2bLoaderForTest,
  configureDockerImage,
  configureE2bApiKey,
  configureNativeLauncherPath,
  detectDockerRuntime,
  dockerLauncher,
  dockerRuntimeAvailable,
  e2bLauncher,
  sweepOrphanAppContainerProfiles
};

export default defineAtomPack({
  manifest: {
    name: 'monad-builtins',
    version: '1.0.0',
    sdkVersion: SDK_VERSION,
    atoms: ['connector', 'channel', 'command', 'provider', 'sandbox', 'workspace-experience', 'agent-adapter'],
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
  workspaceExperiences: builtinWorkspaceExperiences,
  // Launcher priority (first-match-wins within the builtin tier):
  //   macOS  → Seatbelt (system sandbox-exec, enforces write+readDeny+net)
  //   Linux  → bwrap when installed (enforces write+readDeny+net) → Landlock (write+net only)
  //   Windows→ AppContainer when binary present (write+readDeny+net) → Low IL (write only)
  //   any    → Docker (requires runtime) → E2B (requires API key, explicit opt-in)
  // Third-party atom packs override the entire builtin tier (atom > builtin in registry).
  sandboxes: [
    seatbeltLauncher,
    bwrapLauncher,
    landlockLauncher,
    win32AppContainerLauncher,
    win32Launcher,
    dockerLauncher,
    e2bLauncher
  ]
});
