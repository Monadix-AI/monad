import type { ExternalAgentObservationEvent } from '@monad/protocol';
import type { ExternalAgentObservationProjector, ObservationRole } from '../observation-projection.ts';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  observation,
  textValue
} from '../observation-projection.ts';

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
): ExternalAgentObservationEvent[] {
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
  classifyActivity: classifyObservationActivity,
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => openClawRecordEvents(id, record, recordIndex) }]
} satisfies ExternalAgentObservationProjector;
