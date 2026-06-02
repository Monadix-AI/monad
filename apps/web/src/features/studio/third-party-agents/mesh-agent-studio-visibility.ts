import type { MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

export function studioVisibleMeshAgents(agents: readonly MeshAgentView[]): MeshAgentView[] {
  return agents.filter((agent) => agent.provider !== 'monad' || agent.name === 'monad');
}

export function studioVisibleMeshAgentPresets(presets: readonly MeshAgentPresetView[]): MeshAgentPresetView[] {
  return [...presets];
}
