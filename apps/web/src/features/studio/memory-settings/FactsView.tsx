import type { MemoryScopeQuery, ScopeKind } from '@monad/protocol';

import { DatabaseIcon } from '@hugeicons/core-free-icons';
import { useGetMemoryStatusQuery } from '@monad/client-rtk';
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { DataEmpty } from './DataEmpty';
import { Mem0Explorer } from './Mem0Explorer';
import { ScopedFactsView } from './ScopedFactsView';
import { Segmented } from './Segmented';

export function FactsView() {
  const t = useT();
  const { data: status } = useGetMemoryStatusQuery();
  const [scopeKind, setScopeKind] = useState<ScopeKind>('global');
  const [scopeId, setScopeId] = useState('');
  const effectiveId = (scopeKind === 'global' ? '*' : scopeId.trim()) as MemoryScopeQuery['scopeId'];
  const ready = scopeKind === 'global' || effectiveId.length > 0;
  const scope = ready ? ({ scopeKind, scopeId: effectiveId } satisfies MemoryScopeQuery) : undefined;
  const scopes: { value: ScopeKind; label: string }[] = [
    { value: 'global', label: t('web.memory.scopeGlobal') },
    { value: 'project', label: t('web.memory.scopeProject') },
    { value: 'agent', label: t('web.memory.scopeAgent') },
    { value: 'session', label: t('web.memory.scopeSession') }
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
        <Segmented
          onChange={(value) => {
            setScopeKind(value);
            setScopeId('');
          }}
          options={scopes}
          value={scopeKind}
        />
        {scopeKind === 'project' ? (
          <Select
            onValueChange={setScopeId}
            value={scopeId}
          >
            <SelectTrigger className="h-8 w-64">
              <SelectValue placeholder={t('web.memory.pickProject')} />
            </SelectTrigger>
            <SelectContent>
              {(status?.projects ?? []).map((project) => (
                <SelectItem
                  key={project.key}
                  value={project.key}
                >
                  {project.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : scopeKind === 'agent' || scopeKind === 'session' ? (
          <Input
            className="h-8 w-56 font-ui text-xs"
            onChange={(event) => setScopeId(event.target.value)}
            placeholder={scopeKind === 'agent' ? 'agt_…' : 'ses_…'}
            value={scopeId}
          />
        ) : null}
      </div>

      {scope ? (
        <>
          <ScopedFactsView
            readOnly={false}
            scope={scope}
          />
          {(status?.backend ?? 'builtin') === 'mem0' && status?.mem0.ready ? <Mem0Explorer /> : null}
        </>
      ) : (
        <DataEmpty
          icon={DatabaseIcon}
          title={
            scopeKind === 'project'
              ? t('web.memory.pickProject')
              : scopeKind === 'agent'
                ? t('web.memory.enterScopeAgent')
                : t('web.memory.enterScopeSession')
          }
        />
      )}
    </div>
  );
}
