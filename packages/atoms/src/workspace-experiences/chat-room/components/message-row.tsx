import type { ComponentType } from 'react';
import type { Message, MessageAttachment } from '../../experience/types.ts';

import { TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { FaviconLink, ProductIcon, WorkspaceMessageCard } from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  Avatar,
  workspaceMono as mono,
  resolveProductIcon,
  workspaceSans as sans,
  TagChip
} from '@monad/ui/components/AgentAvatar';
import { type Components, Markdown } from '@monad/ui/components/Markdown';
import { MentionCapsule, MentionText, parseMentionTokens } from '@monad/ui/components/MentionText';
import { memo } from 'react';

import { SystemMessageRow, TIME_STYLE } from './system-message-row.tsx';

export type MessageRowLabels = {
  observe?: string;
  retry?: string;
  working?: string;
};

export type MessageAttachmentComponent = ComponentType<{ attachment: MessageAttachment }>;

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
    border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
    border-radius: 7px;
    background: color-mix(in srgb, currentColor 10%, transparent);
    padding: 0.08em 0.42em;
    font-family: ${mono};
    font-size: 0.9em;
    font-weight: 500;
    overflow-wrap: anywhere;
    white-space: normal;
    word-break: break-word;
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

export const messageMarkdownComponents: Components = {
  a: ({ href, children }) => {
    if (typeof href === 'string' && href.startsWith(MENTION_HREF_PREFIX)) {
      const id = decodeURIComponent(href.slice(MENTION_HREF_PREFIX.length));
      return (
        <MentionCapsule
          id={id}
          name={flattenReactText(children).replace(/^@/, '')}
        />
      );
    }
    return <FaviconLink href={href}>{children}</FaviconLink>;
  }
};

function messageAgentBadge(msg: Message): React.ReactNode {
  if (msg.tag === 'AI') return <TagChip tag={msg.tag} />;
  const productIcon = resolveProductIcon({ icon: msg.icon, tag: msg.tag, name: msg.authorName });
  if (productIcon) {
    return (
      <ProductIcon
        product={productIcon}
        size={14}
        title={msg.tag}
      />
    );
  }
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

function MessageHeader({ align, msg }: { align: 'left' | 'right'; msg: Message }): React.ReactElement {
  const showTag = msg.kind === 'agent' || msg.tag !== 'User';
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
        badge={showTag ? messageAgentBadge(msg) : undefined}
        name={msg.authorName}
        nameStyle={NAME_STYLE}
      />
      {msg.time ? <span style={TIME_STYLE}>{msg.time}</span> : null}
    </div>
  );
}

export function MarkdownWithMentions({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement {
  return (
    <>
      <style>{MESSAGE_MARKDOWN_CSS}</style>
      <Markdown
        className="workplace-message-markdown !text-current"
        components={messageMarkdownComponents}
        streaming={streaming}
        text={markdownTextWithMentionCapsules(text)}
      />
    </>
  );
}

function MessageBubbleContent({
  agent,
  hasText,
  labels,
  msg
}: {
  agent: boolean;
  hasText: boolean;
  labels?: MessageRowLabels;
  msg: Message;
}): React.ReactElement | null {
  const agentContent = agent ? (
    <MarkdownWithMentions
      streaming={msg.streaming}
      text={msg.text}
    />
  ) : null;
  return (
    <>
      {hasText ? (
        <span
          data-selectable="true"
          style={{ display: 'block' }}
        >
          {agent ? agentContent : <MentionText text={msg.text} />}
          {msg.streaming && agent ? (
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
  msg,
  Attachment,
  labels,
  onAgentClick
}: {
  msg: Message;
  Attachment?: MessageAttachmentComponent;
  labels?: MessageRowLabels;
  onAgentClick?: (id: string) => void;
}): React.ReactElement {
  if (msg.kind === 'system' || msg.kind === 'developer') {
    return (
      <SystemMessageRow
        msg={msg}
        onAgentClick={onAgentClick}
      />
    );
  }
  const agent = msg.kind === 'agent';
  const hasText = msg.text.trim().length > 0;
  const failed = msg.localStatus === 'failed';
  const sending = msg.localStatus === 'sending';
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
    <WorkspaceMessageCard
      align={agent ? 'start' : 'end'}
      attachments={
        Attachment
          ? msg.attachments?.map((attachment) => (
              <Attachment
                attachment={attachment}
                key={attachment.id}
              />
            ))
          : undefined
      }
      avatar={avatar}
      body={
        <MessageBubbleContent
          agent={agent}
          hasText={hasText}
          labels={labels}
          msg={msg}
        />
      }
      header={
        <MessageHeader
          align={agent ? 'left' : 'right'}
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
  );
});
