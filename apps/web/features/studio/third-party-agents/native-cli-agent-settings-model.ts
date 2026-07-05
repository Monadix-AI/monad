import type {
  NativeCliAgentPresetView,
  NativeCliAgentSetting,
  NativeCliAgentView,
  NativeCliAppServerTransport,
  NativeCliLaunchMode
} from '@monad/protocol';

export function nativeCliLaunchModeOptions(
  agent: NativeCliAgentView,
  preset: NativeCliAgentPresetView | undefined
): NativeCliLaunchMode[] {
  const options = preset?.supportedLaunchModes?.length ? preset.supportedLaunchModes : [agent.defaultLaunchMode];
  return options.includes(agent.defaultLaunchMode) ? options : [agent.defaultLaunchMode, ...options];
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
  if (preset?.settings?.length) return preset.settings;
  if (agent.settings?.length) return agent.settings;
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
