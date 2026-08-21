import type { Participant } from '../../../experience/types.ts';
import type { MonadMcpToolName } from './monad-mcp-projection.ts';

import { CheckmarkCircle02Icon, CircleIcon, InboxIcon, MailOpenIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';
import { MentionText } from '@monad/ui/components/MentionText';

import { MonadMcpAgentIdentity } from './monad-mcp-agent-identity.tsx';

type SemanticOutputProps = {
  emptyLabel: string;
  falseLabel: string;
  memberIdentities?: ReadonlyMap<string, Participant>;
  output: unknown;
  toolName: MonadMcpToolName;
  trueLabel: string;
};

const RECEIPT_TOOLS: readonly MonadMcpToolName[] = ['project_post', 'project_ask', 'project_inbox_ack', 'agent_send'];

export function monadMcpSemanticOutput(props: SemanticOutputProps): React.ReactNode | undefined {
  if (RECEIPT_TOOLS.includes(props.toolName)) {
    const record = recordValue(props.output);
    if (!record || !hasReceiptContent(record)) return undefined;
    return <MonadMcpReceipt {...props} />;
  }
  switch (props.toolName) {
    case 'project_inbox_check':
    case 'agent_read':
      return (
        <MonadMcpInbox
          emptyLabel={props.emptyLabel}
          output={props.output}
        />
      );
    case 'session_members':
      return (
        <MonadMcpMembers
          emptyLabel={props.emptyLabel}
          memberIdentities={props.memberIdentities}
          output={props.output}
        />
      );
    case 'runtime_info':
      return (
        <MonadMcpRuntime
          emptyLabel={props.emptyLabel}
          output={props.output}
        />
      );
    default:
      return undefined;
  }
}

function MonadMcpReceipt({ emptyLabel, falseLabel, output, trueLabel }: SemanticOutputProps) {
  const record = recordValue(output);
  if (!record) return output === undefined ? <EmptyState label={emptyLabel} /> : undefined;
  const message = recordValue(record.message);
  const fields = receiptFields(message ?? record);
  const confirmation = Object.entries(record).find(
    (entry): entry is [string, boolean] =>
      ['accepted', 'delivered', 'acknowledged'].includes(entry[0]) && typeof entry[1] === 'boolean'
  );
  const status = typeof record.status === 'string' ? record.status : undefined;
  if (fields.length === 0 && confirmation === undefined && !status) return undefined;
  return (
    <div
      className="flex min-w-0 items-start gap-3 rounded-lg bg-secondary/30 px-3 py-2.5"
      data-slot="monad-mcp-receipt"
    >
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-success/12 text-success">
        <HugeiconsIcon
          aria-hidden="true"
          className="size-4"
          icon={CheckmarkCircle02Icon}
        />
      </span>
      <div className="min-w-0 flex-1">
        {confirmation || status ? (
          <div className="mb-1.5 flex min-w-0 items-center gap-2">
            {confirmation ? (
              <span className="text-foreground">
                <span className="text-muted-foreground">{friendlyOutputKey(confirmation[0])}</span>{' '}
                <span className="font-medium">{confirmation[1] ? trueLabel : falseLabel}</span>
              </span>
            ) : null}
            {status ? <StatusBadge status={status} /> : null}
          </div>
        ) : null}
        {fields.length > 0 ? <MetadataFields fields={fields} /> : null}
      </div>
    </div>
  );
}

function MonadMcpInbox({ emptyLabel, output }: { emptyLabel: string; output: unknown }) {
  const record = recordValue(output);
  const messages = Array.isArray(record?.messages)
    ? record.messages.flatMap(messageRecord)
    : Array.isArray(record?.items)
      ? record.items.flatMap(inboxItemRecord)
      : [];
  if (messages.length === 0)
    return (
      <EmptyState
        icon={InboxIcon}
        label={emptyLabel}
      />
    );
  return (
    <div
      className="overflow-hidden rounded-lg border border-border/70 bg-card/35"
      data-slot="monad-mcp-inbox"
    >
      {messages.map((message, index) => (
        <article
          className="min-w-0 border-border/60 border-b px-3 py-2.5 last:border-b-0"
          data-slot="monad-mcp-inbox-message"
          key={message.id ?? `${message.from ?? 'message'}:${index}`}
        >
          <div className="flex min-w-0 items-start gap-2">
            {message.from ? (
              <MonadMcpAgentIdentity
                agentName={message.agentName}
                className="min-w-0 flex-1"
                name={message.from}
                size={28}
              />
            ) : (
              <span className="grid size-7 place-items-center rounded-md bg-secondary/60 text-muted-foreground">
                <HugeiconsIcon
                  aria-hidden="true"
                  className="size-4"
                  icon={MailOpenIcon}
                />
              </span>
            )}
            {message.meta ? (
              <span className="ml-auto shrink-0 font-ui text-[10px] text-muted-foreground">{message.meta}</span>
            ) : null}
          </div>
          <div className="wrap-anywhere mt-0.5 ml-[2.375rem] whitespace-pre-wrap text-foreground leading-5">
            <MentionText text={message.text} />
          </div>
        </article>
      ))}
      {typeof record?.cursor === 'number' ? (
        <div className="border-border/60 border-t px-3 py-1.5 text-right font-ui text-[10px] text-muted-foreground">
          {friendlyOutputKey('cursor')} {record.cursor}
        </div>
      ) : null}
    </div>
  );
}

function inboxItemRecord(value: unknown) {
  const item = recordValue(value);
  const message = recordValue(item?.message);
  if (!message) return messageRecord(value);
  return messageRecord({
    ...message,
    createdAt: message.createdAt ?? item?.createdAt,
    ingressSeq: message.ingressSeq ?? item?.ingressSeq
  });
}

function MonadMcpMembers({
  emptyLabel,
  memberIdentities,
  output
}: {
  emptyLabel: string;
  memberIdentities?: ReadonlyMap<string, Participant>;
  output: unknown;
}) {
  const record = recordValue(output);
  const members = Array.isArray(record?.members) ? record.members.flatMap(memberRecord) : [];
  if (members.length === 0) return <EmptyState label={emptyLabel} />;
  return (
    <div
      className="overflow-hidden rounded-lg border border-border/70 bg-card/35"
      data-slot="monad-mcp-members"
    >
      {members.map((member, index) => {
        const identity = member.id ? memberIdentities?.get(member.id) : undefined;
        return (
          <div
            className="flex min-w-0 items-center gap-2.5 border-border/60 border-b px-3 py-2.5 last:border-b-0"
            data-slot="monad-mcp-member"
            key={member.id ?? `${member.name}:${index}`}
          >
            <MonadMcpAgentIdentity
              agentName={identity?.metadata?.agent ?? member.agentName}
              av={identity?.av}
              avatarUrl={identity?.avatarUrl}
              className="min-w-0 flex-1"
              name={identity?.name ?? member.name}
              size={28}
            />
            {member.status ? (
              <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
                <HugeiconsIcon
                  aria-hidden="true"
                  className={cn(
                    'size-2 fill-current',
                    activeStatus(member.status) ? 'text-success' : 'text-muted-foreground'
                  )}
                  icon={CircleIcon}
                />
                {member.status}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function MonadMcpRuntime({ emptyLabel, output }: { emptyLabel: string; output: unknown }) {
  const record = recordValue(output);
  if (!record) return <EmptyState label={emptyLabel} />;
  const headline = stringValue(record.agent) ?? stringValue(record.name) ?? stringValue(record.provider);
  const fields = Object.entries(record).flatMap(([key, value]) => {
    if (key === 'agent' || key === 'name' || value === undefined || value === null) return [];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
    return [{ key, value: String(value) }];
  });
  if (!headline && fields.length === 0) return <EmptyState label={emptyLabel} />;
  return (
    <div
      className="overflow-hidden rounded-lg border border-border/70 bg-card/35"
      data-slot="monad-mcp-runtime"
    >
      {headline ? (
        <div className="flex min-w-0 items-center gap-2.5 border-border/60 border-b px-3 py-2.5">
          <MonadMcpAgentIdentity
            agentName={stringValue(record.agentName) ?? stringValue(record.provider)}
            name={headline}
            size={28}
          />
        </div>
      ) : null}
      {fields.length > 0 ? (
        <MetadataFields
          className="px-3 py-2.5"
          fields={fields}
        />
      ) : null}
    </div>
  );
}

function MetadataFields({ className, fields }: { className?: string; fields: { key: string; value: string }[] }) {
  return (
    <dl className={cn('grid min-w-0 gap-y-1.5', className)}>
      {fields.map((field) => (
        <div
          className="grid min-w-0 grid-cols-[minmax(5.5rem,6.5rem)_minmax(0,1fr)] gap-x-3"
          data-slot="monad-mcp-semantic-field"
          key={field.key}
        >
          <dt
            className="text-muted-foreground"
            data-slot="monad-mcp-semantic-field-label"
          >
            {friendlyOutputKey(field.key)}
          </dt>
          <dd
            className="wrap-anywhere min-w-0 font-ui text-foreground text-xs"
            data-slot="monad-mcp-semantic-field-value"
          >
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'rounded-md bg-secondary px-1.5 py-0.5 font-medium text-muted-foreground text-xs',
        activeStatus(status) && 'bg-info/10 text-info'
      )}
    >
      {status}
    </span>
  );
}

function EmptyState({ icon = InboxIcon, label }: { icon?: typeof InboxIcon; label: string }) {
  return (
    <div className="flex min-h-16 items-center justify-center gap-2 rounded-lg border border-border/70 border-dashed text-muted-foreground">
      <HugeiconsIcon
        aria-hidden="true"
        className="size-4"
        icon={icon}
      />
      <span>{label}</span>
    </div>
  );
}

function receiptFields(record: Record<string, unknown>): { key: string; value: string }[] {
  return Object.entries(record).flatMap(([key, value]) => {
    if (['text', 'accepted', 'delivered', 'acknowledged', 'status', 'attachments'].includes(key)) return [];
    if (typeof value !== 'string' && typeof value !== 'number') return [];
    return [{ key: key === 'id' ? 'messageId' : key, value: String(value) }];
  });
}

function hasReceiptContent(record: Record<string, unknown>): boolean {
  const message = recordValue(record.message);
  return (
    receiptFields(message ?? record).length > 0 ||
    typeof record.status === 'string' ||
    ['accepted', 'delivered', 'acknowledged'].some((key) => typeof record[key] === 'boolean')
  );
}

function messageRecord(
  value: unknown
): { agentName?: string; from?: string; id?: string; meta?: string; text: string }[] {
  const record = recordValue(value);
  if (!record || typeof record.text !== 'string') return [];
  const data = recordValue(record.data);
  const from = [
    data?.agentDisplayName,
    data?.displayName,
    record.from,
    record.author,
    record.displayName,
    record.name
  ].find((entry): entry is string => typeof entry === 'string');
  const agentName = [data?.agentName, record.agentName, record.provider].find(
    (entry): entry is string => typeof entry === 'string'
  );
  const id = [record.id, record.messageId].find((entry): entry is string => typeof entry === 'string');
  const meta = [record.createdAt, record.sentAt, record.ingressSeq].find(
    (entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number'
  );
  return [
    {
      ...(from ? { from } : {}),
      ...(agentName ? { agentName } : {}),
      ...(id ? { id } : {}),
      ...(meta !== undefined ? { meta: String(meta) } : {}),
      text: record.text
    }
  ];
}

function memberRecord(value: unknown): { agentName?: string; id?: string; name: string; status?: string }[] {
  const record = recordValue(value);
  if (!record) return [];
  const name = [record.displayName, record.name, record.id].find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
  if (!name) return [];
  const agentName = [record.productIcon, record.provider, record.agentName, record.name].find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
  return [
    {
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      ...(agentName ? { agentName } : {}),
      name,
      ...(typeof record.status === 'string' ? { status: record.status } : {})
    }
  ];
}

function activeStatus(status: string): boolean {
  return ['active', 'online', 'running', 'pending', 'in_progress'].includes(status.trim().toLowerCase());
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function friendlyOutputKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => (part.toLowerCase() === 'id' ? 'ID' : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`))
    .join(' ');
}
