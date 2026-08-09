import type { MeshAgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationJsonRecordEntry } from '../../observation-projection.ts';

import {
  numberValue,
  observation,
  providerEpochMsTimestamp,
  rawTextValue,
  recordValue,
  textValue,
  thinkingObservation
} from '../../observation-projection.ts';
import {
  codexAppServerToolCallObservation,
  codexAppServerToolResultObservation,
  hasCodexAppServerToolOutput,
  isCodexAppServerToolLikeItem
} from './observation-app-server-tool.ts';

type CodexMessageGroup = {
  key: string;
  kind: 'agent' | 'reasoning' | 'user';
  raw: Record<string, unknown>[];
  rawLines: string[];
  fragments: string[];
  summaryFragments: string[];
  startedText?: string;
  startedSummaries?: string[];
  completedText?: string;
  completedSummaries?: string[];
  startedAt?: string;
  completedAt?: string;
};

type CodexToolGroup = {
  key: string;
  kind: 'tool';
  raw: Record<string, unknown>[];
  rawLines: string[];
  fragments: string[];
  startedItem?: Record<string, unknown>;
  completedItem?: Record<string, unknown>;
  startedRecord?: Record<string, unknown>;
  completedRecord?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
};

type CodexObservationGroup = CodexMessageGroup | CodexToolGroup;

const CODEX_TOOL_DELTA_METHODS = new Set([
  'item/commandExecution/outputDelta',
  'command/exec/outputDelta',
  'process/outputDelta',
  'item/fileChange/outputDelta',
  'item/mcpToolCall/progress'
]);

export function codexItemText(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const direct = rawTextValue(item.text);
  if (direct !== undefined) return direct;
  if (item.type === 'reasoning' || item.type === 'thinking') {
    const content = item.content;
    if (Array.isArray(content)) {
      const text = content.filter((part): part is string => typeof part === 'string').join('\n\n');
      if (text) return text;
    }
  }
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const text = rawTextValue((part as Record<string, unknown>).text, (part as Record<string, unknown>).content);
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join('') : undefined;
}

