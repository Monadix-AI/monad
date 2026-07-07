import type { ExternalAgentObservationEvent } from '@monad/protocol';
import type { ExternalAgentObservationJsonRecordEntry } from '../../observation-projection.ts';

import {
  numberValue,
  observation,
  providerEpochMsTimestamp,
  rawTextValue,
  recordValue,
  textValue
} from '../../observation-projection.ts';

type CodexMessageGroup = {
  key: string;
  kind: 'agent' | 'user';
  raw: Record<string, unknown>[];
  rawLines: string[];
  fragments: string[];
  startedText?: string;
  completedText?: string;
  startedAt?: string;
  completedAt?: string;
};

export function codexItemText(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const direct = rawTextValue(item.text);
  if (direct !== undefined) return direct;
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

function codexMessageGroup(
  record: Record<string, unknown>
): { key: string; kind: CodexMessageGroup['kind'] } | undefined {
  const method = textValue(record.method);
  if (!method) return undefined;
  const params = recordValue(record.params);
  if (!params) return undefined;
  const item = recordValue(params.item);
  if (method === 'item/started' || method === 'item/completed') {
    const itemType = textValue(item?.type);
    const kind = itemType === 'agentMessage' ? 'agent' : itemType === 'userMessage' ? 'user' : undefined;
    if (!kind) return undefined;
    const itemId = textValue(item?.id);
    if (!itemId) return undefined;
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
  return undefined;
}

function codexMessageLifecycleText(record: Record<string, unknown>): {
  completedAt?: string;
  completedText?: string;
  fragment?: string;
  startedAt?: string;
  startedText?: string;
} {
  const method = textValue(record.method);
  const params = recordValue(record.params);
  if (!method || !params) return {};
  if (method === 'item/agentMessage/delta') return { fragment: rawTextValue(params.delta, params.text) };
  const item = recordValue(params.item);
  const itemType = textValue(item?.type);
  if (itemType !== 'agentMessage' && itemType !== 'userMessage') return {};
  const text = codexItemText(item);
  if (method === 'item/started')
    return { startedAt: providerEpochMsTimestamp(numberValue(params.startedAtMs)), startedText: text };
  if (method === 'item/completed')
    return { completedAt: providerEpochMsTimestamp(numberValue(params.completedAtMs)), completedText: text };
  return {};
}

function codexMessageGroupInit(key: string, kind: CodexMessageGroup['kind']): CodexMessageGroup {
  return { key, kind, raw: [], rawLines: [], fragments: [] };
}

function codexMessageGroupAppend(group: CodexMessageGroup, entry: ExternalAgentObservationJsonRecordEntry): void {
  group.raw.push(entry.record);
  group.rawLines.push(entry.raw);
  const text = codexMessageLifecycleText(entry.record);
  if (text.fragment !== undefined) group.fragments.push(text.fragment);
  if (text.startedText !== undefined) group.startedText = text.startedText;
  if (text.completedText !== undefined) group.completedText = text.completedText;
  if (text.startedAt !== undefined) group.startedAt = text.startedAt;
  if (text.completedAt !== undefined) group.completedAt = text.completedAt;
}

function codexMessageGroupEvent(id: string, group: CodexMessageGroup): ExternalAgentObservationEvent[] {
  const text = group.completedText ?? group.startedText ?? group.fragments.join('');
  return observation({
    id: `${id}:json:${group.key}:${group.kind}-message`,
    role: group.kind,
    text,
    source: 'codex-app-server',
    providerEventType: group.kind === 'agent' ? 'item/agentMessage' : 'item/userMessage',
    createdAt: group.completedAt ?? group.startedAt,
    raw: group.rawLines.length > 1 ? group.rawLines : (group.raw[0] ?? group.rawLines[0])
  });
}

export const codexObservationMessageGroupAdapter = {
  append(group: unknown, entry: ExternalAgentObservationJsonRecordEntry): void {
    codexMessageGroupAppend(group as CodexMessageGroup, entry);
  },
  create(record: Record<string, unknown>): { key: string; state: CodexMessageGroup } | undefined {
    const group = codexMessageGroup(record);
    return group ? { key: group.key, state: codexMessageGroupInit(group.key, group.kind) } : undefined;
  },
  render(id: string, group: unknown): ExternalAgentObservationEvent[] {
    return codexMessageGroupEvent(id, group as CodexMessageGroup);
  }
};
