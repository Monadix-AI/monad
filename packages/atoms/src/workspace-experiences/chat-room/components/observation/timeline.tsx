import type { MeshAgentStreamView } from '../../../experience/types.ts';
import type { ObservationItem, ObservationTimelineEntry, PublicObservationCard } from './types.ts';

import { DefaultObservationToolPair, ObservationMeta, ObservationText } from '@monad/ui';
import { workspaceMono as mono } from '@monad/ui/components/AgentAvatar';
import { MorphChevron } from '@monad/ui/components/MorphChevron';
import { memo, useEffect, useState } from 'react';

import {
  privateObservationCard,
  projectPublicObservationItem,
  projectPublicObservationPair,
  renderPrivateObservationCard
} from './adapters.ts';
import { ObservationCardShell, type ObservationCollapseCommand, toolCallSummary } from './card-shell.tsx';
import {
  CodexMcpStartupProgressCard,
  codexMcpStartupUpdate,
  collapseCodexMcpStartupUpdates
} from './codex-startup-progress.tsx';
import { CommandToolCard, CommandToolHeader } from './command-card.tsx';
import { FileReadToolCard, FileReadToolHeader } from './file-read-card.tsx';
import { observationContractRawEvents } from './provenance.ts';

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

function observationItemIdentity(item: ObservationItem): string {
  return item.dedupeKey ?? item.id;
}

function sameObservationItem(left: ObservationItem, right: ObservationItem): boolean {
  if (
    left.id !== right.id ||
    left.dedupeKey !== right.dedupeKey ||
    left.kind !== right.kind ||
    left.streaming !== right.streaming ||
    left.text !== right.text ||
    left.reason !== right.reason ||
    left.at !== right.at
  )
    return false;
  return (
    JSON.stringify([left.tool, left.diagnostic, left.provenance]) ===
    JSON.stringify([right.tool, right.diagnostic, right.provenance])
  );
}

export function reconcileObservationItems(
  previous: readonly ObservationItem[],
  next: readonly ObservationItem[]
): ObservationItem[] {
  if (previous.length === 0) return next as ObservationItem[];
  const sharedLength = Math.min(previous.length, next.length);
  const reconciled = [...next];
  let changed = previous.length !== next.length;
  for (let index = 0; index < sharedLength; index += 1) {
    const previousItem = previous[index];
    const nextItem = next[index];
    if (!previousItem || !nextItem || observationItemIdentity(previousItem) !== observationItemIdentity(nextItem)) {
      changed = true;
      continue;
    }
    const atMutableBoundary = index === sharedLength - 1;
    if (atMutableBoundary && !sameObservationItem(previousItem, nextItem)) {
      changed = true;
      continue;
    }
    reconciled[index] = previousItem;
  }
  if (!changed && reconciled.every((item, index) => item === previous[index])) return previous as ObservationItem[];
  return reconciled;
}

