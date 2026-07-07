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
const COMPOSER_CLEARANCE = 'calc(var(--chat-room-composer-clearance, 132px) + 24px)';

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
            padding: `24px 16px ${COMPOSER_CLEARANCE}`
          }}
        >
          <TranscriptSkeleton />
        </div>
      );
    }
    return (
      <div
        className="scwf-scroll"
        style={{
          boxSizing: 'border-box',
          flex: 1,
          overflowX: 'hidden',
          overflowY: 'auto',
          padding: `24px 16px ${COMPOSER_CLEARANCE}`
        }}
      >
        <div
          className="chat-room-empty-state"
          style={{
            margin: '52px auto 0',
            maxWidth: 560,
            padding: '22px 24px',
            border: `1px solid ${'color-mix(in srgb, var(--accent-blue) 24%, var(--border))'}`,
            borderRadius: 14,
            background: 'color-mix(in srgb, var(--card) 92%, var(--accent-blue-soft))',
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
                Set up Codex, Claude, or another agent.
              </div>
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 14,
                  lineHeight: 1.55,
                  color: 'var(--muted-foreground)',
                  maxWidth: 440
                }}
              >
                Connect an external agent in Studio, then bring it into this room. You can also spawn a project-local
                member when you want monad to manage the session.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
            {['Codex', 'Claude', 'More providers'].map((provider) => (
              <span
                key={provider}
                style={{
                  border: `1px solid ${'var(--border)'}`,
                  borderRadius: 999,
                  background: 'var(--card)',
                  color: provider === 'More providers' ? 'var(--muted-foreground)' : 'var(--foreground)',
                  fontFamily: sans,
                  fontSize: 12,
                  fontWeight: 650,
                  lineHeight: 1,
                  padding: '7px 10px'
                }}
              >
                {provider}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 20 }}>
            <button
              className="workplace-action"
              onClick={() => host.openStudio('externalAgents')}
              style={{
                minHeight: 38,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
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
              Set up external agents
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
                border: `1px solid ${'var(--border)'}`,
                borderRadius: 10,
                background: 'var(--card)',
                color: 'var(--foreground)',
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
              Spawn project member
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
