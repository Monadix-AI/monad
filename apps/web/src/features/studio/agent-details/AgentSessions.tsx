import type { AgentId, Session, SessionState } from '@monad/protocol';
import type { AgentSessionTab } from './agent-details-route';

import { ArrowLeft01Icon, ArrowRight01Icon, Calendar03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { sessionSelectors, useListSessionsQuery } from '@monad/client-rtk';
import { Badge, Button, Skeleton } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { projectSessionPath, sessionPath } from '#/features/shell/routing/paths';
import { replaceShellUrl } from '#/hooks/use-shell-location';

const PAGE_SIZE = 25;
const SESSION_SKELETON_KEYS = ['first', 'second', 'third', 'fourth'];

function sessionStateLabel(state: SessionState, t: ReturnType<typeof useT>): string {
  if (state === 'active') return t('web.studio.agentDetails.sessionState.active');
  if (state === 'paused') return t('web.studio.agentDetails.sessionState.paused');
  if (state === 'completed') return t('web.studio.agentDetails.sessionState.completed');
  if (state === 'cancelled') return t('web.studio.agentDetails.sessionState.cancelled');
  return t('web.studio.agentDetails.sessionState.failed');
}

function openSession(session: Session): void {
  replaceShellUrl(session.projectId ? projectSessionPath(session.projectId, session.id) : sessionPath(session.id));
}

export function AgentSessions({ agentId, kind }: { agentId: AgentId; kind: AgentSessionTab }) {
  const t = useT();
  const [page, setPage] = useState<{ kind: AgentSessionTab; offset: number }>({ kind, offset: 0 });
  const offset = page.kind === kind ? page.offset : 0;
  const query = useListSessionsQuery({ agentId, kind, limit: PAGE_SIZE, offset });
  const sessions = sessionSelectors.selectAll(query.data?.sessions ?? { ids: [], entities: {} });
  const total = query.data?.total ?? 0;

  if (query.isLoading) {
    return (
      <div
        aria-busy="true"
        className="flex flex-col gap-2"
      >
        {SESSION_SKELETON_KEYS.map((key) => (
          <Skeleton
            className="h-20 rounded-xl"
            key={key}
          />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center text-sm">
        <p className="font-medium text-destructive">{t('web.studio.agentDetails.sessionsError')}</p>
        <Button
          className="mt-3"
          onClick={() => void query.refetch()}
          size="sm"
          variant="outline"
        >
          {t('web.studio.agentDetails.retry')}
        </Button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="font-medium text-sm">{t(`web.studio.agentDetails.empty.${kind}`)}</p>
        <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.agentDetails.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-2">
        {sessions.map((session) => (
          <button
            className="flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/50"
            key={session.id}
            onClick={() => openSession(session)}
            type="button"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Calendar03Icon} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-sm">{session.title}</span>
              <span className="mt-1 block text-muted-foreground text-xs">
                {t('web.studio.agentDetails.lastActivity', {
                  date: new Date(session.activityAt ?? session.updatedAt).toLocaleString()
                })}
              </span>
            </span>
            <Badge variant="secondary">{sessionStateLabel(session.state, t)}</Badge>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <span className="text-muted-foreground text-xs">
          {t('web.studio.agentDetails.sessionCount', { count: total })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            disabled={offset === 0}
            onClick={() => setPage({ kind, offset: Math.max(0, offset - PAGE_SIZE) })}
            size="sm"
            variant="outline"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} />
            {t('web.studio.agentDetails.previous')}
          </Button>
          <Button
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setPage({ kind, offset: offset + PAGE_SIZE })}
            size="sm"
            variant="outline"
          >
            {t('web.common.next')}
            <HugeiconsIcon icon={ArrowRight01Icon} />
          </Button>
        </div>
      </div>
    </div>
  );
}
