import type { MonadMcpAttachment, MonadMcpToolView } from './monad-mcp-projection.ts';

import { ObservationMeta, ObservationText } from '@monad/ui';

import { workspaceExperienceT } from '../../../i18n.ts';

export function MonadMcpToolHeader({ view }: { view: MonadMcpToolView }) {
  const t = workspaceExperienceT();
  return (
    <ObservationMeta
      compact
      source="monad"
      title={monadMcpActionTitle(view, t)}
    >
      {'threadId' in view && view.threadId ? (
        <span>{`${t('web.workplace.monadMcp.thread')}: ${view.threadId}`}</span>
      ) : null}
      {'to' in view || 'with' in view ? (
        <span>{`${t('web.workplace.monadMcp.recipient')}: ${monadMcpTarget(view, t)}`}</span>
      ) : null}
      {view.status || view.isError ? <span>{monadMcpDisplayedStatus(view, t)}</span> : null}
      {view.durationMs === undefined ? null : <span>{view.durationMs}ms</span>}
    </ObservationMeta>
  );
}

export function MonadMcpToolCard({ view }: { view: MonadMcpToolView }) {
  const t = workspaceExperienceT();
  return (
    <div className="grid gap-2">
      <div className="grid gap-1.5 rounded-md border border-border/70 bg-secondary/35 p-2 text-xs">
        {monadMcpFields(view, t)}
      </div>
      {view.output === undefined ? null : (
        <div className="grid gap-1">
          <span className="font-medium text-muted-foreground text-xs">{t('web.workplace.monadMcp.result')}</span>
          <ObservationText
            contained
            observationRole="tool"
            text={structuredText(view.output)}
          />
        </div>
      )}
    </div>
  );
}

function monadMcpFields(view: MonadMcpToolView, t: ReturnType<typeof workspaceExperienceT>): React.ReactNode {
  const fields: React.ReactNode[] = [];
  const add = (label: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return;
    fields.push(
      <MonadMcpField
        key={label}
        label={label}
        value={String(value)}
      />
    );
  };
  const addReadBounds = (): void => {
    if (!('before' in view)) return;
    add(t('web.workplace.monadMcp.before'), view.before);
    add(t('web.workplace.monadMcp.after'), view.after);
    if ('around' in view) add(t('web.workplace.monadMcp.around'), view.around);
    add(t('web.workplace.monadMcp.limit'), view.limit);
  };

  switch (view.action) {
    case 'project-post':
      add(t('web.workplace.monadMcp.message'), view.text);
      add(t('web.workplace.monadMcp.thread'), view.threadId);
      addAttachments(fields, view.attachments, t);
      break;
    case 'project-ask':
      add(t('web.workplace.monadMcp.question'), view.question);
      if (view.options.length > 0) add(t('web.workplace.monadMcp.options'), view.options.join(', '));
      if (view.mode) add(t('web.workplace.monadMcp.mode'), view.mode);
      if (view.allowOther !== undefined)
        add(t('web.workplace.monadMcp.allowOther'), monadMcpBoolean(view.allowOther, t));
      break;
    case 'project-read':
      add(t('web.workplace.monadMcp.thread'), view.threadId);
      addReadBounds();
      break;
    case 'project-inbox-ack':
      add(t('web.workplace.monadMcp.cursor'), view.cursor);
      break;
    case 'agent-send':
      add(t('web.workplace.monadMcp.recipient'), monadMcpTarget(view, t));
      add(t('web.workplace.monadMcp.message'), view.text);
      addAttachments(fields, view.attachments, t);
      break;
    case 'agent-read':
      add(t('web.workplace.monadMcp.recipient'), monadMcpTarget(view, t));
      addReadBounds();
      break;
  }
  return fields;
}

function MonadMcpField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="wrap-anywhere text-foreground">{value}</span>
    </div>
  );
}

function addAttachments(
  fields: React.ReactNode[],
  attachments: readonly MonadMcpAttachment[],
  t: ReturnType<typeof workspaceExperienceT>
): void {
  if (attachments.length === 0) return;
  fields.push(
    <MonadMcpField
      key="attachments"
      label={t('web.workplace.monadMcp.attachments')}
      value={attachments.map(attachmentText).join(', ')}
    />
  );
}

function attachmentText(attachment: MonadMcpAttachment): string {
  const name = attachment.name ?? attachment.path.split('/').filter(Boolean).at(-1) ?? attachment.path;
  return attachment.mime ? `${name} (${attachment.mime})` : name;
}

function monadMcpActionTitle(view: MonadMcpToolView, t: ReturnType<typeof workspaceExperienceT>): string {
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
      return t('web.workplace.monadMcp.action.agentSend', { target: monadMcpTarget(view, t) });
    case 'agent-read':
      return t('web.workplace.monadMcp.action.agentRead', { target: monadMcpTarget(view, t) });
    case 'session-members':
      return t('web.workplace.monadMcp.action.sessionMembers');
    case 'runtime-info':
      return t('web.workplace.monadMcp.action.runtimeInfo');
  }
}

function monadMcpTarget(view: MonadMcpToolView, t: ReturnType<typeof workspaceExperienceT>): string {
  if (view.action === 'agent-send') return view.to ?? t('web.workplace.monadMcp.agentFallback');
  if (view.action === 'agent-read') return view.with ?? t('web.workplace.monadMcp.agentFallback');
  return t('web.workplace.monadMcp.agentFallback');
}

function monadMcpStatus(status: string, t: ReturnType<typeof workspaceExperienceT>): string {
  switch (status.trim().toLowerCase()) {
    case 'running':
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

function monadMcpDisplayedStatus(view: MonadMcpToolView, t: ReturnType<typeof workspaceExperienceT>): string {
  const status = view.status?.trim().toLowerCase();
  if (view.isError && status !== 'failed' && status !== 'error') return t('web.workplace.monadMcp.status.error');
  return view.status ? monadMcpStatus(view.status, t) : t('web.workplace.monadMcp.status.error');
}

function monadMcpBoolean(value: boolean, t: ReturnType<typeof workspaceExperienceT>): string {
  return value ? t('web.workplace.monadMcp.yes') : t('web.workplace.monadMcp.no');
}

function structuredText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
