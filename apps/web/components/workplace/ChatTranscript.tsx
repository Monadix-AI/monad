import type { ProjectCanvas } from './presets/types';
import type { Message, TypingIndicator } from './types';

import { Radio } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';

import { MentionText } from '@/components/MentionText';
import { VirtualList, type VirtualListHandle } from '@/components/ui/VirtualList';
import { Avatar, TagChip } from './Bits';
import { boxR, mono, sans } from './styles';

const ROW_STYLE: React.CSSProperties = { display: 'flex', gap: 10, marginBottom: 16 };
const HEADER_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 };
const NAME_STYLE: React.CSSProperties = { fontFamily: sans, fontSize: 14, fontWeight: 600 };
const TIME_STYLE: React.CSSProperties = { fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)' };
const HEADER_SPACER = <div style={{ height: 24 }} />;

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
      aria-label="Follow CLI stream"
      className="workplace-action"
      onClick={() => onFollowNativeCliSession(nativeCliSessionId)}
      style={{
        minWidth: 26,
        height: 24,
        border: `1px solid ${'var(--border)'}`,
        borderRadius: 999,
        background: 'var(--card)',
        color: 'var(--muted-foreground)',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        fontFamily: sans,
        fontSize: 11,
        fontWeight: 600,
        padding: '0 7px'
      }}
      title="Follow CLI stream"
      type="button"
    >
      <Radio
        aria-hidden="true"
        size={13}
        strokeWidth={2}
      />
      <span>Follow</span>
    </button>
  );
}

