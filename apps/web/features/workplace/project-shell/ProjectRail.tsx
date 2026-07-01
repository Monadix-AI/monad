import type { ProjectController } from '../use-project';

import { KeyRound, Loader2 } from 'lucide-react';

import { MiniTag, PresenceDot } from '../Bits';
import { mono, sans, sectionLabel } from '../styles';

const presenceLabel = (presence: ProjectController['railAgents'][number]['presence']): string =>
  presence === 'needs-login' ? 'needs login' : presence;

export function ProjectRail({
  project,
  onStartNativeCliAuth,
  startingNativeCliAuthAgent
}: {
  project: ProjectController;
  onStartNativeCliAuth?: (agentName: string) => void;
  startingNativeCliAuthAgent?: string | null;
}): React.ReactElement {
  const room = project;
  return (
    <div
      className="workplace-project-rail"
      style={{
        width: 212,
        flex: 'none',
        background: 'var(--muted)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          padding: '16px 14px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}
      >
        <span style={{ fontFamily: sans, fontSize: 15, fontWeight: 650 }}>Workspace</span>
        <span style={{ fontFamily: mono, fontSize: 12, color: 'var(--muted-foreground)' }}>▾</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ ...sectionLabel, padding: '18px 12px 7px' }}>PROJECTS</div>
        <ul
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '0 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2
          }}
        >
          {room.projects.length === 0 ? (
            <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)', padding: '4px 8px' }}>
              # {room.projectId}
            </div>
          ) : null}
          {room.projects.map((ch) => (
            <li
              aria-current={ch.active ? 'page' : undefined}
              key={ch.id}
            >
              <button
                className="workplace-action workplace-rail-button"
                onClick={() => room.switchProject(ch.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  padding: '7px 8px',
                  borderRadius: 8,
                  fontFamily: sans,
                  fontSize: 14,
                  fontWeight: ch.active ? 600 : 500,
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: ch.active ? 'var(--accent-blue)' : 'var(--muted-foreground)',
                  background: ch.active ? 'var(--accent-blue-soft)' : 'transparent',
                  border: ch.active ? `1px solid ${'var(--accent-blue)'}` : '1px solid transparent'
                }}
                type="button"
              >
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  # {ch.name}
                </span>
                {ch.unread ? (
                  <span
                    style={{
                      fontFamily: mono,
                      fontSize: 9,
                      color: 'var(--foreground)',
                      border: `1px solid ${'var(--accent-blue)'}`,
                      background: 'color-mix(in srgb, var(--accent-blue) 16%, transparent)',
                      borderRadius: 9,
                      padding: '0 6px'
                    }}
                  >
                    {ch.unread}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div style={{ ...sectionLabel, padding: '20px 12px 7px' }}>AGENTS</div>
      <div style={{ padding: '0 8px 12px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {room.railAgents.map((a) => {
          const canStartAuth = a.presence === 'needs-login' && a.id.startsWith('native-cli:') && onStartNativeCliAuth;
          const startingAuth = startingNativeCliAuthAgent === a.name;
          return (
            <div
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                fontFamily: sans,
                fontSize: 14,
                color: 'var(--muted-foreground)'
              }}
            >
              <PresenceDot presence={a.presence} />
              <span
                style={{ color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={a.name}
              >
                {a.name}
              </span>
              <MiniTag tag={a.tag} />
              {canStartAuth ? (
                <button
                  aria-label={`Connect ${a.name}`}
                  className="workplace-action"
                  disabled={startingAuth}
                  onClick={() => onStartNativeCliAuth?.(a.name)}
                  style={{
                    marginLeft: 'auto',
                    width: 24,
                    height: 24,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `1px solid ${'var(--border)'}`,
                    borderRadius: 7,
                    background: 'var(--card)',
                    color: 'var(--foreground)',
                    cursor: startingAuth ? 'default' : 'pointer',
                    flex: 'none'
                  }}
                  title="Open provider login"
                  type="button"
                >
                  {startingAuth ? <Loader2 size={13} /> : <KeyRound size={13} />}
                </button>
              ) : (
                <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 10, textTransform: 'uppercase' }}>
                  {presenceLabel(a.presence)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
