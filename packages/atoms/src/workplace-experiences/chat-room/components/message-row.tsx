import type { ChannelIcon } from '@monad/protocol';
import type { ChannelOriginDetail, ChannelOriginLabels } from '@monad/ui';
import type { ComponentType } from 'react';
import type { Message, MessageAttachment } from '../../experience/types.ts';
import type { WorkplaceExperienceHostAction } from '../../host-context.tsx';

import { MessageCircleReplyIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ChannelOriginBadge,
  channelOriginDetails,
  FaviconLink,
  showsChannelOrigin,
  WorkspaceMessageCard
} from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  Avatar,
  workspaceMono as mono,
  resolveProductIcon,
  workspaceSans as sans,
  TagChip
} from '@monad/ui/components/AgentAvatar';
import { FileIcon } from '@monad/ui/components/FileIcon';
import { type Components, Markdown } from '@monad/ui/components/Markdown';
import { MentionCapsule, MentionText, parseMentionTokens } from '@monad/ui/components/MentionText';
import { memo, useMemo } from 'react';

import { resolveLocalFileReference } from '../utils/local-file-reference.ts';
import { ProjectQuestionMessage } from './project-question-message.tsx';
import { ReplyPreview } from './reply-preview.tsx';
import { SystemMessageRow, TIME_STYLE } from './system-message-row.tsx';

export type MessageRowLabels = {
  directMessageContent?: string;
  directMessageSent?: (from: string, to: string) => string;
  systemMessage?: string;
  systemMessageDetails?: string;
  observe?: string;
  reply?: string;
  replyUnavailable?: string;
  retry?: string;
  sentFrom?: string;
  originConversation?: string;
  originDirectMessage?: string;
  originGroup?: string;
  originChannel?: string;
  originSender?: string;
  originThread?: string;
  originInstance?: string;
  originVersion?: string;
  waitingForResponse?: string;
  working?: string;
};

export type MessageAttachmentComponent = ComponentType<{
  attachment: MessageAttachment;
  onPreview?: (attachment: MessageAttachment, line?: number) => void;
}>;

const NAME_STYLE: React.CSSProperties = { fontFamily: sans, fontSize: 14, fontWeight: 600 };
const RETRY_BUTTON_STYLE: React.CSSProperties = {
  alignItems: 'center',
  background: 'var(--destructive)',
  border: 0,
  borderRadius: 999,
  color: 'var(--destructive-foreground)',
  display: 'inline-flex',
  flex: 'none',
  fontFamily: mono,
  fontSize: 12,
  fontWeight: 800,
  height: 22,
  justifyContent: 'center',
  lineHeight: 1,
  marginRight: 8,
  width: 22
};
const MESSAGE_MARKDOWN_CSS = `
  .workplace-message-markdown {
    color: inherit;
    font-size: inherit;
    font-weight: inherit;
    line-height: inherit;
    max-width: 100%;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

.workplace-message-markdown :where(p, li, blockquote, table, th, td, code, pre) {
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
}

.workplace-message-markdown p {
  margin-block: 0;
}

  .workplace-message-markdown :not(pre) > code {
    -webkit-box-decoration-break: clone;
    border: 0;
    border-radius: 7px;
    background: color-mix(in srgb, currentColor 10%, transparent);
    box-decoration-break: clone;
    padding: 0.08em 0.42em;
    font-family: ${mono};
    font-size: 0.9em;
    font-weight: 500;
    overflow-wrap: break-word;
    white-space: normal;
    word-break: normal;
  }

.workplace-message-markdown pre code {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
  white-space: pre;
}

.workplace-message-markdown p:first-child {
  margin-top: 0;
}

.workplace-message-markdown p:last-child {
  margin-bottom: 0;
}

.workplace-message-markdown a[href^="#monad-mention-"] {
  border-radius: 4px;
  background: var(--accent-blue);
  color: white;
  cursor: default;
  display: inline-flex;
  max-width: 100%;
  padding: 0 4px;
  pointer-events: none;
  text-decoration: none;
  vertical-align: baseline;
}

.workplace-message-markdown a[href^="#monad-mention-"]:hover {
  text-decoration: none;
}
`;

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}

