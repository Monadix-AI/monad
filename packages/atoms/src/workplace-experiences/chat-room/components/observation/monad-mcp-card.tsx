import type { Participant } from '../../../experience/types.ts';
import type { MonadMcpToolView } from './monad-mcp-projection.ts';

import { ObservationMeta } from '@monad/ui';

import { workplaceExperienceLocale, workplaceExperienceT } from '../../../i18n.ts';
import { MonadMcpAgentIdentity } from './monad-mcp-agent-identity.tsx';
import { MonadMcpAttachmentList } from './monad-mcp-attachment-card.tsx';
import { MonadMcpMessageList } from './monad-mcp-message-list.tsx';
import { MonadMcpOutput } from './monad-mcp-output.tsx';
import { MonadMcpQuestionList } from './monad-mcp-question-list.tsx';

export function MonadMcpToolHeader({
  memberIdentities,
  quiet = false,
  view
}: {
  memberIdentities?: ReadonlyMap<string, Participant>;
  quiet?: boolean;
  view: MonadMcpToolView;
}) {
  const t = workplaceExperienceT();
  const recipient = view.action === 'agent-send' && view.to ? memberIdentities?.get(view.to) : undefined;
  const actionTitle = monadMcpActionTitle(view, t, Boolean(recipient));
  return (
    <ObservationMeta
      compact
      quiet={quiet}
      source="monad"
      title={
        view.action === 'agent-send' && recipient ? (
          <MonadMcpAgentSendTitle
            action={actionTitle}
            recipient={recipient}
          />
        ) : (
          actionTitle
        )
      }
    >
      {view.status || view.isError ? <span className="sr-only">{monadMcpDisplayedStatus(view, t)}</span> : null}
      {view.durationMs === undefined ? null : <span>{view.durationMs}ms</span>}
    </ObservationMeta>
  );
}

export function MonadMcpToolCard({
  memberIdentities,
  view
}: {
  memberIdentities?: ReadonlyMap<string, Participant>;
  view: MonadMcpToolView;
}) {
  const t = workplaceExperienceT();
  const locale = workplaceExperienceLocale();
  if (view.action === 'project-read' && view.messages !== undefined) {
    return (
      <div className="min-w-0 py-0.5 text-sm leading-5">
        <MonadMcpMessageList
          agentFallback={t('web.workplace.monadMcp.agentFallback')}
          emptyLabel={t('web.workplace.monadMcp.empty')}
          locale={locale}
          messages={view.messages}
          userFallback={t('web.chat.you')}
        />
      </div>
    );
  }
  return (
    <div className="min-w-0 py-0.5 text-sm leading-5">
      {view.action === 'project-ask' ? <MonadMcpQuestionList view={view} /> : null}
      {view.action !== 'project-ask' || view.output !== undefined ? (
        <MonadMcpOutput
          body={view.action === 'project-post' || view.action === 'agent-send' ? view.text : undefined}
          completedLabel={t('web.plan.statusCompleted')}
          emptyLabel={t('web.workplace.monadMcp.empty')}
          falseLabel={t('web.workplace.monadMcp.no')}
          inProgressLabel={t('web.plan.statusInProgress')}
          memberIdentities={memberIdentities}
          omitAttachments={view.action === 'project-post' || view.action === 'agent-send'}
          output={view.output}
          pendingLabel={t('web.plan.statusPending')}
          planEmptyLabel={t('web.plan.empty')}
          toolName={view.toolName}
          trueLabel={t('web.workplace.monadMcp.yes')}
        />
      ) : null}
      {view.action === 'project-post' || view.action === 'agent-send' ? (
        <MonadMcpAttachmentList
          attachments={view.attachments}
          locale={locale}
        />
      ) : null}
    </div>
  );
}

function monadMcpActionTitle(
  view: MonadMcpToolView,
  t: ReturnType<typeof workplaceExperienceT>,
  hasResolvedRecipient = false
): string {
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
      return hasResolvedRecipient
        ? t('web.workplace.monadMcp.action.agentSendTo')
        : t('web.workplace.monadMcp.action.agentSend');
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

function MonadMcpAgentSendTitle({ action, recipient }: { action: string; recipient: Participant }) {
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5"
      data-slot="monad-mcp-recipient"
    >
      <span className="shrink-0">{action}</span>
      <MonadMcpAgentIdentity
        agentName={recipient.metadata?.agent}
        av={recipient.av}
        avatarUrl={recipient.avatarUrl}
        className="min-w-0 gap-1.5 text-xs normal-case"
        icon={recipient.icon}
        identityClassName="font-normal"
        name={recipient.name}
        size={18}
      />
    </span>
  );
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
