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
  const renderFrame = (variant: 'original' | '1' | '2' | '3') => {
    const original = variant === 'original';
    const quietMeta = variant === '1';
    const commandDeck = variant === '2';
    const denseConsole = variant === '3';
    const badgeTone = quietMeta ? 'soft' : commandDeck ? 'clear' : denseConsole ? 'bright' : 'default';
    const headerInk = quietMeta ? '#f0f5ff' : commandDeck ? '#f6f8ff' : denseConsole ? '#ffffff' : '#f4f7fb';
    const headerMuted = quietMeta ? '#c4cede' : commandDeck ? '#bac6d8' : denseConsole ? '#c7d3e6' : '#a2aec0';
    const headerSubtle = quietMeta ? '#aebbd0' : commandDeck ? '#a5b4cb' : denseConsole ? '#b2c0d6' : '#93a0b3';
    const providerIcon = icon ?? (title.toLowerCase().includes('gemini') ? 'google' : undefined);
    const displaySubtitle = original ? subtitle : subtitle ? 'Finish provider login in this terminal.' : undefined;
    const badgeBorder = quietMeta
      ? 'rgb(172 184 204 / 0.46)'
      : commandDeck
        ? 'rgb(185 180 255 / 0.5)'
        : 'rgb(168 194 255 / 0.48)';
    const badgeBackground = quietMeta
      ? 'rgb(255 255 255 / 0.07)'
      : commandDeck
        ? 'rgb(185 180 255 / 0.13)'
        : 'rgb(168 194 255 / 0.12)';
    const titleSize = original
      ? 17
      : commandDeck
        ? 'clamp(1.05rem, calc(var(--p-scale, 1) * 1.32rem), 1.55rem)'
        : denseConsole
          ? 'clamp(0.98rem, calc(var(--p-scale, 1) * 1.05rem), 1.22rem)'
          : 'clamp(1rem, calc(var(--p-scale, 1) * 1.18rem), 1.38rem)';
    const subtitleSize = original ? 12 : 'clamp(0.75rem, calc(var(--p-scale, 1) * 0.82rem), 0.95rem)';
    const eyebrowSize = original ? sectionLabel.fontSize : 'clamp(0.64rem, calc(var(--p-scale, 1) * 0.68rem), 0.78rem)';

    return (
      <div
        style={{
          width: 'min(1120px, calc(100vw - 48px))',
          height: 'min(740px, calc(100vh - 64px))',
          minHeight: 500,
          display: 'grid',
          gridTemplateRows: commandDeck ? 'auto minmax(0, 1fr) auto' : 'auto minmax(0, 1fr) auto',
          overflow: 'hidden',
          padding: denseConsole
            ? 'calc(9px + (var(--p-space, 0.5) * 6px))'
            : commandDeck
              ? 'calc(12px + (var(--p-space, 0.5) * 8px))'
              : 'calc(11px + (var(--p-space, 0.5) * 6px))',
          position: 'relative',
          border: original ? '1px solid rgb(124 139 166 / 0.28)' : 0,
          borderRadius: quietMeta ? 12 : commandDeck ? 16 : 10,
          background: quietMeta ? '#101620' : commandDeck ? '#121925' : '#111722',
          boxShadow: commandDeck
            ? '0 24px 68px rgb(0 0 0 / 0.42), inset 0 1px 0 rgb(255 255 255 / 0.08)'
            : '0 22px 64px rgb(0 0 0 / 0.4), inset 0 1px 0 rgb(255 255 255 / 0.07)'
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: denseConsole ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr) auto',
            gap: commandDeck ? 'calc(12px + (var(--p-space, 0.5) * 12px))' : 'calc(10px + (var(--p-space, 0.5) * 8px))',
            alignItems: commandDeck ? 'center' : 'start',
            padding: denseConsole ? '0 0 9px' : commandDeck ? '2px 2px 14px' : '0 0 12px'
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                ...sectionLabel,
                padding: 0,
                color: headerSubtle,
                fontSize: eyebrowSize,
                letterSpacing: original ? sectionLabel.letterSpacing : '0.09em'
              }}
            >
              {eyebrow}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: commandDeck ? 'flex-start' : 'center',
                gap: commandDeck ? 11 : 9,
                minWidth: 0,
                marginTop: commandDeck ? 9 : 7
              }}
            >
              <div
                style={{
                  color: headerInk,
                  filter: denseConsole ? 'drop-shadow(0 0 10px rgb(168 194 255 / 0.16))' : undefined
                }}
              >
                <Avatar
                  av={(avatarText ?? title).slice(0, 2).toUpperCase()}
                  icon={original ? icon : providerIcon}
                  kind="agent"
                  size={commandDeck ? 34 : 30}
                />
              </div>
              <div style={{ minWidth: 0, display: 'grid', gap: commandDeck ? 7 : 5 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: denseConsole ? 8 : 9,
                    minWidth: 0,
                    flexWrap: commandDeck ? 'wrap' : 'nowrap'
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: sans,
                      fontSize: titleSize,
                      lineHeight: original ? undefined : 1.16,
                      fontWeight: commandDeck ? 720 : 650,
                      color: headerInk,
                      letterSpacing: original ? undefined : '-0.01em'
                    }}
                  >
                    {title}
                  </span>
                  {tag && original ? (
                    original ? (
                      <MiniTag tag={tag} />
                    ) : (
                      <span
                        style={{
                          fontFamily: mono,
                          fontSize: 8,
                          color: '#eef3ff',
                          border: `1px solid ${badgeBorder}`,
                          background: badgeBackground,
                          borderRadius: 4,
                          padding: '1px 5px',
                          lineHeight: 1.55,
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {tag}
                      </span>
                    )
                  ) : null}
                  <span style={statusPill(status, badgeTone)}>{statusText(status)}</span>
                </div>
                {displaySubtitle && commandDeck ? (
                  <div
                    style={{
                      color: headerMuted,
                      fontFamily: sans,
                      fontSize: subtitleSize,
                      lineHeight: 1.48,
                      maxWidth: '72ch'
                    }}
                    title={displaySubtitle}
                  >
                    {displaySubtitle}
                  </div>
                ) : null}
              </div>
            </div>
            {displaySubtitle && !commandDeck ? (
              <div
                style={{
                  marginTop: quietMeta ? 10 : 8,
                  color: headerMuted,
                  fontFamily: sans,
                  fontSize: subtitleSize,
                  lineHeight: original ? 1.45 : 1.5,
                  maxWidth: quietMeta ? '70ch' : undefined
                }}
                title={displaySubtitle}
              >
                {displaySubtitle}
              </div>
            ) : null}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: original ? 3 : 0,
              border: original ? '1px solid rgb(124 139 166 / 0.22)' : 0,
              borderRadius: 10,
              background: original ? (quietMeta ? 'rgb(255 255 255 / 0.05)' : 'rgb(7 11 17 / 0.52)') : 'transparent'
            }}
          >
            {onStop && status === 'running' ? (
              <button
                className="workplace-action"
                onClick={onStop}
                style={{
                  border: 0,
                  borderRadius: 7,
                  background: commandDeck ? '#263146' : '#202838',
                  color: headerInk,
                  cursor: 'pointer',
                  fontFamily: sans,
                  fontSize: 12,
                  fontWeight: 650,
                  padding: '7px 11px'
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
                border: 0,
                borderRadius: 7,
                background: commandDeck ? '#263146' : '#202838',
                color: headerInk,
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
            minHeight: 0,
            display: 'flex',
            padding: denseConsole
              ? 'calc(4px + (var(--p-space, 0.5) * 4px))'
              : 'calc(6px + (var(--p-space, 0.5) * 4px))',
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
              borderRadius: denseConsole ? 7 : 8,
              border: denseConsole ? '1px solid rgb(125 180 255 / 0.12)' : '1px solid rgb(125 180 255 / 0.16)'
            }}
          >
            <CliTerminalOutput
              key={id}
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
            padding: denseConsole ? '8px 2px 0' : '10px 2px 0',
            fontFamily: mono,
            fontSize: original ? 10 : 'clamp(0.62rem, calc(var(--p-scale, 1) * 0.66rem), 0.78rem)',
            color: quietMeta ? '#a9b7cb' : denseConsole ? '#9fb1cb' : '#98a7bb',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 12,
            letterSpacing: original ? undefined : '0.015em'
          }}
        >
          <span>{footerLabel}</span>
          <span>{id}</span>
        </div>
      </div>
    );
  };

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
      {renderFrame('1')}
    </div>
  );
}