const MENTION_HREF_PREFIX = '#monad-mention-';

export function markdownTextWithMentionCapsules(text: string): string {
  const tokens = parseMentionTokens(text);
  if (tokens.length === 0) return text;
  let cursor = 0;
  const parts: string[] = [];
  for (const token of tokens) {
    parts.push(text.slice(cursor, token.start));
    parts.push(`[@${escapeMarkdownLinkText(token.name)}](${MENTION_HREF_PREFIX}${encodeURIComponent(token.id)})`);
    cursor = token.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function flattenReactText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenReactText).join('');
  return '';
}

function createMessageMarkdownComponents({
  attachments = [],
  onOpenAttachment
}: {
  attachments?: readonly MessageAttachment[];
  onOpenAttachment?: (attachment: MessageAttachment, line?: number) => void;
} = {}): Components {
  return {
    a: ({ href, children, title }) => {
      if (typeof href === 'string' && href.startsWith(MENTION_HREF_PREFIX)) {
        const id = decodeURIComponent(href.slice(MENTION_HREF_PREFIX.length));
        return (
          <MentionCapsule
            id={id}
            name={flattenReactText(children).replace(/^@/, '')}
          />
        );
      }
      if (title === 'monad:file' && typeof href === 'string') {
        const reference = resolveLocalFileReference(href, attachments);
        const content = (
          <>
            <FileIcon
              className="size-3.5 shrink-0 self-center"
              contentType={reference.attachment?.mime}
              fileName={reference.attachment?.name ?? reference.path}
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
          </>
        );
        if (!reference.attachment) {
          return (
            <button
              aria-disabled="true"
              className="inline-flex max-w-full items-baseline gap-1 border-0 bg-transparent p-0 align-baseline font-[inherit] text-muted-foreground leading-[inherit]"
              data-inline-link="file"
              disabled
              title="File unavailable"
              type="button"
            >
              {content}
            </button>
          );
        }
        const attachment = reference.attachment;
        return (
          <button
            className="inline-flex max-w-full cursor-pointer items-baseline gap-1 border-0 bg-transparent p-0 align-baseline font-[inherit] text-accent-blue leading-[inherit]"
            data-inline-link="file"
            onClick={() => onOpenAttachment?.(attachment, reference.line)}
            title={attachment.path}
            type="button"
          >
            {content}
          </button>
        );
      }
      return <FaviconLink href={href}>{children}</FaviconLink>;
    }
  };
}

function messageAgentBadge(msg: Message): React.ReactNode {
  if (msg.tag === 'AI') return <TagChip tag={msg.tag} />;
  return (
    <span
      aria-label={`${msg.tag} agent`}
      role="img"
      style={{
        flex: 'none',
        width: 16,
        height: 16,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        border: `1px solid ${'var(--border)'}`,
        color: 'var(--muted-foreground)'
      }}
      title={msg.tag}
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={TerminalIcon}
        size={11}
        strokeWidth={2.2}
      />
    </span>
  );
}

/** A human message's delivery provenance, resolved for the origin badge. Null when the message was
 *  written here in the web app (no provenance worth surfacing). */
function messageSentFrom(
  msg: Message,
  channelIcons: ReadonlyMap<string, ChannelIcon> | undefined,
  labels?: MessageRowLabels
): { details: ChannelOriginDetail[]; icon?: ChannelIcon; name: string } | null {
  const origin = msg.origin;
  if (msg.kind !== 'human' || !showsChannelOrigin(origin)) return null;
  const name = origin.client as string;
  const icon = channelIcons?.get(name);
  return {
    details: channelOriginDetails(origin, originLabels(labels)),
    ...(icon ? { icon } : {}),
    name
  };
}

