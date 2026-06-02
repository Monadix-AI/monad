import type { CSSProperties } from 'react';
import type { ActivityStatus } from './types';
import type { ProjectController } from './use-project';

import { Avatar, MiniTag, PresenceBadge } from './Bits';
import { boxR, mono, sans, sectionLabel } from './styles';
import { WorkOutput } from './WorkOutput';

function statusPill(status: ActivityStatus): CSSProperties {
  const color = status === 'ok' ? 'var(--success)' : status === 'error' ? 'var(--destructive)' : 'var(--accent-blue)';
  const background =
    status === 'ok'
      ? 'color-mix(in srgb, var(--success) 14%, transparent)'
      : status === 'error'
        ? 'color-mix(in srgb, var(--destructive) 14%, transparent)'
        : 'color-mix(in srgb, var(--accent-blue) 16%, transparent)';
  return {
    fontFamily: mono,
    fontSize: 9,
    color: 'var(--foreground)',
    border: `1px solid ${color}`,
    background,
    borderRadius: 5,
    padding: '1px 5px',
    flex: 'none',
    whiteSpace: 'nowrap'
  };
}

const statusText = (s: ActivityStatus): string => (s === 'ok' ? 'done' : s === 'error' ? 'error' : 'running');

export function AgentTasksRail({ room }: { room: ProjectController }): React.ReactElement {
  return (
    <div
      className="scwf-scroll workplace-agent-rail"
      style={{
        width: 296,
        flex: 'none',
        borderLeft: `1px solid ${'var(--border)'}`,
        background: 'var(--muted)',
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>ACTIVE WORK</div>
      <div
        className="scwf-scroll"
        style={{
          padding: '0 14px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          borderBottom: `1px solid ${'var(--border)'}`,
          flex: 'none',
          maxHeight: '34%',
          overflowY: 'auto'
        }}
      >
        {room.tasks.length === 0 ? (
          <div
            style={{
              fontFamily: sans,
              fontSize: 13,
              color: 'var(--muted-foreground)',
              padding: '2px 0',
              lineHeight: 1.5
            }}
          >
            Agent tasks will appear here while work is running.
          </div>
        ) : null}
        {room.tasks.map((t) => (
          <div
            key={t.id}
            style={{
              border: `1px solid ${'var(--border)'}`,
              borderRadius: boxR,
              background: 'var(--card)',
              padding: '9px 10px',
              display: 'grid',
              gridTemplateColumns: '24px minmax(0, 1fr) auto',
              alignItems: 'start',
              gap: 8,
              boxShadow: 'none'
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                border: `1px solid ${'var(--accent-blue)'}`,
                background: 'var(--accent-blue-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: mono,
                fontSize: 9,
                flex: 'none'
              }}
            >
              {t.av}
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 14,
                  fontWeight: 500,
                  lineHeight: 1.35,
                  minWidth: 0,
                  wordBreak: 'break-word'
                }}
              >
                {t.title}
              </div>
              {t.output ? (
                <WorkOutput
                  maxHeight={150}
                  output={t.output}
                />
              ) : null}
            </div>
            <span style={statusPill(t.status)}>{statusText(t.status)}</span>
          </div>
        ))}
      </div>

      <div
        className="scwf-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 14 }}
      >
        <div style={{ ...sectionLabel, padding: '13px 15px 8px' }}>PARTICIPANTS</div>
        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {room.participants.map((p) => (
            <div
              key={p.id}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', minWidth: 0 }}
            >
              <div style={{ position: 'relative', flex: 'none' }}>
                <Avatar
                  av={p.av}
                  icon={p.icon}
                  kind={p.kind}
                  size={28}
                />
                <PresenceBadge presence={p.presence} />
              </div>
              <div
                style={{ fontFamily: sans, fontSize: 14, display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                {p.kind === 'agent' ? (
                  <MiniTag tag={p.tag} />
                ) : p.role ? (
                  <span
                    style={{ fontFamily: mono, fontSize: 9, color: 'var(--muted-foreground)', whiteSpace: 'nowrap' }}
                  >
                    · {p.role}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
