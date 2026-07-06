import type { NativeCliObservationEvent } from '@monad/protocol';
import type { NativeCliObservationProjector, ObservationRole } from '../observation-projection.ts';

import { observation, textValue } from '../observation-projection.ts';

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const item = part as Record<string, unknown>;
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
  return text.trim() ? text : undefined;
}

function roleFromOpenClawMessage(record: Record<string, unknown>): ObservationRole {
  const role = textValue(record.role)?.toLowerCase();
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool' || role === 'toolresult' || role === 'tool_result') return 'tool';
  return 'agent';
}

export function openClawRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  if (typeof record.role !== 'string') return [];
  return observation({
    id: `${id}:json:${recordIndex}:message`,
    role: roleFromOpenClawMessage(record),
    text: textFromContent(record.content) ?? textValue(record.text),
    source: 'unknown',
    providerEventType: 'message',
    raw: record
  });
}

export const openClawObservationProjection = {
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => openClawRecordEvents(id, record, recordIndex) }]
} satisfies NativeCliObservationProjector;
