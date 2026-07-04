'use client';

import type { NativeCliStreamView } from '../../../project/types.ts';
import type { ObservationItem, ObservationTimelineEntry } from './types.ts';

import {
  privateObservationCard,
  projectPublicObservationItem,
  projectPublicObservationPair,
  renderPrivateObservationCard
} from './adapters.ts';
import { DefaultToolPairContent, ObservationCardShell, ObservationMeta, ObservationText } from './card-shell.tsx';
import { CommandToolCard } from './command-card.tsx';
import { FileReadToolCard } from './file-read-card.tsx';

export function observationTimelineEntries(items: NativeCliStreamView['items']): ObservationTimelineEntry[] {
  const entries: ObservationTimelineEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = items[index + 1];
    if (item && next && isToolCallEvent(item) && isToolResultEvent(next)) {
      entries.push({
        id: `${item.id}:pair:${next.id}`,
        kind: 'public',
        card: projectPublicObservationPair(item, next) ?? { type: 'tool-pair', call: item, result: next },
        timestamp: observationTimestampLabel(next),
        raw: { call: item.raw, result: next.raw }
      });
      index += 1;
      continue;
    }
    if (!item) continue;
    const publicCard = projectPublicObservationItem(item);
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
      card: { type: 'message', role: item.role, item },
      timestamp: observationTimestampLabel(item),
      raw: item.raw
    });
  }
  return entries;
}

export function ObservationTimelineCard({ entry }: { entry: ObservationTimelineEntry }): React.ReactElement {
  if (entry.kind === 'private') {
    const rendered = renderPrivateObservationCard(entry.card);
    if (rendered) {
      return (
        <ObservationCardShell
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
        raw={entry.raw}
        timestamp={entry.timestamp}
        visualRole="tool"
      >
        <DefaultToolPairContent
          call={entry.card.call}
          result={entry.card.result}
        />
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'public' && entry.card.type === 'command-tool') {
    return (
      <ObservationCardShell
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
        raw={entry.raw}
        timestamp={entry.timestamp}
        visualRole="tool"
      >
        <FileReadToolCard view={entry.card.view} />
      </ObservationCardShell>
    );
  }
  if (entry.kind === 'private') {
    return (
      <GenericObservationCard
        entry={entry}
        item={entry.card.item}
      />
    );
  }
  if (entry.card.type === 'message') {
    return (
      <GenericObservationCard
        entry={entry}
        item={entry.card.item}
      />
    );
  }
  return (
    <ObservationCardShell
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
  entry,
  item
}: {
  entry: ObservationTimelineEntry;
  item: ObservationItem;
}): React.ReactElement {
  return (
    <ObservationCardShell
      raw={entry.raw}
      timestamp={entry.timestamp}
      visualRole={item.role}
    >
      <ObservationMeta
        label={item.role}
        source={item.source}
        type={item.providerEventType}
      />
      <ObservationText
        observationRole={item.role}
        text={item.text}
      />
    </ObservationCardShell>
  );
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
      item.providerEventType === 'item/commandExecution/outputDelta' ||
      item.id.includes(':tool-result') ||
      item.id.includes(':function-output'))
  );
}

function observationTimestampLabel(item: ObservationItem): string | undefined {
  const timestamp =
    timestampMsFromUnknown(item.raw) ?? timestampMsFromUnknown(item.createdAt) ?? timestampMsFromUnknown(item.text);
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

function timestampMsFromUnknown(value: unknown, depth = 0): number | undefined {
  if (depth > 5 || value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return timestampMsFromUnknown(Number(trimmed), depth + 1);
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return timestampMsFromUnknown(JSON.parse(trimmed) as unknown, depth + 1);
      } catch {}
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (Array.isArray(value)) {
    return latestTimestamp(value.map((item) => timestampMsFromUnknown(item, depth + 1)));
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const direct = latestTimestamp([
    timestampMsFromUnknown(record.createdAt, depth + 1),
    timestampMsFromUnknown(record.updatedAt, depth + 1),
    timestampMsFromUnknown(record.timestamp, depth + 1),
    timestampMsFromUnknown(record.time, depth + 1)
  ]);
  if (direct !== undefined) return direct;
  return latestTimestamp(
    ['params', 'item', 'message', 'thread', 'turn', 'output', 'result', 'content', 'aggregatedOutput'].map((key) =>
      timestampMsFromUnknown(record[key], depth + 1)
    )
  );
}

function latestTimestamp(values: Array<number | undefined>): number | undefined {
  const timestamps = values.filter((value): value is number => value !== undefined);
  return timestamps.length === 0 ? undefined : Math.max(...timestamps);
}
