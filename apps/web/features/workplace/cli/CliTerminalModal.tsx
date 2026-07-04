'use client';

import type { Participant } from '@monad/atoms/workspace-experiences/project/types';

import { Avatar, workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';

import { CliTerminalOutput } from './CliTerminalOutput';

export type CliTerminalModalStatus = 'running' | 'ok' | 'error';

function statusText(status: CliTerminalModalStatus): string {
  return status === 'ok' ? 'done' : status === 'error' ? 'error' : 'running';
}

function officialCliName(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes('gemini')) return 'Gemini CLI';
  if (normalized.includes('claude')) return 'Claude Code';
  if (normalized.includes('codex')) return 'OpenAI Codex';
  if (normalized.includes('qwen')) return 'Qwen Code';
  return name;
}

function statusPill(
  status: CliTerminalModalStatus,
  tone: 'default' | 'soft' | 'clear' | 'bright' = 'default'
): React.CSSProperties {
  const color =
    status === 'ok'
      ? tone === 'default'
        ? 'var(--success)'
        : '#74e7a3'
      : status === 'error'
        ? tone === 'default'
          ? 'var(--destructive)'
          : '#ff8c7b'
        : tone === 'bright'
          ? '#a8c2ff'
          : tone === 'clear'
            ? '#b9b4ff'
            : 'var(--accent-blue)';
  const background =
    status === 'ok'
      ? tone === 'default'
        ? 'color-mix(in srgb, var(--success) 14%, transparent)'
        : 'rgb(116 231 163 / 0.16)'
      : status === 'error'
        ? tone === 'default'
          ? 'color-mix(in srgb, var(--destructive) 14%, transparent)'
          : 'rgb(255 140 123 / 0.16)'
        : tone === 'bright'
          ? 'rgb(168 194 255 / 0.2)'
          : tone === 'clear'
            ? 'rgb(185 180 255 / 0.18)'
            : 'color-mix(in srgb, var(--accent-blue) 16%, transparent)';
  return {
    fontFamily: mono,
    fontSize: 10,
    color: tone === 'default' ? 'var(--foreground)' : '#eef3ff',
    border: `1px solid ${color}`,
    background,
    borderRadius: 5,
    padding: '2px 6px',
    flex: 'none',
    whiteSpace: 'nowrap'
  };
}

export function CliTerminalModal({
  title,
  icon,
  status,
  output,
  id,
  onInput,
  onClose,
  onStop
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  tag?: string;
  icon?: Participant['icon'];
  avatarText?: string;
  status: CliTerminalModalStatus;
  output: string;
  id: string;
  footerLabel?: string;
  onInput?: (input: string) => void;
  onClose: () => void;
  onStop?: () => void;
  stopLabel?: string;
}): React.ReactElement {
  const quit = () => {
    if (onStop) onStop();
    else onClose();
  };

  return (
    <div
      aria-modal="true"
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 28,
        background: 'rgb(2 6 14 / 0.58)'
      }}
    >
      <div
        style={{
          width: 'min(1120px, calc(100vw - 48px))',
          height: 'min(740px, calc(100vh - 64px))',
          minHeight: 500,
          display: 'grid',
          gridTemplateRows: 'auto auto minmax(0, 1fr)',
          overflow: 'hidden',
          padding: '14px',
          position: 'relative',
          border: 0,
          borderRadius: 12,
          background: '#101620',
          boxShadow: '0 22px 64px rgb(0 0 0 / 0.4), inset 0 1px 0 rgb(255 255 255 / 0.07)'
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 14,
            alignItems: 'center',
            padding: '0 0 12px'
          }}
        >
          <div style={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: 10 }}>
            <div style={{ color: '#f0f5ff' }}>
              <Avatar
                av={officialCliName(title).slice(0, 2).toUpperCase()}
                icon={icon}
                kind="agent"
                size={30}
              />
            </div>
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: sans,
                fontSize: 'clamp(1.05rem, calc(var(--p-scale, 1) * 1.2rem), 1.38rem)',
                lineHeight: 1.16,
                fontWeight: 680,
                color: '#f0f5ff',
                letterSpacing: '-0.01em'
              }}
            >
              {officialCliName(title)}
            </span>
            <span style={statusPill(status, 'soft')}>{statusText(status)}</span>
          </div>
          <button
            className="workplace-action"
            onClick={quit}
            style={{
              border: 0,
              borderRadius: 7,
              background: '#202838',
              color: '#f0f5ff',
              fontFamily: sans,
              fontSize: 12,
              fontWeight: 650,
              padding: '7px 12px'
            }}
            type="button"
          >
            Quit
          </button>
        </div>
        <div
          style={{
            padding: '0 2px 12px',
            color: '#c4cede',
            fontFamily: sans,
            fontSize: 'clamp(0.8rem, calc(var(--p-scale, 1) * 0.86rem), 0.98rem)',
            lineHeight: 1.5
          }}
        >
          Please complete login authorization.
        </div>
        <div
          style={{
            minHeight: 0,
            display: 'flex',
            padding: 'calc(6px + (var(--p-space, 0.5) * 4px))',
            borderRadius: 12,
            background: '#070b11',
            border: '1px solid rgb(255 255 255 / 0.08)'
          }}
        >
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              overflow: 'hidden',
              borderRadius: 8,
              border: '1px solid rgb(125 180 255 / 0.16)'
            }}
          >
            <CliTerminalOutput
              key={id}
              maxHeight="none"
              minHeight={0}
              onInput={onInput}
              output={output}
              resetKey={id}
              style={{ flex: 1, height: '100%', minHeight: 0, border: 0, borderRadius: 0 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