function originLabels(labels?: MessageRowLabels): ChannelOriginLabels {
  return {
    conversation: labels?.originConversation ?? '',
    directMessage: labels?.originDirectMessage ?? '',
    group: labels?.originGroup ?? '',
    channel: labels?.originChannel ?? '',
    sender: labels?.originSender ?? '',
    thread: labels?.originThread ?? '',
    instance: labels?.originInstance ?? '',
    version: labels?.originVersion ?? ''
  };
}

function MessageHeader({
  align,
  msg
}: {
  align: 'left' | 'right';
  labels?: MessageRowLabels;
  msg: Message;
}): React.ReactElement {
  const showTag = msg.kind === 'agent' || msg.tag !== 'User';
  const productIcon = resolveProductIcon({ icon: msg.icon, tag: msg.tag, name: msg.authorName });
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexDirection: align === 'right' ? 'row-reverse' : 'row',
        gap: 8,
        marginBottom: 3,
        maxWidth: '100%',
        minWidth: 0
      }}
    >
      <AgentIdentity
        badge={showTag && !productIcon ? messageAgentBadge(msg) : undefined}
        icon={productIcon}
        name={msg.authorName}
        nameStyle={NAME_STYLE}
      />
      {msg.time ? <span style={TIME_STYLE}>{msg.time}</span> : null}
    </div>
  );
}

export function MarkdownWithMentions({
  attachments,
  onOpenAttachment,
  text,
  streaming
}: {
  attachments?: readonly MessageAttachment[];
  onOpenAttachment?: (attachment: MessageAttachment, line?: number) => void;
  text: string;
  streaming?: boolean;
}): React.ReactElement {
  const components = useMemo(
    () => createMessageMarkdownComponents({ attachments, onOpenAttachment }),
    [attachments, onOpenAttachment]
  );
  const markdownText = useMemo(() => markdownTextWithMentionCapsules(text), [text]);
  return (
    <>
      <style>{MESSAGE_MARKDOWN_CSS}</style>
      <Markdown
        className="workplace-message-markdown !text-current"
        components={components}
        streaming={streaming}
        text={markdownText}
      />
    </>
  );
}

function MessageBubbleContent({
  agent,
  hasText,
  labels,
  msg,
  onOpenAttachment
}: {
  agent: boolean;
  hasText: boolean;
  labels?: MessageRowLabels;
  msg: Message;
  onOpenAttachment?: (attachment: MessageAttachment, line?: number) => void;
}): React.ReactElement | null {
  const agentContent = agent ? (
    msg.question ? (
      <ProjectQuestionMessage
        pending={Boolean(msg.streaming)}
        presentation={msg.question}
        waitingLabel={labels?.waitingForResponse}
      />
    ) : (
      <MarkdownWithMentions
        attachments={msg.attachments}
        onOpenAttachment={onOpenAttachment}
        streaming={msg.streaming}
        text={msg.text}
      />
    )
  ) : null;
  return (
    <>
      {hasText ? (
        <span
          data-selectable="true"
          style={{ display: 'block' }}
        >
          {agent ? agentContent : <MentionText text={msg.text} />}
          {msg.streaming && agent && !msg.question ? (
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 6,
                height: 16,
                marginLeft: 3,
                verticalAlign: '-2px',
                borderRadius: 2,
                background: 'var(--accent-blue)',
                opacity: 0.65,
                animation: 'scdots 1.2s infinite'
              }}
            />
          ) : null}
        </span>
      ) : msg.streaming ? (
        <span style={{ color: 'var(--muted-foreground)', fontFamily: mono, fontSize: 13 }}>
          {labels?.working ?? 'Working'}
        </span>
      ) : null}
    </>
  );
}

