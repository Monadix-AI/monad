import type { ChatRoomCanvas } from '../experiences/chat-room/canvas';

import { ghostButtonStyle, inkButtonStyle } from '../Bits';
import { boxR, mono, sans, softShadow } from '../styles';

export function ApprovalStack({ room }: { room: ChatRoomCanvas }): React.ReactElement | null {
  const { approvals } = room;
  if (approvals.length === 0) return null;
  const top = approvals[0];
  const hasPeek1 = approvals.length >= 2;
  const hasPeek2 = approvals.length >= 3;

  return (
    <div style={{ position: 'absolute', left: 18, right: 18, bottom: '100%', marginBottom: 12, zIndex: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span
          style={{
            fontFamily: mono,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 1,
            color: 'var(--foreground)',
            background: 'color-mix(in srgb, var(--accent-blue) 16%, transparent)',
            border: `1px solid ${'var(--accent-blue)'}`,
            borderRadius: 999,
            padding: '3px 11px'
          }}
        >
          ⚠ {approvals.length === 1 ? '1 action needs review' : `${approvals.length} actions need review`}
        </span>
      </div>

      <div style={{ position: 'relative', paddingTop: 18 }}>
        {hasPeek2 ? (
          <div
            style={{
              position: 'absolute',
              left: 22,
              right: 22,
              top: 0,
              height: 48,
              border: `1px solid ${'var(--border)'}`,
              borderRadius: '11px 11px 0 0',
              background: 'color-mix(in srgb, var(--accent-blue) 16%, transparent)',
              zIndex: 0
            }}
          />
        ) : null}
        {hasPeek1 ? (
          <div
            style={{
              position: 'absolute',
              left: 11,
              right: 11,
              top: 9,
              height: 48,
              border: `1px solid ${'var(--border)'}`,
              borderRadius: '11px 11px 0 0',
              background: 'color-mix(in srgb, var(--accent-blue) 16%, transparent)',
              zIndex: 1
            }}
          />
        ) : null}

        <div
          style={{
            position: 'relative',
            zIndex: 2,
            border: `1px solid ${'var(--accent-blue)'}`,
            borderRadius: boxR,
            background: 'color-mix(in srgb, var(--accent-blue) 16%, transparent)',
            padding: '11px 13px',
            boxShadow: softShadow,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '10px 14px'
          }}
        >
          <div style={{ flex: '1 1 250px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 11 }}>
            <span
              style={{
                flex: 'none',
                width: 36,
                height: 36,
                borderRadius: 9,
                border: `1px solid ${'var(--accent-blue)'}`,
                background: 'var(--accent-blue-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: mono,
                fontSize: 11
              }}
            >
              {top.av}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: sans, fontSize: 15, lineHeight: 1.4 }}>
                <b>{top.name}</b>{' '}
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 10,
                    color: 'var(--foreground)',
                    border: `1px solid ${'var(--accent-blue)'}`,
                    borderRadius: 4,
                    padding: '0 4px'
                  }}
                >
                  {top.tag}
                </span>{' '}
                asks to {top.text}.
              </div>
              <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)', marginTop: 2 }}>
                {top.meta}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flex: 'none', marginLeft: 'auto' }}>
            <button
              className="workplace-action"
              onClick={() => room.resolveApproval(top.id, 'approve')}
              style={inkButtonStyle({ height: 36, padding: '0 15px', fontSize: 15 })}
              type="button"
            >
              Allow action
            </button>
            <button
              className="workplace-action"
              onClick={() => room.resolveApproval(top.id, 'reject')}
              style={ghostButtonStyle({ height: 36, padding: '0 13px', fontSize: 15 })}
              type="button"
            >
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