export function codexItemSummaries(item: Record<string, unknown> | undefined): string[] {
  if (!item || (item.type !== 'reasoning' && item.type !== 'thinking') || !Array.isArray(item.summary)) return [];
  return item.summary
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function codexItemSummary(item: Record<string, unknown> | undefined): string | undefined {
  const summary = codexItemSummaries(item).join('\n\n');
  return summary || undefined;
}

function codexObservationGroup(
  record: Record<string, unknown>
): { key: string; kind: CodexObservationGroup['kind'] } | undefined {
  const method = textValue(record.method);
  if (!method) return undefined;
  const params = recordValue(record.params);
  if (!params) return undefined;
  const item = recordValue(params.item);
  if (method === 'item/started' || method === 'item/completed') {
    const itemType = textValue(item?.type);
    const kind =
      itemType === 'agentMessage'
        ? 'agent'
        : itemType === 'userMessage'
          ? 'user'
          : itemType === 'reasoning'
            ? 'reasoning'
            : undefined;
    const itemId = textValue(item?.id);
    if (!itemId) return undefined;
    if (!kind && item && isCodexAppServerToolLikeItem(item)) {
      return {
        key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'),
        kind: 'tool'
      };
    }
    if (!kind) return undefined;
    return { key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'), kind };
  }
  if (method === 'item/agentMessage/delta') {
    const itemId = textValue(params.itemId);
    if (!itemId) return undefined;
    return {
      key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'),
      kind: 'agent'
    };
  }
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    const itemId = textValue(params.itemId);
    if (!itemId) return undefined;
    return {
      key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'),
      kind: 'reasoning'
    };
  }
  if (CODEX_TOOL_DELTA_METHODS.has(method)) {
    const itemId = textValue(params.itemId);
    if (!itemId) return undefined;
    return {
      key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'),
      kind: 'tool'
    };
  }
  return undefined;
}

function codexMessageLifecycleText(record: Record<string, unknown>): {
  completedAt?: string;
  completedSummaries?: string[];
  completedText?: string;
  fragment?: string;
  summaryFragment?: string;
  startedAt?: string;
  startedSummaries?: string[];
  startedText?: string;
} {
  const method = textValue(record.method);
  const params = recordValue(record.params);
  if (!method || !params) return {};
  if (method === 'item/reasoning/summaryTextDelta') return { summaryFragment: rawTextValue(params.delta, params.text) };
  if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta')
    return { fragment: rawTextValue(params.delta, params.text) };
  const item = recordValue(params.item);
  const itemType = textValue(item?.type);
  if (itemType !== 'agentMessage' && itemType !== 'reasoning' && itemType !== 'userMessage') return {};
  const text = codexItemText(item);
  const summaries = codexItemSummaries(item);
  if (method === 'item/started')
    return {
      startedAt: providerEpochMsTimestamp(numberValue(params.startedAtMs)),
      ...(summaries.length > 0 ? { startedSummaries: summaries } : {}),
      startedText: text
    };
  if (method === 'item/completed')
    return {
      completedAt: providerEpochMsTimestamp(numberValue(params.completedAtMs)),
      ...(summaries.length > 0 ? { completedSummaries: summaries } : {}),
      completedText: text
    };
  return {};
}

function codexMessageGroupInit(key: string, kind: CodexMessageGroup['kind']): CodexMessageGroup {
  return { key, kind, raw: [], rawLines: [], fragments: [], summaryFragments: [] };
}

function codexMessageGroupAppend(group: CodexMessageGroup, entry: MeshAgentObservationJsonRecordEntry): void {
  group.raw.push(entry.record);
  group.rawLines.push(entry.raw);
  const text = codexMessageLifecycleText(entry.record);
  if (text.fragment !== undefined) group.fragments.push(text.fragment);
  if (text.summaryFragment !== undefined) group.summaryFragments.push(text.summaryFragment);
  if (text.startedText !== undefined) group.startedText = text.startedText;
  if (text.startedSummaries !== undefined) group.startedSummaries = text.startedSummaries;
  if (text.completedText !== undefined) group.completedText = text.completedText;
  if (text.completedSummaries !== undefined) group.completedSummaries = text.completedSummaries;
  if (text.startedAt !== undefined) group.startedAt = text.startedAt;
  if (text.completedAt !== undefined) group.completedAt = text.completedAt;
}

function codexToolGroupAppend(group: CodexToolGroup, entry: MeshAgentObservationJsonRecordEntry): void {
  group.raw.push(entry.record);
  group.rawLines.push(entry.raw);
  const method = textValue(entry.record.method);
  const params = recordValue(entry.record.params);
  if (!method || !params) return;
  if (CODEX_TOOL_DELTA_METHODS.has(method)) {
    const fragment = rawTextValue(params.delta, params.output, params.text, params.message);
    if (fragment !== undefined) group.fragments.push(fragment);
    return;
  }
  const item = recordValue(params.item);
  if (!item) return;
  if (method === 'item/started') {
    group.startedItem = item;
    group.startedRecord = entry.record;
    group.startedAt = providerEpochMsTimestamp(numberValue(params.startedAtMs));
  }
  if (method === 'item/completed') {
    group.completedItem = item;
    group.completedRecord = entry.record;
    group.completedAt = providerEpochMsTimestamp(numberValue(params.completedAtMs));
  }
}

function codexMessageGroupEvent(id: string, group: CodexMessageGroup): MeshAgentObservationEvent[] {
  const text = group.completedText ?? group.startedText ?? group.fragments.join('');
  if (group.kind === 'reasoning') {
    const streamedSummary = group.summaryFragments.join('');
    const summaries =
      group.completedSummaries ?? group.startedSummaries ?? (streamedSummary ? [streamedSummary] : [undefined]);
    const startedAtMs = group.startedAt ? Date.parse(group.startedAt) : Number.NaN;
    const completedAtMs = group.completedAt ? Date.parse(group.completedAt) : Number.NaN;
    const durationMs =
      Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs) && completedAtMs >= startedAtMs
        ? completedAtMs - startedAtMs
        : undefined;
    const multiple = summaries.length > 1;
    return summaries.flatMap((summary, index) =>
      thinkingObservation({
        id: `${id}:json:${group.key}:reasoning${multiple ? `:summary:${index}` : ''}`,
        text: index === summaries.length - 1 ? text : undefined,
        source: 'codex-app-server',
        providerEventType: multiple ? 'item/reasoning/summary' : 'item/reasoning/delta',
        durationMs: index === summaries.length - 1 ? durationMs : undefined,
        summary,
        createdAt: group.completedAt ?? group.startedAt,
        rawEvents: group.raw
      })
    );
  }
  return observation({
    id: `${id}:json:${group.key}:${group.kind}-message`,
    role: group.kind,
    text,
    source: 'codex-app-server',
    providerEventType: group.kind === 'agent' ? 'item/agentMessage' : 'item/userMessage',
    createdAt: group.completedAt ?? group.startedAt,
    rawEvents: group.raw
  });
}

