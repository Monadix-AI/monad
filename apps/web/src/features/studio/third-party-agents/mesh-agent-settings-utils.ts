import type { WebMessageIdWithoutParams } from '@monad/i18n/browser';
import type { MeshAgentAuthState, MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

export const argsToStr = (args?: string[]): string => (args ?? []).join(' ');
export const strToArgs = (s: string): string[] => s.split(/\s+/).filter(Boolean);
export const modelOptionsToStr = (modelOptions?: string[]): string => (modelOptions ?? []).join('\n');
export const strToModelOptions = (s: string): string[] =>
  s
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter(Boolean);
export const envToStr = (env?: Record<string, string>): string =>
  Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
export const strToEnv = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
};

export function meshAgentReasoningEffortsForModel(
  reasoningEfforts: readonly string[] | undefined,
  reasoningEffortsByModel: Readonly<Record<string, string[]>> | undefined,
  modelId: string | undefined
): string[] {
  const values =
    modelId && reasoningEffortsByModel ? (reasoningEffortsByModel[modelId] ?? []) : (reasoningEfforts ?? []);
  return [...new Set(values.map((effort) => effort.trim()).filter(Boolean))];
}

export const presetToView = (p: MeshAgentPresetView): MeshAgentView => ({
  name: p.id,
  displayName: p.label,
  provider: p.provider,
  productIcon: p.productIcon,
  command: p.command,
  args: p.args,
  modelOptions: p.modelOptions,
  modelOptionDisplayNames: p.modelOptionDisplayNames,
  reasoningEfforts: p.reasoningEfforts,
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned',
  capabilities: p.capabilities
});

export function meshAgentPresetCardState({
  preset,
  connectedAgent,
  statusAuth
}: {
  preset: MeshAgentPresetView;
  connectedAgent?: MeshAgentView;
  statusAuth?: MeshAgentAuthState;
}): {
  isConnected: boolean;
  canDisconnect: boolean;
  settingsAgent?: MeshAgentView;
} {
  const isMonad = preset.provider === 'monad';
  const hasAuthenticatedConnection = Boolean(
    preset.installed && connectedAgent && statusAuth !== 'unauthenticated' && statusAuth !== 'unknown'
  );
  return {
    isConnected: isMonad || hasAuthenticatedConnection,
    canDisconnect: !isMonad && hasAuthenticatedConnection,
    settingsAgent: isMonad ? (connectedAgent ?? presetToView(preset)) : connectedAgent
  };
}

export const presetForAgent = (
  agent: MeshAgentView,
  presets: readonly MeshAgentPresetView[]
): MeshAgentPresetView | undefined =>
  presets.find((preset) => preset.id === agent.name || preset.provider === agent.provider);

export function presetHintKey(id: string): WebMessageIdWithoutParams {
  return `web.meshAgent.presetHint.${id}` as WebMessageIdWithoutParams;
}
