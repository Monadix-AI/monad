import type { AgentId } from '@monad/protocol';

import { Edit02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetAgentQuery, useGetAppearanceQuery } from '@monad/client-rtk';
import { Badge, Button, Skeleton } from '@monad/ui';
import { AgentAvatar } from '@monad/ui/components/AgentAvatar';

import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { agentEditPath, studioDetailPath, studioPath } from '#/features/shell/routing/paths';
import { replaceShellUrl } from '#/hooks/use-shell-location';
import { agentCardAvatar } from '../agent-card-avatar';
import { StudioBreadcrumbHeader } from '../StudioBreadcrumbHeader';
import { AgentMemoryDetails } from './AgentMemoryDetails';
import { AgentSessions } from './AgentSessions';
import { type AgentSessionTab, parseAgentDetailsRoute } from './agent-details-route';

const SESSION_TABS: AgentSessionTab[] = ['chat', 'project', 'monadix'];

export function AgentDetails({ agentId, subpath }: { agentId: AgentId; subpath: readonly string[] }) {
  const t = useT();
  const agentQuery = useGetAgentQuery(agentId);
  const { data: appearance } = useGetAppearanceQuery();
  const route = parseAgentDetailsRoute(subpath);
  const agent = agentQuery.data?.agent;

  if (agentQuery.isLoading) {
    return (
      <PanelShell>
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-40 rounded" />
            <Skeleton className="h-4 w-56 rounded" />
          </div>
        </div>
        <PanelShellBody className="p-5">
          <Skeleton className="h-72 rounded-xl" />
        </PanelShellBody>
      </PanelShell>
    );
  }

  if (!agent) {
    return (
      <PanelShell>
        <StudioBreadcrumbHeader
          backHref={studioPath('agents')}
          parentTitle={t('web.studio.agents')}
          title={t('web.studio.agentDetails.notFound')}
        />
        <PanelShellBody className="flex items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <h2 className="font-medium">{t('web.studio.agentDetails.notFound')}</h2>
            <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.agentDetails.notFoundHint')}</p>
            <Button
              className="mt-4"
              onClick={() => replaceShellUrl(studioPath('agents'))}
              size="sm"
            >
              {t('web.studio.agentDetails.backToAgents')}
            </Button>
          </div>
        </PanelShellBody>
      </PanelShell>
    );
  }

  const selectedKind: AgentSessionTab = route.primary === 'sessions' ? route.secondary : 'chat';

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        actions={
          <Button
            onClick={() => replaceShellUrl(agentEditPath(agentId))}
            size="sm"
            variant="outline"
          >
            <HugeiconsIcon icon={Edit02Icon} />
            {t('web.studio.agentDetails.edit')}
          </Button>
        }
        backHref={studioPath('agents')}
        parentTitle={t('web.studio.agents')}
        title={agent.name}
      />

      <PanelShellBody className="overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-5">
          <section className="flex flex-wrap items-center gap-4 rounded-2xl border bg-card p-5">
            <AgentAvatar
              agent={agentCardAvatar(agent, appearance?.avatarStyle)}
              size={56}
            />
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-semibold text-xl">{agent.name}</h1>
              <p className="mt-1 truncate text-muted-foreground text-sm">
                {agent.model ?? agent.modelAlias ?? t('web.studio.modelInherit')}
              </p>
            </div>
            <Badge variant={agent.memory.enabled ? 'secondary' : 'outline'}>
              {t(
                agent.memory.enabled
                  ? 'web.studio.agentDetails.memoryEnabled'
                  : 'web.studio.agentDetails.memoryDisabled'
              )}
            </Badge>
          </section>

          <div
            className="flex gap-1"
            role="tablist"
          >
            <button
              aria-selected={route.primary === 'sessions'}
              className={
                route.primary === 'sessions'
                  ? 'rounded-md bg-secondary px-4 py-2 font-medium text-sm'
                  : 'rounded-md px-4 py-2 text-muted-foreground text-sm hover:bg-accent'
              }
              onClick={() => replaceShellUrl(studioDetailPath('agents', agentId, 'sessions', selectedKind))}
              role="tab"
              type="button"
            >
              {t('web.studio.agentDetails.sessions')}
            </button>
            <button
              aria-selected={route.primary === 'memory'}
              className={
                route.primary === 'memory'
                  ? 'rounded-md bg-secondary px-4 py-2 font-medium text-sm'
                  : 'rounded-md px-4 py-2 text-muted-foreground text-sm hover:bg-accent'
              }
              onClick={() => replaceShellUrl(studioDetailPath('agents', agentId, 'memory', 'facts'))}
              role="tab"
              type="button"
            >
              {t('web.studio.agentDetails.memory')}
            </button>
          </div>

          {route.primary === 'sessions' ? (
            <>
              <div className="flex flex-wrap gap-2">
                {SESSION_TABS.map((kind) => (
                  <Button
                    key={kind}
                    onClick={() => replaceShellUrl(studioDetailPath('agents', agentId, 'sessions', kind))}
                    size="sm"
                    variant={selectedKind === kind ? 'secondary' : 'ghost'}
                  >
                    {t(`web.studio.agentDetails.sessionTab.${kind}`)}
                  </Button>
                ))}
              </div>
              <AgentSessions
                agentId={agentId}
                kind={selectedKind}
              />
            </>
          ) : (
            <AgentMemoryDetails
              agent={agent}
              tab={route.secondary}
            />
          )}
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}
