import type { ProjectCanvas } from '../presets/types';
import type { Message, TypingIndicator } from '../types';

import { ArrowDown01Icon, EyeIcon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ProductIcon } from '@monad/ui';
import { memo, useMemo, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Markdown } from '@/components/Markdown';
import { MentionText, parseMentionTokens } from '@/components/MentionText';
import { VirtualList, type VirtualListHandle } from '@/components/ui/VirtualList';
import { studioPath } from '@/features/routes/route-paths';
import { AgentIdentity, AgentInstanceAvatar, Avatar, resolveProductIcon, TagChip } from '../Bits';
import { boxR, mono, sans } from '../styles';
import { useWorkplaceUiStore } from '../workplace-ui-store';

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
const TIME_STYLE: React.CSSProperties = { fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)' };
const HEADER_SPACER = <div style={{ height: 24 }} />;
const SKELETON_CSS = `
@keyframes chat-transcript-skeleton-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.85; }
}

.chat-transcript-skeleton-bar {
  background: var(--muted);
  border-radius: 6px;
  animation: chat-transcript-skeleton-pulse 1.6s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .chat-transcript-skeleton-bar {
    animation: none;
    opacity: 0.6;
  }
}
`;
const SYSTEM_EVENT_CSS = `
.workplace-system-event {
  max-width: min(620px, 100%);
  display: inline-grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 7px;
  border-radius: 12px;
  background: var(--card);
  color: var(--muted-foreground);
  font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.35;
  padding: 6px 8px;
}

.workplace-system-agent {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--foreground);
  font-weight: 650;
}

.workplace-system-copy {
  min-width: 0;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workplace-system-follow {
  flex: none;
}
`;
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
`;

function FollowButton({
  nativeCliSessionId,
  onFollowNativeCliSession
}: {
  nativeCliSessionId?: string;
  onFollowNativeCliSession?: (id: string) => void;
}): React.ReactElement | null {
  if (!nativeCliSessionId || !onFollowNativeCliSession) return null;
  return (
    <button
      aria-label="Observe"
      className="workplace-action"
      onClick={() => onFollowNativeCliSession(nativeCliSessionId)}
      style={{
        width: 24,
        height: 24,
        border: '1px solid transparent',
        borderRadius: 999,
        background: 'transparent',
        color: 'var(--muted-foreground)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: sans,
        fontSize: 11,
        fontWeight: 600,
        padding: 0
      }}
      title="Observe"
      type="button"
    >
      <HugeiconsIcon
        aria-hidden="true"
        icon={EyeIcon}
        size={13}
        strokeWidth={2}
      />
    </button>
  );
}

function SystemMessageRow({
  msg,
  onAgentClick,
  onFollowNativeCliSession
}: {
  msg: Message;
  onAgentClick?: (id: string) => void;
  onFollowNativeCliSession?: (id: string) => void;
}): React.ReactElement {
  const developer = msg.kind === 'developer' || msg.developerOnly === true;
  const agentProductIcon = msg.agentChip ? resolveProductIcon(msg.agentChip) : null;
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        marginBottom: 12
      }}
    >
      <style>{SYSTEM_EVENT_CSS}</style>
      <div className="workplace-system-event">
        {developer ? <TagChip tag="DEV" /> : null}
        {msg.agentChip ? (
          <button
            className="workplace-action workplace-system-agent"
            onClick={() => onAgentClick?.(msg.agentChip?.id ?? '')}
            style={{ borderRadius: 999, padding: '2px 6px 2px 2px', margin: '-2px -6px -2px -2px' }}
            type="button"
          >
            <AgentInstanceAvatar
              agent={msg.agentChip}
              bordered={false}
              size={22}
            />
            <AgentIdentity
              badge={
                agentProductIcon ? (
                  <ProductIcon
                    product={agentProductIcon}
                    size={12}
                    title={msg.agentChip.tag}
                  />
                ) : null
              }
              badgeGap={4}
              name={msg.agentChip.name}
              nameStyle={{ maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            />
          </button>
        ) : null}
        {msg.fanoutAgents?.length ? (
          <span className="workplace-system-agent">
            {msg.fanoutAgents.map((agent) => (
              <AgentInstanceAvatar
                agent={agent}
                bordered={false}
                key={agent.id}
                size={20}
              />
            ))}
          </span>
        ) : null}
        {msg.text ? <span className="workplace-system-copy">{msg.text}</span> : null}
        {msg.time ? <span style={TIME_STYLE}>{msg.time}</span> : null}
        <span className="workplace-system-follow">
          <FollowButton
            nativeCliSessionId={msg.nativeCliSessionId}
            onFollowNativeCliSession={onFollowNativeCliSession}
          />
        </span>
      </div>
    </div>
  );
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
  onFollowNativeCliSession?: (id: string) => void;
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
        nativeCliSessionId={msg.nativeCliSessionId}
        onFollowNativeCliSession={onFollowNativeCliSession}
      />
    </div>
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
        <span style={{ color: 'var(--muted-foreground)', fontFamily: mono, fontSize: 13 }}>working...</span>
      ) : null}
    </>
  );
}

function MarkdownWithMentions({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement {
  const tokens = parseMentionTokens(text);
  return (
    <>
      <style>{MESSAGE_MARKDOWN_CSS}</style>
      {tokens.length > 0 ? (
        <MentionText text={text} />
      ) : (
        <Markdown
          className="workplace-message-markdown !text-current"
          streaming={streaming}
          text={text}
        />
      )}
    </>
  );
}

const MessageRow = memo(function MessageRow({
  msg,
  onAgentClick,
  onFollowNativeCliSession
}: {
  msg: Message;
  onAgentClick?: (id: string) => void;
  onFollowNativeCliSession?: (id: string) => void;
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

function TypingRow({ typing }: { typing: TypingIndicator }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <AgentInstanceAvatar
        agent={{ av: typing.av, avatarUrl: typing.avatarUrl, icon: typing.icon, name: typing.name }}
        bordered={false}
        size={34}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ fontFamily: sans, fontSize: 14, fontWeight: 600 }}>{typing.name}</span>
        <span style={{ fontFamily: mono, fontSize: 13, color: 'var(--muted-foreground)' }}>{typing.detail}</span>
        <span style={{ display: 'inline-flex', gap: 3 }}>
          {[0, 0.2, 0.4].map((d) => (
            <span
              className="scwf-typing-dot"
              key={d}
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--muted-foreground)',
                display: 'inline-block',
                animation: `scdots 1.2s infinite ${d}s`
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function SkeletonRow({ align, bodyWidth }: { align: 'left' | 'right'; bodyWidth: string }): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        marginBottom: 16,
        flexDirection: align === 'right' ? 'row-reverse' : 'row'
      }}
    >
      <div
        className="chat-transcript-skeleton-bar"
        style={{ flex: 'none', width: 34, height: 34, borderRadius: '50%' }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          alignItems: align === 'right' ? 'flex-end' : 'flex-start'
        }}
      >
        <div
          className="chat-transcript-skeleton-bar"
          style={{ width: 88, height: 11 }}
        />
        <div
          className="chat-transcript-skeleton-bar"
          style={{ width: bodyWidth, height: 44, borderRadius: boxR }}
        />
      </div>
    </div>
  );
}

function TranscriptSkeleton(): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      style={{ paddingTop: 4 }}
    >
      <style>{SKELETON_CSS}</style>
      <SkeletonRow
        align="left"
        bodyWidth="72%"
      />
      <SkeletonRow
        align="right"
        bodyWidth="48%"
      />
      <SkeletonRow
        align="left"
        bodyWidth="58%"
      />
    </div>
  );
}

export function ChatTranscript({ room }: { room: ProjectCanvas }): React.ReactElement {
  const t = useT();
  const listRef = useRef<VirtualListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const openProjectSettings = useWorkplaceUiStore((state) => state.openProjectSettings);
  // Stable footer reference across streamed-token re-renders (only the typing indicator varies), so
  // VirtualList's header/footer context memo isn't invalidated every token.
  const footer = useMemo(
    () => (
      <>
        {room.typing ? (
          <div style={{ boxSizing: 'border-box', padding: '0 16px', width: '100%' }}>
            <TypingRow typing={room.typing} />
          </div>
        ) : null}
        {/* Keeps the last row clear of the floating composer; a footer spacer rather than
            scroller padding, which would skew Virtuoso's row measurement. */}
        <div style={{ height: 108 }} />
      </>
    ),
    [room.typing]
  );

  if (room.messages.length === 0) {
    if (!room.ready) {
      return (
        <div
          className="scwf-scroll"
          style={{
            boxSizing: 'border-box',
            flex: 1,
            overflowX: 'hidden',
            overflowY: 'auto',
            padding: '24px 16px 108px'
          }}
        >
          <TranscriptSkeleton />
        </div>
      );
    }
    return (
      <div
        className="scwf-scroll"
        style={{ boxSizing: 'border-box', flex: 1, overflowX: 'hidden', overflowY: 'auto', padding: '24px 16px 108px' }}
      >
        <div
          style={{
            margin: '52px auto 0',
            maxWidth: 470,
            padding: '24px 26px',
            border: `1px solid ${'var(--border)'}`,
            borderRadius: 14,
            background: 'color-mix(in srgb, var(--card) 88%, var(--muted))',
            textAlign: 'left'
          }}
        >
          <div style={{ display: 'flex', gap: 13, alignItems: 'flex-start' }}>
            <div
              style={{
                flex: 'none',
                width: 42,
                height: 42,
                borderRadius: 12,
                background: 'var(--accent-blue)',
                boxShadow: '0 8px 18px -12px color-mix(in srgb, var(--accent-blue) 80%, transparent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <span
                aria-label="monad"
                role="img"
                style={{
                  width: '52%',
                  height: '52%',
                  WebkitMaskImage: 'url("/monad-icon-vector-solid.svg")',
                  maskImage: 'url("/monad-icon-vector-solid.svg")',
                  WebkitMaskRepeat: 'no-repeat',
                  maskRepeat: 'no-repeat',
                  WebkitMaskPosition: 'center',
                  maskPosition: 'center',
                  WebkitMaskSize: 'contain',
                  maskSize: 'contain',
                  background: 'var(--primary-foreground)'
                }}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: sans, fontSize: 18, fontWeight: 700, lineHeight: 1.3, marginBottom: 7 }}>
                {t('web.workplace.emptyChatTitle')}
              </div>
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: 'var(--muted-foreground)',
                  maxWidth: 390
                }}
              >
                {t('web.workplace.emptyChatDescription')}
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 10,
              marginTop: 20
            }}
          >
            <a
              className="workplace-action"
              href={studioPath('nativeCliAgents')}
              style={{
                minHeight: 38,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: `1px solid ${'var(--border)'}`,
                borderRadius: 10,
                background: 'var(--card)',
                color: 'var(--foreground)',
                fontFamily: sans,
                fontSize: 14,
                fontWeight: 650,
                padding: '0 14px',
                textDecoration: 'none'
              }}
            >
              {t('web.workplace.emptyConnectInStudio')}
            </a>
            <button
              className="workplace-action"
              onClick={() => openProjectSettings(room.projectId, 'spawn-agent')}
              style={{
                minHeight: 38,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                border: `1px solid ${'var(--accent-blue)'}`,
                borderRadius: 10,
                background: 'var(--accent-blue)',
                color: 'var(--primary-foreground)',
                fontFamily: sans,
                fontSize: 14,
                fontWeight: 650,
                padding: '0 14px'
              }}
              type="button"
            >
              <HugeiconsIcon
                icon={TerminalIcon}
                size={15}
              />
              {t('web.workplace.emptySpawnAgentMember')}
            </button>
          </div>
        </div>
        {room.typing ? (
          <div style={{ marginTop: 16 }}>
            <TypingRow typing={room.typing} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <VirtualList
        ariaLive="polite"
        bounce
        className="scwf-scroll"
        controlRef={listRef}
        firstItemIndex={room.firstItemIndex}
        footer={footer}
        getKey={(msg) => msg.id}
        header={HEADER_SPACER}
        items={room.messages}
        onAtBottomChange={setAtBottom}
        onStartReached={room.loadOlder}
        renderItem={(msg) => (
          <div style={{ boxSizing: 'border-box', padding: '0 16px', width: '100%' }}>
            <MessageRow
              msg={msg}
              onAgentClick={room.openAgentCard}
              onFollowNativeCliSession={room.followNativeCliSession}
            />
          </div>
        )}
        role="log"
        stickToBottom
        style={{ boxSizing: 'border-box', flex: 1, overflowX: 'hidden' }}
      />
      {atBottom ? null : (
        <button
          aria-label="Jump to latest messages"
          className="workplace-action"
          onClick={() => listRef.current?.scrollToBottom('smooth')}
          style={{
            position: 'absolute',
            bottom: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 38,
            height: 38,
            padding: 0,
            borderRadius: 999,
            border: `1px solid ${'var(--border)'}`,
            background: 'var(--card)',
            boxShadow: '0 10px 28px -18px rgb(0 0 0 / 0.45), var(--shadow-sm)',
            color: 'var(--foreground)'
          }}
          title="Jump to latest messages"
          type="button"
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={ArrowDown01Icon}
            size={18}
            strokeWidth={2.2}
          />
        </button>
      )}
    </div>
  );
}
