import type { NativeAgentDeliveryId } from '@monad/protocol';
import type { Message, TypingIndicator } from '../../experience/types.ts';
import type { MessageRowLabels } from './message-row.tsx';

import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useFirstItemIndex } from '@monad/ui/hooks/use-first-item-index';
import { useMemo, useRef, useState } from 'react';

import { AttachmentChip } from './attachment-chip.tsx';
import { MessageRow } from './message-row.tsx';
import { TypingRow } from './transcript-skeleton.tsx';

const HEADER_SPACER = <div style={{ height: 24 }} />;
const messageId = (m: Message): string => m.id;

export type ChatMessageListRoom = {
  followNativeCliSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
  loadOlder: () => void;
  messages: Message[];
  openAgentCard?: (id: string) => void;
  typing: TypingIndicator | null;
};

export function ChatMessageList({
  room,
  labels
}: {
  room: ChatMessageListRoom;
  labels: MessageRowLabels & { jumpLatest: string };
}): React.ReactElement {
  const listRef = useRef<VirtualListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const firstItemIndex = useFirstItemIndex(room.messages, messageId);
  const footer = useMemo(
    () => (
      <>
        {room.typing ? (
          <div style={{ boxSizing: 'border-box', padding: '0 16px', width: '100%' }}>
            <TypingRow typing={room.typing} />
          </div>
        ) : null}
        <div style={{ height: 108 }} />
      </>
    ),
    [room.typing]
  );

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