export function observationTimelineEntries(
  items: readonly MeshAgentStreamView['items'][number][],
  provider: string,
  active = false
): ObservationTimelineEntry[] {
  const entries: ObservationTimelineEntry[] = [];
  const resultIndexByCallIndex = toolPairResultIndexes(items);
  const pairedResultIndexes = new Set(resultIndexByCallIndex.values());
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (pairedResultIndexes.has(index)) continue;
    const startupUpdate = item ? codexMcpStartupUpdate(item) : null;
    if (item && startupUpdate) {
      const startupItems = [item];
      const updates = [startupUpdate];
      while (true) {
        const candidate = items[index + 1];
        if (!candidate) break;
        const candidateUpdate = codexMcpStartupUpdate(candidate);
        if (!candidateUpdate) break;
        startupItems.push(candidate);
        updates.push(candidateUpdate);
        index += 1;
      }
      const latest = startupItems.at(-1) ?? item;
      entries.push({
        id: `codex-mcp-startup:${observationItemIdentity(item)}`,
        kind: 'public',
        card: { type: 'codex-mcp-startup-progress', updates: collapseCodexMcpStartupUpdates(updates) },
        timestamp: observationTimestampLabel(latest),
        contractEvents: startupItems.flatMap((startupItem) => startupItem.provenance.contractEvents)
      });
      continue;
    }
    const resultIndex = resultIndexByCallIndex.get(index);
    const result = resultIndex === undefined ? undefined : items[resultIndex];
    if (item && result && isToolCallEvent(item) && isToolResultEvent(result)) {
      const itemId = observationItemIdentity(item);
      entries.push({
        id: itemId,
        kind: 'public',
        card: projectPublicObservationPair(item, result, provider) ?? { type: 'tool-pair', call: item, result },
        timestamp: observationTimestampLabel(result),
        contractEvents: [...item.provenance.contractEvents, ...result.provenance.contractEvents]
      });
      continue;
    }
    if (!item) continue;
    const itemId = observationItemIdentity(item);
    const timelineItem =
      item.kind === 'reasoning' ? { ...item, streaming: active && index === items.length - 1 && item.streaming } : item;
    const publicCard = projectPublicObservationItem(timelineItem, provider);
    if (publicCard) {
      entries.push({
        id: itemId,
        kind: 'public',
        card: publicCard,
        timestamp: observationTimestampLabel(timelineItem),
        contractEvents: timelineItem.provenance.contractEvents
      });
      continue;
    }
    const privateCard = privateObservationCard(timelineItem);
    if (privateCard) {
      entries.push({
        id: itemId,
        kind: 'private',
        card: privateCard,
        timestamp: observationTimestampLabel(timelineItem),
        contractEvents: timelineItem.provenance.contractEvents
      });
      continue;
    }
    entries.push({
      id: itemId,
      kind: 'public',
      card: { type: 'message', role: timelineItem.kind === 'user-message' ? 'user' : 'agent', item: timelineItem },
      timestamp: observationTimestampLabel(timelineItem),
      contractEvents: timelineItem.provenance.contractEvents
    });
  }
  return entries;
}

function toolPairResultIndexes(items: readonly MeshAgentStreamView['items'][number][]): Map<number, number> {
  const resultIndexesByCallId = new Map<string, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const callId = item && isToolResultEvent(item) ? item.tool?.callId : undefined;
    if (!callId) continue;
    const indexes = resultIndexesByCallId.get(callId) ?? [];
    indexes.push(index);
    resultIndexesByCallId.set(callId, indexes);
  }

  const resultIndexByCallIndex = new Map<number, number>();
  const pairedResultIndexes = new Set<number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || !isToolCallEvent(item) || !item.tool?.callId) continue;
    const resultIndex = resultIndexesByCallId
      .get(item.tool.callId)
      ?.find((candidateIndex) => !pairedResultIndexes.has(candidateIndex));
    if (resultIndex === undefined) continue;
    resultIndexByCallIndex.set(index, resultIndex);
    pairedResultIndexes.add(resultIndex);
  }

  for (let index = 0; index < items.length - 1; index += 1) {
    if (resultIndexByCallIndex.has(index)) continue;
    const call = items[index];
    const result = items[index + 1];
    if (!call || !result || !isToolCallEvent(call) || !isToolResultEvent(result)) continue;
    if (pairedResultIndexes.has(index + 1)) continue;
    const callId = call.tool?.callId;
    const resultId = result.tool?.callId;
    if (callId && resultId && callId !== resultId) continue;
    resultIndexByCallIndex.set(index, index + 1);
    pairedResultIndexes.add(index + 1);
  }
  return resultIndexByCallIndex;
}

