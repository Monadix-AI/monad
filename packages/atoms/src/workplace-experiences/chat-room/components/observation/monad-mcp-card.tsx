import type { MonadMcpToolView } from './monad-mcp-projection.ts';

import { ObservationMeta } from '@monad/ui';

import { workplaceExperienceT } from '../../../i18n.ts';
import { MonadMcpOutput } from './monad-mcp-output.tsx';

export function MonadMcpToolHeader({ quiet = false, view }: { quiet?: boolean; view: MonadMcpToolView }) {
  const t = workplaceExperienceT();
  return (
    <ObservationMeta
      compact
      quiet={quiet}
      source="monad"
      title={monadMcpActionTitle(view, t)}
    >
      {view.status || view.isError ? <span className="sr-only">{monadMcpDisplayedStatus(view, t)}</span> : null}
      {view.durationMs === undefined ? null : <span>{view.durationMs}ms</span>}
    </ObservationMeta>
  );
}

export function MonadMcpToolCard({ view }: { view: MonadMcpToolView }) {
  const t = workplaceExperienceT();
  return (
    <div className="min-w-0 py-0.5 text-sm leading-5">
      <MonadMcpOutput
        body={view.action === 'project-post' ? view.text : undefined}
        completedLabel={t('web.plan.statusCompleted')}
        emptyLabel={t('web.workplace.monadMcp.empty')}
        falseLabel={t('web.workplace.monadMcp.no')}
        inProgressLabel={t('web.plan.statusInProgress')}
        output={view.output}
        pendingLabel={t('web.plan.statusPending')}
        planEmptyLabel={t('web.plan.empty')}
        toolName={view.toolName}
        trueLabel={t('web.workplace.monadMcp.yes')}
      />
    </div>
  );
}

function monadMcpActionTitle(view: MonadMcpToolView, t: ReturnType<typeof workplaceExperienceT>): string {
  switch (view.action) {
    case 'project-post':
      return t('web.workplace.monadMcp.action.projectPost');
    case 'project-ask':
      return t('web.workplace.monadMcp.action.projectAsk');
    case 'project-read':
      return t('web.workplace.monadMcp.action.projectRead');
    case 'project-inbox-check':
      return t('web.workplace.monadMcp.action.projectInboxCheck');
    case 'project-inbox-ack':
      return t('web.workplace.monadMcp.action.projectInboxAck');
    case 'agent-send':
      return t('web.workplace.monadMcp.action.agentSend');
    case 'agent-read':
      return t('web.workplace.monadMcp.action.agentRead');
    case 'session-members':
      return t('web.workplace.monadMcp.action.sessionMembers');
    case 'runtime-info':
      return t('web.workplace.monadMcp.action.runtimeInfo');
    case 'project-plan-list':
      return t('web.workplace.monadMcp.action.projectPlanList');
    case 'project-plan-add':
      return t('web.workplace.monadMcp.action.projectPlanAdd');
    case 'project-plan-update':
      return t('web.workplace.monadMcp.action.projectPlanUpdate');
    case 'project-plan-delete':
      return t('web.workplace.monadMcp.action.projectPlanDelete');
  }
}

function monadMcpStatus(status: string, t: ReturnType<typeof workplaceExperienceT>): string {
  switch (status.trim().toLowerCase()) {
    case 'running':
    case 'inprogress':
    case 'in_progress':
    case 'started':
      return t('web.workplace.monadMcp.status.running');
    case 'completed':
      return t('web.workplace.monadMcp.status.completed');
    case 'failed':
      return t('web.workplace.monadMcp.status.failed');
    case 'error':
      return t('web.workplace.monadMcp.status.error');
    default:
      return status;
  }
}

function monadMcpDisplayedStatus(view: MonadMcpToolView, t: ReturnType<typeof workplaceExperienceT>): string {
  const status = view.status?.trim().toLowerCase();
  if (view.isError && status !== 'failed' && status !== 'error') return t('web.workplace.monadMcp.status.error');
  return view.status ? monadMcpStatus(view.status, t) : t('web.workplace.monadMcp.status.error');
}
