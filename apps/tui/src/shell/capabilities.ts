type CapabilityMode = 'native' | 'summary' | 'web-only';
export type TuiSurface = 'workspace' | 'studio' | 'settings';

export interface NavCapability {
  id: string;
  label: string;
  mode: CapabilityMode;
  path: string;
  screen: string;
  surface: TuiSurface;
}

const item = (surface: TuiSurface, id: string, label: string, mode: CapabilityMode, path: string): NavCapability => ({
  id: `${surface}.${id}`,
  label,
  mode,
  path,
  screen: `${surface}.${id}`,
  surface
});

export const NAV_CAPABILITIES: NavCapability[] = [
  item('workspace', 'inbox', 'Inbox', 'native', '/inbox'),
  item('workspace', 'projects', 'Projects', 'native', '/'),
  item('workspace', 'chats', 'Chats', 'native', '/'),
  item('studio', 'runtime', 'Runtime', 'native', '/studio/runtime'),
  item('studio', 'models', 'Models & Providers', 'native', '/studio/models'),
  item('studio', 'agents', 'Monad Agents', 'native', '/studio/agents'),
  item('studio', 'meshAgents', 'MeshAgents', 'native', '/studio/meshAgents'),
  item('studio', 'approvals', 'Approvals', 'native', '/studio/approvals'),
  item('studio', 'capabilities', 'Capabilities', 'summary', '/studio/capabilities'),
  item('studio', 'acpDelegates', 'ACP Delegates', 'summary', '/studio/acpDelegates'),
  item('studio', 'memory', 'Memory', 'summary', '/studio/memory'),
  item('studio', 'safety', 'Safety & Hooks', 'summary', '/studio/safety'),
  item('studio', 'mesh', 'Agent Mesh', 'summary', '/studio/mesh'),
  item('studio', 'workplaceProjects', 'Workplace Projects', 'summary', '/studio/workplaceProjects'),
  item('studio', 'atoms', 'Atoms', 'summary', '/studio/atoms'),
  item('studio', 'import', 'Import', 'web-only', '/studio/import'),
  item('settings', 'connection', 'Connection', 'native', '/settings/connection'),
  item('settings', 'profile', 'Profile', 'summary', '/settings/profile'),
  item('settings', 'preferences', 'Preferences', 'native', '/settings/experience'),
  item('settings', 'mo', 'Mo', 'web-only', '/settings/mo'),
  item('settings', 'licenses', 'Licenses', 'summary', '/settings/licenses'),
  item('settings', 'system', 'System', 'summary', '/settings/system')
];

export function capabilityIds(items: readonly NavCapability[]): string[] {
  return items.map((entry) => entry.id);
}