export const MessageRow = memo(function MessageRow({
  actions,
  channelIcons,
  msg,
  Attachment,
  labels,
  onAgentClick,
  onOpenAttachment,
  onOpenReplyTarget,
  onReply,
  replyTarget
}: {
  actions?: readonly WorkplaceExperienceHostAction[];
  channelIcons?: ReadonlyMap<string, ChannelIcon>;
  msg: Message;
  Attachment?: MessageAttachmentComponent;
  labels?: MessageRowLabels;
  onAgentClick?: (id: string) => void;
  onOpenAttachment?: (attachment: MessageAttachment, line?: number) => void;
  onOpenReplyTarget?: () => void;
  onReply?: (message: Message) => void;
  replyTarget?: Message | null;
}): React.ReactElement {
  if (msg.kind === 'system' || msg.kind === 'developer') {
    return (
      <SystemMessageRow
        actions={actions}
        labels={labels}
        msg={msg}
        onAgentClick={onAgentClick}
      />
    );
  }
  const agent = msg.kind === 'agent';
  const hasText = msg.text.trim().length > 0;
  const failed = msg.localStatus === 'failed';
  const sending = msg.localStatus === 'sending';
  const canReply = Boolean(msg.replyable && !msg.streaming && !msg.localStatus && onReply);
  const sentFrom = messageSentFrom(msg, channelIcons, labels);
  const avatar = agent ? (
    <AgentInstanceAvatar
      agent={{ av: msg.av, avatarUrl: msg.avatarUrl, icon: msg.icon, name: msg.authorName }}
      bordered={false}
      size={34}
    />
  ) : (
    <Avatar
      av={msg.av}
      avatarUrl={msg.avatarUrl}
      icon={msg.icon}
      kind="human"
      size={34}
    />
  );
  return (
    <div className="group relative">
      <WorkspaceMessageCard
        align={agent ? 'start' : 'end'}
        attachments={
          Attachment
            ? msg.attachments?.map((attachment) => (
                <Attachment
                  attachment={attachment}
                  key={attachment.id}
                  onPreview={onOpenAttachment}
                />
              ))
            : undefined
        }
        avatar={avatar}
        body={
          <>
            {replyTarget !== undefined ? (
              <ReplyPreview
                onOpen={() => onOpenReplyTarget?.()}
                target={replyTarget}
                unavailableLabel={labels?.replyUnavailable ?? ''}
              />
            ) : null}
            <MessageBubbleContent
              agent={agent}
              hasText={hasText}
              labels={labels}
              msg={msg}
              onOpenAttachment={onOpenAttachment}
            />
          </>
        }
        bodyClassName={msg.question ? 'rounded-lg border-border/65 bg-card/70 px-4 py-3 text-sm' : 'text-sm'}
        header={
          <MessageHeader
            align={agent ? 'left' : 'right'}
            labels={labels}
            msg={msg}
          />
        }
        retryAction={
          failed && !agent ? (
            <button
              aria-label={labels?.retry}
              onClick={msg.retrySend}
              style={RETRY_BUTTON_STYLE}
              title={labels?.retry}
              type="button"
            >
              !
            </button>
          ) : undefined
        }
        sending={sending}
        tone={agent ? 'agent' : 'human'}
      />
      {canReply || sentFrom ? (
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            gap: 6,
            justifyContent: agent ? 'flex-start' : 'flex-end',
            marginTop: -12,
            marginBottom: 4,
            paddingLeft: agent ? 44 : 0,
            paddingRight: agent ? 0 : 44
          }}
        >
          {canReply ? (
            <button
              aria-label={labels?.reply}
              className="workplace-action flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 [@media_(hover:none),_(pointer:coarse)]:opacity-100"
              onClick={() => onReply?.(msg)}
              title={labels?.reply}
              type="button"
            >
              <HugeiconsIcon
                aria-hidden="true"
                icon={MessageCircleReplyIcon}
                size={13}
              />
              {labels?.reply}
            </button>
          ) : null}
          {sentFrom ? (
            <ChannelOriginBadge
              ariaLabel={`${labels?.sentFrom ?? ''} ${sentFrom.name}`.trim()}
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 [@media_(hover:none),_(pointer:coarse)]:opacity-100"
              details={sentFrom.details}
              icon={sentFrom.icon}
              name={sentFrom.name}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
