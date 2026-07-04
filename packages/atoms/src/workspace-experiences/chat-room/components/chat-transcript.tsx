import type { NativeAgentDeliveryId } from '@monad/protocol';
import type { Message, TypingIndicator } from '../../project/types.ts';
import type { MessageRowLabels } from './message-row.tsx';

import { ArrowDown01Icon, TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useFirstItemIndex } from '@monad/ui/hooks/use-first-item-index';
import { useMemo, useRef, useState } from 'react';

import { AttachmentChip } from './attachment-chip.tsx';
import { MessageRow } from './message-row.tsx';
import { TranscriptSkeleton, TypingRow } from './transcript-skeleton.tsx';

const HEADER_SPACER = <div style={{ height: 24 }} />;
const messageId = (m: Message): string => m.id;

type ChatTranscriptRoom = {
  followNativeCliSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
  loadOlder: () => void;
  messages: Message[];
  openAgentCard?: (id: string) => void;
  projectId: string;
  ready: boolean;
  typing: TypingIndicator | null;
};

export type ChatTranscriptLabels = MessageRowLabels & {
  connectInStudio: string;
  emptyDescription: string;
  emptyTitle: string;
  jumpLatest: string;
  spawnAgentMember: string;
};

export function ChatTranscript({
  room,
  labels,
  nativeCliAgentsHref,
  onSpawnAgentMember
}: {
  room: ChatTranscriptRoom;
  labels: ChatTranscriptLabels;
  nativeCliAgentsHref: string;
  onSpawnAgentMember?: () => void;
}): React.ReactElement {
  const listRef = useRef<VirtualListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const firstItemIndex = useFirstItemIndex(room.messages, messageId);
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
                {labels.emptyTitle}
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
                {labels.emptyDescription}
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
              href={nativeCliAgentsHref}
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
              {labels.connectInStudio}
            </a>
            <button
              className="workplace-action"
              onClick={onSpawnAgentMember}
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
              {labels.spawnAgentMember}
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
        firstItemIndex={firstItemIndex}
        footer={footer}
        getKey={(msg) => msg.id}
        header={HEADER_SPACER}
        items={room.messages}
        onAtBottomChange={setAtBottom}
        onStartReached={room.loadOlder}
        renderItem={(msg) => (
          <div style={{ boxSizing: 'border-box', padding: '0 16px', width: '100%' }}>
            <MessageRow
              Attachment={AttachmentChip}
              labels={labels}
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
          aria-label={labels.jumpLatest}
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
          title={labels.jumpLatest}
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
