import type { NativeAgentDeliveryId } from '@monad/protocol';
import type { Message } from '../types';

import { TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ProductIcon } from '@monad/ui';
import { memo } from 'react';

import { useT } from '@/components/I18nProvider';
import { Markdown } from '@/components/Markdown';
import { MentionText, parseMentionTokens } from '@/components/MentionText';
import { AgentIdentity, AgentInstanceAvatar, Avatar, resolveProductIcon, TagChip } from '../Bits';
import { boxR, mono, sans } from '../styles';
import { AttachmentChip } from './AttachmentChip';
import { FollowButton, SystemMessageRow, TIME_STYLE } from './SystemMessageRow';

const ROW_STYLE: React.CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  gap: 10,
  marginBottom: 16,
  maxWidth: '100%',
  minWidth: 0,
  width: '100%'
};
const NAME_STYLE: React.CSSProperties = { fontFamily: sans, fontSize: 14, fontWeight: 600 };
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

function markdownTextWithMentionCapsules(text: string): string {
  const tokens = parseMentionTokens(text);
  if (tokens.length === 0) return text;
  let cursor = 0;
  const parts: string[] = [];
  for (const token of tokens) {
    parts.push(text.slice(cursor, token.start));
    parts.push(`[@${escapeMarkdownLinkText(token.name)}](#monad-mention-${encodeURIComponent(token.id)})`);
    cursor = token.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

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

function MessageHeader({
  align,
  msg,
  onFollowNativeCliSession
}: {
  align: 'left' | 'right';
  msg: Message;
  onFollowNativeCliSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
}): React.ReactElement {
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
      <FollowButton
        deliveryId={msg.deliveryId}
        nativeCliSessionId={msg.nativeCliSessionId}
        onFollowNativeCliSession={onFollowNativeCliSession}
      />
    </div>
  );
}

function MarkdownWithMentions({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement {
  return (
    <>
      <style>{MESSAGE_MARKDOWN_CSS}</style>
      <Markdown
        className="workplace-message-markdown !text-current"
        streaming={streaming}
        text={markdownTextWithMentionCapsules(text)}
      />
    </>
  );
}

export function MessageBubbleContent({
  agent,
  hasText,
  msg
}: {
  agent: boolean;
  hasText: boolean;
  msg: Message;
}): React.ReactElement | null {
  const t = useT();
  const agentContent = agent ? (
    <MarkdownWithMentions
      streaming={msg.streaming}
      text={msg.text}
    />
  ) : null;
  return (
    <>
      {hasText ? (
        <span style={{ display: 'block' }}>
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
          {t('web.workplace.working')}
        </span>
      ) : null}
      {msg.attachments?.map((attachment) => (
        <AttachmentChip
          attachment={attachment}
          key={attachment.id}
        />
      ))}
    </>
  );
}

export const MessageRow = memo(function MessageRow({
  msg,
  onAgentClick,
  onFollowNativeCliSession
}: {
  msg: Message;
  onAgentClick?: (id: string) => void;
  onFollowNativeCliSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
}): React.ReactElement {
  if (msg.kind === 'system' || msg.kind === 'developer') {
    return (
      <SystemMessageRow
        msg={msg}
        onAgentClick={onAgentClick}
        onFollowNativeCliSession={onFollowNativeCliSession}
      />
    );
  }
  const agent = msg.kind === 'agent';
  const hasText = msg.text.trim().length > 0;
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
  const messageStack = (
    <div
      style={{
        alignItems: agent ? 'flex-start' : 'flex-end',
        display: 'flex',
        flexDirection: 'column',
        maxWidth: 'min(72ch, calc(100% - 44px))',
        minWidth: 0
      }}
    >
      <MessageHeader
        align={agent ? 'left' : 'right'}
        msg={msg}
        onFollowNativeCliSession={onFollowNativeCliSession}
      />
      <div
        style={{
          background: agent ? 'var(--secondary)' : 'var(--foreground)',
          border: `1px solid ${agent ? 'var(--border)' : 'var(--foreground)'}`,
          borderRadius: agent ? boxR : '12px 12px 4px 12px',
          color: agent ? 'var(--foreground)' : 'var(--background)',
          fontFamily: sans,
          fontSize: 15,
          lineHeight: 1.55,
          maxWidth: '100%',
          overflowWrap: 'anywhere',
          padding: '10px 14px',
          wordBreak: 'break-word'
        }}
      >
        <MessageBubbleContent
          agent={agent}
          hasText={hasText}
          msg={msg}
        />
      </div>
    </div>
  );
  return (
    <div
      style={{
        ...ROW_STYLE,
        flexDirection: 'row',
        justifyContent: agent ? 'flex-start' : 'flex-end'
      }}
    >
      {agent ? avatar : messageStack}
      {agent ? messageStack : avatar}
    </div>
  );
});
