import type { OptionalMemoryScopeQuery } from '@monad/protocol';

import { agentSelectors, useListAgentsQuery } from '@monad/client-rtk';
import { agentIdSchema } from '@monad/protocol';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';

import { useT } from '#/components/I18nProvider';

const ALL = '__all__';

export function memoryDataScopeForSelection(value: string): OptionalMemoryScopeQuery | undefined {
  return value === ALL ? undefined : { scopeKind: 'agent', scopeId: agentIdSchema.parse(value) };
}

export function MemoryDataScopePicker({
  onChange,
  value
}: {
  onChange: (scope: OptionalMemoryScopeQuery | undefined) => void;
  value?: OptionalMemoryScopeQuery;
}) {
  const t = useT();
  const { data } = useListAgentsQuery();
  const agents = data ? agentSelectors.selectAll(data) : [];
  const selected = value?.scopeKind === 'agent' ? value.scopeId : ALL;

  return (
    <Select
      onValueChange={(agentId) => onChange(memoryDataScopeForSelection(agentId))}
      value={selected}
    >
      <SelectTrigger className="h-8 w-52">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t('web.memory.scopeAll')}</SelectItem>
        {agents.map((agent) => (
          <SelectItem
            key={agent.id}
            value={agent.id}
          >
            {agent.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
