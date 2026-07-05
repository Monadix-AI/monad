import type { Message, TypingIndicator } from '../../experience/types.ts';
import type { ChatMessageListRoom } from './message-list.tsx';
import type { MessageRowLabels } from './message-row.tsx';

import { TerminalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { lazy, Suspense } from 'react';

import { requestSpawnAgentMemberDialog, useWorkspaceExperienceHost } from '../../host-context.tsx';
import { MessageListSkeleton, TranscriptSkeleton, TypingRow } from './transcript-skeleton.tsx';

const ChatMessageList = lazy(() =>
  import('./message-list.tsx').then((module) => ({ default: module.ChatMessageList }))
);

type ChatTranscriptRoom = ChatMessageListRoom & {
  messages: Message[];
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
  labels
}: {
  room: ChatTranscriptRoom;
  labels: ChatTranscriptLabels;
}): React.ReactElement {
  const host = useWorkspaceExperienceHost();

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
            <button
              className="workplace-action"
              onClick={() => host.openStudio('nativeCliAgents')}
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
                cursor: 'pointer'
              }}
              type="button"
            >
              {labels.connectInStudio}
            </button>
            <button
              className="workplace-action"
              onClick={() => requestSpawnAgentMemberDialog(host.requestProjectDialog)}
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
    <Suspense fallback={<MessageListSkeleton />}>
      <ChatMessageList
        labels={labels}
        room={room}
      />
    </Suspense>
  );
}
