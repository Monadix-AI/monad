'use client';

import type { CSSProperties } from 'react';
import type { ObservationItem } from './types.ts';

// Neutral events carry no display `role`; the card layer derives a visual role from `kind` and passes
// it as this plain union.
type ObservationVisualRole = 'user' | 'agent' | 'tool' | 'system';

import { CheckIcon, ChevronDownIcon, Copy01Icon, SourceCodeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { CodeBlock } from '@monad/ui/components/CodeBlock';
import { useEffect, useState } from 'react';

export type ObservationCollapseCommand = {
  collapsed: boolean;
};

export function ObservationCardShell({
  children,
  defaultCollapsed = false,
  header,
  raw,
  timestamp,
  visualRole,
  collapseCommand
}: {
  children: React.ReactNode;
  collapseCommand?: ObservationCollapseCommand;
  defaultCollapsed?: boolean;
  header?: React.ReactNode;
  raw: unknown;
  timestamp?: string;
  visualRole: ObservationVisualRole;
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(collapseCommand?.collapsed ?? defaultCollapsed);
  const [rawOpen, setRawOpen] = useState(false);
  const commandCollapsed = collapseCommand?.collapsed;

  useEffect(() => {
    if (commandCollapsed === undefined) return;
    setCollapsed(commandCollapsed);
    if (commandCollapsed) setRawOpen(false);
  }, [commandCollapsed]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      if (!value) setRawOpen(false);
      return !value;
    });
  };
  return (
    <article style={cardStyle(visualRole)}>
      <div style={headerRowStyle}>
        <button
          aria-expanded={!collapsed}
          className="workplace-action"
          onClick={toggleCollapsed}
          style={headerToggleStyle}
          type="button"
        >
          <span style={collapseIndicatorStyle(collapsed)}>
            <HugeiconsIcon
              aria-hidden="true"
              icon={ChevronDownIcon}
              size={13}
              strokeWidth={2}
            />
          </span>
          {header ? <div style={headerSlotStyle}>{header}</div> : null}
          <ObservationTimestamp value={timestamp} />
        </button>
        <ObservationHeaderActions
          onToggleRaw={() => setRawOpen((value) => !value)}
          rawOpen={rawOpen}
        />
      </div>
      {!collapsed && rawOpen ? <RawJsonPanel raw={raw} /> : null}
      {!collapsed ? <div style={bodySlotStyle(rawOpen)}>{children}</div> : null}
    </article>
  );
}

