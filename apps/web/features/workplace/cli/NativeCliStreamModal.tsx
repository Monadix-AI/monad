'use client';

import type { CSSProperties } from 'react';
import type { NativeCliStreamView, Participant } from '../types';

import { Cancel01Icon, SourceCodeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ProductIcon } from '@monad/ui';
import { useEffect, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { AgentIdentity, AgentInstanceAvatar, resolveProductIcon } from '../Bits';
import { mono, presenceColor, sans } from '../styles';

const observationAvatarRingCss = `
@keyframes workplace-observation-avatar-breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--observation-presence-color) 58%, transparent); }
  50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--observation-presence-color) 0%, transparent); }
}

@keyframes workplace-observation-avatar-radiate {
  0% {
    opacity: 0.72;
    transform: scale(0.9);
  }
  70%, 100% {
    opacity: 0;
    transform: scale(1.65);
  }
}

.workplace-observation-avatar {
  position: relative;
  display: inline-grid;
  flex: none;
  place-items: center;
  border: 1.5px solid transparent;
  border-radius: 999px;
}

.workplace-observation-avatar[data-active='true'] {
  border-color: var(--observation-presence-color);
  animation: workplace-observation-avatar-breathe 1.8s ease-in-out infinite;
}

.workplace-observation-avatar[data-active='true']::after {
  position: absolute;
  inset: -3px;
  border: 1.5px solid color-mix(in srgb, var(--observation-presence-color) 72%, transparent);
  border-radius: inherit;
  content: '';
  pointer-events: none;
  animation: workplace-observation-avatar-radiate 1.8s ease-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .workplace-observation-avatar,
  .workplace-observation-avatar::after {
    animation: none;
  }
}
`;

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
  focusTurnId?: string;
  icon?: NativeCliStreamView['icon'];
  onBack?: () => void;
  onClose?: () => void;
  onStop: (id: string) => void;
  stream?: NativeCliStreamView;
}): React.ReactElement {
  const t = useT();
  const displayAgent = agent ?? {
    av: (stream?.agentName ?? agentName ?? 'Agent').slice(0, 2).toUpperCase(),
    icon: stream?.icon ?? icon,
    kind: 'agent' as const,
    name: stream?.agentName ?? agentName ?? 'Agent',
    presence: stream?.status === 'running' ? ('working' as const) : ('online' as const),
    tag: stream?.tag ?? 'Agent'
  };
  const productIcon = resolveProductIcon(displayAgent);
  const active = stream?.status === 'running';
  const hasItems = (stream?.items.length ?? 0) > 0;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || stream?.status !== 'running') return;
    scroller.scrollTop = scroller.scrollHeight;
  });

  return (
    <section
      style={
        {
          '--observation-presence-color': presenceColor(active ? 'working' : displayAgent.presence),
          minHeight: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        } as CSSProperties
      }
    >
      <style>{observationAvatarRingCss}</style>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 14px 12px',
          borderBottom: '1px solid var(--border)',
          boxSizing: 'border-box',
          maxWidth: '100%',
          minWidth: 0,
          overflow: 'hidden'
        }}
      >
        {onBack ? (
          <button
            aria-label={t('web.workplace.backToAgents')}
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
        <span
          className="workplace-observation-avatar"
          data-active={active ? 'true' : undefined}
        >
          <AgentInstanceAvatar
            agent={displayAgent}
            bordered={active}
            size={30}
          />
        </span>
        <div style={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', flex: 1 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              minWidth: 0,
              maxWidth: '100%',
              overflow: 'hidden'
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
        </div>
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
              padding: '7px 10px',
              flex: 'none'
            }}
            type="button"
          >
            Stop
          </button>
        ) : null}
        {onClose ? (
          <button
            aria-label={t('web.workplace.closeObservation')}
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
            <HugeiconsIcon
              aria-hidden="true"
              icon={Cancel01Icon}
              size={15}
            />
          </button>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        style={{
          minWidth: 0,
          minHeight: 0,
          boxSizing: 'border-box',
          width: '100%',
          maxWidth: '100%',
          flex: 1,
          overflowX: 'hidden',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        }}
      >
        {hasItems ? (
          observationTimelineEntries(stream?.items ?? []).map((entry) => (
            <ObservationTimelineCard
              entry={entry}
              key={entry.id}
            />
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
    </section>
  );
}

type ObservationItem = NativeCliStreamView['items'][number];

type ObservationTimelineEntry =
  | { id: string; kind: 'event'; item: ObservationItem }
  | { id: string; kind: 'tool-pair'; call: ObservationItem; result: ObservationItem };

function observationTimelineEntries(items: NativeCliStreamView['items']): ObservationTimelineEntry[] {
  const entries: ObservationTimelineEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = items[index + 1];
    if (item && next && isToolCallEvent(item) && isToolResultEvent(next)) {
      entries.push({ id: `${item.id}:pair:${next.id}`, kind: 'tool-pair', call: item, result: next });
      index += 1;
      continue;
    }
    if (item) entries.push({ id: item.id, kind: 'event', item });
  }
  return entries;
}

function isToolCallEvent(item: ObservationItem): boolean {
  return (
    item.role === 'tool' &&
    (item.providerEventType === 'function_call' ||
      item.providerEventType === 'tool_use' ||
      item.providerEventType === 'content_block_start' ||
      item.text.startsWith('Tool call '))
  );
}

function isToolResultEvent(item: ObservationItem): boolean {
  return (
    item.role === 'tool' &&
    (item.providerEventType === 'function_call_output' ||
      item.providerEventType === 'tool_result' ||
      item.id.includes(':tool-result') ||
      item.id.includes(':function-output'))
  );
}

function ObservationTimelineCard({ entry }: { entry: ObservationTimelineEntry }): React.ReactElement {
  if (entry.kind === 'tool-pair') {
    return (
      <article style={cardStyle('tool')}>
        <RawJsonToggle raw={{ call: entry.call.raw, result: entry.result.raw }} />
        <ObservationMeta
          label="tool"
          source={entry.call.source}
          type={entry.call.providerEventType}
        />
        <ObservationText
          compact
          observationRole="tool"
          text={toolCallSummary(entry.call.text)}
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
            source={entry.result.source}
            type={entry.result.providerEventType}
          />
          <ObservationText
            contained
            observationRole="tool"
            text={entry.result.text}
          />
        </div>
      </article>
    );
  }
  return (
    <article style={cardStyle(entry.item.role)}>
      <RawJsonToggle raw={entry.item.raw} />
      <ObservationMeta
        label={entry.item.role}
        source={entry.item.source}
        type={entry.item.providerEventType}
      />
      <ObservationText
        observationRole={entry.item.role}
        text={entry.item.text}
      />
    </article>
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

function ObservationMeta({
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

function ObservationText({
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
    padding: '10px 42px 10px 12px',
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

const metaTextStyle: CSSProperties = {
  color: 'var(--muted-foreground)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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