function AgentChip({
  chip,
  onAgentClick
}: {
  chip: NonNullable<Message['agentChip']>;
  onAgentClick?: (id: string) => void;
}): React.ReactElement {
  return (
    <button
      className="workplace-action"
      onClick={() => onAgentClick?.(chip.id)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: `1px solid ${'var(--accent-blue)'}`,
        borderRadius: 999,
        background: 'var(--accent-blue-soft)',
        color: 'var(--foreground)',
        cursor: onAgentClick ? 'pointer' : 'default',
        fontFamily: sans,
        fontSize: 12,
        fontWeight: 650,
        lineHeight: 1,
        padding: '3px 8px 3px 4px',
        verticalAlign: 'middle'
      }}
      type="button"
    >
      <Avatar
        av={chip.name.slice(0, 2).toUpperCase()}
        icon={chip.icon}
        kind="agent"
        size={18}
      />
      <span>{chip.name}</span>
      <TagChip tag={chip.tag} />
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
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        marginBottom: 12
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          maxWidth: developer ? 720 : 560,
          border: `1px ${developer ? 'dashed' : 'solid'} ${developer ? 'var(--accent-blue)' : 'var(--border)'}`,
          borderRadius: 999,
          background: developer ? 'var(--accent-blue-soft)' : 'var(--muted)',
          color: 'var(--muted-foreground)',
          fontFamily: developer ? mono : sans,
          fontSize: developer ? 11 : 13,
          lineHeight: 1.45,
          padding: developer ? '7px 11px' : '5px 10px',
          whiteSpace: developer ? 'pre-wrap' : 'normal',
          wordBreak: 'break-word'
        }}
      >
        {developer ? <TagChip tag="DEV" /> : null}
        {msg.agentChip ? (
          <AgentChip
            chip={msg.agentChip}
            onAgentClick={onAgentClick}
          />
        ) : null}
        <span>{msg.text}</span>
        {msg.time ? <span style={TIME_STYLE}>{msg.time}</span> : null}
        <FollowButton
          nativeCliSessionId={msg.nativeCliSessionId}
          onFollowNativeCliSession={onFollowNativeCliSession}
        />
      </div>
    </div>
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
  return (
    <div style={ROW_STYLE}>
      <Avatar
        av={msg.av}
        icon={msg.icon}
        kind={agent ? 'agent' : 'human'}
        size={34}
      />
      <div>
        <div style={HEADER_STYLE}>
          <span style={NAME_STYLE}>{msg.authorName}</span>
          <TagChip tag={msg.tag} />
          <span style={TIME_STYLE}>{msg.time}</span>
          <FollowButton
            nativeCliSessionId={msg.nativeCliSessionId}
            onFollowNativeCliSession={onFollowNativeCliSession}
          />
        </div>
        <div
          style={{
            background: agent ? 'var(--secondary)' : 'var(--card)',
            border: `1px solid ${'var(--border)'}`,
            borderRadius: boxR,
            padding: '10px 14px',
            fontFamily: sans,
            fontSize: 15,
            maxWidth: 600,
            lineHeight: 1.55,
            boxShadow: agent ? 'var(--shadow-sm)' : 'none'
          }}
        >
          {msg.reasoning ? (
            <div
              style={{
                marginBottom: hasText ? 8 : 0,
                borderLeft: `2px solid ${'var(--accent-blue)'}`,
                paddingLeft: 9,
                color: 'var(--muted-foreground)',
                fontFamily: mono,
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              <span style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>Thinking</span>
              {msg.reasoning ? ` ${msg.reasoning}` : ''}
            </div>
          ) : null}
          {hasText ? (
            <span>
              <MentionText text={msg.text} />
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
            <span style={{ color: 'var(--muted-foreground)', fontFamily: mono, fontSize: 13 }}>working…</span>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function TypingRow({ typing }: { typing: TypingIndicator }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Avatar
        av={typing.av}
        icon={typing.icon}
        kind="agent"
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

export function ChatTranscript({ room }: { room: ProjectCanvas }): React.ReactElement {
  const listRef = useRef<VirtualListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Stable footer reference across streamed-token re-renders (only the typing indicator varies), so
  // VirtualList's header/footer context memo isn't invalidated every token.
  const footer = useMemo(
    () => (
      <>
        {room.typing ? <TypingRow typing={room.typing} /> : null}
        {/* Keeps the last row clear of the floating composer; a footer spacer rather than
            scroller padding, which would skew Virtuoso's row measurement. */}
        <div style={{ height: 108 }} />
      </>
    ),
    [room.typing]
  );
  const emptyTitle = room.ready ? 'Start the agent conversation.' : 'Opening this project...';
  const emptyBody = room.ready
    ? 'Send a message to monad, or type @ to assign work to a specific agent. Tool calls and approvals appear in Activity.'
    : 'Loading messages, agents, and pending approvals.';

  if (room.messages.length === 0) {
    return (
      <div
        className="scwf-scroll"
        style={{ flex: 1, padding: '24px 24px 108px', background: 'var(--card)', overflowY: 'auto' }}
      >
        <div
          style={{
            margin: '44px auto 0',
            maxWidth: 360,
            padding: '22px 24px',
            border: `1px solid ${'var(--border)'}`,
            borderRadius: 16,
            background: 'var(--muted)',
            textAlign: 'center'
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              border: `1px solid ${'var(--border)'}`,
              background: 'var(--accent-blue-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: mono,
              fontSize: 15,
              color: 'var(--accent-blue)',
              margin: '0 auto 14px'
            }}
          >
            #
          </div>
          <div style={{ fontFamily: sans, fontSize: 18, fontWeight: 600, lineHeight: 1.35, marginBottom: 8 }}>
            {emptyTitle}
          </div>
          <div style={{ fontFamily: sans, fontSize: 14, lineHeight: 1.6, color: 'var(--muted-foreground)' }}>
            {emptyBody}
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
          <MessageRow
            msg={msg}
            onAgentClick={room.openAgentCard}
            onFollowNativeCliSession={room.followNativeCliSession}
          />
        )}
        role="log"
        stickToBottom
        style={{ flex: 1, paddingLeft: 24, paddingRight: 24, background: 'var(--card)' }}
      />
      {atBottom ? null : (
        <button
          aria-label="Jump to latest messages"
          onClick={() => listRef.current?.scrollToBottom('smooth')}
          style={{
            position: 'absolute',
            bottom: 120,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 999,
            border: `1px solid ${'var(--border)'}`,
            background: 'var(--card)',
            boxShadow: 'var(--shadow-sm)',
            color: 'var(--foreground)',
            fontFamily: sans,
            fontSize: 13,
            cursor: 'pointer'
          }}
          type="button"
        >
          ↓ Latest
        </button>
      )}
    </div>
  );
}
