import type { ChannelType } from '@monad/protocol';
import type {
  ChannelAdapterFactory,
  Connector,
  ExternalAgentProviderAdapter,
  HookDefinition,
  ManifestAtomPack,
  ModelProvider,
  SandboxLauncher,
  WorkspaceExperienceApi,
  WorkspaceExperienceDefinition
} from '@monad/sdk-atom';

import builtinAtomPack from '@monad/atoms';

import { loadChannelAtomPacks } from '#/channels/atom-pack-host.ts';

/** The single first-party atom pack — every built-in atom (connectors, Telegram channel, reserved
 *  commands, en/zh locales, model providers) bundled and loaded through the SAME atom-kind-gated
 *  path (loadManifestAtomPack) as third-party atom packs. Non-channel atoms flow to their
 *  respective sinks; commands route to the reserved builtin registry (see the daemon). Tools are
 *  not atoms — they are wired directly by the daemon, not through this loader. */
const BUILTIN_CHANNEL_ATOM_PACKS: ManifestAtomPack[] = [builtinAtomPack];

/** Resolve first-party channels (type → adapter factory) via the unified atom pack loader. */
export function builtinChannelAdapters(
  onError?: (atomPack: string, error: unknown) => void,
  sinks: {
    onConnector?: (connector: Connector) => void;
    onCommand?: (atomPackName: string, command: unknown) => void;
    onProvider?: (provider: ModelProvider) => void;
    onHook?: (hook: HookDefinition) => void;
    onAgentAdapter?: (adapter: ExternalAgentProviderAdapter) => void;
    onSandbox?: (launcher: SandboxLauncher) => void;
    onWorkspaceExperience?: (experience: WorkspaceExperienceDefinition, atomPackName: string) => void;
    onWorkspaceExperienceApi?: (api: WorkspaceExperienceApi, atomPackName: string) => void;
  } = {}
): Promise<Map<ChannelType, ChannelAdapterFactory>> {
  return loadChannelAtomPacks(BUILTIN_CHANNEL_ATOM_PACKS, { onError, ...sinks });
}

/** Later maps win — discovered (third-party) adapters may override a built-in type. */
export function mergeRegistries(
  ...maps: Map<ChannelType, ChannelAdapterFactory>[]
): Map<ChannelType, ChannelAdapterFactory> {
  const out = new Map<ChannelType, ChannelAdapterFactory>();
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  return out;
}
