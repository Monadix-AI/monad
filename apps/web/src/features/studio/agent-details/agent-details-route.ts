export type AgentSessionTab = 'chat' | 'project' | 'monadix';
export type AgentMemoryTab = 'facts' | 'graph' | 'laws';

export type AgentDetailsRoute =
  | { mode: 'edit'; primary: 'sessions'; secondary: 'chat' }
  | { mode: 'detail'; primary: 'sessions'; secondary: AgentSessionTab }
  | { mode: 'detail'; primary: 'memory'; secondary: AgentMemoryTab };

const SESSION_TABS = new Set<AgentSessionTab>(['chat', 'project', 'monadix']);
const MEMORY_TABS = new Set<AgentMemoryTab>(['facts', 'graph', 'laws']);

function isSessionTab(value: string | undefined): value is AgentSessionTab {
  return value !== undefined && SESSION_TABS.has(value as AgentSessionTab);
}

function isMemoryTab(value: string | undefined): value is AgentMemoryTab {
  return value !== undefined && MEMORY_TABS.has(value as AgentMemoryTab);
}

export function parseAgentDetailsRoute(trail: readonly string[]): AgentDetailsRoute {
  if (trail[1] === 'edit') return { mode: 'edit', primary: 'sessions', secondary: 'chat' };
  if (trail[1] === 'memory' && isMemoryTab(trail[2])) {
    return { mode: 'detail', primary: 'memory', secondary: trail[2] };
  }
  if (trail[1] === 'sessions' && isSessionTab(trail[2])) {
    return { mode: 'detail', primary: 'sessions', secondary: trail[2] };
  }
  return { mode: 'detail', primary: 'sessions', secondary: 'chat' };
}
