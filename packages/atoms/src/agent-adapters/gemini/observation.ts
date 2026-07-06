import type { NativeCliObservationEvent } from '@monad/protocol';
import type { NativeCliObservationJsonRecordEntry, NativeCliObservationProjector } from '../observation-projection.ts';

import { observation, providerIsoTimestamp, textValue, thinkingObservation } from '../observation-projection.ts';

export function geminiRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  const type = record.type;
  const createdAt = providerIsoTimestamp(textValue(record.timestamp));
  if (type === 'message') {
    return observation({
      id: `${id}:json:${recordIndex}:message`,
      role: 'agent',
      text: textValue(record.text, record.content, record.delta, record.message),
      source: 'gemini-cli',
      providerEventType: 'message',
      createdAt,
      raw: record
    });
  }
  if (type === 'thinking' || type === 'reasoning' || type === 'thought') {
    return thinkingObservation({
      id: `${id}:json:${recordIndex}:thinking`,
      text: textValue(record.thinking, record.reasoning, record.thought, record.text, record.content, record.delta),
      source: 'gemini-cli',
      providerEventType: String(type),
      createdAt,
      raw: record,
      preserveWhitespace: type === 'thinking' && record.delta !== undefined
    });
  }
  if (type === 'tool_use') {
    const tool = textValue(record.name, record.tool) ?? 'tool';
    const input = record.args ?? record.arguments ?? record.input;
    const inputText = input === undefined ? '' : ` ${typeof input === 'string' ? input : JSON.stringify(input)}`;
    return observation({
      id: `${id}:json:${recordIndex}:tool-use`,
      role: 'tool',
      text: `Tool call ${tool}${inputText}`,
      source: 'gemini-cli',
      providerEventType: 'tool_use',
      createdAt,
      raw: record
    });
  }
  if (type === 'tool_result') {
    return observation({
      id: `${id}:json:${recordIndex}:tool-result`,
      role: 'tool',
      text: textValue(record.output, record.result, record.content) ?? JSON.stringify(record),
      source: 'gemini-cli',
      providerEventType: 'tool_result',
      createdAt,
      raw: record
    });
  }
  if (type === 'error') {
    return observation({
      id: `${id}:json:${recordIndex}:error`,
      role: 'system',
      text: textValue(record.message, record.error) ?? JSON.stringify(record),
      source: 'gemini-cli',
      providerEventType: 'error',
      createdAt,
      raw: record
    });
  }
  if (type === 'result') {
    return observation({
      id: `${id}:json:${recordIndex}:result`,
      role: 'agent',
      text: textValue(record.response, record.result, record.text),
      source: 'gemini-cli',
      providerEventType: 'result',
      createdAt,
      raw: record
    });
  }
  return [];
}

function assistantMessageText(record: Record<string, unknown>): string | undefined {
  return record.type === 'message' && record.role === 'assistant' && typeof record.content === 'string'
    ? record.content
    : undefined;
}

function geminiHistoryEntryFromAssistant(
  entry: NativeCliObservationJsonRecordEntry,
  text: string
): NativeCliObservationJsonRecordEntry {
  const { delta: _delta, ...record } = entry.record;
  const foldedRecord = { ...record, content: text };
  return { record: foldedRecord, raw: JSON.stringify(foldedRecord) };
}

function geminiHistoryEntries(entries: NativeCliObservationJsonRecordEntry[]): NativeCliObservationJsonRecordEntry[] {
  const folded: NativeCliObservationJsonRecordEntry[] = [];
  let pendingEntry: NativeCliObservationJsonRecordEntry | undefined;
  let pendingText = '';

  const flushAssistant = () => {
    if (!pendingEntry || pendingText.length === 0) return;
    folded.push(geminiHistoryEntryFromAssistant(pendingEntry, pendingText));
    pendingEntry = undefined;
    pendingText = '';
  };

  for (const entry of entries) {
    const assistantText = assistantMessageText(entry.record);
    if (assistantText !== undefined) {
      pendingEntry = entry;
      pendingText += assistantText;
      continue;
    }

    if (entry.record.type === 'message' && entry.record.role === 'user') {
      flushAssistant();
      continue;
    }

    if (entry.record.type === 'init') continue;
    if (entry.record.type === 'result' && !textValue(entry.record.response, entry.record.result, entry.record.text)) {
      flushAssistant();
      continue;
    }

    flushAssistant();
    folded.push(entry);
  }
  flushAssistant();
  return folded;
}

export const geminiObservationProjection = {
  historyEntries: geminiHistoryEntries,
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => geminiRecordEvents(id, record, recordIndex) }]
} satisfies NativeCliObservationProjector;
