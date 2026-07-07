'use client';

import type { ExternalAgentStreamView } from '../../../experience/types.ts';
import type { ObservationItem, ObservationTimelineEntry, PublicObservationCard } from './types.ts';

import { ChevronDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { workspaceMono as mono } from '@monad/ui/components/AgentAvatar';
import { useEffect, useState } from 'react';

import {
  privateObservationCard,
  projectPublicObservationItem,
  projectPublicObservationPair,
  renderPrivateObservationCard
} from './adapters.ts';
import {
  DefaultToolPairContent,
  ObservationCardShell,
  type ObservationCollapseCommand,
  ObservationMeta,
  ObservationText
} from './card-shell.tsx';
import { CommandToolCard, CommandToolHeader } from './command-card.tsx';
import { FileReadToolCard, FileReadToolHeader } from './file-read-card.tsx';

const THINKING_LABEL_CSS = `
@keyframes workplace-observation-thinking-sheen {
  0% { background-position: 160% 50%; }
  100% { background-position: -60% 50%; }
}

.workplace-observation-thinking-label {
  position: relative;
  display: inline-block;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
  border-radius: 999px;
  color: color-mix(in srgb, var(--foreground) 72%, transparent);
  padding: 2px 6px;
}

.workplace-observation-thinking-label[data-streaming='true']::after {
  position: absolute;
  inset: 2px 6px;
  content: attr(data-label);
  background:
    linear-gradient(
      110deg,
      transparent 0%,
      transparent 38%,
      var(--foreground) 50%,
      transparent 62%,
      transparent 100%
    );
  background-size: 220% 100%;
  background-clip: text;
  color: transparent;
  pointer-events: none;
  animation: workplace-observation-thinking-sheen 1.45s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .workplace-observation-thinking-label[data-streaming='true']::after {
    animation: none;
  }
}
`;

export type ObservationTimelineRow = {
  id: string;
  entries: ObservationTimelineEntry[];
};

export function observationTimelineEntries(
  items: ExternalAgentStreamView['items'],
  provider: string
): ObservationTimelineEntry[] {
  const entries: ObservationTimelineEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = items[index + 1];
    if (item && next && isToolCallEvent(item) && isToolResultEvent(next)) {
      entries.push({
        id: `${item.id}:pair:${next.id}`,
        kind: 'public',
        card: projectPublicObservationPair(item, next, provider) ?? { type: 'tool-pair', call: item, result: next },
        timestamp: observationTimestampLabel(next),
        raw: { call: item.raw, result: next.raw }
      });
      index += 1;
      continue;
    }
    if (!item) continue;
    const publicCard = projectPublicObservationItem(item, provider);
    if (publicCard) {
      entries.push({
        id: item.id,
        kind: 'public',
        card: publicCard,
        timestamp: observationTimestampLabel(item),
        raw: item.raw
      });
      continue;
    }
    const privateCard = privateObservationCard(item);
    if (privateCard) {
      entries.push({
        id: item.id,
        kind: 'private',
        card: privateCard,
        timestamp: observationTimestampLabel(item),
        raw: item.raw
      });
      continue;
    }
    entries.push({
      id: item.id,
      kind: 'public',
      card: { type: 'message', role: item.kind === 'user-message' ? 'user' : 'agent', item },
      timestamp: observationTimestampLabel(item),
      raw: item.raw
    });
  }
  return entries;
}

function visualRoleFromKind(kind: ObservationItem['kind']): 'user' | 'agent' | 'tool' {
  if (kind === 'user-message') return 'user';
  if (kind === 'tool-call' || kind === 'tool-result') return 'tool';
  return 'agent';
}

