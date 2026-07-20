import type { AgentObservationCard } from '@monad/protocol';
import type { MeshAgentStreamView } from '../../../experience/types.ts';
import type { ObservationItem, ObservationTimelineEntry } from './types.ts';

import { DefaultObservationToolPair, ObservationMeta, ObservationText } from '@monad/ui';
import { memo } from 'react';

import { renderPrivateObservationCard } from './adapters.ts';
import { ObservationCardShell, type ObservationCollapseCommand, toolCallSummary } from './card-shell.tsx';
import { CodexMcpStartupProgressCard, type CodexMcpStartupUpdate } from './codex-startup-progress.tsx';
import { CommandToolCard, CommandToolHeader, commandToolView } from './command-card.tsx';
import { FileReadToolCard, FileReadToolHeader, fileReadToolView } from './file-read-card.tsx';
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

function observationCardIdentity(card: AgentObservationCard): string {
  return card.dedupeKey ?? card.id;
}

function cardEvent(card: AgentObservationCard): ObservationItem | undefined {
  const event = card.payload.event;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as ObservationItem) : undefined;
}

function cardToolCall(card: AgentObservationCard): ObservationItem | undefined {
  const event = card.payload.call;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as ObservationItem) : undefined;
}

function cardToolResult(card: AgentObservationCard): ObservationItem | undefined {
  const event = card.payload.result;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as ObservationItem) : undefined;
}

function sameObservationItem(left: AgentObservationCard, right: AgentObservationCard): boolean {
  if (
    left.id !== right.id ||
    left.dedupeKey !== right.dedupeKey ||
    left.kind !== right.kind ||
    left.streaming !== right.streaming ||
    left.at !== right.at
  )
    return false;
  return JSON.stringify([left.payload, left.provenance]) === JSON.stringify([right.payload, right.provenance]);
}

export function reconcileObservationItems(
  previous: readonly AgentObservationCard[],
  next: readonly AgentObservationCard[]
): AgentObservationCard[] {
  if (previous.length === 0) return next as AgentObservationCard[];
  const sharedLength = Math.min(previous.length, next.length);
  const reconciled = [...next];
  let changed = previous.length !== next.length;
  for (let index = 0; index < sharedLength; index += 1) {
    const previousItem = previous[index];
    const nextItem = next[index];
    if (!previousItem || !nextItem || observationCardIdentity(previousItem) !== observationCardIdentity(nextItem)) {
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
  if (!changed && reconciled.every((item, index) => item === previous[index]))
    return previous as AgentObservationCard[];
  return reconciled;
}

export function observationTimelineEntries(
  items: readonly MeshAgentStreamView['items'][number][],
  _provider: string,
  active = false
): ObservationTimelineEntry[] {
  const cards = items;
  return cards.map((card, index) => {
    const event = cardEvent(card) ?? cardToolCall(card) ?? cardToolResult(card);
    const timestampEvent = cardToolResult(card) ?? event;
    const streaming =
      card.kind === 'reasoning' && event ? active && index === cards.length - 1 && card.streaming : card.streaming;
    return {
      id: observationCardIdentity(card),
      kind: 'public',
      card: streaming === card.streaming ? card : { ...card, streaming },
      timestamp: timestampEvent
        ? observationTimestampLabel(timestampEvent)
        : card.at
          ? formatObservationTime(timestampMsFromIso(card.at) ?? 0)
          : undefined,
      contractEvents: card.provenance.contractEvents
    };
  });
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
  if (entry.kind === 'public' && entry.card.kind === 'tool') {
    const call = cardToolCall(entry.card);
    const result = cardToolResult(entry.card);
    const toolEvent = call ?? result;
    if (call && result) {
      const fileRead = fileReadToolView(call, result, provider);
      if (fileRead) {
        return (
          <ObservationCardShell
            collapseCommand={collapseCommand}
            defaultCollapsed
            header={<FileReadToolHeader view={fileRead} />}
            raw={raw}
            timestamp={entry.timestamp}
            visualRole="tool"
          >
            <FileReadToolCard view={fileRead} />
          </ObservationCardShell>
        );
      }
    }
    if (toolEvent) {
      const command = commandToolView(call ?? toolEvent, result ?? toolEvent, provider);
      if (command) {
        return (
          <ObservationCardShell
            collapseCommand={collapseCommand}
            defaultCollapsed
            header={<CommandToolHeader view={command} />}
            raw={raw}
            timestamp={entry.timestamp}
            visualRole="tool"
          >
            <CommandToolCard view={command} />
          </ObservationCardShell>
        );
      }
    }
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
            title={toolEvent ? toolPairName(toolEvent) : 'tool'}
          />
        }
        raw={raw}
        timestamp={entry.timestamp}
        visualRole="tool"
      >
        <DefaultObservationToolPair
          callText={toolCallSummary(call?.text ?? '')}
          callTool={call?.tool?.name}
          provider={provider}
          resultText={result?.text ?? ''}
          resultTool={result?.tool?.name}
        />
      </ObservationCardShell>
    );
  }
  const entryEvent = entry.kind === 'public' ? cardEvent(entry.card) : undefined;
  if (entry.kind === 'public' && entry.card.kind === 'diagnostic' && entryEvent?.diagnostic) {
    const diagnostic = entryEvent.diagnostic;
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
  if (entry.kind === 'public' && entry.card.kind === 'codex-mcp-startup-progress') {
    const updates = (
      Array.isArray(entry.card.payload.updates) ? entry.card.payload.updates : []
    ) as CodexMcpStartupUpdate[];
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
        <CodexMcpStartupProgressCard updates={updates} />
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.kind === 'reasoning' && entryEvent) {
    const thinkingStreaming = entry.card.streaming;
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
          text={entryEvent.text ?? ''}
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
  if (entry.kind === 'public' && entryEvent) {
    return (
      <GenericObservationCard
        collapseCommand={collapseCommand}
        entry={entry}
        item={entryEvent}
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
  return entries.map((entry) => ({ id: entry.id, entries: [entry] }));
}

function sameObservationEntrySource(left: ObservationTimelineEntry, right: ObservationTimelineEntry): boolean {
  if (left.id !== right.id || left.kind !== right.kind) return false;
  if (left.kind === 'private' && right.kind === 'private') return left.card.item === right.card.item;
  if (left.kind !== 'public' || right.kind !== 'public') return false;
  return (
    left.card === right.card ||
    (left.card.id === right.card.id &&
      left.card.kind === right.card.kind &&
      left.card.streaming === right.card.streaming &&
      JSON.stringify([left.card.payload, left.card.provenance]) ===
        JSON.stringify([right.card.payload, right.card.provenance]))
  );
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

function toolPairName(item: ObservationItem): string {
  if (item.tool?.name) return item.tool.name;
  const textName = /^Tool call\s+([^\s]+)/.exec((item.text ?? '').trim())?.[1];
  if (textName) return textName;
  return 'tool';
}

function observationTimestampLabel(item: ObservationItem): string | undefined {
  const timestamp = timestampMsFromIso(item.at);
  return timestamp === undefined ? undefined : formatObservationTime(timestamp);
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
