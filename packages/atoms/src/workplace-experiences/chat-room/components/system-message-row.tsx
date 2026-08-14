import type { WorkplaceExperienceAgentIdentityResolver } from '@monad/sdk-experience';
import type { Message } from '../../experience/types.ts';
import type { WorkplaceExperienceHostAction } from '../../host-context.tsx';
import type { MessageRowLabels } from './message-row.tsx';

import { InformationCircleIcon, Mail01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tooltip, TooltipContent, TooltipTrigger, WorkspaceSystemEventCard } from '@monad/ui';
import { AgentInstanceAvatar, TagChip, uiFontFamily as uiFont } from '@monad/ui/components/AgentAvatar';
import { MemberIdentity } from '@monad/ui/components/MemberIdentity';

import { AgentProviderBadge } from '../../components/agent-provider-badge.tsx';

export const TIME_STYLE: React.CSSProperties = { fontFamily: uiFont, fontSize: 11, color: 'var(--muted-foreground)' };

export function SystemMessageRow({
  actions,
  labels,
  msg,
  onAgentClick,
  resolveAgentIdentity
}: {
  actions?: readonly WorkplaceExperienceHostAction[];
  labels?: MessageRowLabels;
  msg: Message;
  onAgentClick?: (id: string) => void;
  resolveAgentIdentity?: WorkplaceExperienceAgentIdentityResolver;
}): React.ReactElement {
  const actorIdentity = msg.agentChip
    ? resolveAgentIdentity?.({ id: msg.agentChip.id, name: msg.agentChip.name })
    : undefined;
  const developer = msg.kind === 'developer' || msg.developerOnly === true;
  const directMessageText =
    (msg.directMessage
      ? (labels?.directMessageSent?.(msg.directMessage.fromAgentName, msg.directMessage.toAgentName) ?? msg.text)
      : msg.systemEvent
        ? labels?.meshAgentSystemEvent?.(msg.systemEvent)
        : msg.text) ?? '';
  const detailTooltip =
    msg.systemPresentation === 'detail-tooltip' ? (
      <span
        className="inline-flex items-center gap-1.5"
        data-slot="system-message-detail-placeholder"
      >
        <span
          aria-hidden="true"
          className="h-px w-8 bg-border"
        />
        <span className="text-muted-foreground text-xs">{labels?.systemMessage ?? 'System message'}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={labels?.systemMessageDetails ?? msg.systemDetail}
              className="workplace-action inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={msg.systemDetail}
              type="button"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={InformationCircleIcon}
                size={14}
                strokeWidth={2}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent
            className="max-h-72 max-w-md overflow-y-auto whitespace-pre-wrap break-words text-left text-sm"
            side="top"
            sideOffset={6}
          >
            {msg.systemDetail}
          </TooltipContent>
        </Tooltip>
      </span>
    ) : null;
  const resolvedActions = msg.systemActions
    ?.map((reference) => {
      const action = actions?.find((candidate) => candidate.id === reference.actionId);
      return action ? { action, reference } : null;
    })
    .filter(
      (
        entry
      ): entry is {
        action: WorkplaceExperienceHostAction;
        reference: NonNullable<Message['systemActions']>[number];
      } => entry !== null
    );
  const inlineAction = resolvedActions?.find(
    ({ reference }) => Boolean(reference.inlineText) && directMessageText.includes(reference.inlineText ?? '')
  );
  const inlineText = inlineAction?.reference.inlineText;
  const inlineStart = inlineText ? directMessageText.indexOf(inlineText) : -1;
  return (
    <WorkspaceSystemEventCard
      actor={
        msg.agentChip ? (
          <button
            className="workplace-action inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 font-semibold text-foreground"
            onClick={() => onAgentClick?.(msg.agentChip?.id ?? '')}
            type="button"
          >
            <MemberIdentity
              agent={{
                ...msg.agentChip,
                av: actorIdentity?.av,
                avatarUrl: actorIdentity?.avatarUrl ?? msg.agentChip.avatarUrl,
                name:
                  actorIdentity?.name ??
                  (msg.agentChip.name === msg.agentChip.id ? (msg.agentChip.tag ?? '') : msg.agentChip.name)
              }}
              avatarSize={22}
              badge={actorIdentity?.providerIcon ? <AgentProviderBadge icon={actorIdentity.providerIcon} /> : undefined}
              badgeGap={4}
              bordered={false}
              nameStyle={{ maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            />
          </button>
        ) : undefined
      }
      badge={developer ? <TagChip tag="DEV" /> : undefined}
      body={
        detailTooltip ??
        (directMessageText ? (
          <span className="inline-flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="min-w-0 truncate">
              {inlineAction && inlineText && inlineStart >= 0 ? (
                <>
                  {directMessageText.slice(0, inlineStart)}
                  <button
                    className="workplace-action inline appearance-none border-0 bg-transparent p-0 font-[inherit] text-inherit underline-offset-2 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    disabled={inlineAction.action.disabled}
                    onClick={() => void inlineAction.action.run(inlineAction.reference.payload)}
                    type="button"
                  >
                    {directMessageText.slice(inlineStart, inlineStart + inlineText.length)}
                  </button>
                  {directMessageText.slice(inlineStart + inlineText.length)}
                </>
              ) : (
                directMessageText
              )}
            </span>
            {msg.directMessage ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={labels?.directMessageContent ?? msg.directMessage.text}
                    className="workplace-action inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={msg.directMessage.text}
                    type="button"
                  >
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={Mail01Icon}
                      size={14}
                      strokeWidth={2}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  className="max-w-sm whitespace-pre-wrap break-words text-left text-sm"
                  side="top"
                  sideOffset={6}
                >
                  {msg.directMessage.text}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {resolvedActions
              ?.filter((entry) => entry !== inlineAction)
              .map(({ action, reference }) => (
                <button
                  className="workplace-action inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-border bg-card px-2.5 font-semibold text-foreground text-xs hover:bg-accent"
                  disabled={action.disabled}
                  key={action.id}
                  onClick={() => void action.run(reference.payload)}
                  type="button"
                >
                  {action.label}
                </button>
              ))}
          </span>
        ) : undefined)
      }
      fanout={
        msg.fanoutAgents?.length ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
            {msg.fanoutAgents.map((agent) => {
              const identity = resolveAgentIdentity?.({ id: agent.id, name: agent.name });
              return (
                <AgentInstanceAvatar
                  agent={{
                    ...agent,
                    av: identity?.av,
                    avatarUrl: identity?.avatarUrl ?? agent.avatarUrl,
                    name: identity?.name ?? (agent.name === agent.id ? (agent.tag ?? '') : agent.name)
                  }}
                  bordered={false}
                  key={agent.id}
                  size={20}
                />
              );
            })}
          </span>
        ) : undefined
      }
      timestamp={msg.time ? <span style={TIME_STYLE}>{msg.time}</span> : undefined}
    />
  );
}
