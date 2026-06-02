import type { Agent, AgentMemorySettings, MemoryScopeQuery } from '@monad/protocol';
import type { AgentMemoryTab } from './agent-details-route';

import { JusticeScaleIcon, NeuralNetworkIcon } from '@hugeicons/core-free-icons';
import { Button } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { studioDetailPath } from '#/features/shell/routing/paths';
import { replaceShellUrl } from '#/hooks/use-shell-location';
import { DataEmpty } from '../memory-settings/DataEmpty';
import { GraphView } from '../memory-settings/GraphView';
import { LawsView } from '../memory-settings/LawsView';
import { ScopedFactsView } from '../memory-settings/ScopedFactsView';

const MEMORY_TABS: AgentMemoryTab[] = ['facts', 'graph', 'laws'];

export function agentMemoryScope(agent: Pick<Agent, 'id'>): MemoryScopeQuery {
  return { scopeKind: 'agent', scopeId: agent.id };
}

export function agentMemoryViewState(
  memory: AgentMemorySettings,
  tab: AgentMemoryTab
): 'available' | 'historical' | 'advanced-required' {
  if (!memory.enabled) return 'historical';
  if (tab === 'facts') return 'available';
  if (!memory.advanced) return 'advanced-required';
  return 'available';
}

export function AgentMemoryDetails({ agent, tab }: { agent: Agent; tab: AgentMemoryTab }) {
  const t = useT();
  const scope = agentMemoryScope(agent);
  const viewState = agentMemoryViewState(agent.memory, tab);
  const historical = viewState === 'historical';
  const advancedUnavailable = viewState === 'advanced-required';

  return (
    <div className="flex min-h-[32rem] flex-col">
      <div className="flex flex-wrap gap-2">
        {MEMORY_TABS.map((value) => (
          <Button
            key={value}
            onClick={() => replaceShellUrl(studioDetailPath('agents', agent.id, 'memory', value))}
            size="sm"
            variant={tab === value ? 'secondary' : 'ghost'}
          >
            {t(`web.studio.agentDetails.memoryTab.${value}`)}
          </Button>
        ))}
      </div>

      {historical ? (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm">
          <p className="font-medium">{t('web.memory.historicalTitle')}</p>
          <p className="mt-0.5 text-muted-foreground text-xs">{t('web.memory.historicalHint')}</p>
        </div>
      ) : null}

      <div className="mt-3 flex min-h-0 flex-1 overflow-hidden rounded-xl border">
        {advancedUnavailable ? (
          <DataEmpty
            hint={t('web.memory.agentAdvancedRequiredHint')}
            icon={tab === 'laws' ? JusticeScaleIcon : NeuralNetworkIcon}
            title={t('web.memory.agentAdvancedRequiredTitle')}
          />
        ) : tab === 'facts' ? (
          <ScopedFactsView
            readOnly
            scope={scope}
          />
        ) : tab === 'graph' ? (
          <GraphView scope={scope} />
        ) : (
          <LawsView scope={scope} />
        )}
      </div>
    </div>
  );
}