export function ObservationMeta({
  children,
  compact = false,
  label,
  showSource = false,
  source,
  title,
  type
}: {
  children?: React.ReactNode;
  compact?: boolean;
  label?: string;
  showSource?: boolean;
  source: string;
  title?: string;
  type?: string;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        marginBottom: compact ? 0 : 7,
        fontFamily: mono,
        fontSize: 10,
        lineHeight: 1.2,
        textTransform: 'uppercase'
      }}
    >
      {label ? <span style={metaPillStyle(label)}>{label}</span> : null}
      {title ? <span style={metaTitleStyle}>{title}</span> : null}
      {showSource ? <span style={metaTextStyle}>{source}</span> : null}
      {type ? <span style={metaTextStyle}>{type}</span> : null}
      {children}
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
  observationRole: ObservationVisualRole;
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
  result,
  provider
}: {
  call: ObservationItem;
  result: ObservationItem;
  provider: string;
}): React.ReactElement {
  return (
    <>
      <ObservationMeta
        label="tool"
        source={provider}
        type={call.tool?.name}
      />
      <ObservationText
        compact
        observationRole="tool"
        text={toolCallSummary(call.text ?? '')}
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
          source={provider}
          type={result.tool?.name}
        />
        <ObservationText
          contained
          observationRole="tool"
          text={result.text ?? ''}
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

export function rawJsonText(raw: unknown): string {
  if (raw === undefined) return 'null';
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

function ObservationHeaderActions({
  onToggleRaw,
  rawOpen
}: {
  onToggleRaw: () => void;
  rawOpen: boolean;
}): React.ReactElement {
  return (
    <div style={headerActionsStyle}>
      <button
        aria-expanded={rawOpen}
        aria-label={rawOpen ? 'Hide raw JSONL' : 'Show raw JSONL'}
        className="workplace-action"
        onClick={(event) => {
          event.stopPropagation();
          onToggleRaw();
        }}
        style={rawToggleButtonStyle(rawOpen)}
        title={rawOpen ? 'Hide raw JSONL' : 'Show raw JSONL'}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={SourceCodeIcon}
          size={13}
          strokeWidth={2}
        />
      </button>
    </div>
  );
}

function RawJsonPanel({ raw }: { raw: unknown }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const code = rawJsonText(raw);
  return (
    <section style={rawPanelStyle}>
      <div style={rawPanelHeaderStyle}>
        <span>raw json</span>
        <button
          aria-label="Copy raw JSON"
          className="workplace-action"
          onClick={async (event) => {
            event.stopPropagation();
            if (typeof window === 'undefined' || !navigator?.clipboard?.writeText) return;
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          style={rawCopyButtonStyle}
          title="Copy raw JSON"
          type="button"
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={copied ? CheckIcon : Copy01Icon}
            size={13}
            strokeWidth={2}
          />
        </button>
      </div>
      <CodeBlock
        className="[&>div]:scrollbar-none rounded-md border-0 bg-transparent text-[10.5px] [&>div::-webkit-scrollbar]:hidden [&>div]:max-h-64 [&>div]:overflow-auto [&_pre]:p-0 [&_pre]:text-[10.5px] [&_pre]:leading-[1.45]"
        code={code}
        language="json"
      />
    </section>
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

function cardStyle(role: ObservationVisualRole): CSSProperties {
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
    padding: '10px 12px',
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
  if (!tool || rawInput === undefined) return text;
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

const metaTitleStyle: CSSProperties = {
  maxWidth: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--foreground)',
  fontFamily: mono,
  fontSize: 11,
  fontWeight: 650,
  lineHeight: 1.2,
  textTransform: 'none'
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  width: '100%'
};

const headerToggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flex: 1,
  gap: 8,
  minWidth: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  padding: 0,
  textAlign: 'left'
};

const headerSlotStyle: CSSProperties = {
  flex: 1,
  minWidth: 0
};

function bodySlotStyle(rawOpen: boolean): CSSProperties {
  return {
    marginTop: rawOpen ? 10 : 9
  };
}

function collapseIndicatorStyle(collapsed: boolean): CSSProperties {
  return {
    width: 22,
    height: 22,
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    color: 'var(--muted-foreground)',
    transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
    transition: 'transform 150ms ease'
  };
}

const rawPanelStyle: CSSProperties = {
  boxSizing: 'border-box',
  maxWidth: '100%',
  minWidth: 0,
  overflow: 'hidden',
  marginTop: 10,
  marginBottom: 11,
  border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)',
  borderRadius: 8,
  background: 'color-mix(in srgb, var(--background) 82%, black)'
};

const rawPanelHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  borderBottom: '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
  color: 'var(--muted-foreground)',
  fontFamily: mono,
  fontSize: 10,
  lineHeight: 1,
  padding: '6px 7px 6px 9px',
  textTransform: 'uppercase'
};

const timestampStyle: CSSProperties = {
  color: 'var(--muted-foreground)',
  fontFamily: mono,
  fontSize: 10,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1,
  whiteSpace: 'nowrap'
};

const headerActionsStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  flex: 'none',
  gap: 7,
  maxWidth: '40%'
};

function rawToggleButtonStyle(open: boolean): CSSProperties {
  return {
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
  };
}

const rawCopyButtonStyle: CSSProperties = {
  width: 22,
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid color-mix(in srgb, var(--border) 78%, transparent)',
  borderRadius: 7,
  background: 'color-mix(in srgb, var(--background) 74%, transparent)',
  color: 'var(--muted-foreground)',
  padding: 0
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