function codexToolGroupEvents(id: string, group: CodexToolGroup): MeshAgentObservationEvent[] {
  const item = group.completedItem ?? group.startedItem;
  if (!item) {
    return observation({
      id: `${id}:json:${group.key}:tool-delta`,
      role: 'tool',
      text: group.fragments.join(''),
      source: 'codex-app-server',
      providerEventType: 'item/commandExecution/outputDelta',
      rawEvents: group.raw,
      preserveWhitespace: true
    });
  }
  const callItem = group.startedItem ?? item;
  const callRecord = group.startedRecord ?? group.completedRecord ?? group.raw[0];
  if (!callRecord) return [];
  const call = codexAppServerToolCallObservation({
    id,
    recordIndex: 0,
    method: group.startedItem ? 'item/started' : 'item/completed',
    record: callRecord,
    item: callItem,
    createdAt: group.startedAt ?? group.completedAt
  });
  if (!group.completedItem) return call;
  const completedItem = {
    ...group.startedItem,
    ...group.completedItem,
    ...(!hasCodexAppServerToolOutput(group.completedItem) && group.fragments.length > 0
      ? { aggregatedOutput: group.fragments.join('') }
      : {})
  };
  if (!hasCodexAppServerToolOutput(completedItem)) return call;
  const completedRecord = group.completedRecord ?? group.raw.at(-1);
  if (!completedRecord) return call;
  return [
    ...call,
    ...codexAppServerToolResultObservation({
      id,
      recordIndex: 0,
      method: 'item/completed',
      record: completedRecord,
      item: completedItem,
      createdAt: group.completedAt
    })
  ];
}

export const codexObservationMessageGroupAdapter = {
  append(group: unknown, entry: MeshAgentObservationJsonRecordEntry): void {
    const observationGroup = group as CodexObservationGroup;
    if (observationGroup.kind === 'tool') codexToolGroupAppend(observationGroup, entry);
    else codexMessageGroupAppend(observationGroup, entry);
  },
  create(record: Record<string, unknown>): { key: string; state: CodexObservationGroup } | undefined {
    const group = codexObservationGroup(record);
    if (!group) return undefined;
    return {
      key: group.key,
      state:
        group.kind === 'tool'
          ? { key: group.key, kind: 'tool', raw: [], rawLines: [], fragments: [] }
          : codexMessageGroupInit(group.key, group.kind)
    };
  },
  render(id: string, group: unknown): MeshAgentObservationEvent[] {
    const observationGroup = group as CodexObservationGroup;
    return observationGroup.kind === 'tool'
      ? codexToolGroupEvents(id, observationGroup)
      : codexMessageGroupEvent(id, observationGroup);
  }
};
