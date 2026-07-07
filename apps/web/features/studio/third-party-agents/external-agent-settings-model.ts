import type {
  ExternalAgentAppServerTransport,
  ExternalAgentLaunchMode,
  ExternalAgentPresetView,
  ExternalAgentSetting,
  ExternalAgentView
} from '@monad/protocol';

const EXTERNAL_AGENT_FALLBACK_LAUNCH_MODE: ExternalAgentLaunchMode = 'app-server';

function externalLaunchModes(options: readonly ExternalAgentLaunchMode[]): ExternalAgentLaunchMode[] {
  const filtered = options.filter((option) => option !== 'pty');
  return filtered.length > 0 ? [...new Set(filtered)] : [EXTERNAL_AGENT_FALLBACK_LAUNCH_MODE];
}

export function normalizeExternalAgentLaunchMode(
  launchMode: ExternalAgentLaunchMode,
  options: readonly ExternalAgentLaunchMode[]
): ExternalAgentLaunchMode {
  if (launchMode !== 'pty') return launchMode;
  return externalLaunchModes(options)[0] ?? EXTERNAL_AGENT_FALLBACK_LAUNCH_MODE;
}

export function externalAgentLaunchModeOptions(
  agent: ExternalAgentView,
  preset: ExternalAgentPresetView | undefined
): ExternalAgentLaunchMode[] {
  const options = preset?.supportedLaunchModes?.length ? preset.supportedLaunchModes : [agent.defaultLaunchMode];
  const visibleOptions = externalLaunchModes(options);
  if (agent.defaultLaunchMode !== 'pty' && !visibleOptions.includes(agent.defaultLaunchMode)) {
    return [agent.defaultLaunchMode, ...visibleOptions];
  }
  return visibleOptions;
}

export function externalAgentAppServerTransportOptions(
  preset: ExternalAgentPresetView | undefined
): ExternalAgentAppServerTransport[] {
  return preset?.supportedAppServerTransports ?? [];
}

export function externalAgentSettings(
  agent: ExternalAgentView,
  preset: ExternalAgentPresetView | undefined
): ExternalAgentSetting[] {
  const declaredSettings = preset?.settings?.length ? preset.settings : agent.settings;
  if (declaredSettings?.length) {
    return declaredSettings.map((setting) => {
      if (setting.kind !== 'select' || setting.key !== 'defaultLaunchMode') return setting;
      const options = externalLaunchModes(setting.options.map((option) => option.value as ExternalAgentLaunchMode));
      return {
        ...setting,
        options: options.map(
          (value) => setting.options.find((option) => option.value === value) ?? { value, label: value }
        )
      };
    });
  }
  const appServerTransports = externalAgentAppServerTransportOptions(preset);
  return [
    {
      key: 'defaultLaunchMode',
      label: 'Launch mode',
      kind: 'select',
      options: externalAgentLaunchModeOptions(agent, preset).map((value) => ({ value, label: value }))
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

export function externalAgentSettingDescription(
  setting: ExternalAgentSetting,
  opts: { canToggleAutopilot: boolean }
): string | undefined {
  if (setting.key === 'allowAutopilot' && !opts.canToggleAutopilot) return 'approvalProxyUnavailable';
  return setting.description;
}

export function canDisableAutopilot(agent: ExternalAgentView, preset?: ExternalAgentPresetView): boolean {
  return preset?.capabilities?.approvalProxy === true || agent.capabilities?.approvalProxy === true;
}
