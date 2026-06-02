import type { MeshAgentPresetView, MeshAgentSetting, MeshAgentView } from '@monad/protocol';

export function meshAgentSettings(agent: MeshAgentView, preset: MeshAgentPresetView | undefined): MeshAgentSetting[] {
  const declaredSettings = preset?.settings?.length ? preset.settings : agent.settings;
  return declaredSettings?.length ? declaredSettings : [{ key: 'allowAutopilot', label: 'Autopilot', kind: 'switch' }];
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