function visualRoleFromKind(kind: ObservationItem['kind']): 'user' | 'agent' | 'tool' | 'system' {
  if (kind === 'user-message') return 'user';
  if (kind === 'tool-call' || kind === 'tool-result') return 'tool';
  if (kind === 'system' || kind === 'unknown') return 'system';
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
  const raw = observationContractRawEvents(entry.contractEvents);
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
          raw={raw}
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
        raw={raw}
        timestamp={entry.timestamp}
        visualRole="tool"
      >
        <DefaultObservationToolPair
          callText={toolCallSummary(entry.card.call.text ?? '')}
          callTool={entry.card.call.tool?.name}
          provider={provider}
          resultText={entry.card.result.text ?? ''}
          resultTool={entry.card.result.tool?.name}
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
        raw={raw}
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
        raw={raw}
        timestamp={entry.timestamp}
        visualRole="tool"
      >
        <FileReadToolCard view={entry.card.view} />
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.type === 'diagnostic' && entry.card.item.diagnostic) {
    const diagnostic = entry.card.item.diagnostic;
    return (
      <ObservationCardShell
        collapseCommand={collapseCommand}
        header={
          <ObservationMeta
            compact
            label={diagnostic.severity}
            showSource={!!diagnostic.target}
            source={diagnostic.target ?? provider}
            title={diagnostic.message}
          />
        }
        raw={raw}
        timestamp={entry.timestamp}
        visualRole={diagnostic.severity}
      >
        {diagnostic.detail ? (
          <ObservationText
            contained
            observationRole={diagnostic.severity}
            text={diagnostic.detail}
          />
        ) : null}
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.type === 'codex-mcp-startup-progress') {
    return (
      <ObservationCardShell
        collapseCommand={collapseCommand}
        header={
          <ObservationMeta
            compact
            label="system"
            source={provider}
            title="Startup progress"
          />
        }
        raw={raw}
        timestamp={entry.timestamp}
        visualRole="system"
      >
        <CodexMcpStartupProgressCard updates={entry.card.updates} />
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
        raw={raw}
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
      raw={raw}
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
  const raw = observationContractRawEvents(entry.contractEvents);
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
      defaultCollapsed={item.kind === 'unknown'}
      header={header}
      raw={raw}
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
    rows.push({ id: `tool-group:${toolEntries.at(-1)?.id ?? entry.id}`, entries: toolEntries });
  }
  return rows;
}

function sameObservationEntrySource(left: ObservationTimelineEntry, right: ObservationTimelineEntry): boolean {
  if (left.id !== right.id || left.kind !== right.kind || left.card.type !== right.card.type) return false;
  if (left.kind === 'private' && right.kind === 'private') return left.card.item === right.card.item;
  if (left.kind !== 'public' || right.kind !== 'public') return false;
  if (left.card.type === 'tool-pair' && right.card.type === 'tool-pair')
    return left.card.call === right.card.call && left.card.result === right.card.result;
  if (
    (left.card.type === 'message' && right.card.type === 'message') ||
    (left.card.type === 'thinking' && right.card.type === 'thinking') ||
    (left.card.type === 'diagnostic' && right.card.type === 'diagnostic')
  )
    return left.card.item === right.card.item;
  return left.contractEvents === right.contractEvents;
}

export function reconcileObservationTimelineRows(
  previous: readonly ObservationTimelineRow[],
  next: readonly ObservationTimelineRow[]
): ObservationTimelineRow[] {
  if (previous.length === 0) return next as ObservationTimelineRow[];
  const reusable = new Map(previous.map((row) => [row.id, row]));
  const reconciled = next.map((row) => {
    const candidate = reusable.get(row.id);
    if (!candidate || candidate.entries.length !== row.entries.length) return row;
    return candidate.entries.every((entry, index) => {
      const nextEntry = row.entries[index];
      return nextEntry ? sameObservationEntrySource(entry, nextEntry) : false;
    })
      ? candidate
      : row;
  });
  if (reconciled.length === previous.length && reconciled.every((row, index) => row === previous[index]))
    return previous as ObservationTimelineRow[];
  return reconciled;
}

function ObservationTimelineRowViewImpl({
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

export const ObservationTimelineRowView = memo(ObservationTimelineRowViewImpl);

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
        <MorphChevron
          expanded={!collapsed}
          size={13}
          strokeWidth={2}
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
  return 'tool';
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
