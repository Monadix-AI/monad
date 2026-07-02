'use client';

import type { NativeCliStreamView, Participant } from '../types';

import { ProductIcon } from '@monad/ui';
import { XIcon } from 'lucide-react';
import { useEffect } from 'react';

import { AgentIdentity, AgentInstanceAvatar, resolveProductIcon } from '../Bits';
import { mono, sans } from '../styles';

function statusLabel(status: NativeCliStreamView['status']): string {
  if (status === 'ok') return 'done';
  if (status === 'error') return 'error';
  return 'running';
}

export function NativeCliStreamModal({
  stream,
  onClose,
  onStop
}: {
  stream: NativeCliStreamView;
  onClose: () => void;
  onStop: (id: string) => void;
}): React.ReactElement {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      aria-label={`${stream.agentName} observation`}
      aria-modal="false"
      role="dialog"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 55,
        pointerEvents: 'none'
      }}
    >
      <aside
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(390px, 92vw)',
          display: 'grid',
          gridTemplateRows: 'auto minmax(0, 1fr) auto',
          borderLeft: '1px solid var(--border)',
          background: 'var(--card)',
          boxShadow: '-18px 0 42px rgb(0 0 0 / 0.28)',
          pointerEvents: 'auto'
        }}
      >
        <NativeCliObservationPanel
          onClose={onClose}
          onStop={onStop}
          stream={stream}
        />
      </aside>
    </div>
  );
}

export function NativeCliObservationPanel({
  agent,
  agentName,
  icon,
  onBack,
  onClose,
  onStop,
  stream
}: {
  agent?: Participant;
  agentName?: string;
  icon?: NativeCliStreamView['icon'];
  onBack?: () => void;
  onClose?: () => void;
  onStop: (id: string) => void;
  stream?: NativeCliStreamView;
}): React.ReactElement {
  const displayAgent = agent ?? {
    av: (stream?.agentName ?? agentName ?? 'Agent').slice(0, 2).toUpperCase(),
    icon: stream?.icon ?? icon,
    kind: 'agent' as const,
    name: stream?.agentName ?? agentName ?? 'Agent',
    presence: stream?.status === 'running' ? ('working' as const) : ('online' as const),
    tag: stream?.tag ?? 'Agent'
  };
  const status = stream ? statusLabel(stream.status) : undefined;
  const productIcon = resolveProductIcon(displayAgent);
  const hasItems = (stream?.items.length ?? 0) > 0;

  return (
    <>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 14px 12px',
          borderBottom: '1px solid var(--border)'
        }}
      >
        {onBack ? (
          <button
            aria-label="Back to agents"
            className="workplace-action"
            onClick={onBack}
            style={{
              width: 30,
              height: 30,
              border: '1px solid transparent',
              borderRadius: 8,
              background: 'transparent',
              color: 'var(--foreground)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
              fontFamily: mono,
              fontSize: 15
            }}
            type="button"
          >
            ‹
          </button>
        ) : null}
        <AgentInstanceAvatar
          agent={displayAgent}
          size={30}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              minWidth: 0
            }}
          >
            <AgentIdentity
              badge={
                productIcon ? (
                  <ProductIcon
                    product={productIcon}
                    size={14}
                    title={displayAgent.name}
                  />
                ) : null
              }
              badgeGap={7}
              name={displayAgent.name}
              nameStyle={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: sans,
                fontSize: 14,
                fontWeight: 700
              }}
            />
          </div>
          {status ? (
            <div style={{ marginTop: 2, fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)' }}>
              {status}
            </div>
          ) : null}
        </div>
        {onClose ? (
          <button
            aria-label="Close observation"
            className="workplace-action"
            onClick={onClose}
            style={{
              width: 30,
              height: 30,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--secondary)',
              color: 'var(--foreground)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none'
            }}
            type="button"
          >
            <XIcon
              aria-hidden="true"
              size={15}
            />
          </button>
        ) : null}
      </header>

      <div
        style={{
          minWidth: 0,
          minHeight: 0,
          overflowY: 'auto',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        }}
      >
        {hasItems && stream ? (
          stream.items.map((item) => (
            <div
              key={item.id}
              style={{
                alignSelf: item.role === 'agent' ? 'flex-start' : 'stretch',
                boxSizing: 'border-box',
                maxWidth: item.role === 'agent' ? 'min(88%, 100%)' : '100%',
                minWidth: 0,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: item.role === 'agent' ? 'var(--secondary)' : 'var(--muted)',
                padding: '9px 11px',
                fontFamily: sans,
                fontSize: 13,
                lineHeight: 1.5,
                overflowWrap: 'anywhere',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {item.text}
            </div>
          ))
        ) : (
          <div
            style={{
              margin: 'auto',
              maxWidth: 180,
              textAlign: 'center',
              color: 'var(--muted-foreground)',
              fontFamily: sans,
              fontSize: 13,
              lineHeight: 1.5
            }}
          >
            No activity yet.
          </div>
        )}
      </div>

      <footer
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          padding: 12,
          borderTop: '1px solid var(--border)'
        }}
      >
        {stream?.status === 'running' ? (
          <button
            className="workplace-action"
            onClick={() => onStop(stream.id)}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--secondary)',
              color: 'var(--foreground)',
              fontFamily: sans,
              fontSize: 12,
              fontWeight: 650,
              padding: '7px 10px'
            }}
            type="button"
          >
            Stop
          </button>
        ) : null}
      </footer>
    </>
  );
}
