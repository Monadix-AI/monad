import type {
  AtomConflict,
  ChannelCapabilities,
  ChannelConnectionMode,
  ChannelEnvVar,
  ChannelIcon,
  ChannelSetupGuide,
  InstalledAtomPack
} from '@monad/protocol';

export interface InstalledChannelOption {
  available?: boolean;
  capabilities?: ChannelCapabilities;
  description?: string;
  envVars: ChannelEnvVar[];
  icon?: ChannelIcon;
  label: string;
  packId: string;
  setup?: ChannelSetupGuide;
  connectionMode: ChannelConnectionMode;
  type: string;
}

export function installedChannelOptions(
  atomPacks: InstalledAtomPack[],
  conflicts: AtomConflict[]
): InstalledChannelOption[] {
  const channelConflicts = new Map(
    conflicts.filter((conflict) => conflict.kind === 'channel').map((conflict) => [conflict.bareId, conflict])
  );
  const options = new Map<string, InstalledChannelOption>();

  for (const pack of atomPacks) {
    if (!pack.enabled) continue;
    for (const atom of pack.atomDetails) {
      if (atom.kind !== 'channel') continue;
      const conflict = channelConflicts.get(atom.id);
      const type = conflict && conflict.winner !== pack.name ? `${pack.name}__${atom.id}` : atom.id;
      if (options.has(type)) continue;
      options.set(type, {
        type,
        packId: pack.name,
        label: atom.name ?? atom.id,
        description: atom.description,
        ...(atom.channel?.capabilities ? { capabilities: atom.channel.capabilities } : {}),
        envVars: atom.channel?.envVars ?? [],
        connectionMode: atom.channel?.connectionMode ?? 'credential',
        ...(atom.channel?.icon ? { icon: atom.channel.icon } : {}),
        ...(atom.channel?.setup ? { setup: atom.channel.setup } : {})
      });
    }
  }

  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label) || a.type.localeCompare(b.type));
}
