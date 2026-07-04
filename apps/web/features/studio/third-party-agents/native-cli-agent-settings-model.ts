import type {
  NativeCliAgentPresetView,
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

export function canDisableDangerousMode(agent: NativeCliAgentView, preset?: NativeCliAgentPresetView): boolean {
  return preset?.capabilities?.approvalProxy === true || agent.capabilities?.approvalProxy === true;
}
