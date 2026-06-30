'use client';

import type { Participant } from '../types';

import { X } from 'lucide-react';

import { Avatar, MiniTag } from '../Bits';
import { mono, sans, sectionLabel } from '../styles';
import { CliTerminalOutput } from './CliTerminalOutput';

export type CliTerminalModalStatus = 'running' | 'ok' | 'error';

function statusText(status: CliTerminalModalStatus): string {
  return status === 'ok' ? 'done' : status === 'error' ? 'error' : 'running';
}

function statusPill(status: CliTerminalModalStatus): React.CSSProperties {
  const color = status === 'ok' ? 'var(--success)' : status === 'error' ? 'var(--destructive)' : 'var(--accent-blue)';
  const background =
    status === 'ok'
      ? 'color-mix(in srgb, var(--success) 14%, transparent)'
      : status === 'error'
        ? 'color-mix(in srgb, var(--destructive) 14%, transparent)'
        : 'color-mix(in srgb, var(--accent-blue) 16%, transparent)';
  return {
    fontFamily: mono,
    fontSize: 10,
    color: 'var(--foreground)',
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
  subtitle,
  eyebrow = 'CLI MONITOR',
  tag,
  icon,
  avatarText,
  status,
  output,
  id,
  footerLabel = 'following latest',
  onInput,
  onClose,
  onStop,
  stopLabel = 'Stop'
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
  return (
    <div
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
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
          width: 'min(1180px, calc(100vw - 56px))',
          height: 'min(780px, calc(100vh - 72px))',
          minHeight: 500,
          border: '1px solid rgb(124 139 166 / 0.32)',
          borderRadius: 18,
          background: '#121722',
          boxShadow: '0 28px 80px rgb(0 0 0 / 0.44), inset 0 1px 0 rgb(255 255 255 / 0.08)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'visible',
          padding: 12,
          position: 'relative'
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -18,
            width: 'min(380px, 38%)',
            height: 18,
            transform: 'translateX(-50%)',
            borderRadius: '0 0 16px 16px',
            background: '#0d121b',
            border: '1px solid rgb(124 139 166 / 0.24)',
            borderTop: 0,
            boxShadow: '0 14px 28px rgb(0 0 0 / 0.28)'
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -30,
            width: 'min(520px, 48%)',
            height: 12,
            transform: 'translateX(-50%)',
            borderRadius: 999,
            background: '#0b1018',
            border: '1px solid rgb(124 139 166 / 0.2)',
            boxShadow: '0 12px 24px rgb(0 0 0 / 0.24)'
          }}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 14,
            padding: '12px 12px 10px',
            alignItems: 'center',
            color: '#d7dde8'
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ ...sectionLabel, padding: 0, color: '#8d99ad' }}>{eyebrow}</div>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: status === 'running' ? '#8bd88b' : status === 'error' ? '#ff6b6b' : '#70d6ff',
                  boxShadow:
                    status === 'running'
                      ? '0 0 0 4px rgb(139 216 139 / 0.12), 0 0 16px rgb(139 216 139 / 0.34)'
                      : 'none',
                  flex: 'none'
                }}
              />
              <Avatar
                av={(avatarText ?? title).slice(0, 2).toUpperCase()}
                icon={icon}
                kind="agent"
                size={28}
              />
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: sans,
                  fontSize: 16,
                  fontWeight: 650,
                  color: '#f4f7fb'
                }}
              >
                {title}
              </span>
              {tag ? <MiniTag tag={tag} /> : null}
              <span style={statusPill(status)}>{statusText(status)}</span>
            </div>
            {subtitle ? (
              <div
                style={{
                  marginTop: 6,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: mono,
                  fontSize: 11,
                  color: '#8d99ad'
                }}
                title={subtitle}
              >
                {subtitle}
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {onStop && status === 'running' ? (
              <button
                className="workplace-action"
                onClick={onStop}
                style={{
                  border: '1px solid rgb(124 139 166 / 0.34)',
                  borderRadius: 8,
                  background: '#151c29',
                  color: '#c6d0df',
                  cursor: 'pointer',
                  fontFamily: sans,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '6px 10px'
                }}
                type="button"
              >
                {stopLabel}
              </button>
            ) : null}
            <button
              aria-label="Close CLI terminal"
              className="workplace-action"
              onClick={onClose}
              style={{
                width: 32,
                height: 32,
                border: '1px solid rgb(124 139 166 / 0.34)',
                borderRadius: 8,
                background: '#151c29',
                color: '#c6d0df',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              type="button"
            >
              <X
                aria-hidden="true"
                size={16}
              />
            </button>
          </div>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            padding: 10,
            borderRadius: 14,
            background: '#070b11',
            border: '1px solid rgb(255 255 255 / 0.08)',
            boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.52), inset 0 18px 38px rgb(0 0 0 / 0.3)'
          }}
        >
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid rgb(125 180 255 / 0.18)',
              boxShadow: '0 0 0 1px rgb(0 0 0 / 0.54), 0 0 28px rgb(112 214 255 / 0.08)'
            }}
          >
            <CliTerminalOutput
              maxHeight="none"
              minHeight={0}
              onInput={onInput}
              output={output}
              style={{ flex: 1, height: '100%', minHeight: 0, border: 0, borderRadius: 0 }}
            />
          </div>
        </div>
        <div
          style={{
            padding: '9px 12px 2px',
            fontFamily: mono,
            fontSize: 10,
            color: '#7e8ba0',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12
          }}
        >
          <span>{footerLabel}</span>
          <span>{id}</span>
        </div>
      </div>
    </div>
  );
}