function ObservationTimelineCard({
  collapseCommand,
  entry,
  provider
}: {
  collapseCommand?: ObservationCollapseCommand;
  entry: ObservationTimelineEntry;
  provider: string;
}): React.ReactElement {
  if (entry.kind === 'private') {
    const rendered = renderPrivateObservationCard(entry.card);
    if (rendered) {
      return (
        <ObservationCardShell
          collapseCommand={collapseCommand}
          header={
            <ObservationMeta
              compact
              label="tool"
              source={entry.card.provider}
              type={entry.card.type}
            />
          }
          raw={entry.raw}
          timestamp={entry.timestamp}
          visualRole="tool"
        >
          {rendered}
        </ObservationCardShell>
      );
    }
  }
  if (entry.kind === 'public' && entry.card.type === 'tool-pair') {
    return (
      <ObservationCardShell
        collapseCommand={collapseCommand}
        defaultCollapsed
        header={
          <ObservationMeta
            compact
            label="tool call"
            showSource={false}
            source={provider}
            title={toolPairName(entry.card.call)}
          />
        }
        raw={entry.raw}
        timestamp={entry.timestamp}
        visualRole="tool"
      >
        <DefaultToolPairContent
          call={entry.card.call}
          provider={provider}
          result={entry.card.result}
        />
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.type === 'command-tool') {
    return (
      <ObservationCardShell
        collapseCommand={collapseCommand}
        defaultCollapsed
        header={<CommandToolHeader view={entry.card.view} />}
        raw={entry.raw}
        timestamp={entry.timestamp}
        visualRole="tool"
      >
        <CommandToolCard view={entry.card.view} />
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.type === 'file-read-tool') {
    return (
      <ObservationCardShell
        collapseCommand={collapseCommand}
        defaultCollapsed
        header={<FileReadToolHeader view={entry.card.view} />}
        raw={entry.raw}
        timestamp={entry.timestamp}
        visualRole="tool"
      >
        <FileReadToolCard view={entry.card.view} />
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.type === 'thinking') {
    const thinkingStreaming = isStreamingThinkingObservation(entry.card.item);
    return (
      <ObservationCardShell
        collapseCommand={collapseCommand}
        header={
          <ObservationMeta
            compact
            source={provider}
          >
            <style>{THINKING_LABEL_CSS}</style>
            <span
              className="workplace-observation-thinking-label"
              data-label="thinking"
              data-streaming={thinkingStreaming ? 'true' : undefined}
            >
              thinking
            </span>
          </ObservationMeta>
        }
        raw={entry.raw}
        timestamp={entry.timestamp}
        visualRole="agent"
      >
        <ObservationText
          contained
          observationRole="agent"
          text={entry.card.item.text ?? ''}
        />
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'private') {
    return (
      <GenericObservationCard
        collapseCommand={collapseCommand}
        entry={entry}
        item={entry.card.item}
        provider={provider}
      />
    );
  }
  if (entry.card.type === 'message') {
    return (
      <GenericObservationCard
        collapseCommand={collapseCommand}
        entry={entry}
        item={entry.card.item}
        provider={provider}
      />
    );
  }
  return (
    <ObservationCardShell
      collapseCommand={collapseCommand}
      header={
        <ObservationMeta
          compact
          label="system"
          source="unknown"
          type="unsupported"
        />
      }
      raw={entry.raw}
      timestamp={entry.timestamp}
      visualRole="system"
    >
      <ObservationText
        observationRole="system"
        text="Unsupported observation card."
      />
    </ObservationCardShell>
  );
}

function GenericObservationCard({
  collapseCommand,
  entry,
  item,
  provider
}: {
  collapseCommand?: ObservationCollapseCommand;
  entry: ObservationTimelineEntry;
  item: ObservationItem;
  provider: string;
}): React.ReactElement {
  const role = visualRoleFromKind(item.kind);
  const header =
    role === 'user' ? null : (
      <ObservationMeta
        compact
        label={role}
        source={provider}
        type={item.tool?.name}
      />
    );
  return (
    <ObservationCardShell
      collapseCommand={collapseCommand}
      header={header}
      raw={entry.raw}
      timestamp={entry.timestamp}
      visualRole={role}
    >
      <ObservationText
        observationRole={role}
        text={item.text ?? ''}
      />
    </ObservationCardShell>
  );
}

export function observationTimelineRows(entries: ObservationTimelineEntry[]): ObservationTimelineRow[] {
  const rows: ObservationTimelineRow[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (!isToolEntry(entry)) {
      rows.push({ id: entry.id, entries: [entry] });
      continue;
    }
    const toolEntries = [entry];
    while (true) {
      const next = entries[index + 1];
      if (!isToolEntry(next)) break;
      toolEntries.push(next);
      index += 1;
    }
    if (toolEntries.length === 1) {
      rows.push({ id: entry.id, entries: [entry] });
    } else {
      rows.push({ id: `tool-group:${toolEntries[0]?.id}`, entries: toolEntries });
    }
  }
  return rows;
}

export function ObservationTimelineRowView({
  collapseCommand,
  row,
  provider
}: {
  collapseCommand?: ObservationCollapseCommand;
  row: ObservationTimelineRow;
  provider: string;
}): React.ReactElement | null {
  const first = row.entries[0];
  if (row.entries.length > 1 && isToolEntry(first))
    return (
      <ToolCallGroup
        collapseCommand={collapseCommand}
        entries={row.entries as ToolTimelineEntry[]}
        provider={provider}
      />
    );
  return first ? (
    <ObservationTimelineCard
      collapseCommand={collapseCommand}
      entry={first}
      provider={provider}
    />
  ) : null;
}

function _ObservationTimelineCards({
  collapseCommand,
  entries,
  provider
}: {
  collapseCommand?: ObservationCollapseCommand;
  entries: ObservationTimelineEntry[];
  provider: string;
}): React.ReactElement {
  return (
    <>
      {observationTimelineRows(entries).map((row) => (
        <ObservationTimelineRowView
          collapseCommand={collapseCommand}
          key={row.id}
          provider={provider}
          row={row}
        />
      ))}
    </>
  );
}

type ToolObservationCard = Extract<PublicObservationCard, { type: 'command-tool' | 'file-read-tool' | 'tool-pair' }>;
type ToolTimelineEntry = ObservationTimelineEntry & { kind: 'public'; card: ToolObservationCard };

function ToolCallGroup({
  collapseCommand,
  entries,
  provider
}: {
  collapseCommand?: ObservationCollapseCommand;
  entries: ToolTimelineEntry[];
  provider: string;
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(collapseCommand?.collapsed ?? true);
  const commandCollapsed = collapseCommand?.collapsed;
  useEffect(() => {
    if (commandCollapsed === undefined) return;
    setCollapsed(commandCollapsed);
  }, [commandCollapsed]);
  return (
    <section style={toolGroupStyle}>
      <button
        className="workplace-action"
        onClick={() => setCollapsed((value) => !value)}
        style={toolGroupHeaderStyle}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={ChevronDownIcon}
          size={13}
          strokeWidth={2}
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}
        />
        <span>{entries.length} tool calls</span>
      </button>
      {!collapsed ? (
        <div style={toolGroupBodyStyle}>
          {entries.map((entry) => (
            <ObservationTimelineCard
              collapseCommand={collapseCommand}
              entry={entry}
              key={entry.id}
              provider={provider}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function isToolEntry(entry: ObservationTimelineEntry | undefined): entry is ToolTimelineEntry {
  return (
    !!entry &&
    entry.kind === 'public' &&
    (entry.card.type === 'command-tool' || entry.card.type === 'file-read-tool' || entry.card.type === 'tool-pair')
  );
}

function toolPairName(item: ObservationItem): string {
  if (item.tool?.name) return item.tool.name;
  const textName = /^Tool call\s+([^\s]+)/.exec((item.text ?? '').trim())?.[1];
  if (textName) return textName;
  return toolNameFromRaw(item.raw) ?? 'tool';
}

function toolNameFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const direct = record.name ?? record.tool ?? record.type;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const params = record.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const item = (params as Record<string, unknown>).item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const nested =
    (item as Record<string, unknown>).name ??
    (item as Record<string, unknown>).tool ??
    (item as Record<string, unknown>).type;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined;
}

function isToolCallEvent(item: ObservationItem): boolean {
  return item.kind === 'tool-call';
}

function isToolResultEvent(item: ObservationItem): boolean {
  return item.kind === 'tool-result';
}

function observationTimestampLabel(item: ObservationItem): string | undefined {
  const timestamp = timestampMsFromIso(item.at);
  return timestamp === undefined ? undefined : formatObservationTime(timestamp);
}

function isStreamingThinkingObservation(item: ObservationItem): boolean {
  return item.kind === 'reasoning' && item.streaming;
}

function formatObservationTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(timestamp));
}

function timestampMsFromIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

const toolGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0
};

const toolGroupHeaderStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid color-mix(in srgb, #f59e0b 34%, var(--border))',
  borderRadius: 999,
  background: 'color-mix(in srgb, #f59e0b 8%, transparent)',
  color: 'var(--muted-foreground)',
  fontFamily: mono,
  fontSize: 11,
  padding: '3px 8px'
};

const toolGroupBodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0
};
