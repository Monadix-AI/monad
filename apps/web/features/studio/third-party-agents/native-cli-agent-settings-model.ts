import type {
  NativeCliAgentPresetView,
  NativeCliAgentSetting,
  NativeCliAgentView,
  NativeCliAppServerTransport,
  NativeCliLaunchMode
} from '@monad/protocol';

const EXTERNAL_AGENT_FALLBACK_LAUNCH_MODE: NativeCliLaunchMode = 'app-server';

function externalLaunchModes(options: readonly NativeCliLaunchMode[]): NativeCliLaunchMode[] {
  const filtered = options.filter((option) => option !== 'pty');
  return filtered.length > 0 ? [...new Set(filtered)] : [EXTERNAL_AGENT_FALLBACK_LAUNCH_MODE];
}

export function normalizeNativeCliLaunchMode(
  launchMode: NativeCliLaunchMode,
  options: readonly NativeCliLaunchMode[]
): NativeCliLaunchMode {
  if (launchMode !== 'pty') return launchMode;
  return externalLaunchModes(options)[0] ?? EXTERNAL_AGENT_FALLBACK_LAUNCH_MODE;
}

export function nativeCliLaunchModeOptions(
  agent: NativeCliAgentView,
  preset: NativeCliAgentPresetView | undefined
): NativeCliLaunchMode[] {
  const options = preset?.supportedLaunchModes?.length ? preset.supportedLaunchModes : [agent.defaultLaunchMode];
  const visibleOptions = externalLaunchModes(options);
  if (agent.defaultLaunchMode !== 'pty' && !visibleOptions.includes(agent.defaultLaunchMode)) {
    return [agent.defaultLaunchMode, ...visibleOptions];
  }
  return visibleOptions;
}

export function nativeCliAppServerTransportOptions(
  preset: NativeCliAgentPresetView | undefined
): NativeCliAppServerTransport[] {
  return preset?.supportedAppServerTransports ?? [];
}

export function nativeCliAgentSettings(
  agent: NativeCliAgentView,
  preset: NativeCliAgentPresetView | undefined
): NativeCliAgentSetting[] {
  const declaredSettings = preset?.settings?.length ? preset.settings : agent.settings;
  if (declaredSettings?.length) {
    return declaredSettings.map((setting) => {
      if (setting.kind !== 'select' || setting.key !== 'defaultLaunchMode') return setting;
      const options = externalLaunchModes(setting.options.map((option) => option.value as NativeCliLaunchMode));
      return {
        ...setting,
        options: options.map(
          (value) => setting.options.find((option) => option.value === value) ?? { value, label: value }
        )
      };
    });
  }
  const appServerTransports = nativeCliAppServerTransportOptions(preset);
  return [
    {
      key: 'defaultLaunchMode',
      label: 'Launch mode',
      kind: 'select',
      options: nativeCliLaunchModeOptions(agent, preset).map((value) => ({ value, label: value }))
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

export function nativeCliSettingDescription(
  setting: NativeCliAgentSetting,
  opts: { canToggleAutopilot: boolean }
): string | undefined {
  if (setting.key === 'allowAutopilot' && !opts.canToggleAutopilot) return 'approvalProxyUnavailable';
  return setting.description;
}

export function canDisableAutopilot(agent: NativeCliAgentView, preset?: NativeCliAgentPresetView): boolean {
  return preset?.capabilities?.approvalProxy === true || agent.capabilities?.approvalProxy === true;
}
