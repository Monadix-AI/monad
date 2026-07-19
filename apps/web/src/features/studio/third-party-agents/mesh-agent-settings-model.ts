import type {
  MeshAgentAppServerTransport,
  MeshAgentLaunchMode,
  MeshAgentPresetView,
  MeshAgentSetting,
  MeshAgentView
} from '@monad/protocol';

const MESH_AGENT_FALLBACK_LAUNCH_MODE: MeshAgentLaunchMode = 'app-server';

function externalLaunchModes(options: readonly MeshAgentLaunchMode[]): MeshAgentLaunchMode[] {
  const filtered = options.filter((option) => option !== 'pty');
  return filtered.length > 0 ? [...new Set(filtered)] : [MESH_AGENT_FALLBACK_LAUNCH_MODE];
}

export function normalizeMeshAgentLaunchMode(
  launchMode: MeshAgentLaunchMode,
  options: readonly MeshAgentLaunchMode[]
): MeshAgentLaunchMode {
  if (launchMode !== 'pty') return launchMode;
  return externalLaunchModes(options)[0] ?? MESH_AGENT_FALLBACK_LAUNCH_MODE;
}

export function meshAgentLaunchModeOptions(
  agent: MeshAgentView,
  preset: MeshAgentPresetView | undefined
): MeshAgentLaunchMode[] {
  const options = preset?.supportedLaunchModes?.length ? preset.supportedLaunchModes : [agent.defaultLaunchMode];
  const visibleOptions = externalLaunchModes(options);
  if (agent.defaultLaunchMode !== 'pty' && !visibleOptions.includes(agent.defaultLaunchMode)) {
    return [agent.defaultLaunchMode, ...visibleOptions];
  }
  return visibleOptions;
}

export function meshAgentAppServerTransportOptions(
  preset: MeshAgentPresetView | undefined
): MeshAgentAppServerTransport[] {
  return preset?.supportedAppServerTransports ?? [];
}

export function meshAgentSettings(agent: MeshAgentView, preset: MeshAgentPresetView | undefined): MeshAgentSetting[] {
  const declaredSettings = preset?.settings?.length ? preset.settings : agent.settings;
  if (declaredSettings?.length) {
    return declaredSettings.map((setting) => {
      if (setting.kind !== 'select' || setting.key !== 'defaultLaunchMode') return setting;
      const options = externalLaunchModes(setting.options.map((option) => option.value as MeshAgentLaunchMode));
      return {
        ...setting,
        options: options.map(
          (value) => setting.options.find((option) => option.value === value) ?? { value, label: value }
        )
      };
    });
  }
  const appServerTransports = meshAgentAppServerTransportOptions(preset);
  return [
    {
      key: 'defaultLaunchMode',
      label: 'Launch mode',
      kind: 'select',
      options: meshAgentLaunchModeOptions(agent, preset).map((value) => ({ value, label: value }))
    },
    { key: 'allowAutopilot', label: 'Autopilot', kind: 'switch' },
    ...(appServerTransports.length
      ? [
          {
            key: 'appServerTransport',
            label: 'App-server transport',
            kind: 'select' as const,
            placeholder: 'Default',
            options: appServerTransports.map((value) => ({ value, label: value }))
          }
        ]
      : [])
  ];
}

export function meshAgentSettingDescription(
  setting: MeshAgentSetting,
  opts: { canToggleAutopilot: boolean }
): string | undefined {
  if (setting.key === 'allowAutopilot' && !opts.canToggleAutopilot) return 'approvalProxyUnavailable';
  return setting.description;
}

export function canDisableAutopilot(agent: MeshAgentView, preset?: MeshAgentPresetView): boolean {
  return preset?.capabilities?.approvalProxy === true || agent.capabilities?.approvalProxy === true;
}
