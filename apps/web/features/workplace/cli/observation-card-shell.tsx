'use client';

import type { CSSProperties } from 'react';
import type { ObservationItem } from './observation-card-types';

import { SourceCodeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';

import { mono, sans } from '../styles';

export function ObservationCardShell({
  children,
  raw,
  timestamp,
  visualRole
}: {
  children: React.ReactNode;
  raw: unknown;
  timestamp?: string;
  visualRole: ObservationItem['role'];
}): React.ReactElement {
  return (
    <article style={cardStyle(visualRole)}>
      <RawJsonToggle raw={raw} />
      <ObservationTimestamp value={timestamp} />
      {children}
    </article>
  );
}

export function ObservationMeta({
  label,
  source,
  type
}: {
  label: string;
  source: ObservationItem['source'];
  type?: string;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        marginBottom: 7,
        fontFamily: mono,
        fontSize: 10,
        lineHeight: 1.2,
        textTransform: 'uppercase'
      }}
    >
      <span style={metaPillStyle(label)}>{label}</span>
      <span style={metaTextStyle}>{source}</span>
      {type ? <span style={metaTextStyle}>{type}</span> : null}
    </div>
  );
}

export function ObservationText({
  compact,
  contained,
  observationRole,
  text
}: {
  compact?: boolean;
  contained?: boolean;
  observationRole: ObservationItem['role'];
  text: string;
}): React.ReactElement {
  return (
    <div
      style={{
        ...(contained ? containedTextStyle : null),
        color: observationRole === 'system' ? 'var(--muted-foreground)' : 'var(--foreground)',
        fontFamily: observationRole === 'tool' ? mono : sans,
        fontSize: compact ? 12 : observationRole === 'tool' ? 11 : 13,
        lineHeight: 1.48,
        overflowWrap: 'anywhere',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word'
      }}
    >
      {highlightInlineCode(text)}
    </div>
  );
}

export function DefaultToolPairContent({
  call,
  result
}: {
  call: ObservationItem;
  result: ObservationItem;
}): React.ReactElement {
  return (
    <>
      <ObservationMeta
        label="tool"
        source={call.source}
        type={call.providerEventType}
      />
      <ObservationText
        compact
        observationRole="tool"
        text={toolCallSummary(call.text)}
      />
      <div
        style={{
          marginTop: 9,
          borderTop: '1px solid color-mix(in srgb, var(--border) 78%, transparent)',
          paddingTop: 9
        }}
      >
        <ObservationMeta
          label="result"
          source={result.source}
          type={result.providerEventType}
        />
        <ObservationText
          contained
          observationRole="tool"
          text={result.text}
        />
      </div>
    </>
  );
}

function ObservationTimestamp({ value }: { value?: string }): React.ReactElement | null {
  if (!value) return null;
  return (
    <time
      dateTime={value}
      style={timestampStyle}
    >
      {value}
    </time>
  );
}

function rawJsonText(raw: unknown): string {
  if (raw === undefined) return 'null';
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function RawJsonToggle({ raw }: { raw: unknown }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-expanded={open}
        aria-label={open ? 'Hide raw JSONL' : 'Show raw JSONL'}
        className="workplace-action"
        onClick={() => setOpen((value) => !value)}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 24,
          height: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid color-mix(in srgb, var(--border) 78%, transparent)',
          borderRadius: 7,
          background: open ? 'var(--secondary)' : 'color-mix(in srgb, var(--background) 74%, transparent)',
          color: 'var(--muted-foreground)',
          padding: 0
        }}
        title={open ? 'Hide raw JSONL' : 'Show raw JSONL'}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={SourceCodeIcon}
          size={13}
          strokeWidth={2}
        />
      </button>
      {open ? (
        <pre
          style={{
            boxSizing: 'border-box',
            maxHeight: 260,
            overflow: 'auto',
            margin: '10px 0 0',
            border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)',
            borderRadius: 8,
            background: 'color-mix(in srgb, var(--background) 82%, black)',
            color: 'var(--foreground)',
            fontFamily: mono,
            fontSize: 10.5,
            lineHeight: 1.45,
            padding: '9px 10px',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {rawJsonText(raw)}
        </pre>
      ) : null}
    </>
  );
}

function highlightInlineCode(text: string): React.ReactNode {
  return text.split(/(`[^`]+`)/g).map((part, index) => {
    const key = `${index}:${part}`;
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={key}
          style={{
            border: '1px solid color-mix(in srgb, var(--border) 82%, transparent)',
            borderRadius: 5,
            background: 'color-mix(in srgb, var(--secondary) 76%, transparent)',
            color: 'var(--foreground)',
            fontFamily: mono,
            fontSize: '0.94em',
            padding: '1px 4px',
            whiteSpace: 'break-spaces'
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function cardStyle(role: ObservationItem['role']): CSSProperties {
  const borderColor =
    role === 'tool'
      ? 'color-mix(in srgb, #f59e0b 38%, var(--border))'
      : role === 'agent'
        ? 'color-mix(in srgb, var(--primary) 32%, var(--border))'
        : 'var(--border)';
  const background =
    role === 'agent'
      ? 'color-mix(in srgb, var(--primary) 6%, var(--background))'
      : role === 'tool'
        ? 'color-mix(in srgb, #f59e0b 7%, var(--background))'
        : 'var(--background)';
  return {
    position: 'relative',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    border: `1px solid ${borderColor}`,
    borderRadius: 10,
    background,
    padding: '10px 76px 10px 12px',
    overflow: 'visible'
  };
}

function metaPillStyle(label: string): CSSProperties {
  return {
    border: '1px solid color-mix(in srgb, var(--border) 76%, transparent)',
    borderRadius: 999,
    background:
      label === 'tool' || label === 'result'
        ? 'color-mix(in srgb, #f59e0b 13%, transparent)'
        : 'color-mix(in srgb, var(--primary) 13%, transparent)',
    color: label === 'system' ? 'var(--muted-foreground)' : 'var(--foreground)',
    padding: '2px 6px'
  };
}

function toolCallSummary(text: string): string {
  const match = /^Tool call\s+([^\s]+)\s+(.+)$/s.exec(text.trim());
  if (!match) return text;
  const [, tool, rawInput] = match;
  try {
    const parsed = JSON.parse(rawInput) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const command = (parsed as Record<string, unknown>).command;
      const description = (parsed as Record<string, unknown>).description;
      if (typeof command === 'string' && command.trim()) return `${tool}: ${command.trim()}`;
      if (typeof description === 'string' && description.trim()) return `${tool}: ${description.trim()}`;
    }
  } catch {
    return `${tool}: ${rawInput}`;
  }
  return `${tool}: ${rawInput}`;
}

const metaTextStyle: CSSProperties = {
  color: 'var(--muted-foreground)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
};

const timestampStyle: CSSProperties = {
  position: 'absolute',
  top: 36,
  right: 8,
  color: 'var(--muted-foreground)',
  fontFamily: mono,
  fontSize: 10,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1,
  whiteSpace: 'nowrap'
};

const containedTextStyle: CSSProperties = {
  boxSizing: 'border-box',
  maxHeight: 240,
  overflow: 'auto',
  border: '1px solid color-mix(in srgb, #22c55e 38%, var(--border))',
  borderLeft: '3px solid color-mix(in srgb, #22c55e 72%, var(--border))',
  borderRadius: 7,
  background: 'color-mix(in srgb, #22c55e 7%, var(--background))',
  padding: '8px 9px'
};
