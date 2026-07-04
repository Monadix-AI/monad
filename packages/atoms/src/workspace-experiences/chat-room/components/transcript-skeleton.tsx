import type { TypingIndicator } from '../../project/types.ts';

import {
  AgentInstanceAvatar,
  workspaceBoxRadius as boxR,
  workspaceMono as mono,
  workspaceSans as sans
} from '@monad/ui/components/AgentAvatar';

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

export function TypingRow({ typing }: { typing: TypingIndicator }): React.ReactElement {
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

export function TranscriptSkeleton(): React.ReactElement {
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

export function MessageListSkeleton(): React.ReactElement {
  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
    </div>
  );
}
