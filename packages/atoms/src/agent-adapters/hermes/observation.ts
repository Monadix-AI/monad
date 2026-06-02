import type { MeshAgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationProjector, ObservationRole } from '../observation-projection.ts';

import {
  classifyObservationActivity,
  compactJson,
  isStreamingObservationFragment,
  observation,
  recordValue,
  textValue
} from '../observation-projection.ts';

function roleFromHermesMessage(record: Record<string, unknown>): ObservationRole {
  const role = textValue(record.role)?.toLowerCase();
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool' || role === 'tool_result' || role === 'toolresult') return 'tool';
  return 'agent';
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const item = part as Record<string, unknown>;
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .join('');
  return text.trim() ? text : undefined;
}

function toolCallEvents(id: string, record: Record<string, unknown>, recordIndex: number): MeshAgentObservationEvent[] {
  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  return calls.flatMap((call, callIndex) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return [];
    const item = call as Record<string, unknown>;
    const fn = item.function && typeof item.function === 'object' ? (item.function as Record<string, unknown>) : {};
    const name = textValue(item.name, item.tool_name, fn.name) ?? 'tool';
    const args = item.input ?? item.args ?? item.arguments ?? fn.arguments;
    const argsText = args === undefined ? '' : ` ${compactJson(args) ?? String(args)}`;
    return observation({
      id: `${id}:json:${recordIndex}:tool-call:${callIndex}`,
      role: 'tool',
      text: `Tool call ${name}${argsText}`,
      source: 'unknown',
      providerEventType: 'tool_call',
      raw: record
    });
  });
}

export function hermesRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const params = recordValue(record.params);
  const payload = recordValue(params?.payload);
  const eventType = textValue(params?.type);
  if (record.method === 'event' && eventType) {
    const text = typeof payload?.text === 'string' ? payload.text : undefined;
    switch (eventType) {
      case 'message.start':
        return observation({
          id: `${id}:json:${recordIndex}:turn-start`,
          role: 'system',
          text: 'Message started',
          source: 'unknown',
          providerEventType: 'turn-start',
          raw: record
        });
      case 'reasoning.delta':
        return observation({
          id: `${id}:json:${recordIndex}:reasoning`,
          role: 'agent',
          text,
          source: 'unknown',
          providerEventType: 'reasoning.delta',
          raw: record,
          preserveWhitespace: true
        });
      case 'message.delta':
        return observation({
          id: `${id}:json:${recordIndex}:message`,
          role: 'agent',
          text,
          source: 'unknown',
          providerEventType: 'message.delta',
          raw: record,
          preserveWhitespace: true
        });
      case 'message.complete':
        return observation({
          id: `${id}:json:${recordIndex}:turn-end`,
          role: 'system',
          text: textValue(payload?.status) ?? 'complete',
          source: 'unknown',
          providerEventType: 'turn-end',
          raw: record
        });
      default:
        return [];
    }
  }
  if (typeof record.role !== 'string') return [];

  const reasoningText = textValue(record.reasoning_content, record.reasoning);
  const reasoning = observation({
    id: `${id}:json:${recordIndex}:reasoning`,
    role: 'agent',
    text: reasoningText,
    source: 'unknown',
    providerEventType: 'reasoning',
    raw: record
  });
  const contentText = textFromContent(record.content) ?? textValue(record.text, record.tool_name);
  const content = observation({
    id: `${id}:json:${recordIndex}:message`,
    role: roleFromHermesMessage(record),
    text: contentText,
    source: 'unknown',
    providerEventType: record.role === 'tool' ? 'tool_result' : 'message',
    raw: record
  });
  return [...reasoning, ...content, ...toolCallEvents(id, record, recordIndex)];
}

export const hermesObservationProjection = {
  classifyActivity: classifyObservationActivity,
  eventEntries: (entries) =>
    entries.filter(({ record }) => {
      if (typeof record.role === 'string') return true;
      const params = recordValue(record.params);
      const type = textValue(params?.type);
      if (record.method !== 'event') return record.method !== undefined;
      if (
        type === 'message.start' ||
        type === 'reasoning.delta' ||
        type === 'message.delta' ||
        type === 'message.complete'
      )
        return true;
      return (
        type !== 'gateway.ready' &&
        type !== 'session.info' &&
        type !== 'thinking.delta' &&
        type !== 'reasoning.available' &&
        type !== 'session.title'
      );
    }),
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => hermesRecordEvents(id, record, recordIndex) }]
} satisfies MeshAgentObservationProjector;
